#!/usr/bin/env python3
"""Run one caller-provided raw guest disk with no host container runtime."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import FrameType

DISK_MAX = 32 * 1024**3
ISO_MAX = 4 * 1024**3
OUTPUT_DISK_MAX = 384 * 1024**2
OUTPUT_DISK_MIN = 64 * 1024
LOG_MAX = 8 * 1024**2
DISK_BPS = 16_777_216
DISK_IOPS = 512
HOST_WAIT_GRACE = 20
# These are policy, not caller-provided mount roots. No general /usr or /usr/share bind.
QEMU_BINARY = Path("/usr/bin/qemu-system-x86_64")
RUNTIME_DIRS = (
    Path("/usr/lib/x86_64-linux-gnu"),  # loader libraries and QEMU dlopen modules
    Path("/usr/lib64"),  # x86-64 ELF interpreter symlink
    Path("/usr/share/qemu"),
    Path("/usr/share/seabios"),
)
PSEUDODEVICES = ("null", "zero", "random", "urandom")
SYSTEMD_RUN = Path("/usr/bin/systemd-run")
SYSTEMCTL = Path("/usr/bin/systemctl")
PROPERTIES = (
    "RuntimeMaxSec={seconds}",
    "MemoryMax=4G",
    "MemorySwapMax=0",
    "TasksMax=128",
    "CPUQuota=200%",  # Best-effort quota; not proof when cpu.max is absent.
    "LimitCPU=1800",  # RLIMIT_CPU (CPU time), independent of placement.
    "LimitFSIZE=34359738368",
    "LimitCORE=0",
    "KillMode=control-group",
    "TimeoutStopSec=10s",
)


class InvalidInput(ValueError):
    """A boundary check failed; nothing has been launched."""


# Only internally authored, path-free reasons may be printed. OSError details stay private.
SAFE_INVALID_INPUT_REASONS = frozenset(
    {
        "paths must be absolute, canonical and free of dot components",
        "invalid path characters or length",
        "symlink path component",
        "noncanonical path",
        "directory must be owned by caller and inaccessible to others",
        "unsafe directory ancestor",
        "input must be a singly linked regular file owned by caller",
        "input size outside bounds",
        "input must be private",
        "raw root disk must be writable by owner",
        "qcow image is not a raw disk",
        "ISO must be read-only for all users",
        "output disk and size must be supplied together",
        "output disk size outside bounds",
        "output disk must be a private writable regular file",
        "output disk must be zero initialized",
        "input changed during preflight",
        "input changed while hashing",
        "tool directory must be root-owned and nonwritable",
        "tool must be root-owned, executable and nonwritable",
        "tool SHA256 mismatch",
        "untrusted QEMU runtime directory",
        "accessible root-owned /dev/kvm (10:232) character device required",
        "unexpected library directory layout",
        "untrusted library alias",
        "unexpected library alias",
        "untrusted library target",
        "disk and ISOs must be distinct",
        "raw disk must match the declared sector-aligned virtual size",
        "raw disk SHA256 mismatch",
        "assets ISO and hash must be supplied together",
        "seed hash required",
        "ISO SHA256 mismatch",
        "root execution is forbidden",
        "timeout must be 1..1200 seconds",
        "empty allowed CPU affinity",
        "expected fixed root-owned QEMU and bubblewrap paths",
        "invalid systemd unit identity",
        "unsafe singleton lock",
        "concurrent run in output directory",
        "ISO changed since planning",
        "disk changed since planning",
        "raw disk changed since planning",
        "output disk changed since planning",
    }
)


@dataclass(frozen=True)
class InputFile:
    path: Path
    size: int
    sha256: str | None
    device: int
    inode: int


@dataclass(frozen=True)
class Plan:
    unit: str
    argv: list[str]
    inputs: dict[str, InputFile]
    output_dir: Path
    seconds: int
    cpu_ids: tuple[int, ...]

    def manifest(self) -> dict[str, object]:
        return {
            "unit": self.unit,
            "argv": self.argv,
            "inputs": {
                name: {"path": str(value.path), "size": value.size, "sha256": value.sha256}
                for name, value in self.inputs.items()
            },
            "output_dir": str(self.output_dir),
            "seconds": self.seconds,
            "cpu_ids": list(self.cpu_ids),
            "log_limit_bytes": LOG_MAX,
            "virtual_disk_bytes": self.inputs["disk"].size,
        }


def absolute_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or str(path) != os.path.normpath(value) or ".." in path.parts:
        raise InvalidInput("paths must be absolute, canonical and free of dot components")
    if len(value) > 4096 or "$" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise InvalidInput("invalid path characters or length")
    return path


def no_symlink_components(path: Path) -> None:
    current = Path("/")
    for part in path.parts[1:]:
        current = current / part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise InvalidInput("symlink path component")
    if path.resolve(strict=True) != path:
        raise InvalidInput("noncanonical path")


def private_dir(path: Path) -> None:
    no_symlink_components(path)
    st = path.stat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise InvalidInput("directory must be owned by caller and inaccessible to others")
    # Ancestors may be root-owned sticky /tmp, but must not be replaceable by another user.
    for parent in path.parents:
        mode = parent.stat()
        if mode.st_mode & 0o022 and not (mode.st_uid == 0 and mode.st_mode & stat.S_ISVTX):
            if mode.st_uid != os.geteuid() or mode.st_mode & 0o077:
                raise InvalidInput("unsafe directory ancestor")


def regular_file(path: Path, *, maximum: int | None, writable: bool) -> InputFile:
    private_dir(path.parent)
    no_symlink_components(path)
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1:
            raise InvalidInput("input must be a singly linked regular file owned by caller")
        if st.st_size <= 0 or (maximum is not None and st.st_size > maximum):
            raise InvalidInput("input size outside bounds")
        if st.st_mode & 0o077:
            raise InvalidInput("input must be private")
        if writable:
            if st.st_mode & 0o200 == 0:
                raise InvalidInput("raw root disk must be writable by owner")
            if os.read(fd, 4) == b"QFI\xfb":
                raise InvalidInput("qcow image is not a raw disk")
        elif st.st_mode & 0o222:
            raise InvalidInput("ISO must be read-only for all users")
        return InputFile(path, st.st_size, None, st.st_dev, st.st_ino)
    finally:
        os.close(fd)


def output_file(path: Path, declared_size: int) -> InputFile:
    private_dir(path.parent)
    no_symlink_components(path)
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
    )
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.geteuid()
            or details.st_nlink != 1
            or details.st_mode & 0o077
            or details.st_mode & 0o200 == 0
        ):
            raise InvalidInput("output disk must be a private writable regular file")
        if (
            declared_size < OUTPUT_DISK_MIN
            or declared_size > OUTPUT_DISK_MAX
            or declared_size % 512
            or details.st_size != declared_size
        ):
            raise InvalidInput("output disk size outside bounds")
        if os.read(descriptor, 4) == b"QFI\xfb":
            raise InvalidInput("qcow image is not a raw disk")
        return InputFile(path, details.st_size, None, details.st_dev, details.st_ino)
    finally:
        os.close(descriptor)


def all_zero(info: InputFile) -> bool:
    descriptor = os.open(
        info.path,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
    )
    try:
        before = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size) != (
            info.device,
            info.inode,
            info.size,
        ):
            return False
        while block := os.read(descriptor, 1024 * 1024):
            if any(block):
                return False
        after = os.fstat(descriptor)
        return (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ) == (
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
    finally:
        os.close(descriptor)


def digest(info: InputFile) -> str:
    sha = hashlib.sha256()
    fd = os.open(info.path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size) != (info.device, info.inode, info.size):
            raise InvalidInput("input changed during preflight")
        while block := os.read(fd, 1024 * 1024):
            sha.update(block)
        after = os.fstat(fd)
        if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ):
            raise InvalidInput("input changed while hashing")
        return sha.hexdigest()
    finally:
        os.close(fd)


def tool(path: Path, expected: str | None = None) -> None:
    no_symlink_components(path)
    for parent in path.parents:
        st = parent.stat()
        if st.st_uid != 0 or st.st_mode & 0o022:
            raise InvalidInput("tool directory must be root-owned and nonwritable")
    st = path.stat()
    if (
        not stat.S_ISREG(st.st_mode)
        or st.st_uid != 0
        or st.st_mode & 0o6022
        or not st.st_mode & 0o111
    ):
        raise InvalidInput("tool must be root-owned, executable and nonwritable")
    if expected is not None:
        info = InputFile(path, st.st_size, None, st.st_dev, st.st_ino)
        if digest(info) != expected:
            raise InvalidInput("tool SHA256 mismatch")


def trusted_runtime_dir(path: Path) -> None:
    no_symlink_components(path)
    for component in (path, *path.parents):
        st = component.stat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise InvalidInput("untrusted QEMU runtime directory")


def kvm() -> None:
    path = Path("/dev/kvm")
    no_symlink_components(path)
    st = path.stat()
    if (
        not stat.S_ISCHR(st.st_mode)
        or (os.major(st.st_rdev), os.minor(st.st_rdev)) != (10, 232)
        or st.st_uid != 0
        or not os.access(path, os.R_OK | os.W_OK)
    ):
        raise InvalidInput("accessible root-owned /dev/kvm (10:232) character device required")


def library_mounts() -> list[str]:
    args: list[str] = []
    # Support only root-controlled /lib* -> /usr/lib* aliases, never arbitrary host paths.
    for alias in (Path("/lib"), Path("/lib64")):
        if not alias.is_symlink():
            if alias.exists():
                raise InvalidInput("unexpected library directory layout")
            continue
        if alias.lstat().st_uid != 0:
            raise InvalidInput("untrusted library alias")
        target = alias.resolve(strict=True)
        if target != Path("/usr") / alias.name or not target.is_dir():
            raise InvalidInput("unexpected library alias")
        tool_dir = target
        for parent in (tool_dir, *tool_dir.parents):
            st = parent.stat()
            if st.st_uid != 0 or st.st_mode & 0o022:
                raise InvalidInput("untrusted library target")
        args += ["--symlink", f"usr/{alias.name}", str(alias)]
    return args


def sha_arg(value: str) -> str:
    if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise argparse.ArgumentTypeError("expected lowercase SHA256 hex")
    return value


def add_output_input(args: argparse.Namespace, inputs: dict[str, InputFile]) -> None:
    if (args.output_disk is None) != (args.output_disk_size_bytes is None):
        raise InvalidInput("output disk and size must be supplied together")
    if args.output_disk is None or args.output_disk_size_bytes is None:
        return
    output = output_file(absolute_path(args.output_disk), args.output_disk_size_bytes)
    if not all_zero(output):
        raise InvalidInput("output disk must be zero initialized")
    inputs["output"] = output


def verify_root_disk(args: argparse.Namespace, inputs: dict[str, InputFile]) -> None:
    disk = inputs["disk"]
    if disk.size != args.disk_size_bytes or disk.size % 512:
        raise InvalidInput("raw disk must match the declared sector-aligned virtual size")
    if digest(disk) != args.disk_sha256:
        raise InvalidInput("raw disk SHA256 mismatch")
    inputs["disk"] = InputFile(disk.path, disk.size, args.disk_sha256, disk.device, disk.inode)


def verify_isos(args: argparse.Namespace, inputs: dict[str, InputFile]) -> None:
    for name, expected in (("seed", args.seed_sha256), ("assets", args.assets_sha256)):
        if (name in inputs) != (expected is not None):
            raise (
                InvalidInput("assets ISO and hash must be supplied together")
                if name == "assets"
                else InvalidInput("seed hash required")
            )
        if expected is not None:
            info = inputs[name]
            if digest(info) != expected:
                raise InvalidInput("ISO SHA256 mismatch")
            inputs[name] = InputFile(info.path, info.size, expected, info.device, info.inode)


def validate_inputs(args: argparse.Namespace) -> dict[str, InputFile]:
    inputs: dict[str, InputFile] = {}
    for name, value, maximum, writable in (
        ("disk", args.disk, DISK_MAX, True),
        ("seed", args.seed_iso, ISO_MAX, False),
        ("assets", args.assets_iso, ISO_MAX, False),
    ):
        if value is not None:
            inputs[name] = regular_file(absolute_path(value), maximum=maximum, writable=writable)
    add_output_input(args, inputs)
    identities = [(item.device, item.inode) for item in inputs.values()]
    if len(identities) != len(set(identities)):
        raise InvalidInput("disk and ISOs must be distinct")
    verify_root_disk(args, inputs)
    verify_isos(args, inputs)
    return inputs


def runtime_sandbox(qemu: Path, bwrap: Path) -> list[str]:
    """Construct the fixed QEMU runtime; caller files are appended separately."""
    aliases = library_mounts()
    for directory in RUNTIME_DIRS:
        trusted_runtime_dir(directory)
    return [
        str(bwrap),
        "--unshare-all",
        "--unshare-user",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--unsetenv",
        "PWD",
        "--dir",
        "/usr",
        "--dir",
        "/usr/bin",
        "--dir",
        "/usr/lib",
        "--dir",
        "/usr/share",
        "--ro-bind",
        str(qemu),
        str(qemu),
        *(
            item
            for directory in RUNTIME_DIRS
            for item in ("--ro-bind", str(directory), str(directory))
        ),
        *aliases,
        "--proc",
        "/proc",
        "--dir",
        "/dev",
        *(
            item
            for name in PSEUDODEVICES
            for item in ("--dev-bind", f"/dev/{name}", f"/dev/{name}")
        ),
        "--dev-bind",
        "/dev/kvm",
        "/dev/kvm",
    ]


def selected_cpu_ids() -> tuple[int, ...]:
    """Place QEMU and its threads on up to two allowed logical CPUs, not exclusive cores."""
    allowed = sorted(os.sched_getaffinity(0))
    if not allowed:
        raise InvalidInput("empty allowed CPU affinity")
    return tuple(allowed[-2:])  # Prefer the last IDs over the usual first IRQ CPUs.


def build_plan(args: argparse.Namespace) -> Plan:
    if os.geteuid() == 0 or os.getuid() == 0:
        raise InvalidInput("root execution is forbidden")
    if not 1 <= args.timeout <= 1200:
        raise InvalidInput("timeout must be 1..1200 seconds")
    cpu_ids = selected_cpu_ids()
    output = absolute_path(args.output_dir)
    private_dir(output)
    private_dir(Path(f"/run/user/{os.geteuid()}"))
    inputs = validate_inputs(args)
    qemu, bwrap = absolute_path(args.qemu), absolute_path(args.bwrap)
    if qemu != QEMU_BINARY or bwrap != Path("/usr/bin/bwrap"):
        raise InvalidInput("expected fixed root-owned QEMU and bubblewrap paths")
    for path, expected in ((qemu, args.qemu_sha256), (bwrap, args.bwrap_sha256)):
        tool(path, expected)
    tool(SYSTEMD_RUN)
    tool(SYSTEMCTL)
    kvm()
    sandbox = [
        *runtime_sandbox(qemu, bwrap),
        "--dir",
        "/vm",
        "--chdir",
        "/",
        "--bind",
        str(inputs["disk"].path),
        "/vm/root.raw",
        "--ro-bind",
        str(inputs["seed"].path),
        "/vm/seed.iso",
    ]
    if "assets" in inputs:
        sandbox += ["--ro-bind", str(inputs["assets"].path), "/vm/assets.iso"]
    if "output" in inputs:
        sandbox += ["--bind", str(inputs["output"].path), "/vm/output.raw"]
    qemu_args = [
        str(qemu),
        "-nodefaults",
        "-no-user-config",
        "-machine",
        "q35,accel=kvm",
        "-cpu",
        "host,vmx=off,svm=off",
        "-smp",
        "2",
        "-m",
        "2048",
        "-display",
        "none",
        "-vga",
        "none",
        "-nic",
        "none",
        "-monitor",
        "none",
        "-serial",
        "stdio",
        "-no-reboot",
        "-sandbox",
        "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
        "-drive",
        f"id=penny-root,file=/vm/root.raw,format=raw,if=none,bps={DISK_BPS},iops={DISK_IOPS}",
        "-device",
        "virtio-blk-pci,drive=penny-root,serial=penny-root,bootindex=1",
        "-drive",
        f"file=/vm/seed.iso,format=raw,if=virtio,readonly=on,bps={DISK_BPS},iops={DISK_IOPS}",
    ]
    if "assets" in inputs:
        qemu_args += [
            "-drive",
            f"file=/vm/assets.iso,format=raw,if=virtio,readonly=on,bps={DISK_BPS},iops={DISK_IOPS}",
        ]
    if "output" in inputs:
        qemu_args += [
            "-drive",
            f"id=penny-output,file=/vm/output.raw,format=raw,if=none,bps={DISK_BPS},iops={DISK_IOPS}",
            "-device",
            "virtio-blk-pci,drive=penny-output,serial=penny-output,bootindex=100",
        ]
    if re.fullmatch(r"penny-guest-[a-f0-9]{32}\.service", args.unit) is None:
        raise InvalidInput("invalid systemd unit identity")
    unit = args.unit
    argv = [
        str(SYSTEMD_RUN),
        "--user",
        "--wait",
        "--pipe",
        "--collect",
        "--quiet",
        f"--unit={unit}",
        *(f"--property={p.format(seconds=args.timeout)}" for p in PROPERTIES),
        f"--property=CPUAffinity={' '.join(map(str, cpu_ids))}",
        "--",
        *sandbox,
        "--",
        *qemu_args,
    ]
    return Plan(unit, argv, inputs, output, args.timeout, cpu_ids)


def lock(directory: Path) -> int:
    path = directory / ".guest.lock"
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        st = os.fstat(fd)
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_uid != os.geteuid()
            or st.st_nlink != 1
            or st.st_mode & 0o077
        ):
            raise InvalidInput("unsafe singleton lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InvalidInput("concurrent run in output directory") from exc
        return fd
    except BaseException:
        os.close(fd)
        raise


def exclusive_json(path: Path, data: dict[str, object]) -> None:
    payload = (json.dumps(data, indent=2, sort_keys=True) + "\n").encode("utf-8")
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.link(temp, path, follow_symlinks=False)  # Exclusive, atomic publication.
    finally:
        temp.unlink(missing_ok=True)


def inactive(unit: str) -> bool:
    try:
        status = subprocess.run(
            [str(SYSTEMCTL), "--user", "show", "--property=ActiveState", "--value", unit],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
            env=host_env(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return status.returncode == 0 and status.stdout.strip() in (b"inactive", b"failed")


def stop(unit: str) -> bool:
    try:
        stopped = subprocess.run(
            [str(SYSTEMCTL), "--user", "stop", unit],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
            env=host_env(),
        )
        return stopped.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def host_env() -> dict[str, str]:
    # Needed for the user manager bus; never forwarded into the cleared bwrap guest environment.
    runtime = f"/run/user/{os.geteuid()}"
    return {"XDG_RUNTIME_DIR": runtime, "PATH": "/usr/bin", "LANG": "C"}


class Cancellation:
    def __init__(self) -> None:
        self.requested = False

    def cancel(self, _signum: int, _frame: FrameType | None) -> None:
        self.requested = True


def capture(
    process: subprocess.Popen[bytes], log: Path, seconds: int, cancel: Cancellation
) -> tuple[bool, bool, int]:
    """Drain untrusted combined stdio without ever forwarding it to the terminal."""
    assert process.stdout is not None
    count, overflow, timed_out = 0, False, False
    deadline = time.monotonic() + seconds + HOST_WAIT_GRACE
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output, selectors.DefaultSelector() as selector:
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            if cancel.requested or time.monotonic() >= deadline:
                timed_out = not cancel.requested
                break
            for key, _ in selector.select(0.2):
                try:
                    block = os.read(key.fd, 65536)
                except BlockingIOError:
                    continue
                if not block:
                    selector.unregister(key.fileobj)
                    break
                available = LOG_MAX - count
                output.write(block[:available])
                count += min(available, len(block))
                if len(block) > available:
                    overflow = True
                    break
            if overflow:
                break
        output.flush()
        os.fsync(output.fileno())
    return overflow, timed_out, count


def revalidate(plan: Plan) -> None:
    # Revalidate after obtaining the singleton lock and immediately before launch.
    for name in ("seed", "assets"):
        if name in plan.inputs and digest(plan.inputs[name]) != plan.inputs[name].sha256:
            raise InvalidInput("ISO changed since planning")
    disk = plan.inputs["disk"]
    current = regular_file(disk.path, maximum=DISK_MAX, writable=True)
    if (current.device, current.inode, current.size) != (disk.device, disk.inode, disk.size):
        raise InvalidInput("disk changed since planning")
    if digest(disk) != disk.sha256:
        raise InvalidInput("raw disk changed since planning")
    if "output" in plan.inputs:
        output = plan.inputs["output"]
        current_output = output_file(output.path, output.size)
        if (
            current_output.device,
            current_output.inode,
            current_output.size,
        ) != (
            output.device,
            output.inode,
            output.size,
        ) or not all_zero(output):
            raise InvalidInput("output disk changed since planning")


def execute(
    plan: Plan, log_tmp: Path
) -> tuple[subprocess.Popen[bytes] | None, Cancellation, bool, bool, int, bool, bool, bool]:
    cancel = Cancellation()
    previous = {sig: signal.signal(sig, cancel.cancel) for sig in (signal.SIGINT, signal.SIGTERM)}
    process: subprocess.Popen[bytes] | None = None
    overflow, timed_out, count, stop_ok, confirmed = False, False, 0, False, False
    error = False
    try:
        if not cancel.requested:
            process = subprocess.Popen(
                plan.argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=host_env(),
                cwd="/",
                close_fds=True,
            )
            overflow, timed_out, count = capture(process, log_tmp, plan.seconds, cancel)
    except (OSError, InvalidInput):
        error = True
    finally:
        if process is not None:
            if not (overflow or timed_out or cancel.requested or error):
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    error = True
            if overflow or timed_out or cancel.requested or error:
                stop_ok = stop(plan.unit)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()  # Kill the client only; the unit is stopped separately.
                process.wait(timeout=5)
            confirmed = inactive(plan.unit)
            if not confirmed:
                stop_ok = stop(plan.unit) or stop_ok
                confirmed = inactive(plan.unit)
            if process.stdout:
                process.stdout.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return process, cancel, overflow, timed_out, count, stop_ok, confirmed, error


def run(plan: Plan) -> dict[str, object]:
    lock_fd = lock(plan.output_dir)
    try:
        revalidate(plan)
        manifest = plan.output_dir / f"{plan.unit}.command.json"
        log_tmp = plan.output_dir / f".{plan.unit}.serial.tmp"
        log = plan.output_dir / f"{plan.unit}.serial.log"
        result_path = plan.output_dir / f"{plan.unit}.result.json"
        exclusive_json(manifest, plan.manifest())
        started = time.monotonic()
        outcome = execute(plan, log_tmp)
        execution_duration_ms = max(0, round((time.monotonic() - started) * 1000))
        process, cancel, overflow, timed_out, count, stop_ok, confirmed, error = outcome
        if log_tmp.exists():
            os.link(log_tmp, log, follow_symlinks=False)
            log_tmp.unlink()
        preserved = True
        for name in ("seed", "assets"):
            if name in plan.inputs:
                try:
                    preserved = digest(plan.inputs[name]) == plan.inputs[name].sha256 and preserved
                except (OSError, InvalidInput):
                    preserved = False
        rc = process.returncode if process is not None else None
        success = (
            rc == 0
            and not (overflow or timed_out or cancel.requested or error)
            and preserved
            and confirmed
            and count <= LOG_MAX
        )
        result: dict[str, object] = {
            "unit": plan.unit,
            "returncode": rc,
            "success": success,
            "success_scope": "launcher_process_and_supervisor_only",
            "guest_marker_verified": False,
            "reason": (
                "containment_uncertain"
                if not confirmed and process is not None
                else (
                    "ok"
                    if success
                    else (
                        "cancelled"
                        if cancel.requested
                        else (
                            "output_limit"
                            if overflow
                            else (
                                "timeout"
                                if timed_out
                                else (
                                    "launch_error"
                                    if error
                                    else (
                                        "input_changed"
                                        if not preserved
                                        else (
                                            "inactive_unconfirmed"
                                            if not confirmed
                                            else "service_failed"
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            ),
            "log_bytes": count,
            "log_truncated": overflow,
            "execution_duration_ms": execution_duration_ms,
            "confirmed_inactive": confirmed,
            "stop_succeeded": stop_ok,
            "input_hashes_preserved": preserved,
            "input_sha256": {n: i.sha256 for n, i in plan.inputs.items() if i.sha256 is not None},
        }
        exclusive_json(result_path, result)
        return result
    finally:
        os.close(lock_fd)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--disk", required=True)
    p.add_argument("--disk-sha256", type=sha_arg, required=True)
    p.add_argument("--disk-size-bytes", type=int, required=True)
    p.add_argument("--seed-iso", required=True)
    p.add_argument("--seed-sha256", type=sha_arg, required=True)
    p.add_argument("--assets-iso")
    p.add_argument("--assets-sha256", type=sha_arg)
    p.add_argument("--output-disk")
    p.add_argument("--output-disk-size-bytes", type=int)
    p.add_argument("--qemu", required=True)
    p.add_argument("--qemu-sha256", type=sha_arg, required=True)
    p.add_argument("--bwrap", required=True)
    p.add_argument("--bwrap-sha256", type=sha_arg, required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--unit", required=True)
    p.add_argument("--timeout", type=int, default=1200)
    p.add_argument("--dry-run", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        plan = build_plan(args)
        if args.dry_run:
            print(json.dumps(plan.manifest(), indent=2, sort_keys=True))
            return 0
        result = run(plan)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["success"] else 1
    except InvalidInput as exc:
        reason = str(exc)
        if reason not in SAFE_INVALID_INPUT_REASONS:
            reason = "invalid input"
        print(f"launcher refused: {reason}", file=sys.stderr)
        return 1
    except OSError:
        print("launcher refused: operating system error", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
