"""Host bridge unit tests; no test launches QEMU, systemd, or a VM."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "run_job.py"
SPEC = importlib.util.spec_from_file_location("run_job", SOURCE)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700)
    path.chmod(0o700)


def test_job_tree_accepts_shared_unicode_canonical_json(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    job = tmp_path / "job"
    private_directory(job)
    document = {
        "limits": {"max_output_bytes": 1024, "max_result_items": 1},
        "operation": "source_query",
        "payload": {"query": "λ"},
        "schema_id": "penny.sca-vm-job.v1",
        "schema_version": 1,
    }
    encoded = json.dumps(
        document,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    (job / "job.json").write_bytes(encoded)
    (job / "job.json").chmod(0o600)
    actual, digest = runner.verify_job_tree(job)
    assert actual == encoded
    assert len(digest) == 64


def test_job_tree_rejects_ascii_escaped_unicode_variant(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    job = tmp_path / "job"
    private_directory(job)
    document = {"operation": "source_query", "payload": "λ"}
    (job / "job.json").write_text(json.dumps(document, sort_keys=True, separators=(",", ":")))
    (job / "job.json").chmod(0o600)
    with pytest.raises(runner.JobRunnerError, match="not canonical"):
        runner.verify_job_tree(job)


def test_atomic_private_file_never_replaces_existing_target(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    target = tmp_path / "result.json"
    target.write_bytes(b"original")
    target.chmod(0o600)
    with pytest.raises(FileExistsError):
        runner.atomic_private_file(target, b"replacement")
    assert target.read_bytes() == b"original"
    assert not list(tmp_path.glob(".result.json.tmp-*"))


def test_bounded_command_stops_during_output_overflow() -> None:
    with pytest.raises(runner.JobRunnerError, match="output exceeded"):
        runner.bounded_command(
            [
                sys.executable,
                "-c",
                f"import os; os.write(1, b'x' * {runner.MAX_CONTROL_BYTES + 1})",
            ],
            10,
        )
    assert runner._active_child is None


def test_output_disk_size_is_aligned_and_bounded() -> None:
    value = runner.aligned_output_size(1)
    assert value >= 2 * 1024 * 1024
    assert value % runner.ALIGNMENT == 0
    with pytest.raises(runner.JobRunnerError):
        runner.aligned_output_size(runner.MAX_OUTPUT_DISK_BYTES)


def test_global_lock_serializes_distinct_job_directories(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    lock = tmp_path / ".vm-global.lock"
    lock.write_bytes(b"")
    lock.chmod(0o600)
    first = runner.acquire_global_lock(lock)
    try:
        with pytest.raises(runner.JobRunnerError, match="another SCA VM job is active"):
            runner.acquire_global_lock(lock)
    finally:
        runner.write_global_lock_state(first, b"")
        os.close(first)
    second = runner.acquire_global_lock(lock)
    runner.write_global_lock_state(second, b"")
    os.close(second)


def test_abrupt_owner_death_leaves_durable_admission_poison(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    lock = tmp_path / ".vm-global.lock"
    lock.write_bytes(b"")
    lock.chmod(0o600)
    descriptor = runner.acquire_global_lock(lock)
    os.close(descriptor)  # Simulate process death before safe-finally cleanup.
    assert lock.read_bytes() == b"run-pending\n"
    with pytest.raises(runner.JobRunnerError, match="global lock file is unsafe"):
        runner.acquire_global_lock(lock)


def test_failed_unit_stop_is_not_treated_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(["systemctl"], 20)

    monkeypatch.setattr(runner.subprocess, "run", timeout)
    assert (
        runner.stop_and_prove_inactive(
            Path("/usr/bin/systemctl"),
            "penny-guest-" + "a" * 32 + ".service",
            was_observed=True,
        )
        is False
    )


def test_missing_unit_requires_prior_positive_observation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runner.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, b"", b""),
    )
    monkeypatch.setattr(runner, "systemd_state", lambda *_args: "not-found")
    unit = "penny-guest-" + "a" * 32 + ".service"
    assert (
        runner.stop_and_prove_inactive(Path("/usr/bin/systemctl"), unit, was_observed=False)
        is False
    )
    assert (
        runner.stop_and_prove_inactive(Path("/usr/bin/systemctl"), unit, was_observed=True) is True
    )


def test_unproved_containment_retains_vm_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tmp_path.chmod(0o700)
    job, output = tmp_path / "job", tmp_path / "runs"
    private_directory(job)
    private_directory(output)
    document = {
        "limits": {"max_output_bytes": 1024, "max_result_items": 1},
        "operation": "health",
        "payload": {},
        "schema_id": "penny.sca-vm-job.v1",
        "schema_version": 1,
    }
    (job / "job.json").write_bytes(
        json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    )
    (job / "job.json").chmod(0o600)
    lock = tmp_path / ".vm-global.lock"
    lock.write_bytes(b"")
    lock.chmod(0o600)
    template = tmp_path / "template.raw"
    template.write_bytes(b"x" * (64 * 1024))
    template.chmod(0o400)
    tools = []
    for name in ("launcher", "python", "genisoimage", "cp", "qemu", "bwrap", "systemctl"):
        tool = tmp_path / name
        tool.write_bytes(b"tool")
        tool.chmod(0o700)
        tools.append(tool)
    digests = {tool.name: hashlib.sha256(tool.read_bytes()).hexdigest() for tool in tools}

    def fake_command(
        argv: list[str],
        _timeout: int,
        activity_probe: object = None,
        activity_started: object = None,
    ) -> bytes:
        del activity_probe, activity_started
        if "-o" in argv:
            target = Path(argv[argv.index("-o") + 1])
            target.write_bytes(b"iso")
            return b""
        if argv[0] == str(tmp_path / "cp"):
            shutil.copyfile(argv[-2], argv[-1])
            return b""
        raise KeyboardInterrupt

    monkeypatch.setattr(runner, "bounded_command", fake_command)
    monkeypatch.setattr(runner, "stop_and_prove_inactive", lambda *_args, **_kwargs: False)
    argv = [
        "run_job.py",
        "--job-dir",
        str(job),
        "--output-parent",
        str(output),
        "--template",
        str(template),
        "--template-sha256",
        hashlib.sha256(template.read_bytes()).hexdigest(),
        "--template-size-bytes",
        str(template.stat().st_size),
        "--lock-file",
        str(lock),
        "--max-output-bytes",
        "1024",
        "--timeout",
        "60",
    ]
    for name in ("launcher", "python", "genisoimage", "copy", "qemu", "bwrap", "systemctl"):
        file_name = "cp" if name == "copy" else name
        argv += [f"--{name}", str(tmp_path / file_name), f"--{name}-sha256", digests[file_name]]
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(KeyboardInterrupt):
        runner.main()
    runs = list(output.iterdir())
    assert len(runs) == 1
    assert (runs[0] / "root.raw").exists()
    assert (runs[0] / "output.raw").exists()
    assert lock.read_bytes() == b"containment-unproved\n"
    with pytest.raises(runner.JobRunnerError, match="global lock file is unsafe"):
        runner.acquire_global_lock(lock)
