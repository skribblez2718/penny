"""
Pytest configuration and shared fixtures for the jsa skill test suite.

This conftest:
1. Adds the scripts/ directory to sys.path so test files don't need to do it manually
2. Configures test markers (slow, integration, network, etc.)
3. Provides shared fixtures used across multiple test files
4. Skips tests gracefully when optional dependencies are missing
"""

import sys
from pathlib import Path

import pytest

# Ensure scripts/ is on sys.path so `import fsm`, `import orchestrate`, etc. work
# in any test file without per-file sys.path manipulation.
SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# ── Pytest markers ──────────────────────────────────────────────────────────


def pytest_configure(config):
    """Register custom markers for this project."""
    config.addinivalue_line(
        "markers",
        "slow: marks tests as slow (deselect with '-m \"not slow\"')",
    )
    config.addinivalue_line(
        "markers",
        "integration: marks integration tests that exercise the full pipeline",
    )
    config.addinivalue_line(
        "markers",
        "network: marks tests that require network access (will hit external APIs)",
    )
    config.addinivalue_line(
        "markers",
        "requires_semgrep: tests that need the semgrep binary on PATH",
    )
    config.addinivalue_line(
        "markers",
        "requires_tree_sitter: tests that need tree-sitter and tree-sitter-javascript",
    )
    config.addinivalue_line(
        "markers",
        "requires_jsluice: tests that need the jsluice Go binary on PATH",
    )
    config.addinivalue_line(
        "markers",
        "requires_playwright: tests that need a Playwright browser installed",
    )


# ── Skip helpers for optional dependencies ──────────────────────────────────


def _has_module(name: str) -> bool:
    """Return True if a Python module can be imported."""
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def _has_binary(name: str) -> bool:
    """Return True if a CLI binary is on PATH."""
    import shutil

    return shutil.which(name) is not None


# ── Auto-skip on missing optional dependencies ─────────────────────────────


@pytest.fixture(autouse=True)
def _skip_tree_sitter_if_missing(request):
    """Auto-skip tests marked @pytest.mark.requires_tree_sitter if not installed."""
    marker = request.node.get_closest_marker("requires_tree_sitter")
    if marker and not _has_module("tree_sitter_javascript"):
        pytest.skip("tree_sitter_javascript not installed; run `pip install tree-sitter-javascript`")


@pytest.fixture(autouse=True)
def _skip_semgrep_if_missing(request):
    """Auto-skip tests marked @pytest.mark.requires_semgrep if binary not on PATH."""
    marker = request.node.get_closest_marker("requires_semgrep")
    if marker and not _has_binary("semgrep"):
        pytest.skip("semgrep binary not on PATH")


@pytest.fixture(autouse=True)
def _skip_jsluice_if_missing(request):
    """Auto-skip tests marked @pytest.mark.requires_jsluice if binary not on PATH."""
    marker = request.node.get_closest_marker("requires_jsluice")
    if marker and not _has_binary("jsluice"):
        pytest.skip("jsluice binary not on PATH")


# ── Shared fixtures ────────────────────────────────────────────────────────


@pytest.fixture
def temp_output_dir(tmp_path: Path) -> Path:
    """A clean temporary output directory matching the jsa convention.

    Returns a path with no contents; tests can populate it as needed.
    """
    out = tmp_path / "jsa-test-output"
    out.mkdir(parents=True, exist_ok=True)
    return out


@pytest.fixture
def temp_js_dir(temp_output_dir: Path) -> Path:
    """A temporary output_dir/assets/js/ directory."""
    js_dir = temp_output_dir / "assets" / "js"
    js_dir.mkdir(parents=True, exist_ok=True)
    return js_dir


@pytest.fixture
def sample_vulnerable_js() -> str:
    """A small JS snippet with one clearly-vulnerable innerHTML sink.

    Useful for tests that just need a representative code sample.
    """
    return """
// app.js — DOM XSS vulnerable
const params = new URLSearchParams(location.search);
const userName = params.get('name');

function renderProfile() {
    const profileEl = document.getElementById('profile');
    profileEl.innerHTML = '<h1>Welcome ' + userName + '</h1>';  // VULNERABLE
}
"""


@pytest.fixture
def sample_safe_js() -> str:
    """A small JS snippet with no obvious vulnerabilities."""
    return """
// utils.js — safe code
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
"""


@pytest.fixture
def mock_playwright_page():
    """A pre-configured Mock that quacks like a Playwright Page.

    Returns a Mock with a sensible `evaluate()` default. Tests can override.
    """
    from unittest.mock import Mock

    page = Mock()
    page.evaluate = Mock(return_value=None)
    page.goto = Mock(return_value=None)
    page.close = Mock(return_value=None)
    return page
