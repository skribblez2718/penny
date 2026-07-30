"""Integration tests for the migrated prd skill (PrdPlaybook) on the engine.

Exercises the clarify-first HITL flow (first generate = CLARIFICATION QUESTIONS
mode, escalation with synthia's questions, clarify-resume into SYNTHESIS mode),
the vera revision loop with honest exhaustion (no force-valid at the cap), stall
escalation, UNCERTAIN escalation from vera (a legacy dead-end, now coherent), and
the run_id/checkpointer contract (fresh instance per step).
"""

import json

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.prd import (
    PRD_GENERATE,
    PRD_VALIDATE,
    PrdPlaybook,
    available_domains,
)

SID, RID = "sess-prd", "run-prd"
GOAL = "build a fastapi service for document search"

CLARIFY_SUMMARY = {
    "complete": True,
    "requirement_count": 0,
    "narrative_sections": 0,
    "verification_matrix_complete": False,
    "ideal_state_valid": False,
    "needs_clarification": True,
    "clarifying_questions": ["Who are the users?", "What scale of documents?"],
    "confidence": "PROBABLE",
}
SYNTH_SUMMARY = {
    "complete": True,
    "domain": "web-app",  # synthia declares the best-fit pack (model-owned, R1)
    "requirement_count": 12,
    "narrative_sections": 12,
    "verification_matrix_complete": True,
    "ideal_state_valid": True,
    "needs_clarification": False,
    "clarifying_questions": [],
    "confidence": "PROBABLE",
}
# vera is evidence-gated (Rec 4): every verdict carries captured evidence.
VERA_PASS = {
    "valid": True,
    "ideal_state_valid": True,
    "issues": [],
    "evidence": ["validate_ideal_state: OK", "12/12 narrative sections found"],
    "confidence": "CERTAIN",
}


def _vera_fail(issues):
    return {
        "valid": False,
        "ideal_state_valid": False,
        "issues": issues,
        "evidence": ["schema check ran", "section audit ran"],
        "confidence": "PROBABLE",
    }


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, goal=GOAL, constraints=None, cls=PrdPlaybook):
    return cls(cp).start(
        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {}
    )


