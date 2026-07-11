"""Unit tests for size-rotation configuration knobs (C1 + C2).

C1: config defines DB_SIZE_MAX_GB (default 5.0, env PI_OBSERVABILITY_DB_SIZE_MAX_GB)
    and DB_SIZE_FLOOR_GB (default 1.0, env PI_OBSERVABILITY_DB_SIZE_FLOOR_GB), and each
    env var overrides the default.
C2: the age-based RETENTION_*_DAYS knobs are gone (grep-clean of src).
"""

import importlib
import subprocess
from pathlib import Path

import observability.config as config_module

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"


def _reload_config():
    """Re-import the config module so class-level os.getenv reads run again."""
    return importlib.reload(config_module)


def test_size_knob_defaults(monkeypatch):
    """DB_SIZE_MAX_GB defaults to 5.0 and DB_SIZE_FLOOR_GB to 1.0 (floats)."""
    monkeypatch.delenv("PI_OBSERVABILITY_DB_SIZE_MAX_GB", raising=False)
    monkeypatch.delenv("PI_OBSERVABILITY_DB_SIZE_FLOOR_GB", raising=False)
    cfg = _reload_config()
    try:
        assert cfg.Config.DB_SIZE_MAX_GB == 5.0
        assert isinstance(cfg.Config.DB_SIZE_MAX_GB, float)
        assert cfg.Config.DB_SIZE_FLOOR_GB == 1.0
        assert isinstance(cfg.Config.DB_SIZE_FLOOR_GB, float)
    finally:
        _reload_config()


def test_size_knob_env_override(monkeypatch):
    """Each env var overrides its default."""
    monkeypatch.setenv("PI_OBSERVABILITY_DB_SIZE_MAX_GB", "7.5")
    monkeypatch.setenv("PI_OBSERVABILITY_DB_SIZE_FLOOR_GB", "2.25")
    cfg = _reload_config()
    try:
        assert cfg.Config.DB_SIZE_MAX_GB == 7.5
        assert cfg.Config.DB_SIZE_FLOOR_GB == 2.25
    finally:
        monkeypatch.delenv("PI_OBSERVABILITY_DB_SIZE_MAX_GB", raising=False)
        monkeypatch.delenv("PI_OBSERVABILITY_DB_SIZE_FLOOR_GB", raising=False)
        _reload_config()


def test_retention_day_knobs_removed():
    """The RETENTION_*_DAYS knobs must no longer exist on Config (C2)."""
    cfg = _reload_config()
    for attr in (
        "RETENTION_RAW_DAYS",
        "RETENTION_COMPACTION_DAYS",
        "RETENTION_LOG_DAYS",
        "RETENTION_WATCHER_LOG_DAYS",
    ):
        assert not hasattr(cfg.Config, attr), f"Config.{attr} should be removed"


def test_src_is_grep_clean_of_retention_days():
    """`grep -rn retention_.*_days src` returns nothing (C2)."""
    result = subprocess.run(
        ["grep", "-rn", "--include=*.py", "retention_.*_days", str(_SRC_DIR)],
        capture_output=True,
        text=True,
    )
    # grep exit code 1 == no matches (the desired state); 0 == matches found.
    assert result.returncode == 1, f"unexpected retention_*_days matches:\n{result.stdout}"
