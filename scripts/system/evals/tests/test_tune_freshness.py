"""Tests for tune_freshness.py — LEAD_THRESHOLDS, check_all_stale(), FR-19 invalidation.

Uses tmp_path/fake-store injection for hermetic unit testing.
No network calls, no model calls, no live store access.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from tune_freshness import (
    LEAD_THRESHOLDS,
    RATCHET_TOLERANCES,
    PRODUCER_DIRS,
    check_all_stale,
    stale_producers,
    _model_roster_hash,
    _model_roster_changed,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _make_artifact(
    tmp_path: Path,
    producer: str,
    ts: datetime,
    extra: dict | None = None,
) -> Path:
    """Write a fake latest.json artifact for *producer* under tmp_path."""
    rel = PRODUCER_DIRS[producer]
    d = tmp_path / rel
    d.mkdir(parents=True, exist_ok=True)
    data = {"ts": _iso(ts), "runner_version": 1}
    if extra:
        data.update(extra)
    f = d / "latest.json"
    f.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return f


def _touch_system_md(tmp_path: Path, mtime: datetime | None = None) -> Path:
    """Create .pi/SYSTEM.md under tmp_path with an optional mtime."""
    p = tmp_path / ".pi" / "SYSTEM.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("# System prompt\n", encoding="utf-8")
    if mtime is not None:
        ts = mtime.timestamp()
        os.utime(p, (ts, ts))
    return p


# ---------------------------------------------------------------------------
# SM-1: Lead thresholds vs ratchet tolerances
# ---------------------------------------------------------------------------


class TestLeadThresholds:
    """SM-1: lead thresholds < ratchet tolerance with >=3d gap."""

    def test_lead_thresholds_values(self):
        assert LEAD_THRESHOLDS == {
            "trajectory": 10,
            "prompt_efficacy": 10,
            "judgment": 21,
        }

    def test_lead_less_than_tolerance(self):
        for producer, lead in LEAD_THRESHOLDS.items():
            tol = RATCHET_TOLERANCES[producer]
            assert lead < tol, f"{producer}: lead {lead} must be < tolerance {tol}"

    def test_lead_gap_at_least_3_days(self):
        for producer, lead in LEAD_THRESHOLDS.items():
            tol = RATCHET_TOLERANCES[producer]
            gap = tol - lead
            assert gap >= 3, f"{producer}: gap {gap} must be >= 3d"

    def test_producer_dirs_cover_all_thresholds(self):
        assert set(PRODUCER_DIRS.keys()) == set(LEAD_THRESHOLDS.keys())


# ---------------------------------------------------------------------------
# check_all_stale — basic freshness
# ---------------------------------------------------------------------------


class TestCheckAllStale:
    """Test check_all_stale with various artifact states."""

    def test_missing_artifact_is_stale(self, tmp_path):
        results = check_all_stale(project_root=tmp_path, now=_now())
        for producer in LEAD_THRESHOLDS:
            assert results[producer]["stale"] is True
            assert results[producer]["reason"] == "missing"
            assert results[producer]["age_days"] is None

    def test_fresh_artifact_not_stale(self, tmp_path):
        now = _now()
        for producer in LEAD_THRESHOLDS:
            _make_artifact(tmp_path, producer, now - timedelta(days=1))
        results = check_all_stale(project_root=tmp_path, now=now)
        for producer in LEAD_THRESHOLDS:
            assert results[producer]["stale"] is False
            assert results[producer]["reason"] == "fresh"
            assert results[producer]["age_days"] is not None
            assert results[producer]["age_days"] < LEAD_THRESHOLDS[producer]

    def test_stale_by_age(self, tmp_path):
        now = _now()
        for producer in LEAD_THRESHOLDS:
            threshold = LEAD_THRESHOLDS[producer]
            _make_artifact(tmp_path, producer, now - timedelta(days=threshold + 1))
        results = check_all_stale(project_root=tmp_path, now=now)
        for producer in LEAD_THRESHOLDS:
            assert results[producer]["stale"] is True
            assert results[producer]["reason"] == "stale (age)"
            assert results[producer]["age_days"] >= LEAD_THRESHOLDS[producer]

    def test_exactly_at_threshold_is_stale(self, tmp_path):
        """Age >= threshold is stale (boundary)."""
        now = _now()
        _make_artifact(tmp_path, "trajectory", now - timedelta(days=10))
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["trajectory"]["stale"] is True
        assert results["trajectory"]["reason"] == "stale (age)"

    def test_just_below_threshold_is_fresh(self, tmp_path):
        """Age < threshold is fresh (boundary)."""
        now = _now()
        _make_artifact(tmp_path, "trajectory", now - timedelta(days=9, hours=23))
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["trajectory"]["stale"] is False
        assert results["trajectory"]["reason"] == "fresh"

    def test_unreadable_artifact_is_stale(self, tmp_path):
        rel = PRODUCER_DIRS["trajectory"]
        d = tmp_path / rel
        d.mkdir(parents=True, exist_ok=True)
        (d / "latest.json").write_text("not json{", encoding="utf-8")
        results = check_all_stale(project_root=tmp_path, now=_now())
        assert results["trajectory"]["stale"] is True
        assert results["trajectory"]["reason"] == "unreadable"

    def test_no_ts_is_stale(self, tmp_path):
        rel = PRODUCER_DIRS["trajectory"]
        d = tmp_path / rel
        d.mkdir(parents=True, exist_ok=True)
        (d / "latest.json").write_text(json.dumps({"runner_version": 1}), encoding="utf-8")
        results = check_all_stale(project_root=tmp_path, now=_now())
        assert results["trajectory"]["stale"] is True
        assert results["trajectory"]["reason"] == "no ts"

    def test_threshold_in_results(self, tmp_path):
        now = _now()
        _make_artifact(tmp_path, "judgment", now - timedelta(days=1))
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["judgment"]["threshold"] == 21

    def test_stale_producers_helper(self, tmp_path):
        now = _now()
        _make_artifact(tmp_path, "trajectory", now - timedelta(days=1))
        # prompt_efficacy and judgment are missing
        stale = stale_producers(project_root=tmp_path, now=now)
        assert "trajectory" not in stale
        assert "prompt_efficacy" in stale
        assert "judgment" in stale


# ---------------------------------------------------------------------------
# FR-19: prompt_efficacy invalidation
# ---------------------------------------------------------------------------


class TestPromptEfficacyInvalidation:
    """FR-19: prompt_efficacy invalidated by frame/model-roster change."""

    def test_frame_changed_by_mtime(self, tmp_path):
        """SYSTEM.md mtime > artifact ts → invalidated (frame changed)."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        _make_artifact(tmp_path, "prompt_efficacy", artifact_ts)
        # SYSTEM.md modified AFTER the artifact was created
        _touch_system_md(tmp_path, mtime=now)
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["prompt_efficacy"]["stale"] is True
        assert results["prompt_efficacy"]["reason"] == "invalidated (frame changed)"
        # Even though age < threshold
        assert results["prompt_efficacy"]["age_days"] < LEAD_THRESHOLDS["prompt_efficacy"]

    def test_frame_changed_by_hash(self, tmp_path):
        """frame_sha256 mismatch → invalidated (frame changed), even if mtime is old."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        # Artifact has a frame_sha256 that won't match the current SYSTEM.md
        _make_artifact(
            tmp_path,
            "prompt_efficacy",
            artifact_ts,
            extra={"frame_sha256": "0" * 64},
        )
        # SYSTEM.md modified BEFORE the artifact (so mtime check passes)
        _touch_system_md(tmp_path, mtime=artifact_ts - timedelta(days=10))
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["prompt_efficacy"]["stale"] is True
        assert results["prompt_efficacy"]["reason"] == "invalidated (frame changed)"

    def test_frame_not_changed_fresh(self, tmp_path):
        """SYSTEM.md older than artifact, hash matches → fresh."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        sys_md = _touch_system_md(tmp_path, mtime=artifact_ts - timedelta(days=10))
        frame_hash = hashlib.sha256(sys_md.read_bytes()).hexdigest()
        _make_artifact(
            tmp_path,
            "prompt_efficacy",
            artifact_ts,
            extra={"frame_sha256": frame_hash},
        )
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["prompt_efficacy"]["stale"] is False
        assert results["prompt_efficacy"]["reason"] == "fresh"

    def test_model_roster_changed(self, tmp_path):
        """Model roster changed → invalidated (model roster changed)."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        sys_md = _touch_system_md(tmp_path, mtime=artifact_ts - timedelta(days=10))
        frame_hash = hashlib.sha256(sys_md.read_bytes()).hexdigest()
        artifact_models = [
            {"provider": "ollama", "model": "glm-5.2:cloud", "family": "glm"},
            {"provider": "ollama", "model": "qwen3:32b", "family": "qwen"},
        ]
        _make_artifact(
            tmp_path,
            "prompt_efficacy",
            artifact_ts,
            extra={"frame_sha256": frame_hash, "models": artifact_models},
        )
        # Current models differ
        current_models = [
            {"provider": "ollama", "model": "glm-5.2:cloud", "family": "glm"},
            {"provider": "ollama", "model": "llama3.3:70b", "family": "llama"},
        ]
        results = check_all_stale(project_root=tmp_path, now=now, current_models=current_models)
        assert results["prompt_efficacy"]["stale"] is True
        assert results["prompt_efficacy"]["reason"] == "invalidated (model roster changed)"

    def test_model_roster_same_not_invalidated(self, tmp_path):
        """Model roster same → not invalidated by roster."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        sys_md = _touch_system_md(tmp_path, mtime=artifact_ts - timedelta(days=10))
        frame_hash = hashlib.sha256(sys_md.read_bytes()).hexdigest()
        models = [
            {"provider": "ollama", "model": "glm-5.2:cloud", "family": "glm"},
        ]
        _make_artifact(
            tmp_path,
            "prompt_efficacy",
            artifact_ts,
            extra={"frame_sha256": frame_hash, "models": models},
        )
        results = check_all_stale(project_root=tmp_path, now=now, current_models=models)
        assert results["prompt_efficacy"]["stale"] is False

    def test_no_system_md_falls_back_to_age(self, tmp_path):
        """Missing SYSTEM.md → falls back to age-only check (no crash)."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        _make_artifact(tmp_path, "prompt_efficacy", artifact_ts)
        # No SYSTEM.md created
        results = check_all_stale(project_root=tmp_path, now=now)
        # Age is 2 days, threshold is 10 → fresh
        assert results["prompt_efficacy"]["stale"] is False
        assert results["prompt_efficacy"]["reason"] == "fresh"

    def test_invalidation_with_stale_age_reports_invalidation(self, tmp_path):
        """If both invalidated AND old, invalidation reason takes priority."""
        now = _now()
        artifact_ts = now - timedelta(days=15)
        _make_artifact(tmp_path, "prompt_efficacy", artifact_ts)
        _touch_system_md(tmp_path, mtime=now)
        results = check_all_stale(project_root=tmp_path, now=now)
        assert results["prompt_efficacy"]["stale"] is True
        assert results["prompt_efficacy"]["reason"] == "invalidated (frame changed)"

    def test_invalidation_only_for_prompt_efficacy(self, tmp_path):
        """FR-19 invalidation only applies to prompt_efficacy, not trajectory/judgment."""
        now = _now()
        artifact_ts = now - timedelta(days=2)
        _make_artifact(tmp_path, "trajectory", artifact_ts)
        _make_artifact(tmp_path, "judgment", artifact_ts)
        _touch_system_md(tmp_path, mtime=now)  # frame changed
        results = check_all_stale(project_root=tmp_path, now=now)
        # trajectory and judgment should be fresh (age < threshold), NOT invalidated
        assert results["trajectory"]["stale"] is False
        assert results["trajectory"]["reason"] == "fresh"
        assert results["judgment"]["stale"] is False
        assert results["judgment"]["reason"] == "fresh"


# ---------------------------------------------------------------------------
# Model roster helpers
# ---------------------------------------------------------------------------


class TestModelRosterHelpers:
    """Test _model_roster_hash and _model_roster_changed."""

    def test_hash_stable_regardless_of_order(self):
        models_a = [
            {"provider": "ollama", "model": "b:1", "family": "b"},
            {"provider": "ollama", "model": "a:1", "family": "a"},
        ]
        models_b = [
            {"provider": "ollama", "model": "a:1", "family": "a"},
            {"provider": "ollama", "model": "b:1", "family": "b"},
        ]
        assert _model_roster_hash(models_a) == _model_roster_hash(models_b)

    def test_changed_detects_different_models(self):
        a = [{"provider": "ollama", "model": "x:1"}]
        b = [{"provider": "ollama", "model": "y:1"}]
        assert _model_roster_changed(a, b) is True

    def test_changed_same_models(self):
        a = [{"provider": "ollama", "model": "x:1"}]
        b = [{"provider": "ollama", "model": "x:1"}]
        assert _model_roster_changed(a, b) is False

    def test_changed_different_count(self):
        a = [{"provider": "ollama", "model": "x:1"}]
        b = [{"provider": "ollama", "model": "x:1"}, {"provider": "ollama", "model": "y:1"}]
        assert _model_roster_changed(a, b) is True

    def test_hash_ignores_extra_keys(self):
        """Only provider/model matter for the hash."""
        a = [{"provider": "ollama", "model": "x:1", "family": "x", "extra": "foo"}]
        b = [{"provider": "ollama", "model": "x:1", "family": "y"}]
        assert _model_roster_hash(a) == _model_roster_hash(b)


# ---------------------------------------------------------------------------
# CLI / stale_producers
# ---------------------------------------------------------------------------


class TestStaleProducersList:
    """Test stale_producers returns correct list."""

    def test_all_fresh(self, tmp_path):
        now = _now()
        for p in LEAD_THRESHOLDS:
            _make_artifact(tmp_path, p, now - timedelta(days=1))
        assert stale_producers(project_root=tmp_path, now=now) == []

    def test_all_stale(self, tmp_path):
        now = _now()
        for p in LEAD_THRESHOLDS:
            _make_artifact(tmp_path, p, now - timedelta(days=100))
        result = stale_producers(project_root=tmp_path, now=now)
        assert set(result) == set(LEAD_THRESHOLDS.keys())

    def test_partial_stale(self, tmp_path):
        now = _now()
        _make_artifact(tmp_path, "trajectory", now - timedelta(days=1))
        _make_artifact(tmp_path, "prompt_efficacy", now - timedelta(days=100))
        # judgment missing
        result = stale_producers(project_root=tmp_path, now=now)
        assert "trajectory" not in result
        assert "prompt_efficacy" in result
        assert "judgment" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
