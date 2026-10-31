"""No test executes QEMU, bubblewrap, systemd or a real VM."""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Protocol, runtime_checkable

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "run_guest.py"
SPEC = importlib.util.spec_from_file_location("run_guest", SOURCE)
assert SPEC and SPEC.loader
launcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = launcher
SPEC.loader.exec_module(launcher)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def fixture(tmp_path: Path) -> tuple[Path, list[str]]:
    tmp_path.chmod(0o700)
    disk, seed = tmp_path / "disk.raw", tmp_path / "seed.iso"
    disk.write_bytes(b"raw boot disk".ljust(512, b"\0"))
    disk.chmod(0o600)
    seed.write_bytes(b"seed bytes")
    seed.chmod(0o400)
    args = [
        "--disk",
        str(disk),
        "--disk-sha256",
        sha(disk),
        "--disk-size-bytes",
        str(disk.stat().st_size),
        "--seed-iso",
        str(seed),
        "--seed-sha256",
        sha(seed),
        "--qemu",
        "/usr/bin/qemu-system-x86_64",
        "--qemu-sha256",
        sha(Path("/usr/bin/qemu-system-x86_64")),
        "--bwrap",
        "/usr/bin/bwrap",
        "--bwrap-sha256",
        sha(Path("/usr/bin/bwrap")),
        "--output-dir",
        str(tmp_path),
        "--unit",
        "penny-guest-0123456789abcdef0123456789abcdef.service",
        "--timeout",
        "1",
    ]
    return tmp_path, args


@runtime_checkable
class PlanView(Protocol):
    unit: str
    argv: list[str]
    cpu_ids: tuple[int, ...]

    def manifest(self) -> dict[str, object]: ...


class CancellationView(Protocol):
    requested: bool


def plan(args: list[str]) -> PlanView:
    built: object = launcher.build_plan(launcher.parser().parse_args(args))
    assert isinstance(built, PlanView)
    return built


