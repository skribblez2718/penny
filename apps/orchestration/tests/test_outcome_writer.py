"""Tests for orchestration.outcome_writer — the engine's capture into penny/outcomes."""

import json

from orchestration import outcome_writer as ow
from orchestration.checkpointer import Checkpointer
from orchestration.code_artifacts import ArtifactRegistry
from orchestration.context import RunContext
from orchestration.outcome_writer import (
    build_outcome_content,
    record_outcome,
    _delta_score,
    _failure_mode,
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


class TestFailureModeClassification:
    """Model judgment primary, keyword table as the fallback it should be."""

    def _ctx_with_gaps(self, gaps):
        ctx = _ctx(met=False)
        ctx.verify_gaps = list(gaps)
        return ctx

    def test_keyword_table_decides_when_no_model_is_configured(self, monkeypatch):
        monkeypatch.delenv("PI_FAILURE_MODE_MODEL", raising=False)
        ctx = self._ctx_with_gaps(["claim 3 is unsupported by any cited source"])
        assert _failure_mode(ctx, "MISMATCH") == "unverified_claim"

    def test_model_judgment_wins_when_configured(self, monkeypatch):
        monkeypatch.setenv("PI_FAILURE_MODE_MODEL", "ollama/fake")
        monkeypatch.setattr(
            ow,
            "_load_detect",
            lambda: (lambda *a, **k: {"ok": True, "answer": "wrong_result"}),
        )
        # Gap text whose KEYWORDS say 'missing_constraint'; the model says otherwise.
        ctx = self._ctx_with_gaps(["the requirement was missing from the output"])
        assert _failure_mode(ctx, "MISMATCH") == "wrong_result"

    def test_model_failure_falls_back_to_keywords(self, monkeypatch):
        monkeypatch.setenv("PI_FAILURE_MODE_MODEL", "ollama/fake")
        monkeypatch.setattr(ow, "_load_detect", lambda: (lambda *a, **k: {"ok": False}))
        ctx = self._ctx_with_gaps(["no citation for the 40% figure"])
        assert _failure_mode(ctx, "MISMATCH") == "unverified_claim"

    def test_model_returning_garbage_falls_back_to_keywords(self, monkeypatch):
        monkeypatch.setenv("PI_FAILURE_MODE_MODEL", "ollama/fake")
        monkeypatch.setattr(
            ow,
            "_load_detect",
            lambda: (lambda *a, **k: {"ok": True, "answer": "not_a_real_mode"}),
        )
        ctx = self._ctx_with_gaps(["no citation for the 40% figure"])
        assert _failure_mode(ctx, "MISMATCH") == "unverified_claim"

    def test_a_raising_detector_never_breaks_capture(self, monkeypatch):
        monkeypatch.setenv("PI_FAILURE_MODE_MODEL", "ollama/fake")

        def _boom(*a, **k):
            raise RuntimeError("model down")

        monkeypatch.setattr(ow, "_load_detect", lambda: _boom)
        ctx = self._ctx_with_gaps(["the output is incorrect"])
        assert _failure_mode(ctx, "MISMATCH") == "wrong_result"

    def test_vocabulary_is_the_single_source_for_both_classifiers(self):
        """The model prompt and the keyword table must not drift apart."""
        table_modes = {m for m, _ in ow._FAILURE_MODE_KEYWORDS}
        assert table_modes <= set(ow.FAILURE_MODES)

    def test_match_runs_have_no_failure_mode(self):
        assert _failure_mode(_ctx(met=True), "MATCH") == ""


class TestBuildContent:
    def test_header_carries_unquoted_delta_score(self):
        # The mismatch watcher reads a truncated summary and matches an UNQUOTED
        # `delta_score: MISMATCH`. It must appear in the leading header line.
        content = build_outcome_content(_ctx(met=False))
        header = content.splitlines()[0]
        assert "delta_score: MISMATCH" in header
        assert header.index("delta_score") < 200

    def test_header_carries_verify_verdict_when_a_gate_ran(self):
        """DELIVERY and VERIFICATION are different questions. A run can be MATCH
        (artifact produced) while its verification gate FAILED — research ships a
        report with unverified claims exactly this way, honestly. Header-reading
        watchers must be able to see both, or such runs are invisible to the
        improvement loop."""
        ctx = _ctx(met=True)
        ctx.verify_verdict = "FAIL"
        header = build_outcome_content(ctx).splitlines()[0]
        assert "delta_score: MATCH" in header
        assert "verify_verdict: FAIL" in header
        # must survive the 200-char summary truncation the watchers read
        assert header.index("verify_verdict") < 200

    def test_header_omits_verify_verdict_when_no_gate_ran(self):
        """Playbooks without a verify signal keep a clean header; absence means
        'no gate', which is distinguishable from a recorded PASS/FAIL."""
        header = build_outcome_content(_ctx(met=True)).splitlines()[0]
        assert "verify_verdict" not in header

    def test_verify_verdict_in_header_does_not_disturb_delta_parsing(self):
        """The digest/watcher parsers regex on field NAMES, so an inserted field is
        safe — pinned here because the header is a shared contract."""
        import re

        ctx = _ctx(met=False)
        ctx.verify_verdict = "FAIL"
        header = build_outcome_content(ctx).splitlines()[0]
        assert re.search(r"delta_score:\s*(\S+)", header).group(1) == "MISMATCH"

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

    def test_failure_mode_empty_on_match(self):
        assert self._body(met=True, iteration=1)["failure_mode"] == ""

    def test_failure_mode_classifies_verify_gaps(self):
        # A verifier gap describing a work-quality problem gets a categorical key.
        assert (
            self._body(met=False, verify_gaps=["did not address the stated requirement"])[
                "failure_mode"
            ]
            == "missing_constraint"
        )
        assert (
            self._body(met=False, verify_gaps=["the claim is unsupported by any evidence"])[
                "failure_mode"
            ]
            == "unverified_claim"
        )

    def test_failure_mode_defaults_incomplete_for_unspecific_gaps(self):
        # Verifier found gaps but nothing keyword-matched → still didn't meet the
        # bar, so "incomplete" (not "other") — it clusters with other verify fails.
        assert (
            self._body(met=False, verify_gaps=["something felt off"])["failure_mode"]
            == "incomplete"
        )

    def test_failure_mode_other_for_hard_error_without_gaps(self):
        # A process/orchestration error is NOT a work-quality category; it stays
        # "other" so grouping falls back to the (repeatable) error string.
        assert (
            self._body(met=False, errors=["step failed after 3 retries"])["failure_mode"] == "other"
        )

    def test_failure_mode_clusters_across_different_reasons(self):
        # The engine-side analogue of the keystone fix: two verify failures with
        # DIFFERENT free-text gaps but the same category must now cluster.
        import sys as _sys
        from pathlib import Path as _Path

        si = _Path(__file__).resolve().parents[3] / "scripts" / "system" / "self_improve"
        _sys.path.insert(0, str(si))
        from compression_loop import identify_patterns  # type: ignore

        outcomes = [
            self._body(met=False, verify_gaps=["omitted the required null check"]),
            self._body(met=False, verify_gaps=["ignored the constraint about timezones"]),
        ]
        # different reasons, same failure_mode → one clustered pattern
        assert identify_patterns(outcomes) == ["missing_constraint"]

    def test_failure_mode_values_stay_in_capture_vocab(self):
        # Drift guard: everything this writer can emit must be a real
        # capture.FAILURE_MODES value (the compression loop's vocabulary).
        import sys as _sys
        from pathlib import Path as _Path

        ol = _Path(__file__).resolve().parents[3] / "scripts" / "system" / "outcome_ledger"
        _sys.path.insert(0, str(ol))
        from capture import FAILURE_MODES  # type: ignore

        from orchestration.outcome_writer import _FAILURE_MODE_KEYWORDS

        emitted = {mode for mode, _ in _FAILURE_MODE_KEYWORDS} | {"incomplete", "other"}
        assert emitted <= set(FAILURE_MODES)


class TestRecordOutcomeSafety:
    def test_p0_registry_outcome_is_durable_even_when_mempalace_capture_is_disabled(self, tmp_path):
        cp = Checkpointer(db_path=tmp_path / "orch.db")
        registry = ArtifactRegistry(cp, "run-1")
        registry.create_and_register(
            kind="terminal_result",
            payload={"met": True, "residual_risks": []},
            producer="test",
            authority="completion-predicate",
        )
        ctx = _ctx(
            met=True,
            extras={
                "code": {
                    "p0_enabled": True,
                    "terminal_result": {"met": True, "residual_risks": []},
                }
            },
        )
        assert record_outcome(ctx, cp) is True
        selected = registry.selected("outcome")
        assert selected is not None
        assert registry.get(selected).payload["terminal_result"]["met"] is True

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
