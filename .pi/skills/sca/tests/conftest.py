"""
Pytest configuration and shared fixtures for the sca skill test suite.

This conftest:
1. Adds the scripts/ directory to sys.path (DYNAMICALLY — never hardcoded)
   so test files can `import fsm` / `import orchestrate` without per-file
   sys.path manipulation.
2. Registers custom markers (slow, integration, network, e2e, requires_*).
3. Provides shared fixtures.

Fast-lane note: these tests are fully mocked. No live tools, LLM, network, or
subprocess calls are made.
"""

import sys
from pathlib import Path

import pytest

# Dynamically resolve scripts/ relative to THIS file — never a hardcoded or
# home-relative path. tests/ -> <skill>/ -> scripts/
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# ── Pytest markers ──────────────────────────────────────────────────────────


def pytest_configure(config):
    """Register custom markers for this project."""
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )
    config.addinivalue_line(
        "markers", "integration: marks integration tests that exercise the pipeline"
    )
    config.addinivalue_line(
        "markers", "network: marks tests that require network access"
    )
    config.addinivalue_line(
        "markers", "e2e: marks end-to-end tests over the full skill lifecycle"
    )
    config.addinivalue_line(
        "markers", "requires_semgrep: tests that need the semgrep binary on PATH"
    )
    config.addinivalue_line(
        "markers", "requires_scanner: tests that need an external SAST/SCA scanner"
    )
    config.addinivalue_line(
        "markers", "requires_llm: tests that need a live LLM/provider"
    )


# ── Shared fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def temp_repo(tmp_path: Path) -> Path:
    """A clean temporary directory that stands in for a cloned source repo."""
    repo = tmp_path / "sample-repo"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "app.py").write_text("def handler(x):\n    return x\n")
    return repo


@pytest.fixture
def temp_output_dir(tmp_path: Path) -> Path:
    """A clean temporary output directory under tmp_path (never the project)."""
    out = tmp_path / "sca-output"
    out.mkdir(parents=True, exist_ok=True)
    return out
