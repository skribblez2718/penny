"""Strict caller-supplied configuration contract for one supervised MemPalace hub."""

from __future__ import annotations

import ipaddress
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .common import (
    ValidationError,
    ensure_owner_only,
    load_json_object,
    require_absolute_path,
    require_identifier,
    sha256_file,
)

HUB_CONFIG_SCHEMA_VERSION = 1
REQUIRED_DATA_ROOTS = frozenset(
    {"palace", "kg", "logstream", "archive", "runtime", "logs", "home", "config", "cache", "state"}
)
MIN_TIMEOUT_SECONDS = 0.1
MAX_TIMEOUT_SECONDS = 300.0
MAX_TOKEN_BYTES = 16 * 1024


@dataclass(frozen=True)
class HubConfig:
    """Validated configuration for exactly one palace owner."""

    config_path: Path
    endpoint: str
    host: str
    port: int
    palace_id: str
    backend: str
    python_executable: Path
    token_file: Path
    data_roots: dict[str, Path]
    health_timeout_seconds: float
    stop_timeout_seconds: float
    config_sha256: str

    @property
    def pid_file(self) -> Path:
        """Return the palace-anchored identity shared by every would-be owner."""

        return self.data_roots["palace"] / ".mempalace-hub-supervisor.json"


def _timeout(raw: object, field: str) -> float:
    if not isinstance(raw, (int, float)) or isinstance(raw, bool):
        raise ValidationError(f"{field} must be numeric")
    value = float(raw)
    if not MIN_TIMEOUT_SECONDS <= value <= MAX_TIMEOUT_SECONDS:
        raise ValidationError(
            f"{field} must be between {MIN_TIMEOUT_SECONDS} and {MAX_TIMEOUT_SECONDS}"
        )
    return value


def _endpoint(raw: object) -> tuple[str, str, int]:
    if not isinstance(raw, str) or not raw:
        raise ValidationError("endpoint must be an explicit loopback HTTP URL")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise ValidationError(f"invalid endpoint: {exc}") from exc
    if (
        parsed.scheme != "http"
        or parsed.username is not None
        or parsed.password is not None
        or not parsed.hostname
        or port is None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValidationError(
            "endpoint must be http://<loopback-host>:<port> with no credentials/path"
        )
    host = parsed.hostname
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if not loopback:
        raise ValidationError("foundation service config permits loopback endpoints only")
    if not 1 <= port <= 65535:
        raise ValidationError("endpoint port is out of range")
    return raw.rstrip("/"), host, port


def _python_executable(raw: object) -> Path:
    if not isinstance(raw, str) or not raw or not Path(raw).expanduser().is_absolute():
        raise ValidationError("python_executable must be an absolute path")
    candidate = Path(raw).expanduser().absolute()
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ValidationError(f"cannot resolve python_executable: {exc}") from exc
    if not resolved.is_file() or not os.access(candidate, os.X_OK):
        raise ValidationError("python_executable must resolve to an executable file")
    # Keep the configured venv launcher path: resolving its symlink would bypass
    # the isolated environment and execute the base interpreter instead.
    return candidate


def _validate_data_roots(raw: object) -> dict[str, Path]:
    if not isinstance(raw, dict) or set(raw) != REQUIRED_DATA_ROOTS:
        raise ValidationError(f"data_roots must contain exactly {sorted(REQUIRED_DATA_ROOTS)}")
    roots: dict[str, Path] = {}
    for name, value in raw.items():
        must_exist = name not in {"kg", "logstream"}
        root = require_absolute_path(value, f"data_roots.{name}", must_exist=must_exist)
        if must_exist and not root.is_dir():
            raise ValidationError(f"data_roots.{name} must be a directory")
        roots[name] = root

    palace = roots["palace"]
    if roots["kg"] != palace / "knowledge_graph.sqlite3":
        raise ValidationError("data_roots.kg must be <palace>/knowledge_graph.sqlite3")
    if roots["logstream"] != palace / "logstream.sqlite3":
        raise ValidationError("data_roots.logstream must be <palace>/logstream.sqlite3")
    for name in ("palace", "archive", "runtime", "logs", "home", "config", "cache", "state"):
        root_stat = roots[name].stat()
        if root_stat.st_uid != os.geteuid():
            raise ValidationError(f"data_roots.{name} must be owned by the service user")
        if stat.S_IMODE(root_stat.st_mode) & 0o077:
            raise ValidationError(f"data_roots.{name} must be owner-only")
    return roots


def load_hub_config(path: Path) -> HubConfig:
    """Load a strict owner-only config with no implicit filesystem defaults."""

    config_path = require_absolute_path(str(path), "config")
    ensure_owner_only(config_path, "config")
    document = load_json_object(config_path)
    required_fields = {
        "schema_version",
        "endpoint",
        "palace_id",
        "backend",
        "python_executable",
        "token_file",
        "data_roots",
        "health_timeout_seconds",
        "stop_timeout_seconds",
    }
    if set(document) != required_fields:
        raise ValidationError("hub config has unknown or missing fields")
    if document.get("schema_version") != HUB_CONFIG_SCHEMA_VERSION:
        raise ValidationError(f"hub config schema_version must be {HUB_CONFIG_SCHEMA_VERSION}")
    endpoint, host, port = _endpoint(document["endpoint"])
    token_file = require_absolute_path(document["token_file"], "token_file")
    ensure_owner_only(token_file, "token_file")
    if token_file.stat().st_size > MAX_TOKEN_BYTES:
        raise ValidationError(f"token_file exceeds {MAX_TOKEN_BYTES} bytes")
    token = token_file.read_bytes()
    if not token.strip() or b"\n" in token.strip() or b"\r" in token.strip():
        raise ValidationError("token_file must contain one non-empty line-free token")
    return HubConfig(
        config_path=config_path,
        endpoint=endpoint,
        host=host,
        port=port,
        palace_id=require_identifier(document["palace_id"], "palace_id"),
        backend=require_identifier(document["backend"], "backend"),
        python_executable=_python_executable(document["python_executable"]),
        token_file=token_file,
        data_roots=_validate_data_roots(document["data_roots"]),
        health_timeout_seconds=_timeout(
            document["health_timeout_seconds"], "health_timeout_seconds"
        ),
        stop_timeout_seconds=_timeout(document["stop_timeout_seconds"], "stop_timeout_seconds"),
        config_sha256=sha256_file(config_path),
    )


def read_token(config: HubConfig) -> str:
    """Read the external token without exposing it in config, argv, or logs."""

    ensure_owner_only(config.token_file, "token_file")
    try:
        token = config.token_file.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise ValidationError(f"cannot read token_file: {exc}") from exc
    if not token or "\n" in token or "\r" in token:
        raise ValidationError("token_file must contain one non-empty line-free token")
    return token


def child_environment(config: HubConfig) -> dict[str, str]:
    """Build the upstream process environment from caller-supplied roots."""

    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    environment.update(
        {
            "HOME": str(config.data_roots["home"]),
            "XDG_CONFIG_HOME": str(config.data_roots["config"]),
            "XDG_CACHE_HOME": str(config.data_roots["cache"]),
            "XDG_STATE_HOME": str(config.data_roots["state"]),
            "MEMPALACE_PALACE_PATH": str(config.data_roots["palace"]),
            "MEMPALACE_BACKEND": config.backend,
            "MEMPALACE_BACKEND_EXPLICIT": config.backend,
            "MEMPALACE_MCP_HTTP_TOKEN": read_token(config),
            "MEMPALACE_MCP_IDLE_HOURS": "0",
        }
    )
    return environment
