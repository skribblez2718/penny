"""Shared, side-effect-bounded helpers for memory service and data tooling."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, cast

JSON_READ_LIMIT_BYTES = 256 * 1024 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")


class ValidationError(ValueError):
    """Raised when an external configuration or manifest is invalid."""


def canonical_json_bytes(value: object) -> bytes:
    """Serialize a value deterministically for hashing and immutable receipts."""

    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    """Return the lowercase SHA-256 digest of bytes."""

    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    """Hash one regular file without following a caller-supplied symlink."""

    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"expected a regular non-symlink file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_object(path: Path) -> dict[str, Any]:
    """Load a size-bounded JSON object from a regular non-symlink file."""

    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"expected a regular non-symlink JSON file: {path}")
    size = path.stat().st_size
    if size > JSON_READ_LIMIT_BYTES:
        raise ValidationError(f"JSON input exceeds {JSON_READ_LIMIT_BYTES} bytes: {path}")
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"invalid JSON file {path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValidationError(f"JSON root must be an object: {path}")
    return cast(dict[str, Any], parsed)


def atomic_write_json(path: Path, value: object, mode: int = 0o600) -> None:
    """Publish a new JSON file atomically and refuse to overwrite any path."""

    if path.exists() or path.is_symlink():
        raise ValidationError(f"refusing to overwrite output: {path}")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = canonical_json_bytes(value)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), mode)
        os.link(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except FileExistsError as exc:
        raise ValidationError(f"refusing to overwrite output: {path}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def require_absolute_path(raw: object, field: str, *, must_exist: bool = True) -> Path:
    """Validate an absolute caller-supplied path and return its canonical form."""

    if not isinstance(raw, str) or not raw:
        raise ValidationError(f"{field} must be a non-empty absolute path")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ValidationError(f"{field} must be absolute")
    try:
        resolved = candidate.resolve(strict=must_exist)
    except OSError as exc:
        raise ValidationError(f"cannot resolve {field}: {exc}") from exc
    if candidate.is_symlink():
        raise ValidationError(f"{field} must not be a symlink")
    return resolved


def require_identifier(raw: object, field: str) -> str:
    """Validate a bounded machine identifier."""

    if not isinstance(raw, str) or not IDENTIFIER_PATTERN.fullmatch(raw):
        raise ValidationError(f"{field} is not a valid identifier")
    return raw


def require_sha256(raw: object, field: str) -> str:
    """Validate a canonical lowercase SHA-256 digest."""

    if not isinstance(raw, str) or not SHA256_PATTERN.fullmatch(raw):
        raise ValidationError(f"{field} must be a lowercase SHA-256 digest")
    return raw


def require_utc_timestamp(raw: object, field: str) -> str:
    """Validate an ISO-8601 timestamp with an explicit UTC offset."""

    if not isinstance(raw, str) or not raw:
        raise ValidationError(f"{field} must be an ISO-8601 timestamp")
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValidationError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValidationError(f"{field} must use UTC")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now() -> str:
    """Return the current UTC timestamp in canonical ISO-8601 form."""

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_relative_path(raw: object, field: str) -> str:
    """Validate a portable, non-traversing relative POSIX path."""

    if not isinstance(raw, str) or not raw or "\\" in raw:
        raise ValidationError(f"{field} must be a non-empty POSIX relative path")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValidationError(f"{field} contains an absolute or traversing path")
    return path.as_posix()


def ensure_owner_only(path: Path, field: str) -> None:
    """Require a regular owner-only file (no group/other permission bits)."""

    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"{field} must be a regular non-symlink file")
    file_stat = path.stat()
    if file_stat.st_uid != os.geteuid():
        raise ValidationError(f"{field} must be owned by the current user")
    if stat.S_IMODE(file_stat.st_mode) & 0o077:
        raise ValidationError(f"{field} must not grant group or other permissions")


def mode_string(mode: int) -> str:
    """Return a canonical four-digit octal mode string."""

    return f"{stat.S_IMODE(mode):04o}"
