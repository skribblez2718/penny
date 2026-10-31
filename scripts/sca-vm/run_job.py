#!/usr/bin/env python3
"""Run one closed SCA VM job and publish only verified guest outputs."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, NoReturn, Sequence

from output_protocol import MAX_OUTPUT_DISK_BYTES, read_envelope

MAX_INPUT_BYTES = 1024 * 1024 * 1024
MAX_TOOL_BYTES = 256 * 1024 * 1024
MAX_CONTROL_BYTES = 1024 * 1024
HEADER_BYTES = 64 * 1024
ALIGNMENT = 4096
_active_child: subprocess.Popen[bytes] | None = None


class JobRunnerError(RuntimeError):
    """A closed job could not be run or verified."""


@dataclass(frozen=True)
class Tool:
    path: Path
    sha256: str


def digest_file(path: Path, maximum: int) -> str:
    details = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        raise JobRunnerError("input is not a singly linked regular file")
    if details.st_size < 1 or details.st_size > maximum:
        raise JobRunnerError("input size is outside the admitted bound")
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    after = path.stat(follow_symlinks=False)
    if (details.st_dev, details.st_ino, details.st_size) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
    ):
        raise JobRunnerError("input changed while hashing")
    return digest.hexdigest()


def exact_private_directory(path: Path, label: str) -> Path:
    normalized = Path(os.path.normpath(path))
    if not path.is_absolute() or normalized != path or path.resolve(strict=True) != path:
        raise JobRunnerError(f"{label} must be an absolute non-symlink path")
    details = path.stat(follow_symlinks=False)
    if (
        not stat.S_ISDIR(details.st_mode)
        or details.st_uid != os.getuid()
        or stat.S_IMODE(details.st_mode) != 0o700
    ):
        raise JobRunnerError(f"{label} must be an owner-private directory")
    return path


def verify_tool(tool: Tool, executable: bool = True) -> None:
    if not tool.path.is_absolute() or tool.path.resolve(strict=True) != tool.path:
        raise JobRunnerError("tool path is not canonical")
    details = tool.path.stat(follow_symlinks=False)
    if details.st_uid not in (0, os.getuid()):
        raise JobRunnerError("tool has an unexpected owner")
    if executable and details.st_mode & stat.S_IXUSR == 0:
        raise JobRunnerError("tool is not executable")
    if digest_file(tool.path, MAX_TOOL_BYTES) != tool.sha256:
        raise JobRunnerError("tool digest mismatch")


def safe_relative(value: str) -> bool:
    item = PurePosixPath(value)
    return (
        value != ""
        and len(value.encode("utf-8")) <= 4096
        and not item.is_absolute()
        and "\\" not in value
        and "\x00" not in value
        and all(part not in ("", ".", "..") for part in item.parts)
    )


def verify_job_tree(root: Path) -> tuple[bytes, str]:  # noqa: C901
    exact_private_directory(root, "job directory")
    total = 0
    seen: set[str] = set()
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        relative_root = Path(current).relative_to(root)
        for name in sorted([*directories, *files]):
            relative = (relative_root / name).as_posix()
            if not safe_relative(relative) or relative in seen:
                raise JobRunnerError("job tree contains an unsafe path")
            seen.add(relative)
            target = Path(current) / name
            details = target.stat(follow_symlinks=False)
            if stat.S_ISLNK(details.st_mode) or details.st_uid != os.getuid():
                raise JobRunnerError("job tree contains an unsafe entry")
            if name in directories:
                if not stat.S_ISDIR(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o700:
                    raise JobRunnerError("job directory entry is not owner-private")
            elif not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
                raise JobRunnerError("job file is not a singly linked regular file")
            else:
                if stat.S_IMODE(details.st_mode) & 0o077:
                    raise JobRunnerError("job file is not owner-private")
                total += details.st_size
                if total > MAX_INPUT_BYTES:
                    raise JobRunnerError("job tree exceeds the byte limit")
    job_path = root / "job.json"
    raw = job_path.read_bytes()
    if len(raw) > MAX_CONTROL_BYTES:
        raise JobRunnerError("job control document exceeds the byte limit")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JobRunnerError("job control document is invalid") from exc
    canonical = json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if raw != canonical:
        raise JobRunnerError("job control document is not canonical JSON")
    return raw, hashlib.sha256(raw).hexdigest()


def terminate_group(child: subprocess.Popen[bytes], grace: int = 30) -> None:
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)


def bounded_command(  # noqa: C901
    argv: Sequence[str],
    timeout: int,
    activity_probe: Callable[[], bool] | None = None,
    activity_started: Callable[[], None] | None = None,
) -> bytes:
    global _active_child
    child = subprocess.Popen(
        list(argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={"HOME": "/var/tmp", "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"},
        start_new_session=True,
    )
    if child.stdout is None:
        terminate_group(child)
        raise JobRunnerError("host command output pipe is unavailable")
    _active_child = child
    output = bytearray()
    deadline = time.monotonic() + timeout
    next_activity_probe = time.monotonic()
    activity_confirmed = activity_probe is None
    activity_sequence = 0
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                terminate_group(child)
                raise JobRunnerError("host command timed out")
            events = selector.select(min(remaining, 0.25))
            if activity_probe is not None and time.monotonic() >= next_activity_probe:
                if activity_probe():
                    if not activity_confirmed:
                        activity_confirmed = True
                        if activity_started is not None:
                            activity_started()
                    else:
                        activity_sequence += 1
                        progress(f"guest_active:{activity_sequence}")
                next_activity_probe = time.monotonic() + 30
            for key, _ in events:
                chunk = os.read(key.fd, 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(chunk)
                if len(output) > MAX_CONTROL_BYTES:
                    terminate_group(child)
                    raise JobRunnerError("host command output exceeded its bound")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            terminate_group(child)
            raise JobRunnerError("host command timed out")
        child.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        terminate_group(child)
        raise JobRunnerError("host command timed out") from exc
    finally:
        selector.close()
        _active_child = None
    if child.returncode != 0:
        raise JobRunnerError("host command failed")
    return bytes(output)


def progress(phase: str) -> None:
    print(f"PENNY_SCA_VM_PROGRESS:{phase}", file=sys.stderr, flush=True)


def acquire_global_lock(path: Path) -> int:
    exact_private_directory(path.parent, "global lock parent")
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise JobRunnerError("global lock path is not canonical")
    descriptor = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        details = os.fstat(descriptor)
        named = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
            or details.st_nlink != 1
            or stat.S_IMODE(details.st_mode) != 0o600
            or (details.st_dev, details.st_ino) != (named.st_dev, named.st_ino)
        ):
            raise JobRunnerError("global lock file is unsafe")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise JobRunnerError("another SCA VM job is active") from exc
        if details.st_size != 0:
            raise JobRunnerError("global lock file is unsafe")
        os.ftruncate(descriptor, 0)
        os.write(descriptor, b"run-pending\n")
        os.fsync(descriptor)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def write_global_lock_state(descriptor: int, state: bytes) -> None:
    if state not in {b"", b"run-pending\n", b"containment-unproved\n"}:
        raise JobRunnerError("invalid global lock state")
    os.ftruncate(descriptor, 0)
    os.lseek(descriptor, 0, os.SEEK_SET)
    if state:
        os.write(descriptor, state)
    os.fsync(descriptor)


def systemd_state(systemctl: Path, unit: str) -> str | None:
    try:
        measured = subprocess.run(
            [
                str(systemctl),
                "--user",
                "show",
                "--property=ActiveState",
                "--value",
                unit,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
            env={
                "HOME": "/var/tmp",
                "LANG": "C.UTF-8",
                "PATH": "/usr/bin:/bin",
                "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
            },
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if len(measured.stdout) > 128:
        return None
    value = measured.stdout.strip().decode("ascii", "strict")
    if measured.returncode == 0:
        return value
    if measured.returncode == 4 and value == "":
        return "not-found"
    return None


def unit_active(systemctl: Path, unit: str) -> bool:
    return systemd_state(systemctl, unit) in {"activating", "active", "deactivating"}


def stop_and_prove_inactive(systemctl: Path, unit: str, *, was_observed: bool) -> bool:
    try:
        subprocess.run(
            [str(systemctl), "--user", "stop", unit],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
            env={
                "HOME": "/var/tmp",
                "LANG": "C.UTF-8",
                "PATH": "/usr/bin:/bin",
                "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
            },
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    state = systemd_state(systemctl, unit)
    return state in {"inactive", "failed"} or (was_observed and state == "not-found")


def interrupted(_signum: int, _frame: object) -> NoReturn:
    child = _active_child
    if child is not None:
        terminate_group(child)
    raise KeyboardInterrupt


def aligned_output_size(maximum_bytes: int) -> int:
    requested = max(2 * 1024 * 1024, HEADER_BYTES + maximum_bytes + ALIGNMENT)
    result = (requested + ALIGNMENT - 1) // ALIGNMENT * ALIGNMENT
    if result > MAX_OUTPUT_DISK_BYTES:
        raise JobRunnerError("requested output does not fit the output disk")
    return result


def atomic_private_file(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        written = 0
        while written < len(content):
            written += os.write(descriptor, content[written:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.link(temporary, path, follow_symlinks=False)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True, type=Path)
    parser.add_argument("--output-parent", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--template-sha256", required=True)
    parser.add_argument("--template-size-bytes", required=True, type=int)
    parser.add_argument("--launcher", required=True, type=Path)
    parser.add_argument("--launcher-sha256", required=True)
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--python-sha256", required=True)
    parser.add_argument("--genisoimage", required=True, type=Path)
    parser.add_argument("--genisoimage-sha256", required=True)
    parser.add_argument("--copy", required=True, type=Path)
    parser.add_argument("--copy-sha256", required=True)
    parser.add_argument("--qemu", required=True, type=Path)
    parser.add_argument("--qemu-sha256", required=True)
    parser.add_argument("--bwrap", required=True, type=Path)
    parser.add_argument("--bwrap-sha256", required=True)
    parser.add_argument("--systemctl", required=True, type=Path)
    parser.add_argument("--systemctl-sha256", required=True)
    parser.add_argument("--lock-file", required=True, type=Path)
    parser.add_argument("--max-output-bytes", required=True, type=int)
    parser.add_argument("--timeout", required=True, type=int)
    return parser.parse_args()


def main() -> int:  # noqa: C901
    if os.geteuid() == 0:
        raise JobRunnerError("job runner refuses root")
    args = parse_args()
    if not 1 <= args.max_output_bytes <= 256 * 1024 * 1024:
        raise JobRunnerError("invalid output limit")
    if not 1 <= args.timeout <= 1200:
        raise JobRunnerError("invalid timeout")
    if not 64 * 1024 <= args.template_size_bytes <= 32 * 1024 * 1024 * 1024:
        raise JobRunnerError("invalid template size")
    tools = (
        (Tool(args.launcher, args.launcher_sha256), False),
        (Tool(args.python, args.python_sha256), True),
        (Tool(args.genisoimage, args.genisoimage_sha256), True),
        (Tool(args.copy, args.copy_sha256), True),
        (Tool(args.qemu, args.qemu_sha256), True),
        (Tool(args.bwrap, args.bwrap_sha256), True),
        (Tool(args.systemctl, args.systemctl_sha256), True),
    )
    for tool, executable in tools:
        verify_tool(tool, executable=executable)
    template = args.template
    if (
        not template.is_absolute()
        or template.resolve(strict=True) != template
        or template.stat(follow_symlinks=False).st_size != args.template_size_bytes
        or stat.S_IMODE(template.stat(follow_symlinks=False).st_mode) != 0o400
        or digest_file(template, 32 * 1024 * 1024 * 1024) != args.template_sha256
    ):
        raise JobRunnerError("template identity mismatch")
    job_bytes, job_sha256 = verify_job_tree(args.job_dir)
    job_document = json.loads(job_bytes)
    if not isinstance(job_document, dict) or not isinstance(job_document.get("operation"), str):
        raise JobRunnerError("job control document has no operation")
    operation = job_document["operation"]
    global_lock_fd = acquire_global_lock(args.lock_file)
    progress("validated")
    parent = exact_private_directory(args.output_parent, "output parent")
    run = Path(tempfile.mkdtemp(prefix="sca-vm-job-", dir=parent))
    run.chmod(0o700)
    seed = run / "seed"
    results = run / "results"
    evidence = run / "evidence"
    for directory in (seed, results, evidence):
        directory.mkdir(mode=0o700)
    root_disk = run / "root.raw"
    job_iso = run / "job.iso"
    seed_iso = run / "seed.iso"
    output_disk = run / "output.raw"
    launch_output = run / "launcher.json"
    ephemeral = [root_disk, job_iso, seed_iso, output_disk]
    succeeded = False
    launcher_started = False
    unit_observed = False
    containment_proved = True
    unit = f"penny-guest-{uuid.uuid4().hex}.service"
    try:
        atomic_private_file(
            seed / "meta-data",
            f"instance-id: penny-sca-{job_sha256[:24]}\nlocal-hostname: penny-sca-job\n".encode(),
        )
        atomic_private_file(
            seed / "user-data",
            b"#cloud-config\nruncmd:\n  - [ /usr/local/bin/penny-sca-worker ]\n"
            b"power_state:\n  delay: now\n  mode: poweroff\n  condition: true\n",
        )
        os.chmod(seed / "meta-data", 0o400)
        os.chmod(seed / "user-data", 0o400)
        bounded_command(
            [
                str(args.genisoimage),
                "-quiet",
                "-V",
                "PENNY_JOB",
                "-R",
                "-J",
                "-o",
                str(job_iso),
                str(args.job_dir),
            ],
            120,
        )
        bounded_command(
            [
                str(args.genisoimage),
                "-quiet",
                "-V",
                "cidata",
                "-R",
                "-J",
                "-o",
                str(seed_iso),
                str(seed),
            ],
            120,
        )
        os.chmod(job_iso, 0o400)
        os.chmod(seed_iso, 0o400)
        progress("media_ready")
        bounded_command(
            [str(args.copy), "--sparse=always", "--", str(template), str(root_disk)], 300
        )
        os.chmod(root_disk, 0o600)
        if digest_file(root_disk, 32 * 1024 * 1024 * 1024) != args.template_sha256:
            raise JobRunnerError("runtime copy digest mismatch")
        progress("disk_ready")
        output_size = aligned_output_size(args.max_output_bytes)
        descriptor = os.open(output_disk, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.ftruncate(descriptor, output_size)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        launcher_started = True
        containment_proved = False

        def guest_started() -> None:
            nonlocal unit_observed
            unit_observed = True
            progress("guest_started")

        launcher_result = bounded_command(
            [
                str(args.python),
                str(args.launcher),
                "--disk",
                str(root_disk),
                "--disk-sha256",
                args.template_sha256,
                "--disk-size-bytes",
                str(args.template_size_bytes),
                "--seed-iso",
                str(seed_iso),
                "--seed-sha256",
                digest_file(seed_iso, 4 * 1024 * 1024 * 1024),
                "--assets-iso",
                str(job_iso),
                "--assets-sha256",
                digest_file(job_iso, 4 * 1024 * 1024 * 1024),
                "--output-disk",
                str(output_disk),
                "--output-disk-size-bytes",
                str(output_size),
                "--qemu",
                str(args.qemu),
                "--qemu-sha256",
                args.qemu_sha256,
                "--bwrap",
                str(args.bwrap),
                "--bwrap-sha256",
                args.bwrap_sha256,
                "--output-dir",
                str(evidence),
                "--unit",
                unit,
                "--timeout",
                str(args.timeout),
            ],
            args.timeout + 60,
            activity_probe=lambda: unit_active(args.systemctl, unit),
            activity_started=guest_started,
        )
        containment_proved = stop_and_prove_inactive(
            args.systemctl, unit, was_observed=unit_observed
        )
        if not containment_proved:
            raise JobRunnerError("VM unit inactivity could not be proved")
        progress("guest_finished")
        atomic_private_file(launch_output, launcher_result)
        os.chmod(launch_output, 0o400)
        launch = json.loads(launcher_result)
        if (
            not isinstance(launch, dict)
            or launch.get("success") is not True
            or launch.get("confirmed_inactive") is not True
            or launch.get("input_hashes_preserved") is not True
        ):
            raise JobRunnerError("launcher did not prove safe completion")
        envelope = read_envelope(
            output_disk,
            expected_job_sha256=job_sha256,
            max_output_bytes=args.max_output_bytes,
            max_result_items=16,
        )
        expected_outputs = {
            "health": (("result.json", "application/json", "penny.sca-vm-health.v1"),),
            "source_query": (
                ("result.json", "application/json", "penny.sca-source-query-result.v1"),
            ),
            "graph_query": (
                ("result.json", "application/json", "penny.sca-graph-query-result.v1"),
            ),
            "application_test": (
                ("result.json", "application/json", "penny.sca-application-test-result.v1"),
            ),
            "graph_build": (
                ("graph.cpg.bin", "application/vnd.penny.joern-cpg", "penny.sca-joern-cpg.v1"),
                ("metadata.json", "application/json", "penny.sca-graph-build-metadata.v1"),
            ),
        }
        actual_outputs = tuple(
            (item.name, item.media_type, item.schema_id) for item, _ in envelope.outputs
        )
        if actual_outputs != expected_outputs.get(operation):
            raise JobRunnerError("guest outputs do not match the operation contract")
        published = []
        logical_items = 0
        for output_descriptor, content in envelope.outputs:
            target = results / output_descriptor.name
            atomic_private_file(target, content)
            os.chmod(target, 0o400)
            if output_descriptor.media_type == "application/json":
                try:
                    body = json.loads(content)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise JobRunnerError("guest JSON output is invalid") from exc
                if not isinstance(body, dict):
                    raise JobRunnerError("guest JSON output is not an object")
                items = body.get("items", [])
                if not isinstance(items, list):
                    raise JobRunnerError("guest JSON result items are invalid")
                logical_items += len(items)
            else:
                logical_items += 1
            published.append(
                {
                    "byte_length": len(content),
                    "content_sha256": output_descriptor.sha256,
                    "media_type": output_descriptor.media_type,
                    "name": output_descriptor.name,
                    "path": str(target),
                    "schema_id": output_descriptor.schema_id,
                }
            )
        progress("output_verified")
        duration = launch.get("execution_duration_ms")
        if not isinstance(duration, int) or not 0 <= duration <= (args.timeout + 60) * 1000:
            raise JobRunnerError("launcher duration is invalid")
        receipt = {
            "error_code": envelope.error_code,
            "execution_duration_ms": duration,
            "job_sha256": job_sha256,
            "logical_result_items": logical_items,
            "outputs": published,
            "run_directory": str(run),
            "schema_id": "penny.sca-vm-host-result.v1",
            "schema_version": 1,
            "status": envelope.status,
        }
        receipt_bytes = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        atomic_private_file(run / "result.json", receipt_bytes)
        os.chmod(run / "result.json", 0o400)
        succeeded = True
        print(receipt_bytes.decode("utf-8"), flush=True)
        return 0 if envelope.status == "succeeded" else 1
    finally:
        cancelled = isinstance(sys.exc_info()[1], KeyboardInterrupt)
        if launcher_started and not containment_proved:
            containment_proved = stop_and_prove_inactive(
                args.systemctl, unit, was_observed=unit_observed
            )
        if containment_proved:
            for path in ephemeral:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
            shutil.rmtree(seed, ignore_errors=True)
            if not succeeded:
                shutil.rmtree(run, ignore_errors=True)
        write_global_lock_state(
            global_lock_fd,
            b"" if containment_proved else b"containment-unproved\n",
        )
        if cancelled:
            cancellation = {
                "containment_proved": containment_proved,
                "job_sha256": job_sha256,
                "run_media_removed": not run.exists(),
                "schema_id": "penny.sca-vm-cancellation.v1",
                "schema_version": 1,
                "status": "cancelled",
                "unit": unit,
                "unit_observed": unit_observed,
            }
            print(json.dumps(cancellation, sort_keys=True, separators=(",", ":")), flush=True)
        os.close(global_lock_fd)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("sca_vm_job_cancelled", file=sys.stderr)
        raise SystemExit(130)
    except (JobRunnerError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
