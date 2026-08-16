"""Portable foreground, health, status, and stop interface for one MemPalace hub."""

from __future__ import annotations

import argparse
import json
import os
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Any, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .common import (
    ValidationError,
    atomic_write_json,
    load_json_object,
    require_identifier,
    require_sha256,
    require_utc_timestamp,
    utc_now,
)
from .hub_config import HubConfig, child_environment, load_hub_config, read_token

PID_SCHEMA_VERSION = 1
PID_FILE_TYPE = "mempalace-hub-supervisor"
MAX_HTTP_RESPONSE_BYTES = 1024 * 1024
PROCESS_POLL_SECONDS = 0.05


@dataclass(frozen=True)
class ProcessMetadata:
    """Owner-only process identity used by portable status and stop commands."""

    pid: int
    start_marker: str | None
    config_sha256: str
    palace_id: str
    endpoint: str
    started_at: str


def build_hub_command(config: HubConfig) -> list[str]:
    """Return the exact upstream foreground command with no credential in argv."""

    return [
        str(config.python_executable),
        "-m",
        "mempalace.mcp_server",
        "--transport",
        "http",
        "--host",
        config.host,
        "--port",
        str(config.port),
        "--palace",
        str(config.data_roots["palace"]),
        "--backend",
        config.backend,
    ]


def _linux_process_stat(pid: int) -> tuple[str, str] | None:
    """Return Linux process state and start marker, handling spaces in comm."""

    stat_path = Path("/proc") / str(pid) / "stat"
    try:
        raw = stat_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    closing = raw.rfind(") ")
    if closing < 0:
        return None
    fields_after_command = raw[closing + 2 :].split()
    if len(fields_after_command) <= 19:
        return None
    return fields_after_command[0], fields_after_command[19]


def _linux_start_marker(pid: int) -> str | None:
    process_stat = _linux_process_stat(pid)
    return process_stat[1] if process_stat is not None else None


def _process_alive(metadata: ProcessMetadata) -> bool:
    try:
        os.kill(metadata.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    process_stat = _linux_process_stat(metadata.pid)
    # An exited child remains visible to kill(0) until its parent reaps it. Treat
    # that Linux zombie as stopped so portable stop does not report a false
    # timeout when the caller itself owns the foreground supervisor process.
    if process_stat is not None and process_stat[0] == "Z":
        return False
    if metadata.start_marker is not None:
        return process_stat is not None and process_stat[1] == metadata.start_marker
    return True


def _metadata_dict(config: HubConfig) -> dict[str, Any]:
    return {
        "schema_version": PID_SCHEMA_VERSION,
        "file_type": PID_FILE_TYPE,
        "pid": os.getpid(),
        "start_marker": _linux_start_marker(os.getpid()),
        "config_sha256": config.config_sha256,
        "palace_id": config.palace_id,
        "endpoint": config.endpoint,
        "started_at": utc_now(),
    }


def _read_process_metadata(path: Path) -> ProcessMetadata:
    document = load_json_object(path)
    if (
        document.get("schema_version") != PID_SCHEMA_VERSION
        or document.get("file_type") != PID_FILE_TYPE
    ):
        raise ValidationError("supervisor pid file has an unsupported schema")
    pid = document.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise ValidationError("supervisor pid file contains an invalid pid")
    start_marker = document.get("start_marker")
    if start_marker is not None and not isinstance(start_marker, str):
        raise ValidationError("supervisor pid file contains an invalid start marker")
    config_sha256 = require_sha256(document.get("config_sha256"), "pid.config_sha256")
    palace_id = require_identifier(document.get("palace_id"), "pid.palace_id")
    endpoint_value = document.get("endpoint")
    if not isinstance(endpoint_value, str) or not endpoint_value:
        raise ValidationError("supervisor pid file contains an invalid endpoint")
    started_at = require_utc_timestamp(document.get("started_at"), "pid.started_at")
    file_stat = path.stat()
    if file_stat.st_uid != os.geteuid() or stat.S_IMODE(file_stat.st_mode) & 0o077:
        raise ValidationError("supervisor pid file must be owner-only")
    return ProcessMetadata(
        pid=pid,
        start_marker=start_marker,
        config_sha256=config_sha256,
        palace_id=palace_id,
        endpoint=endpoint_value,
        started_at=started_at,
    )


def _remove_own_pid_file(config: HubConfig, pid: int) -> None:
    try:
        metadata = _read_process_metadata(config.pid_file)
    except (OSError, ValidationError):
        return
    if metadata.pid == pid and metadata.config_sha256 == config.config_sha256:
        config.pid_file.unlink(missing_ok=True)


def _acquire_supervisor_identity(config: HubConfig) -> None:
    pid_file = config.pid_file
    if pid_file.exists() or pid_file.is_symlink():
        if pid_file.is_symlink():
            raise ValidationError("refusing symlink supervisor pid file")
        try:
            existing = _read_process_metadata(pid_file)
        except ValidationError as exc:
            raise ValidationError("invalid supervisor pid file; refusing unsafe recovery") from exc
        if _process_alive(existing):
            raise ValidationError(f"writable hub already supervised by PID {existing.pid}")
        pid_file.unlink(missing_ok=True)
    atomic_write_json(pid_file, _metadata_dict(config), 0o600)


def _request(config: HubConfig, path: str, *, authenticated: bool) -> tuple[int, bytes]:
    headers = {"Accept": "application/json"}
    if authenticated:
        headers["Authorization"] = f"Bearer {read_token(config)}"
    request = Request(f"{config.endpoint}{path}", headers=headers, method="GET")
    try:
        with urlopen(request, timeout=config.health_timeout_seconds) as response:
            payload = response.read(MAX_HTTP_RESPONSE_BYTES + 1)
            status = response.status
    except HTTPError as exc:
        payload = exc.read(MAX_HTTP_RESPONSE_BYTES + 1)
        status = exc.code
    except (OSError, URLError, TimeoutError) as exc:
        raise ValidationError(f"hub request failed: {exc}") from exc
    if len(payload) > MAX_HTTP_RESPONSE_BYTES:
        raise ValidationError("hub response exceeds the status/health limit")
    return status, payload


def health(config: HubConfig) -> dict[str, Any]:
    """Return a machine-readable liveness result from the credential-free endpoint."""

    try:
        status, payload = _request(config, "/healthz", authenticated=False)
        healthy = status == 200 and payload == b"ok\n"
        error = None if healthy else f"unexpected health response: HTTP {status}"
    except ValidationError as exc:
        healthy = False
        status = 0
        error = str(exc)
    return {
        "schema_version": 1,
        "operation": "health",
        "palace_id": config.palace_id,
        "endpoint": config.endpoint,
        "healthy": healthy,
        "http_status": status,
        "error": error,
    }


def status(config: HubConfig) -> dict[str, Any]:
    """Combine supervisor identity, liveness, and authenticated upstream status."""

    metadata: ProcessMetadata | None = None
    pid_error: str | None = None
    try:
        metadata = _read_process_metadata(config.pid_file)
    except FileNotFoundError:
        pid_error = "not supervised"
    except (OSError, ValidationError) as exc:
        pid_error = str(exc)
    running = metadata is not None and _process_alive(metadata)
    health_result = health(config)
    upstream: Any = None
    status_error: str | None = None
    if running and health_result["healthy"]:
        try:
            http_status, payload = _request(config, "/statusz", authenticated=True)
            if http_status != 200:
                raise ValidationError(f"status endpoint returned HTTP {http_status}")
            upstream = json.loads(payload.decode("utf-8"))
            if not isinstance(upstream, dict):
                raise ValidationError("status endpoint did not return an object")
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as exc:
            status_error = str(exc)
    return {
        "schema_version": 1,
        "operation": "status",
        "palace_id": config.palace_id,
        "endpoint": config.endpoint,
        "supervised": metadata is not None,
        "running": running,
        "pid": metadata.pid if metadata is not None else None,
        "pid_error": pid_error,
        "healthy": health_result["healthy"],
        "upstream": upstream,
        "error": status_error or health_result["error"],
    }


def run_foreground(config: HubConfig) -> int:
    """Supervise one upstream process in the foreground and forward terminal signals."""

    _acquire_supervisor_identity(config)
    child: subprocess.Popen[bytes] | None = None
    previous_handlers: dict[int, Any] = {}

    def forward_signal(signum: int, _frame: FrameType | None) -> None:
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    try:
        child = subprocess.Popen(
            build_hub_command(config),
            env=child_environment(config),
            stdin=subprocess.DEVNULL,
            close_fds=os.name != "nt",
        )
        for signal_name in ("SIGTERM", "SIGHUP"):
            active_signal = getattr(signal, signal_name, None)
            if active_signal is None:
                continue
            previous_handlers[active_signal] = signal.getsignal(active_signal)
            signal.signal(active_signal, forward_signal)
        return child.wait()
    except KeyboardInterrupt:
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                return child.wait(timeout=config.stop_timeout_seconds)
            except subprocess.TimeoutExpired:
                return 124
        return 130
    finally:
        for active_signal, previous_handler in previous_handlers.items():
            signal.signal(active_signal, previous_handler)
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=config.stop_timeout_seconds)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        _remove_own_pid_file(config, os.getpid())