def _step(cp, agent, result, cls=PrdPlaybook):
    return cls(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _to_validating(cp, constraints=None, cls=PrdPlaybook):
    """Walk the canonical clarify-first path up to the first vera dispatch."""
    _start(cp, constraints=constraints, cls=cls)
    _step(cp, "synthia", CLARIFY_SUMMARY, cls=cls)  # -> escalate with questions
    _step(cp, "user", {"answer": "internal ops team; ~10k documents"}, cls=cls)  # -> SYNTHESIS
    _step(cp, "synthia", SYNTH_SUMMARY, cls=cls)  # -> validating


class _MalformedIdealPrd(PrdPlaybook):
    """PrdPlaybook whose IDEAL_STATE read returns a schema-MALFORMED spec (missing the
    required fields), so the T4 code schema-floor must reject it regardless of vera."""

    def _read_ideal_state(self, ctx):
        return {"goal": "x"}  # not a valid IdealState -> validate_json fails


# ---------------------------------------------------------------------------
# start + clarify-first dispatch
# ---------------------------------------------------------------------------


def test_start_requires_goal(cp):
    d = PrdPlaybook(cp).start(session_id=SID, run_id=RID, goal="   ")
    assert d["action"] == "error"


def test_start_dispatches_clarification_mode(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert d["run_id"] == RID and "orchestrator_state" not in d
    assert "Mode: CLARIFICATION QUESTIONS" in d["task_summary"]
    # room contract the code skill depends on
    assert f"skills/prd-{SID}" in d["task_summary"]
    assert "wing=penny" in d["task_summary"]


def test_first_task_lists_available_packs_for_model_choice(cp):
    # No caller domain: the first task lists the packs and asks the model to
    # declare one — no keyword detection.
    d = _start(cp)
    assert "Available domain guidance packs" in d["task_summary"]
    assert "web-app" in d["task_summary"] and "generic" in d["task_summary"]
    assert "Domain:" not in d["task_summary"]  # unresolved until declared


def test_available_domains_includes_generic_and_web_app():
    ctx = RunContext(session_id=SID, run_id=RID, playbook="prd", goal=GOAL)
    names = available_domains(ctx)
    assert "generic" in names and "web-app" in names


def test_caller_domain_constraint_wins_and_is_not_overridden(cp):
    d = _start(cp, constraints={"domain": "web-app"})
    assert "Domain: web-app" in d["task_summary"]
    _step(cp, "synthia", CLARIFY_SUMMARY)
    _step(cp, "user", {"answer": "ops"})
    _step(cp, "synthia", {**SYNTH_SUMMARY, "domain": "generic"})  # model tries to differ
    assert cp.load(RID).context.extras["prd"]["domain"] == "web-app"


def test_model_declared_domain_is_captured(cp):
    _to_validating(cp)  # SYNTH_SUMMARY declares web-app
    assert cp.load(RID).context.extras["prd"]["domain"] == "web-app"


def test_unknown_declared_domain_falls_back_to_generic(cp):
    _start(cp)
    _step(cp, "synthia", CLARIFY_SUMMARY)
    _step(cp, "user", {"answer": "ops"})
    _step(cp, "synthia", {**SYNTH_SUMMARY, "domain": "not-a-real-pack"})
    assert cp.load(RID).context.extras["prd"]["domain"] == "generic"


def test_max_iterations_defaults_to_legacy_five(cp):
    _start(cp)
    assert cp.load(RID).context.max_iterations == 5


def test_max_iterations_constraint_overrides_default(cp):
    _start(cp, constraints={"max_iterations": 2})
    assert cp.load(RID).context.max_iterations == 2


# ---------------------------------------------------------------------------
# clarify-first HITL: escalation with synthia's questions + SYNTHESIS resume
# ---------------------------------------------------------------------------


def test_needs_clarification_escalates_with_questions(cp):
    _start(cp)
    d = _step(cp, "synthia", CLARIFY_SUMMARY)
    assert d["action"] == "escalate_to_user"
    assert "Who are the users?" in d["unknown_reason"]
    # escalation question shape the extension's questionnaire builder needs
    assert d["questions"][0]["options"] == [] and d["questions"][0]["allowOther"] is True
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"


def test_clarify_resumes_in_synthesis_mode(cp):
    _start(cp)
    _step(cp, "synthia", CLARIFY_SUMMARY)
    d = _step(cp, "user", {"answer": "internal ops team"})
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert "Mode: SYNTHESIS" in d["task_summary"]
    assert "User clarification: internal ops team" in d["task_summary"]


def test_clarification_pass_without_questions_self_loops_to_synthesis(cp):
    # A clarification pass that produced neither questions nor artifacts must
    # dispatch a full synthesis, not send vera an empty room.
    _start(cp)
    d = _step(
        cp,
        "synthia",
        {"complete": True, "requirement_count": 0, "needs_clarification": False},
    )
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert "Mode: SYNTHESIS" in d["task_summary"]


# ---------------------------------------------------------------------------
# happy path: synthesis -> vera -> complete
# ---------------------------------------------------------------------------


def test_synthesis_routes_to_vera(cp):
    _to_validating(cp)
    rec = cp.load(RID)
    assert rec.current_state_id == "validating"
    # the pending directive was for vera with the artifact-read instructions
    d = _step(cp, "vera", _vera_fail(["Section 7 NFRs missing thresholds"]))
    assert d["agent"] == "synthia"  # fail loops back (proves vera was consumed)


def test_validation_pass_completes_with_prd_summary(cp):
    _to_validating(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    ps = d["result"]["prd_summary"]
    assert ps["goal"] == GOAL and ps["domain"] == "web-app"
    assert ps["requirement_count"] == 12 and ps["narrative_sections"] == 12
    assert ps["verification_matrix_complete"] is True and ps["ideal_state_valid"] is True
    assert ps["session_id"] == SID and ps["requires_approval"] is True
    assert d["result"]["session_room"] == f"skills/prd-{SID}"
    assert d["result"]["mempalace_drawers"] == {"wing": "penny", "room": f"skills/prd-{SID}"}
    assert d["result"]["exhausted"] is False and d["result"]["unresolved_issues"] == []


# ---------------------------------------------------------------------------
# revision loop + honest exhaustion (no force-valid at the cap)
# ---------------------------------------------------------------------------


def test_validation_failure_dispatches_revision_mode(cp):
    _to_validating(cp)
    d = _step(cp, "vera", _vera_fail(["REQ-005 lacks acceptance criteria"]))
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "synthia" and d["state_id"] == "generating"
    assert "Mode: REVISION" in d["task_summary"]
    assert "REQ-005 lacks acceptance criteria" in d["task_summary"]


def test_exhaustion_completes_honestly_not_forced_valid(cp):
    # A perpetually-failing validation with CHANGING issues walks the budget and
    # completes with met=False + unresolved issues — never a fabricated valid=True.
    _to_validating(cp, constraints={"max_iterations": 2})
    d = _step(cp, "vera", _vera_fail(["issue a"]))  # iter 0 -> revise
    assert d["state_id"] == "generating"
    _step(cp, "synthia", SYNTH_SUMMARY)  # revision -> validating
    d2 = _step(cp, "vera", _vera_fail(["issue b"]))  # iter 1 -> budget spent
    assert d2["action"] == "complete"
    assert d2["result"]["met"] is False
    assert d2["result"]["exhausted"] is True
    assert d2["result"]["unresolved_issues"] == ["issue b"]
    assert d2["result"]["prd_summary"]["ideal_state_valid"] is False


def test_stalled_revisions_escalate_instead_of_spinning(cp):
    # Same issue every round -> stall detector escalates rather than burning the
    # remaining budget (default max_iterations 5).
    _to_validating(cp)
    _step(cp, "vera", _vera_fail(["same problem"]))  # iter 0 -> revise
    _step(cp, "synthia", SYNTH_SUMMARY)
    _step(cp, "vera", _vera_fail(["same problem"]))  # iter 1 -> revise
    _step(cp, "synthia", SYNTH_SUMMARY)
    d = _step(cp, "vera", _vera_fail(["same problem"]))  # iter 2 -> stall
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# UNCERTAIN escalation (fix vs. legacy: vera UNCERTAIN was a dead-end error)
# ---------------------------------------------------------------------------


def test_vera_uncertain_escalates_and_resumes_generation(cp):
    _to_validating(cp)
    d = _step(
        cp,
        "vera",
        {
            "valid": False,
            "ideal_state_valid": False,
            "issues": ["contradictory artifacts"],
            "evidence": ["cross-artifact audit ran"],
            "confidence": "UNCERTAIN",
        },
    )
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "validating"
    # legacy drove the FSM into terminal error here; the engine port resumes
    d2 = _step(cp, "user", {"answer": "drop the offline mode requirement"})
    assert d2["action"] == "invoke_agent"
    assert d2["agent"] == "synthia" and d2["state_id"] == "generating"


def test_synthia_uncertain_escalates(cp):
    _start(cp)
    d = _step(cp, "synthia", {"complete": True, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "generating"


# ---------------------------------------------------------------------------
# SUMMARY contract enforcement
# ---------------------------------------------------------------------------


def test_malformed_generate_summary_is_retried(cp):
    _start(cp)
    # missing required 'complete' -> bounded retry re-issues generating
    d = _step(cp, "synthia", {"requirement_count": 3})
    assert d["action"] == "invoke_agent" and d["state_id"] == "generating"


def test_malformed_validate_summary_is_retried(cp):
    _to_validating(cp)
    # missing required 'valid' -> bounded retry re-issues validating
    d = _step(cp, "vera", {"issues": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "validating"


def test_wrong_agent_for_state_errors(cp):
    _start(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# recovery re-presents a pending clarification
# ---------------------------------------------------------------------------


def test_recovery_re_presents_pending_clarification(cp, monkeypatch):
    import orchestration.playbooks as playbooks
    from orchestration.recovery import recover_pending

    monkeypatch.setitem(playbooks.PLAYBOOKS, "prd", PrdPlaybook)
    _start(cp)
    _step(cp, "synthia", CLARIFY_SUMMARY)  # -> awaiting_clarification
    directives = recover_pending(cp, session_id=SID, playbook="prd")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "generating"
    assert "Who are the users?" in directives[0]["unknown_reason"]


# ---------------------------------------------------------------------------
# evidence-gated validation (Rec 4) + recall injection (R5.5)
# ---------------------------------------------------------------------------


def test_validate_rejects_empty_evidence_then_accepts_grounded(cp):
    _to_validating(cp)
    # PASS with EMPTY evidence violates the contract -> bounded retry, not a pass.
    d = _step(
        cp,
        "vera",
        {
            "valid": True,
            "ideal_state_valid": True,
            "issues": [],
            "evidence": [],
            "confidence": "CERTAIN",
        },
    )
    assert d["action"] == "invoke_agent" and d["state_id"] == "validating"
    # With captured evidence it passes.
    d2 = _step(cp, "vera", VERA_PASS)
    assert d2["action"] == "complete" and d2["result"]["met"] is True


def test_validate_evidence_lands_on_context(cp):
    _to_validating(cp)
    _step(cp, "vera", VERA_PASS)
    assert cp.load(RID).context.verify_evidence  # captured for the outcome ledger


# ---------------------------------------------------------------------------
# T4: deterministic IDEAL_STATE schema-floor beneath vera's judgement
# ---------------------------------------------------------------------------


def test_schema_check_rejects_malformed_and_skips_unreadable(cp):
    from orchestration.context import RunContext

    ctx = RunContext(session_id=SID, run_id=RID, playbook="prd")
    ok, errors = _MalformedIdealPrd(cp)._schema_check_ideal_state(ctx)
    assert ok is False and errors  # malformed -> rejected by code, with errors
    # default read is None under pytest -> the floor is skipped (vera stands)
    assert PrdPlaybook(cp)._schema_check_ideal_state(ctx) == (None, [])


def test_schema_floor_overrides_vera_pass_on_malformed_ideal_state(cp):
    # vera PASSes (valid + ideal_state_valid True), but the code schema-floor finds the
    # IDEAL_STATE malformed -> the run does NOT complete; it revises. A schema-malformed
    # spec can never pass on vera's say-so.
    _to_validating(cp, cls=_MalformedIdealPrd)
    d = _step(cp, "vera", VERA_PASS, cls=_MalformedIdealPrd)
    assert d["action"] == "invoke_agent" and d["state_id"] == "generating"  # forced revise
    prd = cp.load(RID).context.extras["prd"]
    assert prd["ideal_state_valid"] is False  # code floor overrode vera's PASS
    assert prd.get("schema_evidence")  # deterministic schema errors captured as evidence


def test_schema_floor_skipped_when_unreadable_lets_vera_pass(cp):
    # Unreadable IDEAL_STATE (pytest-hermetic default) -> floor skipped, vera's PASS stands.
    _to_validating(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["action"] == "complete"
    assert cp.load(RID).context.extras["prd"]["schema_checked"] is False


# ---------------------------------------------------------------------------
# item 4: absolute paths as run facts (agents spawn with cwd = project_root,
# which for an off-repo run is NOT this repo — relative paths silently miss)
# ---------------------------------------------------------------------------


class _ValidIdealPrd(PrdPlaybook):
    """PrdPlaybook whose IDEAL_STATE read returns a schema-VALID spec, so the T4 floor
    runs for real and the learning-loop capture has criteria to publish."""

    IDEAL = {
        "goal": "ship a document-search service",
        "success_criteria": ["P95 search latency < 200ms", "recall@10 >= 0.85"],
    }

    def _read_ideal_state(self, ctx):
        return dict(self.IDEAL)


def test_generate_task_carries_absolute_guidance_root(cp):
    d = _start(cp)
    task = d["task_summary"]
    assert "Guidance root (ABSOLUTE" in task
    assert "/.pi/skills/prd/resources/" in task
    assert "/resources/prd-template.md" in task
    # the path handed to the agent must be absolute, never cwd-relative
    for token in task.split():
        if token.endswith("prd-template.md"):
            assert token.startswith("/"), f"guidance path not absolute: {token}"


def test_validate_task_carries_absolute_validator_path(cp):
    _to_validating(cp)
    d = _step(cp, "vera", _vera_fail(["x"]))  # consumes vera, re-dispatches synthia
    _step(cp, "synthia", SYNTH_SUMMARY)  # -> validating again
    rec = cp.load(RID)
    assert rec.current_state_id == "validating"
    task = PrdPlaybook(cp)._task_summary("validating", None, rec.context)
    assert "validate_ideal_state.py --stdin" in task
    assert "Artifact oracle (ABSOLUTE" in task
    for token in task.split():
        if token.endswith("validate_ideal_state.py"):
            assert token.lstrip("`").startswith("/"), f"validator path not absolute: {token}"


def test_validate_task_warns_when_schema_floor_was_skipped(cp):
    # Round 1 leaves schema_checked False (hermetic read returns None); round 2's
    # vera task must SAY the floor could not run rather than staying silent (item 9).
    _to_validating(cp)
    _step(cp, "vera", _vera_fail(["needs thresholds"]))
    _step(cp, "synthia", SYNTH_SUMMARY)
    rec = cp.load(RID)
    task = PrdPlaybook(cp)._task_summary("validating", None, rec.context)
    assert "could NOT read your IDEAL_STATE" in task


# ---------------------------------------------------------------------------
# item 6: the learning-loop signal (outcome ledger reads the STANDARD ctx fields)
# ---------------------------------------------------------------------------


def test_vera_issues_land_on_verify_gaps_for_the_ledger(cp):
    _to_validating(cp)
    _step(cp, "vera", _vera_fail(["REQ-005 lacks acceptance criteria"]))
    ctx = cp.load(RID).context
    assert ctx.verify_gaps == ["REQ-005 lacks acceptance criteria"]
    assert ctx.verify_verdict == "FAIL"


def test_passing_validation_records_pass_verdict_and_no_gaps(cp):
    _to_validating(cp)
    _step(cp, "vera", VERA_PASS)
    ctx = cp.load(RID).context
    assert ctx.verify_verdict == "PASS" and ctx.verify_gaps == []


def test_success_criteria_from_ideal_state_land_on_context(cp):
    # expected_outcome in the outcome ledger comes from ctx.success_criteria; empty
    # meant every prd run recorded the placeholder "goal satisfied".
    _to_validating(cp, cls=_ValidIdealPrd)
    _step(cp, "vera", VERA_PASS, cls=_ValidIdealPrd)
    ctx = cp.load(RID).context
    assert ctx.success_criteria == ["P95 search latency < 200ms", "recall@10 >= 0.85"]


def test_exhausted_run_carries_its_unresolved_gaps_to_the_ledger(cp):
    _to_validating(cp, constraints={"max_iterations": 2})
    _step(cp, "vera", _vera_fail(["issue a"]))
    _step(cp, "synthia", SYNTH_SUMMARY)
    _step(cp, "vera", _vera_fail(["issue b"]))  # budget spent -> complete met=False
    ctx = cp.load(RID).context
    assert ctx.met is False
    assert ctx.verify_gaps == ["issue b"] and ctx.verify_verdict == "FAIL"


# ---------------------------------------------------------------------------
# item 8: the revision budget is a tagged, tier-scaled LOAN (not a frozen 5)
# ---------------------------------------------------------------------------


def test_revision_budget_scales_up_for_a_strong_model_tier(cp, monkeypatch):
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    _start(cp)
    assert cp.load(RID).context.max_iterations == 8  # 5*2.0, clamped to the ceiling


def test_revision_budget_scales_down_for_a_cheap_model_tier(cp, monkeypatch):
    monkeypatch.setenv("PI_MODEL_TIER", "cheap")
    _start(cp)
    assert cp.load(RID).context.max_iterations == 2


def test_revision_budget_loan_ablation_falls_back_to_engine_default(cp, monkeypatch):
    monkeypatch.setenv("PENNY_ABLATE_PRD_REVISION_BUDGET", "1")
    _start(cp)
    assert cp.load(RID).context.max_iterations == 3  # engine generic default


def test_caller_constraint_still_beats_the_tier_scaled_budget(cp, monkeypatch):
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    _start(cp, constraints={"max_iterations": 2})
    assert cp.load(RID).context.max_iterations == 2


# ---------------------------------------------------------------------------
# item 9: whether the deterministic floor RAN is part of the result
# ---------------------------------------------------------------------------


def test_result_reports_that_the_schema_floor_was_skipped(cp):
    _to_validating(cp)
    d = _step(cp, "vera", VERA_PASS)
    assert d["result"]["schema_checked"] is False  # oracle never ran — visible, not silent


def test_result_reports_that_the_schema_floor_ran(cp):
    _to_validating(cp, cls=_ValidIdealPrd)
    d = _step(cp, "vera", VERA_PASS, cls=_ValidIdealPrd)
    assert d["result"]["schema_checked"] is True
    assert d["result"]["met"] is True


# ---------------------------------------------------------------------------
# item 5: the prompts must NOT depend on the summary_schema_restatement LOAN.
# That directive returns "" under PI_MODEL_TIER=strong or ablation — i.e. on
# exactly the stronger-model path — so a prompt that defers its key list to it
# loses the contract precisely when we upgrade.
# ---------------------------------------------------------------------------


def _prompt_summary_keys(agent: str) -> set:
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    text = (root / ".pi" / "skills" / "prd" / "assets" / "prompts" / f"{agent}.md").read_text(
        encoding="utf-8"
    )
    keys: set = set()
    for line in text.splitlines():
        m = re.search(r'SUMMARY:(\{".*)', line)
        if m:
            keys |= set(re.findall(r'"([^"]+)"\s*:', m.group(1)))
    return keys


@pytest.mark.parametrize(
    "agent,spec",
    [("synthia", PRD_GENERATE), ("vera", PRD_VALIDATE)],
)
def test_prompt_carries_its_own_summary_contract_without_the_loan(agent, spec, monkeypatch):
    # Strong tier + ablation both blank the engine's OUTPUT FORMAT directive.
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    monkeypatch.setenv("PENNY_ABLATE_SUMMARY_SCHEMA_RESTATEMENT", "1")
    assert PrdPlaybook._summary_contract_directive(spec) == ""  # the crutch is gone
    required = set(spec.summary_contract.get("required", {}))
    prompt_keys = _prompt_summary_keys(agent)
    assert required <= prompt_keys, (
        f"{agent}.md must name its own required SUMMARY keys "
        f"(missing {sorted(required - prompt_keys)}) — it cannot rely on the "
        f"summary_schema_restatement loan, which is OFF for strong models."
    )


# ---------------------------------------------------------------------------
# item 10: opt-in cross-model verification hook (model_for_state).
# independence.py classifies prd's synthia->vera edge SAME_MODEL; this is the
# hook that lets a caller/ops opt into a genuinely independent validator.
# ---------------------------------------------------------------------------


def _ctx(constraints=None):
    return RunContext(
        session_id=SID, run_id=RID, playbook="prd", goal=GOAL, constraints=constraints or {}
    )


def test_unset_is_unchanged_no_override_for_any_state(cp, monkeypatch):
    # SM1: the default path must be byte-identical to before the hook existed.
    for key in ("PRD_VERA", "PRD_SYNTHIA", "PRD_DEFAULT"):
        monkeypatch.delenv(key, raising=False)
    pb = PrdPlaybook(cp)
    assert pb.model_for_state("validating", _ctx()) is None
    assert pb.model_for_state("generating", _ctx()) is None


def test_validate_model_constraint_selects_the_validator_model(cp):
    # SM2: the constraint drives `validating` only.
    ctx = _ctx({"validate_model": "ollama/glm"})
    pb = PrdPlaybook(cp)
    assert pb.model_for_state("validating", ctx) == "ollama/glm"
    assert pb.model_for_state("generating", ctx) is None  # scoped: never the generator


def test_validate_model_constraint_beats_the_env_tier(cp, monkeypatch):
    monkeypatch.setenv("PRD_VERA", "ollama/other")
    ctx = _ctx({"validate_model": "ollama/glm"})
    assert PrdPlaybook(cp).model_for_state("validating", ctx) == "ollama/glm"


def test_env_tier_is_honored_when_no_constraint(cp, monkeypatch):
    # SM3: PRD_VERA (per-agent) beats PRD_DEFAULT.
    monkeypatch.setenv("PRD_DEFAULT", "ollama/fallback")
    assert PrdPlaybook(cp).model_for_state("validating", _ctx()) == "ollama/fallback"
    monkeypatch.setenv("PRD_VERA", "ollama/specific")
    assert PrdPlaybook(cp).model_for_state("validating", _ctx()) == "ollama/specific"


@pytest.mark.parametrize("bad", ["", "   ", "noslash", "has space/model", "/leading", "trailing/"])
def test_malformed_ENV_values_fall_through_and_never_raise(cp, monkeypatch, bad):
    # SM3 (fail-safe): the ENV tier is strict — a typo in ops config must never break a
    # run, it falls through to the agent's own model.
    monkeypatch.setenv("PRD_VERA", bad)
    assert PrdPlaybook(cp).model_for_state("validating", _ctx()) is None


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_constraint_falls_through_to_the_env_tier(cp, monkeypatch, blank):
    for key in ("PRD_VERA", "PRD_DEFAULT"):
        monkeypatch.delenv(key, raising=False)
    assert PrdPlaybook(cp).model_for_state("validating", _ctx({"validate_model": blank})) is None


@pytest.mark.parametrize("value", ["haiku", "ollama/glm", "anthropic/claude-sonnet-4"])
def test_constraint_tier_is_deliberately_permissive(cp, value):
    # The CONSTRAINT tier is intentionally NOT format-validated, unlike the env tier:
    # agent-runner.ts (~613) documents that "a bare override (no '/') keeps the legacy
    # model-only meaning", so a caller passing a bare model name is legitimate.
    # Applying _is_valid_provider_model here would silently ignore that caller.
    # Matches the jsa/sca precedent, which also only .strip()s the constraint.
    assert PrdPlaybook(cp).model_for_state("validating", _ctx({"validate_model": value})) == value


def test_none_constraints_are_guarded(cp):
    ctx = RunContext(session_id=SID, run_id=RID, playbook="prd")
    ctx.constraints = None
    assert PrdPlaybook(cp).model_for_state("validating", ctx) is None


def test_hook_does_not_reclassify_the_independence_edge():
    # SM4: the hook is OPT-IN and off by default, so the default path is still
    # same-model bare judgement — the edge must stay SAME_MODEL and registered.
    from orchestration import independence as ind

    edge = next(e for e in ind.VERIFY_EDGES if e.skill == "prd")
    assert ind.classify(edge) == ind.SAME_MODEL
    assert "prd" in ind.SAME_MODEL_EXCEPTIONS
    assert ind.check_independence() == []  # invariant still holds


# ---------------------------------------------------------------------------
# item 11: deterministic artifact facts + the rules-tier floor.
# The functions are PURE, so these run without MemPalace. Structure is derived
# (template + artifact-to-artifact set comparison), never a hardcoded vocabulary.
# ---------------------------------------------------------------------------

from orchestration.playbooks.prd import (  # noqa: E402
    _extract_json,
    artifact_facts,
    declared_sections,
    hard_contradictions,
)

_CATALOG = [
    {"id": "REQ-001", "priority": "P0", "title": "a", "acceptance_criteria": ["x", "y"]},
    {"id": "REQ-002", "priority": "P1", "title": "b", "acceptance_criteria": ["x", "y"]},
]
_MATRIX = {
    "REQ-001": {"unit_tests": ["t1"], "e2e_tests": []},
    "REQ-002": {"unit_tests": ["t2"], "e2e_tests": []},
}
_NARRATIVE = "\n".join(f"## {i}. Section {i}\nbody" for i in range(1, 13))


def test_extract_json_handles_a_drawer_header_and_nested_braces():
    body = 'sid Requirement Catalog\n\n[{"id":"REQ-001","d":{"k":"]"}}]'
    assert _extract_json(body) == [{"id": "REQ-001", "d": {"k": "]"}}]
    assert _extract_json("no json here") is None
    assert _extract_json("") is None


def test_facts_are_counts_not_judgements():
    f = artifact_facts(
        narrative=_NARRATIVE, catalog=_CATALOG, matrix=_MATRIX,
        ideal={"success_criteria": ["a", "b"], "deliverables": ["f.py"]},
        declared=set(range(1, 13)),
    )
    assert f["narrative_sections_found"] == 12
    assert f["narrative_sections_missing"] == []
    assert f["requirement_count"] == 2 and f["catalog_ids"] == 2
    assert f["matrix_missing_ids"] == [] and f["matrix_unknown_ids"] == []
    assert f["ideal_success_criteria"] == 2 and f["ideal_deliverables"] == 1
    assert hard_contradictions(f) == []


def test_the_id_key_is_discovered_not_assumed():
    # Structure is DERIVED: renaming the id field must not blind the check (item 16
    # will change this schema, and this floor has to survive that).
    renamed = [{"requirement_id": "REQ-001", "acceptance_criteria": ["x"]}]
    f = artifact_facts(catalog=renamed, matrix={"REQ-001": {"unit_tests": ["t"]}})
    assert f["catalog_id_key"] == "requirement_id"
    assert f["catalog_ids"] == 1 and f["matrix_missing_ids"] == []


def test_floor_catches_a_requirement_missing_from_the_matrix():
    f = artifact_facts(catalog=_CATALOG, matrix={"REQ-001": {"unit_tests": ["t"]}})
    assert f["matrix_missing_ids"] == ["REQ-002"]
    assert any("omits requirement" in c for c in hard_contradictions(f))


def test_floor_catches_duplicate_ids_and_unknown_matrix_keys():
    dup = _CATALOG + [{"id": "REQ-001", "acceptance_criteria": ["z"]}]
    f = artifact_facts(catalog=dup, matrix={**_MATRIX, "REQ-999": {"unit_tests": ["t"]}})
    assert f["catalog_duplicate_ids"] == ["REQ-001"]
    issues = hard_contradictions(f)
    assert any("duplicate ids" in c for c in issues)
    assert any("unknown id" in c for c in issues)


def test_floor_catches_a_requirement_with_no_verification_strategy():
    f = artifact_facts(catalog=_CATALOG, matrix={"REQ-001": {"unit_tests": ["t"]}, "REQ-002": {}})
    assert f["matrix_ids_without_strategy"] == ["REQ-002"]
    assert any("no verification strategy" in c for c in hard_contradictions(f))


def test_criteria_vs_metric_count_is_REPORTED_not_floored():
    # The live miss that motivated item 11 (5 criteria asserted "1:1" with 6 metrics).
    # It is surfaced as a fact for the verifier, NOT failed: merging two metrics into
    # one criterion is defensible, so this is judgement, not contradiction.
    f = artifact_facts(catalog=_CATALOG, matrix=_MATRIX, ideal={"success_criteria": [1, 2, 3, 4, 5]})
    assert f["ideal_success_criteria"] == 5
    assert hard_contradictions(f) == []


def test_section_coverage_is_reported_not_floored():
    f = artifact_facts(narrative="## 1. Overview\n## 2. Problem", declared=set(range(1, 13)))
    assert f["narrative_sections_missing"] == list(range(3, 13))
    assert hard_contradictions(f) == []  # item 12 is still under review; do not harden it


def test_declared_sections_are_read_from_the_template_not_hardcoded():
    from orchestration.playbooks.prd import skill_root

    declared = declared_sections(skill_root(RunContext(session_id="s", run_id="r", playbook="prd")))
    assert declared == set(range(1, 13))  # whatever prd-template.md declares today
    assert declared_sections("") == set()  # unresolvable -> facts omitted, never a crash


def test_facts_never_raise_on_garbage():
    assert artifact_facts(catalog="not-a-list", matrix="not-a-dict", ideal="nope") == {}
    assert hard_contradictions({}) == []


class _FactsPrd(PrdPlaybook):
    """Artifacts readable, with REQ-002 missing from the matrix."""

    def _read_artifacts(self, ctx):
        return {
            "narrative": _NARRATIVE,
            "requirement catalog": "hdr\n\n" + json.dumps(_CATALOG),
            "verification matrix": "hdr\n\n" + json.dumps({"REQ-001": {"unit_tests": ["t"]}}),
        }

    def _read_ideal_state(self, ctx):
        return {"goal": "g", "success_criteria": ["c1"]}


def test_rules_floor_overrides_a_vera_pass_on_an_objective_contradiction(cp):
    # vera PASSes, but REQ-002 has no matrix entry — code decides, not judgement.
    _to_validating(cp, cls=_FactsPrd)
    d = _step(cp, "vera", VERA_PASS, cls=_FactsPrd)
    assert d["action"] == "invoke_agent" and d["state_id"] == "generating"  # forced revise
    prd = cp.load(RID).context.extras["prd"]
    assert prd["valid"] is False
    assert any("omits requirement" in c for c in prd["artifact_contradictions"])
    assert prd["artifact_facts"]["requirement_count"] == 2


def test_computed_counts_are_handed_to_vera_in_her_task(cp):
    _to_validating(cp, cls=_FactsPrd)
    _step(cp, "vera", _vera_fail(["x"]), cls=_FactsPrd)
    _step(cp, "synthia", SYNTH_SUMMARY, cls=_FactsPrd)
    rec = cp.load(RID)
    task = _FactsPrd(cp)._task_summary("validating", None, rec.context)
    assert "computed deterministically" in task
    assert "requirement_count=2" in task


def test_extract_json_picks_the_earliest_bracket_not_the_array_first():
    # Regression: an object whose values contain arrays must not parse as the inner
    # array. This silently reduced the whole verification matrix to ["t"].
    body = 'sid Verification Matrix\n\n{"REQ-001": {"unit_tests": ["t"]}}'
    assert _extract_json(body) == {"REQ-001": {"unit_tests": ["t"]}}
    # and an array payload still wins when it genuinely comes first
    assert _extract_json('hdr\n\n[{"id":"REQ-001"}]') == [{"id": "REQ-001"}]


# ---------------------------------------------------------------------------
# item 11 regression: artifact SELECTION. A live run reported "0/12 sections
# found" for a narrative that had all 12, because the loose header scan matched
# the Validate report and a diagnostic note, and no recency rule was applied.
# vera caught it, but it cost a full revision cycle.
# ---------------------------------------------------------------------------

from orchestration.playbooks.prd import select_artifacts  # noqa: E402

_NARR_V1 = "sid PRD Narrative (SYNTHESIS mode)\n\n## 1. Overview\nv1"
_NARR_V2 = "sid PRD Narrative (REVISION mode)\n\n" + "\n".join(
    f"## {i}. S{i}\nbody" for i in range(1, 13)
)


def test_selection_ignores_the_validate_report_that_mentions_the_narrative():
    # The exact shape that produced the false 0/12.
    validate = "## sid Validate\n\nValidator: Vera. Narrative: all 12 sections present."
    got = select_artifacts([(validate, "2026-07-30T08:17"), (_NARR_V2, "2026-07-30T08:20")])
    assert got["narrative"] == _NARR_V2


def test_selection_ignores_a_diagnostic_note_naming_the_narrative():
    note = "sid Synthia Diagnostic Note — narrative-section-count discrepancy\n\nno sections here"
    got = select_artifacts([(note, "2026-07-30T08:35"), (_NARR_V2, "2026-07-30T08:20")])
    assert got["narrative"] == _NARR_V2  # newer note must NOT win — it isn't an artifact


def test_selection_keeps_the_newest_revision_of_an_artifact():
    got = select_artifacts([(_NARR_V2, "2026-07-30T08:20"), (_NARR_V1, "2026-07-30T08:14")])
    assert got["narrative"] == _NARR_V2
    # order of presentation must not matter
    got2 = select_artifacts([(_NARR_V1, "2026-07-30T08:14"), (_NARR_V2, "2026-07-30T08:20")])
    assert got2["narrative"] == _NARR_V2


def test_selection_end_to_end_yields_the_right_section_count():
    validate = "## sid Validate (pass 2)\n\nNarrative: 12/12 sections found."
    note = "sid Synthia Diagnostic Note — narrative-section-count\n\nnothing"
    picked = select_artifacts([
        (_NARR_V1, "2026-07-30T08:14"),
        (validate, "2026-07-30T08:17"),
        (_NARR_V2, "2026-07-30T08:20"),
        (note, "2026-07-30T08:35"),
    ])
    f = artifact_facts(narrative=picked["narrative"], declared=set(range(1, 13)))
    assert f["narrative_sections_found"] == 12  # was 0 in the live run
    assert f["narrative_sections_missing"] == []


def test_selection_picks_catalog_and_matrix_by_exact_contract_name():
    got = select_artifacts([
        ("sid Requirement Catalog\n\n[]", "1"),
        ("sid Verification Matrix\n\n{}", "1"),
        ("sid PRD Narrative\n\n## 1. A", "1"),
    ])
    assert set(got) == {"narrative", "requirement catalog", "verification matrix"}
