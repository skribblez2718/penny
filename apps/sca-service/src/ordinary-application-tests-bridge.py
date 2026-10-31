#!/usr/bin/env python3
"""Trusted host bridge; delegates containment to the existing pinned run_guest.py.

Invoked only by ordinary-application-tests.ts with private admitted operands. No target
interpreter runs here. Existing run_job.py owns the deployment-wide flock/quarantine.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import signal
import stat
import sys
import tempfile
from types import FrameType, ModuleType
from typing import (
    Callable,
    Literal,
    Mapping,
    NoReturn,
    Protocol,
    Sequence,
    TypedDict,
    runtime_checkable,
)

MAX_PAYLOAD = 24 * 1024 * 1024
MAX_SERIAL = 8 * 1024 * 1024


PIN_NAMES = {
    "run_job",
    "run_guest",
    "output_protocol",
    "python",
    "genisoimage",
    "cp",
    "qemu",
    "bwrap",
    "systemctl",
    "template",
    "bridge",
    "guest",
}


@dataclass(frozen=True)
class Pin:
    path: Path
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class HostConfig:
    workspace_parent: Path
    global_lock: Path
    pins: Mapping[str, Pin]


@dataclass(frozen=True)
class Invocation:
    request_sha256: str
    vm_timeout_seconds: int


@dataclass(frozen=True)
class CliArgs:
    config: Path
    payload: Path
    unit: str


@dataclass(frozen=True)
class LaunchProof:
    success: bool
    confirmed_inactive: bool
    input_hashes_preserved: bool
    execution_duration_ms: int


class BridgeReceipt(TypedDict):
    schema_version: Literal[1]
    payload_sha256: str
    status: Literal["completed", "failed", "cancelled"]
    launcher_started: bool
    unit_observed: bool
    containment_proved: bool
    media_removed: bool
    launcher_base64: str
    command_base64: str
    serial_base64: str


@runtime_checkable
class VmJob(Protocol):
    JobRunnerError: type[Exception]

    def exact_private_directory(self, path: Path, label: str) -> Path: ...
    def acquire_global_lock(self, path: Path) -> int: ...
    def interrupted(self, signum: int, frame: FrameType | None) -> NoReturn: ...
    def progress(self, phase: str) -> None: ...
    def atomic_private_file(self, path: Path, content: bytes) -> None: ...

    def bounded_command(
        self,
        argv: Sequence[str],
        timeout: int,
        activity_probe: Callable[[], bool] | None = None,
        activity_started: Callable[[], None] | None = None,
    ) -> bytes: ...
    def digest_file(self, path: Path, maximum: int) -> str: ...
    def unit_active(self, systemctl: Path, unit: str) -> bool: ...

    def stop_and_prove_inactive(
        self, systemctl: Path, unit: str, *, was_observed: bool
    ) -> bool: ...
    def write_global_lock_state(self, descriptor: int, state: bytes) -> None: ...


def object_fields(value: object, keys: set[str] | None = None) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("object required")
    fields: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise ValueError("string key required")
        fields[key] = item
    if keys is not None and set(fields) != keys:
        raise ValueError("unexpected fields")
    return fields


def text(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError("bounded string required")
    return value


def integer(value: object, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError("bounded integer required")
    return value


def boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise ValueError("boolean proof required")
    return value


def parse_pin(value: object) -> Pin:
    fields = object_fields(value, {"path", "sha256", "size_bytes"})
    digest = text(fields["sha256"], 64)
    if re.fullmatch(r"[a-f0-9]{64}", digest) is None:
        raise ValueError("pin digest required")
    return Pin(
        Path(text(fields["path"], 4096)), digest, integer(fields["size_bytes"], 1, 32 * 1024**3)
    )


def parse_config(value: object) -> HostConfig:
    fields = object_fields(value, PIN_NAMES | {"workspace_parent", "global_lock"})
    return HostConfig(
        Path(text(fields["workspace_parent"], 4096)),
        Path(text(fields["global_lock"], 4096)),
        {name: parse_pin(fields[name]) for name in PIN_NAMES},
    )


def parse_invocation(value: object) -> Invocation:
    # Source/test fields remain exact canonical bytes; the guest validates their complete grammar.
    fields = object_fields(
        value,
        {
            "schema_version",
            "request_sha256",
            "source_snapshot_sha256",
            "source_corpus_sha256",
            "plan_sha256",
            "policy_sha256",
            "interpreter",
            "resources",
            "files",
            "stdin_base64",
        },
    )
    integer(fields["schema_version"], 1, 1)
    digest = text(fields["request_sha256"], 64)
    if re.fullmatch(r"[a-f0-9]{64}", digest) is None:
        raise ValueError("request digest required")
    limits = object_fields(
        fields["resources"],
        {
            "vm_timeout_seconds",
            "test_timeout_ms",
            "cpu_seconds",
            "memory_bytes",
            "processes",
            "file_bytes",
            "output_bytes",
        },
    )
    return Invocation(digest, integer(limits["vm_timeout_seconds"], 1, 1200))


def parse_launch(value: object) -> LaunchProof:
    # The pinned launcher's other bounded diagnostic fields are retained raw, not trusted as proof.
    fields = object_fields(value)
    return LaunchProof(
        boolean(fields["success"]),
        boolean(fields["confirmed_inactive"]),
        boolean(fields["input_hashes_preserved"]),
        integer(fields["execution_duration_ms"], 0, 1_260_000),
    )


def load_pinned_module(name: str, pin: Pin) -> ModuleType:
    filename = verify_pin(pin, 256 * 1024 * 1024)
    spec = importlib.util.spec_from_file_location(name, filename)
    if spec is None or spec.loader is None:
        raise ValueError("existing VM module unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def bounded(path: Path, maximum: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > maximum
            or before.st_mode & 0o077
            or before.st_uid != os.getuid()
        ):
            raise ValueError("unsafe private bridge file")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            data = stream.read(maximum + 1)
        after = os.fstat(descriptor)
        if (
            len(data) > maximum
            or len(data) != before.st_size
            or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise ValueError("bridge file drift")
        return data
    finally:
        os.close(descriptor)


def verify_pin(pin: Pin, maximum: int) -> Path:
    path = pin.path
    details = path.stat(follow_symlinks=False)
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or details.st_size != pin.size_bytes
        or details.st_size > maximum
        or details.st_uid not in (0, os.getuid())
        or details.st_mode & 0o022
    ):
        raise ValueError("host pin custody drift")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while data := stream.read(1024 * 1024):
            digest.update(data)
    if digest.hexdigest() != pin.sha256:
        raise ValueError("host pin digest drift")
    return path


def retained_evidence(
    evidence: Path, unit: str, launcher: bytes, command: bytes, serial: bytes
) -> tuple[bytes, bytes, bytes]:
    values = {"result.json": launcher, "command.json": command, "serial.log": serial}
    for suffix, maximum in (
        ("result.json", 12_288),
        ("command.json", 1024 * 1024),
        ("serial.log", MAX_SERIAL),
    ):
        if not values[suffix]:
            try:
                values[suffix] = bounded(evidence / f"{unit}.{suffix}", maximum)
            except (OSError, ValueError):
                pass
    return values["result.json"], values["command.json"], values["serial.log"]


def admitted_host_operands(
    args: CliArgs,
) -> tuple[HostConfig, bytes, Invocation, VmJob, Path, int]:
    if os.getuid() == 0:
        raise ValueError("root execution forbidden")
    config_value: object = json.loads(bounded(args.config, 1024 * 1024))
    config = parse_config(config_value)
    payload_bytes = bounded(args.payload, MAX_PAYLOAD)
    payload_value: object = json.loads(payload_bytes)
    payload = parse_invocation(payload_value)
    if canonical(payload_value) != payload_bytes:
        raise ValueError("payload must be canonical")
    if args.unit != f"penny-guest-{payload.request_sha256[:32]}.service":
        raise ValueError("unit mismatch")
    # Verify BOTH modules before import. Isolated Python (-I -B) ignores ambient paths/env.
    run_job = verify_pin(config.pins["run_job"], 256 * 1024 * 1024)
    protocol = verify_pin(config.pins["output_protocol"], 256 * 1024 * 1024)
    if protocol != run_job.parent / "output_protocol.py":
        raise ValueError("noncanonical bridge dependency")
    for key in ("run_guest", "python", "genisoimage", "cp", "qemu", "bwrap", "systemctl", "guest"):
        verify_pin(config.pins[key], 256 * 1024 * 1024)
    verify_pin(config.pins["template"], 32 * 1024**3)
    # Publish only the exact already-verified dependency; never extend sys.path.
    load_pinned_module("output_protocol", config.pins["output_protocol"])
    module = load_pinned_module("penny_existing_vm_job", config.pins["run_job"])
    if not isinstance(module, VmJob):
        raise ValueError("existing VM job protocol unavailable")
    job = module
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, job.interrupted)
    work = job.exact_private_directory(args.config.parent, "ordinary application workspace")
    if (
        work.parent != config.workspace_parent
        or args.payload != work / "payload.json"
        or args.config != work / "config.json"
        or config.global_lock.parent != config.workspace_parent
    ):
        raise ValueError("host workspace binding mismatch")
    lock_fd = job.acquire_global_lock(config.global_lock)
    return config, payload_bytes, payload, job, work, lock_fd


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--payload", required=True)
    parser.add_argument("--unit", required=True)
    namespace = parser.parse_args()
    args = CliArgs(
        Path(text(namespace.config, 4096)),
        Path(text(namespace.payload, 4096)),
        text(namespace.unit, 128),
    )
    config, payload_bytes, payload, job, work, lock_fd = admitted_host_operands(args)
    digest = hashlib.sha256(payload_bytes).hexdigest()
    run = Path(tempfile.mkdtemp(prefix="vm-", dir=work))
    seed_dir = run / "seed"
    seed_dir.mkdir(mode=0o700)
    evidence = run / "evidence"
    evidence.mkdir(mode=0o700)
    root = run / "root.raw"
    seed_iso = run / "seed.iso"
    started = False
    observed = False
    proved = True
    removed = False
    launcher = b""
    serial = b""
    command = b""
    status: Literal["completed", "failed", "cancelled"] = "failed"
    try:
        job.progress("validated")
        guest = config.pins["guest"].path.read_bytes()
        files = [
            {
                "path": "/var/lib/penny-app/runner.py",
                "permissions": "0500",
                "encoding": "b64",
                "content": base64.b64encode(guest).decode(),
            },
            {
                "path": "/var/lib/penny-app/payload.json",
                "permissions": "0400",
                "encoding": "b64",
                "content": base64.b64encode(payload_bytes).decode(),
            },
        ]
        cloud = {
            "write_files": files,
            "runcmd": [["/usr/bin/python3", "-I", "-B", "/var/lib/penny-app/runner.py"]],
            "power_state": {"delay": "now", "mode": "poweroff", "condition": True},
        }
        job.atomic_private_file(
            seed_dir / "user-data", b"#cloud-config\n" + canonical(cloud) + b"\n"
        )
        job.atomic_private_file(
            seed_dir / "meta-data",
            f"instance-id: penny-app-{digest}\nlocal-hostname: penny-app\n".encode(),
        )
        job.bounded_command(
            [
                str(config.pins["genisoimage"].path),
                "-quiet",
                "-V",
                "cidata",
                "-R",
                "-J",
                "-o",
                str(seed_iso),
                str(seed_dir),
            ],
            120,
        )
        seed_iso.chmod(0o400)
        job.progress("media_ready")
        job.bounded_command(
            [
                str(config.pins["cp"].path),
                "--sparse=always",
                "--",
                str(config.pins["template"].path),
                str(root),
            ],
            300,
        )
        root.chmod(0o600)
        if job.digest_file(root, 32 * 1024**3) != config.pins["template"].sha256:
            raise ValueError("disposable root copy drift")
        job.progress("disk_ready")
        argv = [
            str(config.pins["python"].path),
            "-I",
            "-B",
            str(config.pins["run_guest"].path),
            "--disk",
            str(root),
            "--disk-sha256",
            config.pins["template"].sha256,
            "--disk-size-bytes",
            str(config.pins["template"].size_bytes),
            "--seed-iso",
            str(seed_iso),
            "--seed-sha256",
            job.digest_file(seed_iso, MAX_PAYLOAD * 2),
            "--qemu",
            str(config.pins["qemu"].path),
            "--qemu-sha256",
            config.pins["qemu"].sha256,
            "--bwrap",
            str(config.pins["bwrap"].path),
            "--bwrap-sha256",
            config.pins["bwrap"].sha256,
            "--output-dir",
            str(evidence),
            "--unit",
            args.unit,
            "--timeout",
            str(payload.vm_timeout_seconds),
        ]
        started = True
        proved = False

        def guest_started() -> None:
            nonlocal observed
            observed = True
            job.progress("guest_started")

        launcher = job.bounded_command(
            argv,
            payload.vm_timeout_seconds + 60,
            activity_probe=lambda: job.unit_active(config.pins["systemctl"].path, args.unit),
            activity_started=guest_started,
        )
        # A fast VM can complete between probes: the exact launcher's terminal receipt proves
        # it was launched, not just that the service is absent now.
        launch_value: object = json.loads(launcher)
        launch = parse_launch(launch_value)
        observed = observed or (
            launch.execution_duration_ms > 0 and launch.confirmed_inactive is True
        )
        proved = job.stop_and_prove_inactive(
            config.pins["systemctl"].path, args.unit, was_observed=observed
        )
        job.progress("guest_finished")
        command = bounded(evidence / f"{args.unit}.command.json", 1024 * 1024)
        serial = bounded(evidence / f"{args.unit}.serial.log", MAX_SERIAL)
        if (
            launch.success is True
            and launch.confirmed_inactive is True
            and launch.input_hashes_preserved is True
            and proved
        ):
            status = "completed"
            job.progress("output_verified")
    except KeyboardInterrupt:
        status = "cancelled"
    except (OSError, ValueError, job.JobRunnerError):
        status = "failed"
    finally:
        if started and not proved:
            proved = job.stop_and_prove_inactive(
                config.pins["systemctl"].path, args.unit, was_observed=observed
            )
        # Preserve failed launcher's exact evidence when present; never guess success.
        if started:
            launcher, command, serial = retained_evidence(
                evidence, args.unit, launcher, command, serial
            )
        if proved:
            try:
                shutil.rmtree(run)
                removed = not run.exists()
            except OSError:
                removed = False
        job.write_global_lock_state(
            lock_fd, b"" if proved and removed else b"containment-unproved\n"
        )
        os.close(lock_fd)
    receipt: BridgeReceipt = {
        "schema_version": 1,
        "payload_sha256": digest,
        "status": status,
        "launcher_started": started,
        "unit_observed": observed,
        "containment_proved": proved,
        "media_removed": removed,
        "launcher_base64": base64.b64encode(launcher).decode(),
        "command_base64": base64.b64encode(command).decode(),
        "serial_base64": base64.b64encode(serial).decode(),
    }
    raw = canonical(receipt)
    job.atomic_private_file(work / "receipt.json", raw)
    pointer = {
        "schema_version": 1,
        "receipt_sha256": hashlib.sha256(raw).hexdigest(),
        "receipt_bytes": len(raw),
    }
    print(canonical(pointer).decode(), flush=True)
    return 0 if status == "completed" else 130 if status == "cancelled" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError):
        print("ordinary_application_bridge_refused", file=sys.stderr)
        raise SystemExit(1)