def stop(config: HubConfig) -> dict[str, Any]:
    """Request graceful supervisor shutdown; never kills after timeout implicitly."""

    try:
        metadata = _read_process_metadata(config.pid_file)
    except FileNotFoundError:
        return {"stopped": True, "already_stopped": True, "stale_recovered": False}
    if metadata.config_sha256 != config.config_sha256 or metadata.palace_id != config.palace_id:
        raise ValidationError("pid file identity does not match the supplied config")
    if not _process_alive(metadata):
        config.pid_file.unlink(missing_ok=True)
        return {"stopped": True, "already_stopped": True, "stale_recovered": True}
    os.kill(metadata.pid, signal.SIGTERM)
    deadline = time.monotonic() + config.stop_timeout_seconds
    while time.monotonic() < deadline:
        if not _process_alive(metadata):
            config.pid_file.unlink(missing_ok=True)
            return {"stopped": True, "already_stopped": False, "stale_recovered": False}
        time.sleep(PROCESS_POLL_SECONDS)
    return {
        "stopped": False,
        "already_stopped": False,
        "stale_recovered": False,
        "error": "graceful stop timeout; no force signal was sent",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Supervise and inspect one MemPalace HTTP hub")
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for operation in ("command", "foreground", "health", "status", "stop"):
        command = subparsers.add_parser(operation)
        command.add_argument("--config", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the portable service interface; no operation starts in an extension factory."""

    args = _parser().parse_args(argv)
    try:
        config = load_hub_config(args.config)
        if args.operation == "command":
            result: Any = {"command": build_hub_command(config)}
            exit_code = 0
        elif args.operation == "foreground":
            return run_foreground(config)
        elif args.operation == "health":
            result = health(config)
            exit_code = 0 if result["healthy"] else 1
        elif args.operation == "status":
            result = status(config)
            exit_code = 0 if result["running"] and result["healthy"] else 1
        else:
            result = stop(config)
            exit_code = 0 if result["stopped"] else 1
    except (OSError, ValidationError) as exc:
        print(json.dumps({"error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
