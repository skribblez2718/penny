"""Exercise actual gate discovery without importing runtime or generated Python."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
from typing import Literal

import pytest

ROOT = Path(__file__).resolve().parents[4]
Gate = Literal["flake8", "black", "mypy"]
GATES: tuple[Gate, ...] = ("flake8", "black", "mypy")
VALID_SOURCE = "def identity(value: int) -> int:\n    return value\n"


@pytest.fixture
def gate_project(tmp_path: Path) -> Path:
    # No Git index: discovery must include new source before it is staged.
    for name in (".flake8", "pyproject.toml"):
        shutil.copyfile(ROOT / name, tmp_path / name)
    return tmp_path


def write_source(root: Path, relative: str, content: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def run_gate(root: Path, gate: Gate) -> subprocess.CompletedProcess[str]:
    options = {
        "flake8": ["--config", ".flake8"],
        "black": ["--check", "--config", "pyproject.toml"],
        "mypy": ["--config-file", "pyproject.toml", "--cache-dir", str(root / ".mypy_cache")],
    }
    return subprocess.run(
        [sys.executable, "-m", gate, ".", *options[gate]],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize("gate", GATES)
def test_gates_ignore_runtime_generated_and_private_trees(gate_project: Path, gate: Gate) -> None:
    write_source(gate_project, "apps/service/source.py", VALID_SOURCE)
    for directory in (
        ".penny/runtime",
        ".mempalace",
        "apps/service/build",
        "apps/service/dist",
        "apps/service/out",
        "apps/service/_build",
        "apps/service/buck-out",
        "plans",
        "research",
        "evals",
    ):
        # Identical module names also detect mypy traversing source and build copies.
        write_source(gate_project, f"{directory}/source.py", "this is not valid Python!\n")
    result = run_gate(gate_project, gate)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("gate", GATES)
@pytest.mark.parametrize("directory", ["apps/service", "apps/distribution/plans_module"])
def test_gates_check_unstaged_source_and_do_not_overexclude(
    gate_project: Path, gate: Gate, directory: str
) -> None:
    bad_source = {
        "flake8": "import os\n",  # Unused import.
        "black": "value=1\n",
        "mypy": 'value: int = "not an int"\n',
    }
    write_source(gate_project, f"{directory}/new_source.py", bad_source[gate])
    result = run_gate(gate_project, gate)
    assert result.returncode != 0, "gate silently omitted newly created source"
    assert "new_source.py" in result.stdout + result.stderr


def test_mypy_preserves_the_existing_test_exclusion_policy(gate_project: Path) -> None:
    write_source(gate_project, "apps/service/source.py", VALID_SOURCE)
    write_source(gate_project, "apps/service/tests/test_fixture.py", "not valid Python!\n")
    result = run_gate(gate_project, "mypy")
    assert result.returncode == 0, result.stdout + result.stderr
