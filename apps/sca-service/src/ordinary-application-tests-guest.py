#!/usr/bin/env python3
"""Guest-only root supervisor. Target/harness run as an unprivileged disposable UID.

Never run on the host. A VM check and fixed root-only payload guard precede writes.
The host independently proves service termination and removes disposable VM media.
"""

from __future__ import annotations

import base64
import ctypes
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import resource
import re
import selectors
import signal
import stat
import subprocess
import termios
import time
from typing import Literal, TypedDict

ROOT = Path("/var/lib/penny-app")
UID = 65534
MAX_INPUT = 24 * 1024 * 1024


Interpreter = Literal["php", "node", "node_typescript"]
GuestStatus = Literal["exited", "unsupported", "timeout", "output_limit", "failed"]


@dataclass(frozen=True)
class Resources:
    vm_timeout_seconds: int
    test_timeout_ms: int
    cpu_seconds: int
    memory_bytes: int
    processes: int
    file_bytes: int
    output_bytes: int


@dataclass(frozen=True)
class GuestFile:
    path: str
    content: bytes


@dataclass(frozen=True)
class Payload:
    interpreter: Interpreter
    resources: Resources
    files: tuple[GuestFile, ...]
    stdin: bytes


class GuestResult(TypedDict):
    schema_version: Literal[1]
    payload_sha256: str
    status: GuestStatus
    execution: Literal["RUN", "NOT RUN"]
    exit_code: int | None
    stdout_base64: str
    stderr_base64: str


def object_fields(value: object, keys: set[str]) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("object required")
    fields: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise ValueError("string key required")
        fields[key] = item
    if set(fields) != keys:
        raise ValueError("unexpected fields")
    return fields


