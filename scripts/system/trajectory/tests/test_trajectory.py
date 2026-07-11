"""Unit tests for the behavioral-regression ratchet: fixtures, eval section, guard.

Hermetic — the eval reads a monkeypatched artifact; the live pi-replay path is
integration-lane. Fixture well-formedness is checked so a malformed fixture
can't silently pass through the runner.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # trajectory/
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "evals"))  # eval_lib

import pytest  # noqa: E402

import guard  # noqa: E402
import run_trajectory as rt  # noqa: E402
import eval_trajectory as et  # noqa: E402
from eval_lib import FAIL, PASS, SKIP, run_checks  # noqa: E402

# ── fixtures (the Oracle-authored asset) ──────────────────────────────────────


def test_fixtures_are_well_formed():
    fixtures = rt.load_fixtures()
    assert len(fixtures) >= 6
    seen = set()
    for f in fixtures:
        assert f["id"] not in seen, f"duplicate fixture id {f['id']}"
        seen.add(f["id"])
        assert f["task"].strip()
        assert f["pass_bar"].strip()
        assert f["oracle_output"].strip()
        assert isinstance(f["load_bearing_facts"], list) and f["load_bearing_facts"]
        assert f["expected_route"]  # route-fidelity dimension


def test_parse_route():
    assert rt.parse_route("ROUTE: direct") == "direct"
    assert rt.parse_route("thinking...\nROUTE: skill:plan") == "skill:plan"
    assert rt.parse_route("ROUTE: agent/echo") == "agent:echo"
    assert rt.parse_route("ROUTE: skill: jsa") == "skill:jsa"
    # last match wins (a chatty model may mention route mid-thought)
    assert rt.parse_route("maybe route: skill:x\nROUTE: direct") == "direct"
    assert rt.parse_route("no route here") is None


# ── eval section (monkeypatched artifact) ────────────────────────────────────


def _artifact(cells, ts=None):
    return {"ts": ts or datetime.now(timezone.utc).isoformat(), "cells": cells}


def _cell(fid, verdict, error=None):
    return {"id": fid, "verdict": verdict, "error": error, "why": ""}


def test_pass_rate_and_regressed_are_ratcheted_not_hard_gated(monkeypatch):
    # 2/3 pass (one FAIL) — above the catastrophic floor, so PASS status; the
    # regression count is a ratcheted metric (PASS status, value carries the count).
    cells = [_cell("a", "PASS"), _cell("b", "PASS"), _cell("c", "FAIL"), _cell("d", None, "err")]
    monkeypatch.setattr(et, "load_latest", lambda: _artifact(cells))
    pr = et.check_pass_rate()
    assert pr.value == pytest.approx(2 / 3, abs=1e-3)  # errored cell excluded from denominator
    assert pr.status == PASS  # 0.67 > 0.4 catastrophic floor — drift caught by the ratchet
    reg = et.check_regressed_fixtures()
    assert reg.status == PASS and reg.value == 1.0 and "c" in reg.detail


def test_pass_rate_catastrophic_fails(monkeypatch):
    cells = [_cell("a", "FAIL"), _cell("b", "FAIL"), _cell("c", "FAIL"), _cell("d", "PASS")]
    monkeypatch.setattr(et, "load_latest", lambda: _artifact(cells))
    assert et.check_pass_rate().status == FAIL  # 25% < 40% catastrophic floor


def test_pass_rate_all_pass(monkeypatch):
    cells = [_cell("a", "PASS"), _cell("b", "PASS")]
    monkeypatch.setattr(et, "load_latest", lambda: _artifact(cells))
    assert et.check_pass_rate().status == PASS
    assert et.check_regressed_fixtures().value == 0.0


def test_route_fidelity(monkeypatch):
    cells = [
        {
            "id": "a",
            "verdict": "PASS",
            "expected_route": "direct",
            "route": "direct",
            "route_ok": True,
        },
        {
            "id": "b",
            "verdict": "PASS",
            "expected_route": "direct",
            "route": "skill:plan",
            "route_ok": False,
        },
        {"id": "c", "verdict": "PASS", "expected_route": "", "route": None, "route_ok": None},
    ]
    monkeypatch.setattr(et, "load_latest", lambda: _artifact(cells))
    r = et.check_route_fidelity()
    assert r.informational and r.value == pytest.approx(0.5)  # 1 of 2 with route data
    assert "b(direct→skill:plan)" in r.detail


def test_route_fidelity_skips_without_data(monkeypatch):
    cells = [{"id": "a", "verdict": "PASS", "route_ok": None}]
    monkeypatch.setattr(et, "load_latest", lambda: _artifact(cells))
    from eval_lib import SKIP as _SKIP

    results = {
        r.name: r for r in run_checks([("trajectory.route_fidelity", et.check_route_fidelity)])
    }
    assert results["trajectory.route_fidelity"].status == _SKIP


def test_checks_skip_without_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(et, "LATEST_PATH", tmp_path / "missing.json")
    results = {r.name: r for r in run_checks(et.CHECKS)}
    assert results["trajectory.pass_rate"].status == SKIP
    assert results["trajectory.regressed_fixtures"].status == SKIP
    # fixture_count reads the fixtures file, not the artifact — stays alive
    assert results["trajectory.fixture_count"].status == PASS
    assert results["trajectory.fixture_count"].informational


def test_corrupt_artifact_skips_not_errors(tmp_path, monkeypatch):
    for bad in ({"no": "cells"}, {"cells": "not-a-list"}, "not-json"):
        path = tmp_path / "latest.json"
        path.write_text(json.dumps(bad) if not isinstance(bad, str) else bad)
        monkeypatch.setattr(et, "LATEST_PATH", path)
        results = {r.name: r for r in run_checks(et.CHECKS)}
        assert results["trajectory.pass_rate"].status == SKIP, bad


# ── pre-apply guard ──────────────────────────────────────────────────────────


def _baseline(tmp_path, regressed_count):
    p = tmp_path / "baseline.json"
    p.write_text(
        json.dumps({"metrics": {"trajectory.regressed_fixtures": {"value": regressed_count}}})
    )
    return p


def test_guard_allows_known_gap_at_baseline(tmp_path):
    # 1 failing fixture, and the baseline already accepts 1 → known gap, not new drift
    art = tmp_path / "latest.json"
    art.write_text(
        json.dumps({"cells": [_cell("a", "PASS"), _cell("b", "PASS"), _cell("c", "FAIL")]})
    )
    ok, msg = guard.check_no_regression(art, _baseline(tmp_path, 1))
    assert ok is True


def test_guard_blocks_on_new_drift_above_baseline(tmp_path):
    # 2 failing but baseline accepts only 1 → NEW drift → block
    art = tmp_path / "latest.json"
    art.write_text(
        json.dumps(
            {
                "cells": [
                    _cell("a", "PASS"),
                    _cell("b", "FAIL"),
                    _cell("c", "FAIL"),
                    _cell("d", "PASS"),
                ]
            }
        )
    )
    ok, msg = guard.check_no_regression(art, _baseline(tmp_path, 1))
    assert ok is False and "NEW" in msg


def test_guard_blocks_on_catastrophic_collapse(tmp_path):
    art = tmp_path / "latest.json"
    art.write_text(
        json.dumps(
            {
                "cells": [
                    _cell("a", "FAIL"),
                    _cell("b", "FAIL"),
                    _cell("c", "FAIL"),
                    _cell("d", "PASS"),
                ]
            }
        )
    )
    ok, msg = guard.check_no_regression(art, _baseline(tmp_path, 3))  # even if baseline accepts 3
    assert ok is False and "catastrophic" in msg


def test_guard_fails_open_on_missing_artifact(tmp_path):
    ok, _ = guard.check_no_regression(tmp_path / "nope.json", tmp_path / "no-baseline.json")
    assert ok is True
    assert guard.latest_regressions(tmp_path / "nope.json") == []


# ── runner pure helpers ──────────────────────────────────────────────────────


def test_run_fixture_marks_error_when_no_replay(monkeypatch, tmp_path):
    monkeypatch.setattr(rt, "replay", lambda *a, **k: None)
    cell = rt.run_fixture(
        {"id": "x", "task": "t", "pass_bar": "p", "load_bearing_facts": ["f"]},
        ("ollama", "glm"),
        ("ollama", "mm"),
        tmp_path / "f",
        tmp_path / "j",
        tmp_path,
        10,
    )
    assert cell["error"] and cell["verdict"] is None


def test_run_fixture_records_verdict(monkeypatch, tmp_path):
    monkeypatch.setattr(rt, "replay", lambda *a, **k: "a plausible replay answer")
    monkeypatch.setattr(rt, "judge_replay", lambda *a, **k: ("FAIL", "missed the boundary test"))
    cell = rt.run_fixture(
        {"id": "x", "task": "t", "pass_bar": "p", "load_bearing_facts": ["f"]},
        ("ollama", "glm"),
        ("ollama", "mm"),
        tmp_path / "f",
        tmp_path / "j",
        tmp_path,
        10,
    )
    assert cell["verdict"] == "FAIL"
    assert cell["why"] == "missed the boundary test"
    assert cell["error"] is None
