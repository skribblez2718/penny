from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).parents[3]
MASTER_SETUP = PROJECT_ROOT / "scripts" / "setup" / "setup.sh"
EXTERNAL_TOOLS_SETUP = PROJECT_ROOT / "scripts" / "setup" / "init-external-tools.sh"
MEMORY_SETUP = PROJECT_ROOT / "scripts" / "setup" / "init-memory.sh"
MAKEFILE = PROJECT_ROOT / "Makefile"


def _write_init(path: Path, marker: Path, exit_code: int) -> None:
    path.write_text(
        "#!/bin/bash\n"
        f'printf \'%s\\n\' "$(basename "$0")" >> {shlex.quote(str(marker))}\n'
        f"exit {exit_code}\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_master_setup_runs_all_children_but_exits_nonzero_on_failure(
    tmp_path: Path,
) -> None:
    setup_dir = tmp_path / "scripts" / "setup"
    setup_dir.mkdir(parents=True)
    shutil.copy2(MASTER_SETUP, setup_dir / "setup.sh")
    marker = tmp_path / "calls.txt"
    _write_init(setup_dir / "init-a.sh", marker, 0)
    _write_init(setup_dir / "init-b.sh", marker, 7)
    _write_init(setup_dir / "init-c.sh", marker, 0)

    completed = subprocess.run(
        ["bash", str(setup_dir / "setup.sh")],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert marker.read_text(encoding="utf-8").splitlines() == [
        "init-a.sh",
        "init-b.sh",
        "init-c.sh",
    ]
    assert "Completed: 2 / 3" in completed.stdout


def test_master_setup_exits_zero_when_all_children_pass(tmp_path: Path) -> None:
    setup_dir = tmp_path / "scripts" / "setup"
    setup_dir.mkdir(parents=True)
    shutil.copy2(MASTER_SETUP, setup_dir / "setup.sh")
    marker = tmp_path / "calls.txt"
    _write_init(setup_dir / "init-a.sh", marker, 0)
    _write_init(setup_dir / "init-b.sh", marker, 0)

    completed = subprocess.run(
        ["bash", str(setup_dir / "setup.sh")],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert "Completed: 2 / 2" in completed.stdout


def test_memory_setup_no_args_is_non_destructive_and_explicit(tmp_path: Path) -> None:
    setup_dir = tmp_path / "scripts" / "setup"
    setup_dir.mkdir(parents=True)
    script = setup_dir / "init-memory.sh"
    shutil.copy2(MEMORY_SETUP, script)

    completed = subprocess.run(
        ["bash", str(script)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert "explicit and non-destructive" in completed.stdout
    assert not (tmp_path / ".mempalace").exists()


def test_memory_setup_delegates_only_to_supervised_hub_command(tmp_path: Path) -> None:
    setup_dir = tmp_path / "scripts" / "setup"
    setup_dir.mkdir(parents=True)
    script = setup_dir / "init-memory.sh"
    shutil.copy2(MEMORY_SETUP, script)
    python = tmp_path / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    marker = tmp_path / "python-args.txt"
    python.write_text(
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(marker)) + "\n",
        encoding="utf-8",
    )
    python.chmod(0o755)
    config = tmp_path / "hub.json"
    config.write_text("{}", encoding="utf-8")

    completed = subprocess.run(
        ["bash", str(script), "status", "--config", str(config)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert marker.read_text(encoding="utf-8").splitlines() == [
        "-m",
        "scripts.system.memory.hub_service",
        "status",
        "--config",
        str(config),
    ]
    assert not (tmp_path / ".mempalace").exists()


def test_clean_target_preserves_memory_data() -> None:
    source = MAKEFILE.read_text(encoding="utf-8")
    clean = source.split("\nclean:\n", maxsplit=1)[1].split("\n\n", maxsplit=1)[0]
    assert ".mempalace" not in clean
    assert "memory data was preserved" in clean


def _copy_external_tools_setup(tmp_path: Path) -> Path:
    setup_dir = tmp_path / "scripts" / "setup"
    setup_dir.mkdir(parents=True)
    script = setup_dir / "init-external-tools.sh"
    shutil.copy2(EXTERNAL_TOOLS_SETUP, script)
    (tmp_path / ".venv").mkdir()
    return script


def test_external_tools_setup_returns_nonzero_when_bun_is_missing(
    tmp_path: Path,
) -> None:
    script = _copy_external_tools_setup(tmp_path)
    environment = os.environ.copy()
    # Bun is installed under the operator's user path, not /usr/bin. Restricting
    # PATH produces a deterministic preflight failure without attempting installs.
    environment["PATH"] = "/usr/bin:/bin"

    completed = subprocess.run(
        ["bash", str(script)],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert "Some external dependencies failed to provision" in completed.stdout