def text(value: object, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("bounded string required")
    return value


def integer(value: object, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError("bounded integer required")
    return value


def parse_interpreter(value: object) -> Interpreter:
    if value == "php":
        return "php"
    if value == "node":
        return "node"
    if value == "node_typescript":
        return "node_typescript"
    raise ValueError("unsupported interpreter")


def parse_resources(value: object) -> Resources:
    fields = object_fields(
        value,
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
    return Resources(
        integer(fields["vm_timeout_seconds"], 1, 1200),
        integer(fields["test_timeout_ms"], 100, 60_000),
        integer(fields["cpu_seconds"], 1, 60),
        integer(fields["memory_bytes"], 16_777_216, 1_610_612_736),
        integer(fields["processes"], 1, 32),
        integer(fields["file_bytes"], 1024, 8_388_608),
        integer(fields["output_bytes"], 1, 65_536),
    )


def parse_files(value: object) -> tuple[GuestFile, ...]:
    if not isinstance(value, list) or not 2 <= len(value) <= 137:
        raise ValueError("bounded guest files required")
    files = []
    total = 0
    for entry in value:
        fields = object_fields(entry, {"path", "content_sha256", "content_base64"})
        name = text(fields["path"], 1040)
        content = decode(text(fields["content_base64"], 2_796_204), 2 * 1024 * 1024)
        total += len(content)
        if (
            not safe_name(name)
            or total > 16 * 1024 * 1024
            or hashlib.sha256(content).hexdigest() != fields["content_sha256"]
        ):
            raise ValueError("guest exact file binding")
        files.append(GuestFile(name, content))
    return tuple(files)


def parse_payload(value: object) -> Payload:
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
    for key in (
        "request_sha256",
        "source_snapshot_sha256",
        "source_corpus_sha256",
        "plan_sha256",
        "policy_sha256",
    ):
        if re.fullmatch(r"[a-f0-9]{64}", text(fields[key], 64)) is None:
            raise ValueError("guest digest binding")
    return Payload(
        parse_interpreter(fields["interpreter"]),
        parse_resources(fields["resources"]),
        parse_files(fields["files"]),
        decode(text(fields["stdin_base64"], 2_796_204), 2 * 1024 * 1024),
    )


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def guard() -> None:
    if os.getuid() != 0 or Path(__file__) != ROOT / "runner.py":
        raise ValueError("guest-only supervisor")
    detected = subprocess.run(
        ["/usr/bin/systemd-detect-virt", "--vm"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=5,
        check=False,
        env={"PATH": "/usr/bin:/bin"},
    )
    if detected.returncode != 0 or detected.stdout.strip() != b"kvm":
        raise ValueError("real KVM guest required")
    details = (ROOT / "payload.json").stat(follow_symlinks=False)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_uid != 0
        or details.st_nlink != 1
        or stat.S_IMODE(details.st_mode) != 0o400
        or details.st_size > MAX_INPUT
    ):
        raise ValueError("guest operand custody")
    # Nicless is independently set by QEMU; refuse unexpected in-guest interfaces too.
    if {entry.name for entry in Path("/sys/class/net").iterdir()} != {"lo"}:
        raise ValueError("unexpected guest NIC")


def descendants() -> list[int]:
    result = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdecimal():
            try:
                if entry.stat().st_uid == UID:
                    result.append(int(entry.name))
            except FileNotFoundError:
                pass
    return result


def safe_name(value: str) -> bool:
    return (
        value.startswith(("source/", "tests/"))
        and len(value) <= 1040
        and all(part not in ("", ".", "..") and len(part) <= 255 for part in value.split("/"))
        and all(c.isascii() and (c.isalnum() or c in "._@+/-") for c in value)
    )


def decode(value: str, maximum: int) -> bytes:
    data = base64.b64decode(value, validate=True)
    if len(data) > maximum or base64.b64encode(data).decode() != value:
        raise ValueError("guest input size/encoding")
    return data


def emit(result: GuestResult) -> None:
    # Only root owns the console; child pipes cannot forge supervisor framing.
    fd = os.open("/dev/ttyS0", os.O_WRONLY | os.O_NOFOLLOW)
    try:
        settings = termios.tcgetattr(fd)
        settings[1] &= ~termios.OPOST
        termios.tcsetattr(fd, termios.TCSANOW, settings)
        data = b"\nPENNY_APP_TEST_RESULT=" + canonical(result) + b"\n"
        while data:
            data = data[os.write(fd, data) :]
    finally:
        os.close(fd)


def stage(payload: Payload) -> Path:
    work = ROOT / "work"
    work.mkdir(mode=0o755)
    total = 0
    names = set()
    for item in payload.files:
        name = item.path
        if not safe_name(name) or name in names:
            raise ValueError("guest path/duplicate denied")
        names.add(name)
        data = item.content
        total += len(data)
        if total > 16 * 1024 * 1024:
            raise ValueError("guest exact input mismatch")
        target = work / name
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
    scratch = work / "scratch"
    scratch.mkdir(mode=0o700)
    os.chown(scratch, UID, UID)
    # Directory sizes and all source/harness bytes are fixed before untrusted execution.
    for current, dirs, _files in os.walk(work):
        for name in dirs:
            if Path(current) / name != scratch:
                os.chmod(Path(current) / name, 0o555)
    os.chmod("/dev/ttyS0", 0o600)
    return scratch


def command_for(payload: Payload) -> list[str]:
    commands = {
        "php": ["/usr/bin/php", "-n", "../tests/harness.php"],
        "node": ["/usr/bin/node", "--jitless", "--max-old-space-size=64", "../tests/harness.mjs"],
        "node_typescript": [
            "/usr/bin/node",
            "--jitless",
            "--max-old-space-size=64",
            "--experimental-strip-types",
            "../tests/harness.ts",
        ],
    }
    argv = commands[payload.interpreter]
    return argv


def interpreter_available(payload: Payload, argv: list[str]) -> bool:
    if not os.access(argv[0], os.X_OK):
        return False
    if payload.interpreter != "node_typescript":
        return True
    version = subprocess.run(
        [argv[0], "--version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=3,
        check=False,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
    )
    match = re.fullmatch(rb"v([0-9]+)\.([0-9]+)\.([0-9]+)\n?", version.stdout)
    return (
        version.returncode == 0
        and match is not None
        and (int(match[1]) > 22 or (int(match[1]) == 22 and int(match[2]) >= 6))
    )


def demote(limits: Resources) -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
    resource.setrlimit(resource.RLIMIT_AS, (limits.memory_bytes, limits.memory_bytes))
    resource.setrlimit(resource.RLIMIT_NPROC, (limits.processes, limits.processes))
    resource.setrlimit(resource.RLIMIT_FSIZE, (limits.file_bytes, limits.file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    # Inherited no-new-privileges prevents setuid/file-capability escalation in the guest.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError("guest no-new-privileges unavailable")
    os.setgroups([])
    os.setgid(UID)
    os.setuid(UID)
    os.umask(0o077)


def absorb(
    selector: selectors.BaseSelector, outputs: dict[str, bytearray], maximum: int, wait: float
) -> bool:
    count = sum(len(value) for value in outputs.values())
    for selected, _events in selector.select(wait):
        data = os.read(selected.fd, 65536)
        if not data:
            selector.unregister(selected.fileobj)
            continue
        available = maximum - count
        outputs[selected.data].extend(data[:available])
        count += min(len(data), available)
        if len(data) > available:
            return False
    return True


def capture(
    child: subprocess.Popen[bytes], limits: Resources, outputs: dict[str, bytearray]
) -> Literal["timeout", "output_limit", "exited"]:
    deadline = time.monotonic() + limits.test_timeout_ms / 1000
    with selectors.DefaultSelector() as selector:
        if child.stdout is None or child.stderr is None:
            raise ValueError("guest output pipes unavailable")
        for pipe, field in ((child.stdout, "stdout_base64"), (child.stderr, "stderr_base64")):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, field)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "timeout"
            if not absorb(selector, outputs, limits.output_bytes, min(0.1, remaining)):
                return "output_limit"
        try:
            child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return "timeout"
    return "exited"


def stop_children(child: subprocess.Popen[bytes]) -> None:
    # UID-wide sweep catches setsid/forked descendants; VM teardown is the final boundary.
    for pid in descendants():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait(timeout=5)
    if child.stdout is not None:
        child.stdout.close()
    if child.stderr is not None:
        child.stderr.close()


def execute(payload: Payload, result: GuestResult) -> None:
    if descendants():
        raise ValueError("disposable UID already in use")
    scratch = stage(payload)
    argv = command_for(payload)
    if not interpreter_available(payload, argv):
        result["status"] = "unsupported"
        return
    limits = payload.resources
    stdin = payload.stdin
    stdin_path = ROOT / "stdin"
    stdin_path.write_bytes(stdin)
    stdin_path.chmod(0o400)
    # File-backed stdin avoids an unbounded blocking write when the target never reads it.
    with stdin_path.open("rb") as input_stream:
        child = subprocess.Popen(
            argv,
            stdin=input_stream,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=scratch,
            start_new_session=True,
            env={"HOME": str(scratch), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            preexec_fn=lambda: demote(limits),
        )
    result["execution"] = "RUN"
    outputs = {"stdout_base64": bytearray(), "stderr_base64": bytearray()}
    try:
        result["status"] = capture(child, limits, outputs)
    finally:
        stop_children(child)
    result["exit_code"] = child.returncode
    result["stdout_base64"] = base64.b64encode(outputs["stdout_base64"]).decode()
    result["stderr_base64"] = base64.b64encode(outputs["stderr_base64"]).decode()


def main() -> None:
    guard()
    raw = (ROOT / "payload.json").read_bytes()
    value: object = json.loads(raw)
    if canonical(value) != raw:
        raise ValueError("guest noncanonical payload")
    payload = parse_payload(value)
    result: GuestResult = {
        "schema_version": 1,
        "payload_sha256": hashlib.sha256(raw).hexdigest(),
        "status": "failed",
        "execution": "NOT RUN",
        "exit_code": None,
        "stdout_base64": "",
        "stderr_base64": "",
    }
    try:
        execute(payload, result)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        result["status"] = "failed"
    emit(result)


if __name__ == "__main__":
    main()