def test_confinement_and_read_only_plan(
    fixture: tuple[Path, list[str]],
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory, args = fixture
    monkeypatch.setattr(launcher.os, "sched_getaffinity", lambda _pid: {1, 3, 8, 12})
    assert launcher.main(args + ["--dry-run"]) == 0
    assert set(directory.iterdir()) == {directory / "disk.raw", directory / "seed.iso"}
    output = capsys.readouterr().out
    assert '"argv"' in output and "--unshare-all" in output
    built = plan(args)
    argv = built.argv
    assert argv[:5] == [str(launcher.SYSTEMD_RUN), "--user", "--wait", "--pipe", "--collect"]
    for required in (
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--dev-bind",
        "/dev/kvm",
        "--proc",
        "--ro-bind",
        "--bind",
        "-nodefaults",
        "-nic",
        "none",
        "-sandbox",
    ):
        assert required in argv
    assert "docker" not in " ".join(argv)
    assert argv[argv.index("-cpu") + 1] == "host,vmx=off,svm=off"
    assert "--ro-bind" in argv and argv[argv.index("--bind") + 1] == str(directory / "disk.raw")
    assert argv.count("-drive") == 2
    for drive in (argv[i + 1] for i, part in enumerate(argv) if part == "-drive"):
        assert drive.endswith("bps=16777216,iops=512")
        assert "format=raw" in drive
    assert "file=/vm/seed.iso,format=raw,if=virtio,readonly=on," in " ".join(argv)
    assert "id=penny-root,file=/vm/root.raw,format=raw,if=none," in " ".join(argv)
    assert "virtio-blk-pci,drive=penny-root,serial=penny-root,bootindex=1" in argv
    assert "--tmpfs" not in argv and "--dev" not in argv
    assert "/dev/tty" not in argv and "/usr" not in [
        argv[i + 1] for i, x in enumerate(argv[:-1]) if x == "--ro-bind"
    ]
    sources = [argv[i + 1] for i, x in enumerate(argv[:-2]) if x == "--ro-bind"]
    assert set(sources) == {
        str(directory / "seed.iso"),
        str(launcher.QEMU_BINARY),
        *(str(p) for p in launcher.RUNTIME_DIRS),
    }
    device_sources = {argv[i + 1] for i, x in enumerate(argv[:-2]) if x == "--dev-bind"}
    assert device_sources == {"/dev/kvm", *(f"/dev/{name}" for name in launcher.PSEUDODEVICES)}
    assert "--new-session" in argv and "/etc/ld.so.cache" not in argv
    manifest = built.manifest()
    assert manifest["virtual_disk_bytes"] == (directory / "disk.raw").stat().st_size
    inputs = manifest["inputs"]
    assert isinstance(inputs, dict)
    disk = inputs["disk"]
    assert isinstance(disk, dict)
    assert disk["sha256"] == sha(directory / "disk.raw")
    assert manifest["cpu_ids"] == [8, 12]
    assert "--property=CPUAffinity=8 12" in argv
    assert all(f"--property={p.format(seconds=1)}" in argv for p in launcher.PROPERTIES)


@pytest.mark.parametrize(
    ("allowed", "chosen"),
    [({7, 0, 2, 19}, (7, 19)), ({5}, (5,))],
)
def test_affinity_selection(
    fixture: tuple[Path, list[str]],
    monkeypatch: pytest.MonkeyPatch,
    allowed: set[int],
    chosen: tuple[int, ...],
) -> None:
    monkeypatch.setattr(
        launcher.os, "sched_getaffinity", lambda pid: allowed if pid == 0 else set()
    )
    assert launcher.selected_cpu_ids() == chosen
    built = plan(fixture[1])
    assert built.cpu_ids == chosen
    assert built.argv.count(f"--property=CPUAffinity={' '.join(map(str, chosen))}") == 1


def test_empty_affinity_fails_before_launch(
    fixture: tuple[Path, list[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(launcher.os, "sched_getaffinity", lambda _pid: set())
    with pytest.raises(launcher.InvalidInput, match="empty allowed CPU affinity"):
        plan(fixture[1])


@pytest.mark.parametrize(
    ("major", "minor", "accepted"), [(10, 231, False), (1, 3, False), (10, 232, True)]
)
def test_kvm_requires_exact_device_number(
    monkeypatch: pytest.MonkeyPatch, major: int, minor: int, accepted: bool
) -> None:
    original_stat = Path.stat

    def fake_stat(path: Path, *, follow_symlinks: bool = True) -> os.stat_result | SimpleNamespace:
        if path == Path("/dev/kvm") and follow_symlinks:
            return SimpleNamespace(st_mode=stat.S_IFCHR, st_uid=0, st_rdev=os.makedev(major, minor))
        return original_stat(path, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(Path, "stat", fake_stat)
    monkeypatch.setattr(launcher.os, "access", lambda _path, _mode: True)
    if accepted:
        launcher.kvm()
    else:
        with pytest.raises(launcher.InvalidInput, match="10:232"):
            launcher.kvm()


def test_only_fixed_input_reasons_are_displayed(
    fixture: tuple[Path, list[str]],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def reject(_args: object) -> None:
        raise launcher.InvalidInput("raw disk SHA256 mismatch")

    monkeypatch.setattr(launcher, "build_plan", reject)
    assert launcher.main(fixture[1]) == 1
    assert capsys.readouterr().err.strip() == "launcher refused: raw disk SHA256 mismatch"

    def unsafe(_args: object) -> None:
        raise launcher.InvalidInput("/private/disk SECRET")

    monkeypatch.setattr(launcher, "build_plan", unsafe)
    assert launcher.main(fixture[1]) == 1
    assert capsys.readouterr().err.strip() == "launcher refused: invalid input"

    def os_error(_args: object) -> None:
        raise OSError("/private/disk SECRET")

    monkeypatch.setattr(launcher, "build_plan", os_error)
    assert launcher.main(fixture[1]) == 1
    assert capsys.readouterr().err.strip() == "launcher refused: operating system error"


def test_invalid_input_reasons_are_literal_and_allowlisted() -> None:
    tree = ast.parse(SOURCE.read_text())
    reasons = [
        call.args[0]
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "InvalidInput"
    ]
    assert reasons and all(isinstance(reason, ast.Constant) for reason in reasons)
    assert {
        reason.value for reason in reasons if isinstance(reason, ast.Constant)
    } == launcher.SAFE_INVALID_INPUT_REASONS


def test_assets_optional_and_confined(fixture: tuple[Path, list[str]]) -> None:
    directory, args = fixture
    assets = directory / "assets.iso"
    assets.write_bytes(b"assets")
    assets.chmod(0o400)
    built = plan(args + ["--assets-iso", str(assets), "--assets-sha256", sha(assets)])
    assert built.argv.count("-drive") == 3
    assert (
        "file=/vm/assets.iso,format=raw,if=virtio,readonly=on,bps=16777216,iops=512" in built.argv
    )


def test_output_disk_is_separate_bounded_virtio_device(
    fixture: tuple[Path, list[str]],
) -> None:
    directory, args = fixture
    output = directory / "output.raw"
    with output.open("wb") as stream:
        stream.truncate(launcher.OUTPUT_DISK_MIN)
    output.chmod(0o600)
    built = plan(
        args
        + [
            "--output-disk",
            str(output),
            "--output-disk-size-bytes",
            str(launcher.OUTPUT_DISK_MIN),
        ]
    )
    assert built.argv.count("-drive") == 3
    assert built.argv.count("-device") == 2
    assert (
        "id=penny-output,file=/vm/output.raw,format=raw,if=none,bps=16777216,iops=512" in built.argv
    )
    assert "virtio-blk-pci,drive=penny-output,serial=penny-output,bootindex=100" in built.argv
    bind_sources = [
        built.argv[index + 1] for index, value in enumerate(built.argv[:-2]) if value == "--bind"
    ]
    assert bind_sources == [str(directory / "disk.raw"), str(output)]
    inputs = built.manifest()["inputs"]
    assert isinstance(inputs, dict)
    assert inputs["output"] == {
        "path": str(output),
        "size": launcher.OUTPUT_DISK_MIN,
        "sha256": None,
    }


@pytest.mark.parametrize("variant", ["missing_size", "nonzero", "too_small", "world_readable"])
def test_rejects_invalid_output_disk(fixture: tuple[Path, list[str]], variant: str) -> None:
    directory, args = fixture
    output = directory / "output.raw"
    size = launcher.OUTPUT_DISK_MIN
    with output.open("wb") as stream:
        stream.truncate(size)
    output.chmod(0o600)
    extra = ["--output-disk", str(output), "--output-disk-size-bytes", str(size)]
    if variant == "missing_size":
        extra = extra[:2]
    elif variant == "nonzero":
        with output.open("r+b") as stream:
            stream.write(b"x")
    elif variant == "too_small":
        size = launcher.OUTPUT_DISK_MIN - 512
        with output.open("r+b") as stream:
            stream.truncate(size)
        extra[-1] = str(size)
    elif variant == "world_readable":
        output.chmod(0o644)
    with pytest.raises(launcher.InvalidInput):
        plan(args + extra)


def test_output_disk_revalidated_immediately_before_launch(
    fixture: tuple[Path, list[str]],
) -> None:
    directory, args = fixture
    output = directory / "output.raw"
    with output.open("wb") as stream:
        stream.truncate(launcher.OUTPUT_DISK_MIN)
    output.chmod(0o600)
    built = plan(
        args
        + [
            "--output-disk",
            str(output),
            "--output-disk-size-bytes",
            str(launcher.OUTPUT_DISK_MIN),
        ]
    )
    with output.open("r+b") as stream:
        stream.write(b"changed")
    with pytest.raises(launcher.InvalidInput, match="output disk changed"):
        launcher.revalidate(built)


def test_rejects_root(fixture: tuple[Path, list[str]], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(launcher.os, "geteuid", lambda: 0)
    with pytest.raises(launcher.InvalidInput, match="root"):
        plan(fixture[1])


@pytest.mark.parametrize(
    "variant",
    [
        "relative",
        "symlink",
        "hardlink",
        "oversize",
        "mutable_iso",
        "bad_hash",
        "escape",
        "world_dir",
        "same_file",
    ],
)
def test_rejects_special_inputs(fixture: tuple[Path, list[str]], variant: str) -> None:
    directory, args = fixture
    seed = directory / "seed.iso"
    if variant == "relative":
        args[args.index("--disk") + 1] = "disk.raw"
    elif variant == "symlink":
        link = directory / "alias.iso"
        link.symlink_to(seed)
        args[args.index("--seed-iso") + 1] = str(link)
    elif variant == "hardlink":
        os.link(seed, directory / "hard.iso")
    elif variant == "oversize":
        with (directory / "disk.raw").open("r+b") as output:
            output.truncate(launcher.DISK_MAX + 1)
    elif variant == "mutable_iso":
        seed.chmod(0o600)
    elif variant == "bad_hash":
        args[args.index("--seed-sha256") + 1] = "0" * 64
    elif variant == "escape":
        args[args.index("--disk") + 1] = str(directory) + "/../" + directory.name + "/disk.raw"
    elif variant == "world_dir":
        directory.chmod(0o755)
    elif variant == "same_file":
        args[args.index("--seed-iso") + 1] = str(directory / "disk.raw")
    with pytest.raises(launcher.InvalidInput):
        plan(args)


@pytest.mark.parametrize(
    "variant", ["qcow_magic", "wrong_disk_hash", "wrong_disk_size", "unaligned_disk_size"]
)
def test_rejects_invalid_raw_disk(fixture: tuple[Path, list[str]], variant: str) -> None:
    directory, args = fixture
    disk = directory / "disk.raw"
    if variant == "qcow_magic":
        disk.write_bytes(b"QFI\xfb" + b"x" * 508)
        args[args.index("--disk-sha256") + 1] = sha(disk)
    elif variant == "wrong_disk_hash":
        args[args.index("--disk-sha256") + 1] = "0" * 64
    elif variant == "wrong_disk_size":
        args[args.index("--disk-size-bytes") + 1] = "1024"
    elif variant == "unaligned_disk_size":
        disk.write_bytes(b"raw" * 171)
        args[args.index("--disk-size-bytes") + 1] = "513"
        args[args.index("--disk-sha256") + 1] = sha(disk)
    with pytest.raises(launcher.InvalidInput):
        plan(args)


def test_tool_identity_and_lock(fixture: tuple[Path, list[str]]) -> None:
    directory, args = fixture
    args[args.index("--qemu-sha256") + 1] = "0" * 64
    with pytest.raises(launcher.InvalidInput, match="SHA256"):
        plan(args)
    fd = launcher.lock(directory)
    try:
        with pytest.raises(launcher.InvalidInput, match="concurrent"):
            launcher.lock(directory)
    finally:
        os.close(fd)
    assert stat.S_IMODE((directory / ".guest.lock").stat().st_mode) == 0o600


@pytest.mark.parametrize(
    "flag", ["--disk", "--seed-iso", "--qemu", "--bwrap", "--output-dir", "--assets-iso"]
)
def test_rejects_dollar_in_every_caller_path(fixture: tuple[Path, list[str]], flag: str) -> None:
    _, base = fixture
    args = base.copy()
    if flag == "--assets-iso":
        args += ["--assets-iso", "/private/$ASSETS.iso", "--assets-sha256", "0" * 64]
    else:
        args[args.index(flag) + 1] = "/private/$INJECTED"
    with pytest.raises(launcher.InvalidInput, match="path characters"):
        plan(args)


def test_revalidation_rejects_disk_mutation(fixture: tuple[Path, list[str]]) -> None:
    directory, args = fixture
    built = plan(args)
    (directory / "disk.raw").write_bytes(b"different disk".ljust(512, b"\0"))
    with pytest.raises(launcher.InvalidInput, match="raw disk changed"):
        launcher.revalidate(built)


def test_unconfirmed_unit_is_containment_uncertain(
    fixture: tuple[Path, list[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    directory, args = fixture
    built = plan(args)

    class Client:
        returncode = 0

    monkeypatch.setattr(
        launcher,
        "execute",
        lambda _plan, _log: (
            Client(),
            launcher.Cancellation(),
            False,
            False,
            0,
            False,
            False,
            False,
        ),
    )
    result = launcher.run(built)
    assert result["success"] is False
    assert result["reason"] == "containment_uncertain"
    assert result["confirmed_inactive"] is False
    assert result["stop_succeeded"] is False
    assert (directory / f"{built.unit}.result.json").exists()


def mocked_manager(directory: Path, monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    state = directory / "state"
    runner = directory / "mock-run"
    ctl = directory / "mock-ctl"
    runner.write_text(
        "#!/usr/bin/python3\nimport sys,time\nfrom pathlib import Path\n"
        f"state=Path({str(state)!r})\n"
        f"mode={mode!r}\n"
        "if mode == 'noise':\n sys.stdout.buffer.write(b'guest SECRET\\n' * 200); sys.stdout.flush()\n"
        "if mode in ('hang', 'noise'):\n"
        " while not state.exists(): time.sleep(.02)\n"
        "else: state.write_text('done')\n"
        "sys.exit(0 if mode == 'ok' else 1)\n"
    )
    ctl.write_text(
        "#!/usr/bin/python3\nimport sys\nfrom pathlib import Path\n"
        f"state=Path({str(state)!r})\n"
        "if 'stop' in sys.argv: state.write_text(sys.argv[-1])\n"
        "elif 'show' in sys.argv: print('inactive' if state.exists() else 'active')\n"
    )
    runner.chmod(0o700)
    ctl.chmod(0o700)
    monkeypatch.setattr(launcher, "SYSTEMCTL", ctl)
    # Tests replace the command transport, not the confinement argv builder or host tools.
    monkeypatch.setattr(launcher, "SYSTEMD_RUN", runner)


def test_bounded_log_and_sanitized_result(
    fixture: tuple[Path, list[str]],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    directory, args = fixture
    built = plan(args)
    mocked_manager(directory, monkeypatch, "noise")
    monkeypatch.setattr(launcher, "LOG_MAX", 100)
    # Built plan retains the complete sandbox command; only the transport is replaced by the mock.
    built.argv[:] = [str(launcher.SYSTEMD_RUN), *built.argv[1:]]
    result = launcher.run(built)
    assert result["success"] is False and result["reason"] == "output_limit"
    assert result["log_bytes"] == 100 and result["confirmed_inactive"]
    assert len((directory / f"{built.unit}.serial.log").read_bytes()) == 100
    assert stat.S_IMODE((directory / f"{built.unit}.serial.log").stat().st_mode) == 0o600
    assert "SECRET" not in capsys.readouterr().out
    assert (directory / "state").read_text() == built.unit
    assert (directory / f"{built.unit}.result.json").exists()


def test_timeout_and_cancel_stop_exact_unit(
    fixture: tuple[Path, list[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    directory, args = fixture
    second_args = list(args)
    second_args[second_args.index("--unit") + 1] = (
        "penny-guest-1123456789abcdef0123456789abcdef.service"
    )
    built_plans = [plan(args), plan(second_args)]
    mocked_manager(directory, monkeypatch, "hang")
    monkeypatch.setattr(launcher, "HOST_WAIT_GRACE", 0)
    for cancelled, built in zip((False, True), built_plans, strict=True):
        (directory / "state").unlink(missing_ok=True)
        built.argv[:] = [str(launcher.SYSTEMD_RUN), *built.argv[1:]]
        if cancelled:
            original_capture: Callable[
                [subprocess.Popen[bytes], Path, int, CancellationView], tuple[bool, bool, int]
            ] = launcher.capture

            def cancel_after_spawn(
                process: subprocess.Popen[bytes], log: Path, seconds: int, cancel: CancellationView
            ) -> tuple[bool, bool, int]:
                cancel.requested = True
                return original_capture(process, log, seconds, cancel)

            monkeypatch.setattr(launcher, "capture", cancel_after_spawn)
        result = launcher.run(built)
        assert result["reason"] == ("cancelled" if cancelled else "timeout")
        assert result["confirmed_inactive"] and not result["success"]
        assert (directory / "state").read_text() == built.unit


def test_nonzero_service_exit_is_not_guest_script_verdict(
    fixture: tuple[Path, list[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    directory, args = fixture
    built = plan(args)
    mocked_manager(directory, monkeypatch, "fail")
    built.argv[:] = [str(launcher.SYSTEMD_RUN), *built.argv[1:]]
    result = launcher.run(built)
    assert result["returncode"] == 1
    assert result["success"] is False
    assert result["reason"] == "service_failed"
    assert result["guest_marker_verified"] is False


def test_success_requires_preserved_hashes(
    fixture: tuple[Path, list[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    directory, args = fixture
    second_args = list(args)
    second_args[second_args.index("--unit") + 1] = (
        "penny-guest-1123456789abcdef0123456789abcdef.service"
    )
    built_plans = [plan(args), plan(second_args)]
    mocked_manager(directory, monkeypatch, "ok")
    for changed, built in zip((False, True), built_plans, strict=True):
        (directory / "state").unlink(missing_ok=True)
        built.argv[:] = [str(launcher.SYSTEMD_RUN), *built.argv[1:]]
        if changed:
            original_capture: Callable[
                [subprocess.Popen[bytes], Path, int, CancellationView], tuple[bool, bool, int]
            ] = launcher.capture

            def alter_input_after_exit(
                process: subprocess.Popen[bytes], log: Path, seconds: int, cancel: CancellationView
            ) -> tuple[bool, bool, int]:
                outcome = original_capture(process, log, seconds, cancel)
                iso = directory / "seed.iso"
                iso.chmod(0o600)
                iso.write_bytes(b"different seed")
                iso.chmod(0o400)
                return outcome

            monkeypatch.setattr(launcher, "capture", alter_input_after_exit)
        result = launcher.run(built)
        assert result["success"] is (not changed)
        assert result["reason"] == ("input_changed" if changed else "ok")
        assert result["success_scope"] == "launcher_process_and_supervisor_only"
        assert result["guest_marker_verified"] is False
        assert result["confirmed_inactive"]
        assert result["input_hashes_preserved"] is (not changed)
        assert result["log_truncated"] is False
