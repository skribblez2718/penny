"""Tests for comfy-generate.py — the provenance-aware CLI.

Covers the pure helpers (seed planning, graph resolution, manifest, count clamp)
by importing the hyphenated module via importlib, plus the mandatory
**entry-point-from-its-own-directory** subprocess test (server-startup Category
2): running the script from inside ``scripts/`` must not break the
``import comfy_http`` sibling import — the recurring cwd/sys.path bug class.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
CLI_PATH = SCRIPTS_DIR / "comfy-generate.py"


def _load_cli():
    spec = importlib.util.spec_from_file_location("comfy_generate_cli", CLI_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def cli():
    return _load_cli()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_plan_seeds_fixed_base_is_sequential(cli):
    assert cli.plan_seeds(100, 3) == [100, 101, 102]


def test_plan_seeds_random_when_none(cli):
    seeds = cli.plan_seeds(None, 2)
    assert len(seeds) == 2 and all(isinstance(s, int) for s in seeds)
    assert seeds[1] == seeds[0] + 1  # still internally reproducible


def test_plan_seeds_at_least_one(cli):
    assert len(cli.plan_seeds(5, 0)) == 1


def test_random_seed_in_range(cli):
    for _ in range(50):
        assert 0 <= cli.random_seed() <= cli._SEED_MAX


def test_resolve_graph_known_preset(cli):
    graph, preset = cli.resolve_graph("hero-flux")
    assert preset == "hero-flux" and "7" in graph


def test_resolve_graph_file_path(cli, tmp_path):
    p = tmp_path / "custom.api.json"
    p.write_text('{"1": {"class_type": "X", "inputs": {}}}')
    graph, preset = cli.resolve_graph(str(p))
    assert preset is None and "1" in graph


def test_build_manifest_has_reproduction_fields(cli):
    manifest = cli.build_manifest(
        preset="hero-flux",
        graph_arg="hero-flux",
        seeds=[1, 2],
        overrides=["3.text=x"],
        host="127.0.0.1:8188",
        outputs=[{"index": 0, "seed": 1, "graph_sha256": "abc", "files": ["/tmp/a.png"]}],
        comfy_version="0.27.0",
    )
    assert manifest["preset"] == "hero-flux"
    assert manifest["seeds"] == [1, 2]
    assert manifest["overrides"] == ["3.text=x"]
    assert manifest["candidates"][0]["graph_sha256"] == "abc"


# ---------------------------------------------------------------------------
# Entry-point-from-its-own-directory (server-startup Category 2)
# ---------------------------------------------------------------------------


def test_entry_point_imports_from_its_own_dir():
    """Run a driver that imports the CLI while cwd == scripts/. If the script
    failed to self-add its dir to sys.path, `import comfy_http` would raise
    ModuleNotFoundError here."""
    driver = (
        "import importlib.util, pathlib, sys;"
        "spec = importlib.util.spec_from_file_location('cg', 'comfy-generate.py');"
        "m = importlib.util.module_from_spec(spec);"
        "spec.loader.exec_module(m);"
        "assert hasattr(m, 'main');"
        "assert 'comfy_http' in sys.modules;"
        "print('OK')"
    )
    result = subprocess.run(
        [sys.executable, "-c", driver],
        capture_output=True,
        text=True,
        cwd=str(SCRIPTS_DIR),
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_cli_rejects_bad_set_override():
    """A malformed --set fails fast (exit 2) before any network call."""
    result = subprocess.run(
        [sys.executable, str(CLI_PATH), "hero-flux", "--set", "noequals"],
        capture_output=True,
        text=True,
        cwd=str(SCRIPTS_DIR),
        timeout=30,
    )
    assert result.returncode == 2
    assert "error" in result.stderr.lower()


def test_cli_help_runs_from_own_dir():
    result = subprocess.run(
        [sys.executable, "comfy-generate.py", "--help"],
        capture_output=True,
        text=True,
        cwd=str(SCRIPTS_DIR),
        timeout=30,
    )
    assert result.returncode == 0
    assert "--count" in result.stdout and "--manifest" in result.stdout


# ---------------------------------------------------------------------------
# Count clamp integration through the module
# ---------------------------------------------------------------------------


def test_generate_candidates_is_offline_safe_on_unreachable(cli, tmp_path):
    """With no ComfyUI reachable, generate_candidates returns zero records and a
    per-candidate error string (partial-batch honesty) rather than hanging."""
    # Port 1 is a privileged port nothing listens on -> connection refused fast,
    # independent of whether the real ComfyUI service is up on 8188.
    records, errors = cli.generate_candidates(
        graph_arg="hero-flux",
        overrides=[],
        seeds=[1],
        host="127.0.0.1:1",
        out_dir=str(tmp_path / "out"),
        timeout=1,
    )
    assert records == []
    assert len(errors) == 1 and "failed" in errors[0]
