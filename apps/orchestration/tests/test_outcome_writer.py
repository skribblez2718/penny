"""Tests for orchestration.outcome_writer — the engine's capture into penny/outcomes."""

import json

from orchestration.context import RunContext
from orchestration.outcome_writer import (
    build_outcome_content,
    record_outcome,
    _delta_score,
)


def _ctx(**kw) -> RunContext:
    base = dict(session_id="sess-1", run_id="run-1", playbook="code", goal="fix the bug")
    base.update(kw)
    return RunContext(**base)


class TestDeltaScore:
    def test_met_first_pass_is_match(self):
        assert _delta_score(_ctx(met=True, iteration=1)) == "MATCH"

    def test_met_after_iterating_is_still_match(self):
        # PARTIAL here would count a successful run as suboptimal in every
        # miner and leave it permanently "unresolved" in the staleness watcher
        # (decision_ids are unique run_ids — no later MATCH can resolve them).
        assert _delta_score(_ctx(met=True, iteration=3)) == "MATCH"

    def test_not_met_is_mismatch(self):
        assert _delta_score(_ctx(met=False, iteration=2)) == "MISMATCH"


class TestBuildContent:
    def test_header_carries_unquoted_delta_score(self):
        # The mismatch watcher reads a truncated summary and matches an UNQUOTED
        # `delta_score: MISMATCH`. It must appear in the leading header line.
        content = build_outcome_content(_ctx(met=False))
        header = content.splitlines()[0]
        assert "delta_score: MISMATCH" in header
        assert header.index("delta_score") < 200

    def test_body_is_valid_json_with_outcome_and_delta(self):
        content = build_outcome_content(_ctx(met=True, iteration=1))
        body = json.loads("\n".join(content.splitlines()[1:]))
        assert body["outcome"] == "MATCH"
        assert body["delta_score"] == "MATCH"
        assert body["domain"] == "coding"
        assert body["session_id"] == "sess-1"

    def test_freeform_fields_are_single_line(self):
        content = build_outcome_content(_ctx(goal="line1\nline2: trap", errors=["boom\nsplat"]))
        header = content.splitlines()[0]
        assert "\n" not in header
        body = json.loads("\n".join(content.splitlines()[1:]))
        assert "\n" not in body["action_taken"]

    def test_unknown_playbook_maps_to_other(self):
        body = json.loads(
            "\n".join(build_outcome_content(_ctx(playbook="mystery")).splitlines()[1:])
        )
        assert body["domain"] == "other"

    def _body(self, **kw):
        return json.loads("\n".join(build_outcome_content(_ctx(**kw)).splitlines()[1:]))

    def test_reason_is_present_and_groupable(self):
        # Same failure → same normalized reason, so recurring failures cluster.
        a = self._body(met=False, errors=["ENOENT: bun not found"])
        b = self._body(met=False, errors=["ENOENT: bun not found"])
        assert a["reason"] and a["reason"] == b["reason"]

    def test_reason_feeds_compression_pattern_detection(self):
        # The whole point of capture: two same-reason MISMATCH outcomes must
        # produce a pattern in the real compression grouping logic.
        import sys as _sys
        from pathlib import Path as _Path

        si = _Path(__file__).resolve().parents[3] / "scripts" / "system" / "self_improve"
        _sys.path.insert(0, str(si))
        from compression_loop import identify_patterns  # type: ignore

        outcomes = [
            self._body(met=False, errors=["ENOENT: bun not found"]),
            self._body(met=False, errors=["ENOENT: bun not found"]),
        ]
        assert len(identify_patterns(outcomes)) >= 1


class TestRecordOutcomeSafety:
    def test_no_write_under_pytest(self):
        # Capture is skipped under pytest so the suite never pollutes the real store.
        assert record_outcome(_ctx(met=True)) is False

    def test_capture_enabled_but_unresolved_returns_false(self, monkeypatch):
        # Force capture on, but make root resolution fail → no write, no raise.
        monkeypatch.setattr("orchestration.outcome_writer._capture_enabled", lambda: True)
        monkeypatch.setattr("orchestration.outcome_writer._resolve_project_root", lambda ctx: None)
        assert record_outcome(_ctx(met=True)) is False

    def test_never_raises(self, monkeypatch):
        # Any internal error is swallowed — capture must never break a run.
        def boom(ctx):
            raise RuntimeError("resolve exploded")

        monkeypatch.setattr("orchestration.outcome_writer._capture_enabled", lambda: True)
        monkeypatch.setattr("orchestration.outcome_writer._resolve_project_root", boom)
        assert record_outcome(_ctx(met=True)) is False
