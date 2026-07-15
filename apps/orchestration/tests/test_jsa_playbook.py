"""Integration tests for the migrated jsa skill (JSAPlaybook) on the engine.

Exercises the INTAKE schema gate (validate + re-ask), the long deterministic
TOOL_STATE run (acquire → … → slice) executed inline, the INVESTIGATE wave loop
(bounded fan-through with honest unverified reporting), the auto-advance through
collect into the evidence-grounded VERIFY oracle and agent tail to completion,
UNCERTAIN / needs_clarification escalation, and recovery.

The tool execution seam ``_domain_run`` is overridden here so NO real scanner
(semgrep / jsluice / OSV / joern / katana) and NO skill-dir import ever runs —
tests are hermetic. Each ``_step`` builds a FRESH playbook instance against a tmp
Checkpointer (the run_id/checkpointer contract).
"""

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, STATUS_RUNNING, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.jsa import JSAMachine, JSAPlaybook

SID, RID = "sess-jsa", "run-jsa"

_VALID_INTAKE = {
    "target_url": "https://example.com",
    "authenticated_testing": "anonymous_only",
    "session_management": "cookie",
}


class FakeJSA(JSAPlaybook):
    """JSAPlaybook with the deterministic tool seam stubbed: records the phase
    order and seeds the wave plan, without importing the skill-dir or running any
    scanner."""

    NAME = "jsa"
    needs_llm_count = 5  # -> 1 wave (ceil(5/10)=1)
    canned_stubs: list | None = None

    def _domain_run(self, ctx, phase):
        jsa = ctx.extras.setdefault("jsa", {})
        jsa.setdefault("ran", []).append(phase)
        if phase == "slice":
            jsa.setdefault("investigate", {})["needs_llm"] = self.needs_llm_count

    def _read_mempalace_stubs(self, ctx):
        return list(self.canned_stubs) if self.canned_stubs is not None else []

    def _persist_learned_rules(self, ctx, new_rules):
        # Hermetic: no skill-dir import / semgrep. Echo inputs as "written".
        return {
            "written": [r.get("filename") for r in new_rules],
            "rejected": [],
            "dir": "/fake/learned/jsa",
        }


def _start(cp, constraints=None, cls=FakeJSA):
    return cls(cp).start(
        session_id=SID,
        run_id=RID,
        goal="analyze https://example.com",
        constraints=constraints or {},
    )


def _step(cp, agent, result, cls=FakeJSA):
    return cls(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


# ---------------------------------------------------------------------------
# FSM well-formedness (mirrors the base contract expectations)
# ---------------------------------------------------------------------------


def test_machine_has_required_control_states():
    m = JSAMachine()
    ids = {s.id for s in m.states}
    assert {"intake", "unknown", "awaiting_clarification", "complete", "error"} <= ids
    # intake is the initial gate; complete/error are final.
    assert m.intake.initial
    assert m.complete.final and m.error.final


def test_escalatable_states_are_reachable_by_to_unknown():
    # Every ESCALATABLE state must have a to_unknown edge (else _escalate wedges).
    m = JSAMachine()
    sources = {t.source.id for s in m.states for t in s.transitions if t.event == "to_unknown"}
    assert JSAPlaybook.ESCALATABLE_STATES <= sources


# ---------------------------------------------------------------------------
# INTAKE gate: valid-upfront skips the gate; missing opens it
# ---------------------------------------------------------------------------


def test_start_with_valid_intake_runs_tools_to_investigate(cp):
    d = _start(cp, constraints={"intake": _VALID_INTAKE})
    assert (
        d["action"] == "invoke_agent" and d["agent"] == "annie" and d["state_id"] == "investigate"
    )
    rec = cp.load(RID)
    assert rec.current_state_id == "investigate" and rec.status == STATUS_RUNNING
    # All 10 deterministic phases ran inline (collect runs later, after the waves).
    assert rec.context.extras["jsa"]["ran"] == [
        "acquire",
        "cve_research",
        "sast_scan",
        "normalize",
        "dedup_within_source",
        "correlate_evidence",
        "agent_review",
        "sast_validate",
        "structure",
        "slice",
    ]
    # Model-agnostic: NO per-state model override and NO local-model hint in the
    # task text — annie (like every agent) resolves its own frontmatter model.
    assert "model" not in d
    assert "qwen" not in d["task_summary"].lower()
    assert "ollama" not in d["task_summary"].lower()
    assert "Wave 1/1" in d["task_summary"]


def test_start_missing_intake_opens_gate(cp):
    d = _start(cp, constraints={})
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "intake"
    ids = {q["id"] for q in d["questions"]}
    assert "target_url" in ids and "authenticated_testing" in ids
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "intake"


def test_intake_gate_invalid_answer_reasks_only_missing(cp):
    _start(cp, constraints={})
    # Provide only the URL — auth mode + session still missing -> re-ask those.
    d = _step(cp, "user", {"responses": {"target_url": "https://example.com"}})
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "intake"
    ids = {q["id"] for q in d["questions"]}
    assert ids == {"authenticated_testing", "session_management"}


def test_intake_gate_valid_answer_advances_to_investigate(cp):
    _start(cp, constraints={})
    d = _step(cp, "user", {"responses": _VALID_INTAKE})
    assert (
        d["action"] == "invoke_agent" and d["agent"] == "annie" and d["state_id"] == "investigate"
    )


def test_intake_conditional_auth_instructions_required(cp):
    # authenticated_only makes auth_instructions required_when -> still gated.
    _start(cp, constraints={})
    d = _step(
        cp,
        "user",
        {
            "responses": {
                "target_url": "https://example.com",
                "authenticated_testing": "authenticated_only",
                "session_management": "cookie",
            }
        },
    )
    assert d["action"] == "escalate_to_user"
    assert {q["id"] for q in d["questions"]} == {"auth_instructions"}


def test_intake_accepts_novel_session_mechanism(cp):
    # #15: session_management is free text now — a novel/hybrid scheme the old enum
    # would hard-reject is accepted, so a real target can actually be described.
    _start(cp, constraints={})
    d = _step(
        cp,
        "user",
        {
            "responses": {
                "target_url": "https://example.com",
                "authenticated_testing": "anonymous_only",
                "session_management": "passkeys + rotating refresh token (WebAuthn)",
            }
        },
    )
    assert (
        d["action"] == "invoke_agent"
        and d["agent"] == "annie"
        and d["state_id"] == "investigate"
    )


# ---------------------------------------------------------------------------
# INVESTIGATE wave loop (bounded fan-through)
# ---------------------------------------------------------------------------


def _to_investigate(cp, cls=FakeJSA):
    _start(cp, constraints={"intake": _VALID_INTAKE}, cls=cls)


def test_single_wave_advances_to_merge(cp):
    _to_investigate(cp)
    d = _step(cp, "annie", {"wave_complete": True, "confidence": "PROBABLE", "unverified_count": 2})
    # Waves exhausted -> collect runs inline -> merge dispatched, with NO human gate.
    assert d["action"] == "invoke_agent" and d["agent"] == "synthia" and d["state_id"] == "merge"
    assert cp.load(RID).context.extras["jsa"]["ran"][-1] == "collect"
    # Honest exhaustion is preserved on the run (surfaced later in result_payload).
    assert cp.load(RID).context.extras["jsa"]["investigate"]["unverified"] == 2


def test_wave_loop_redispatches_annie_until_waves_exhausted(cp):
    class TwoWave(FakeJSA):
        needs_llm_count = 15  # ceil(15/10) = 2 waves

    _to_investigate(cp, cls=TwoWave)
    d1 = _step(cp, "annie", {"wave_complete": True, "confidence": "PROBABLE"}, cls=TwoWave)
    # More waves remain -> annie re-dispatched (self-loop), still at investigate.
    assert (
        d1["action"] == "invoke_agent"
        and d1["agent"] == "annie"
        and d1["state_id"] == "investigate"
    )
    assert "Wave 2/2" in d1["task_summary"]
    d2 = _step(cp, "annie", {"wave_complete": True, "confidence": "CERTAIN"}, cls=TwoWave)
    # Final wave -> auto-advance through collect to merge (no human gate).
    assert d2["action"] == "invoke_agent" and d2["agent"] == "synthia" and d2["state_id"] == "merge"


def test_wave_size_is_a_tunable_budget(cp):
    # WAVE_SIZE is no longer a frozen constant: constraints.wave_size sets the
    # batch, so needs_llm=12 at wave_size=5 seeds ceil(12/5)=3 waves.
    class BigWave(FakeJSA):
        needs_llm_count = 12

    BigWave(cp).start(
        session_id=SID,
        run_id=RID,
        goal="analyze https://example.com",
        constraints={"intake": _VALID_INTAKE, "wave_size": 5},
    )
    d = _step(cp, "annie", {"wave_complete": True, "confidence": "PROBABLE"}, cls=BigWave)
    assert "Wave 2/3" in d["task_summary"]
    assert cp.load(RID).context.extras["jsa"]["investigate"]["wave_size"] == 5


def test_recall_lessons_render_in_first_directive(cp):
    from orchestration.playbooks.jsa import JSA_INVESTIGATE

    pb = JSAPlaybook(cp)
    ctx = RunContext(session_id=SID, run_id=RID, playbook="jsa", goal="analyze https://example.com")
    ctx.recall_lessons = ["verify DOM XSS with a live browser PoC, never by pattern alone"]
    ctx.extras["jsa"] = {"investigate": {"wave": 0, "total_waves": 1}}
    txt = pb._task_summary("investigate", JSA_INVESTIGATE, ctx)
    assert "Lessons from prior runs" in txt
    assert "live browser PoC" in txt


# ---------------------------------------------------------------------------
# After the wave loop the pipeline flows straight into collect -> merge (no gate)
# ---------------------------------------------------------------------------


def _to_merge(cp, cls=FakeJSA):
    """Run to the point where the final wave has fired and merge (synthia) is
    dispatched — collect ran inline, with no human gate in between."""
    _to_investigate(cp, cls=cls)
    _step(cp, "annie", {"wave_complete": True, "confidence": "PROBABLE"}, cls=cls)


# ---------------------------------------------------------------------------
# Agent tail to completion (evidence-grounded VERIFY)
# ---------------------------------------------------------------------------


def _through_merge(cp):
    _to_merge(cp)


def test_full_happy_path_to_complete(cp):
    _through_merge(cp)
    d_verify = _step(
        cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE", "merged_count": 4}
    )
    assert d_verify["agent"] == "vera" and d_verify["state_id"] == "verify"
    # SCOPE hard constraint is present in the verify task.
    assert "OUT OF SCOPE" in d_verify["task_summary"]
    d_report = _step(
        cp,
        "vera",
        {
            "verdict": "PASS",
            "gaps": [],
            "confidence": "CERTAIN",
            "evidence": ["executed browser-PoC transcript: alert(1) fired on /search?q=<script>"],
            "verified_count": 3,
        },
    )
    assert d_report["agent"] == "skribble" and d_report["state_id"] == "report"
    d_reflect = _step(
        cp,
        "skribble",
        {
            "report_complete": True,
            "confidence": "CERTAIN",
            "reports_written": 3,
            "application_context": ["DOM XSS runs as the victim in their authed session on app.js"],
        },
    )
    assert d_reflect["agent"] == "carren" and d_reflect["state_id"] == "reflect"
    d = _step(cp, "carren", {"reflect_complete": True})
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["verify_verdict"] == "PASS"
    assert d["result"]["counts"]["verified"] == 3


def _to_verify_with_dual(cp, **extra):
    FakeJSA(cp).start(
        session_id=SID,
        run_id=RID,
        goal="analyze https://example.com",
        constraints={"intake": _VALID_INTAKE, "dual_verify": True, **extra},
    )
    _step(cp, "annie", {"wave_complete": True, "confidence": "PROBABLE"})  # investigate -> merge
    return _step(
        cp, "synthia", {"merge_complete": True, "merged_count": 2, "confidence": "PROBABLE"}
    )


_VPASS = {
    "verdict": "PASS",
    "gaps": [],
    "confidence": "CERTAIN",
    "evidence": ["poc transcript"],
    "verified_count": 2,
}


def test_dual_verify_runs_a_second_independent_verifier_on_a_different_model(cp):
    d0 = _to_verify_with_dual(cp, reverify_model="anthropic/other")
    assert d0["agent"] == "vera" and d0["state_id"] == "verify"
    # A PASS routes to a SECOND independent verifier (reverify), not report.
    d1 = _step(cp, "vera", _VPASS)
    assert d1["agent"] == "vera" and d1["state_id"] == "reverify"
    assert d1["model"] == "anthropic/other"  # independent judge
    assert "INDEPENDENT re-verification" in d1["task_summary"]
    # Second pass confirms -> report; agreement recorded.
    d2 = _step(cp, "vera", {**_VPASS, "evidence": ["independent poc transcript"]})
    assert d2["agent"] == "skribble" and d2["state_id"] == "report"
    assert cp.load(RID).context.extras["jsa"]["dual_verify_agreed"] is True


def test_dual_verify_disagreement_is_recorded_honestly(cp):
    _to_verify_with_dual(cp)
    _step(cp, "vera", _VPASS)  # first PASS -> reverify
    # Second verifier could NOT reproduce -> FAIL; disagreement recorded.
    d = _step(
        cp,
        "vera",
        {
            "verdict": "FAIL",
            "gaps": ["could not reproduce finding #2"],
            "confidence": "CERTAIN",
            "evidence": ["attempted PoC, no trigger"],
        },
    )
    assert d["agent"] == "skribble" and d["state_id"] == "report"
    jsa = cp.load(RID).context.extras["jsa"]
    assert jsa["dual_verify_agreed"] is False
    assert jsa["reverify"]["could_not_reproduce"] == ["could not reproduce finding #2"]


def test_dual_verify_per_finding_disagreement_demotes_single_pass(cp):
    # T5/T6: verify PASSes {A,B}; reverify PASSes {B,C}. Agreement = the INTERSECTION {B};
    # A and C are single-pass -> DEMOTED to 'unconfirmed', never 'agreed' (which the coarse
    # top-level-verdict signal would have falsely reported, since both passes are PASS).
    _to_verify_with_dual(cp)
    _step(cp, "vera", {**_VPASS, "verified_findings": [
        {"finding_id": "A", "verdict": "PASS", "evidence": "poc-A"},
        {"finding_id": "B", "verdict": "PASS", "evidence": "poc-B"},
    ]})
    d = _step(cp, "vera", {**_VPASS, "evidence": ["independent poc"], "verified_findings": [
        {"finding_id": "B", "verdict": "PASS", "evidence": "poc-B2"},
        {"finding_id": "C", "verdict": "PASS", "evidence": "poc-C"},
    ]})
    assert d["agent"] == "skribble" and d["state_id"] == "report"
    jsa = cp.load(RID).context.extras["jsa"]
    assert jsa["dual_verify_agreed_findings"] == ["B"]
    assert jsa["dual_verify_unconfirmed_findings"] == ["A", "C"]
    assert jsa["dual_verify_agreed"] is False  # a single-pass finding exists -> not full agreement
    # T6: the report task DEMOTES the single-pass findings (reported unconfirmed, never verified)
    assert "UNCONFIRMED" in d["task_summary"]
    assert "'A'" in d["task_summary"] and "'C'" in d["task_summary"] and "'B'" in d["task_summary"]


def test_dual_verify_per_finding_full_agreement(cp):
    # Both passes confirm the SAME findings {A,B} -> fully agreed, no demotion.
    _to_verify_with_dual(cp)
    vf = [
        {"finding_id": "A", "verdict": "PASS", "evidence": "a"},
        {"finding_id": "B", "verdict": "PASS", "evidence": "b"},
    ]
    _step(cp, "vera", {**_VPASS, "verified_findings": vf})
    d = _step(cp, "vera", {**_VPASS, "evidence": ["ind"], "verified_findings": vf})
    assert d["agent"] == "skribble" and d["state_id"] == "report"
    jsa = cp.load(RID).context.extras["jsa"]
    assert jsa["dual_verify_agreed_findings"] == ["A", "B"]
    assert jsa["dual_verify_unconfirmed_findings"] == []
    assert jsa["dual_verify_agreed"] is True
    assert "UNCONFIRMED" not in d["task_summary"]  # nothing demoted


def test_dual_verify_off_by_default_goes_straight_to_report(cp):
    # No dual_verify constraint: a PASS routes directly to report (no reverify).
    _to_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "merged_count": 2, "confidence": "PROBABLE"})
    d = _step(cp, "vera", _VPASS)
    assert d["agent"] == "skribble" and d["state_id"] == "report"
    assert "reverify" not in cp.load(RID).context.extras["jsa"]


def test_report_requires_application_context_narrative(cp):
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    d_report = _step(
        cp,
        "vera",
        {
            "verdict": "PASS",
            "gaps": [],
            "confidence": "CERTAIN",
            "evidence": ["poc transcript"],
            "verified_count": 1,
        },
    )
    assert d_report["agent"] == "skribble" and d_report["state_id"] == "report"
    # The report task demands a within-the-application exploitability + impact narrative.
    t = d_report["task_summary"].lower()
    assert "context of this application" in t and "exploit" in t and "impact" in t
    # A skribble SUMMARY WITHOUT application_context violates the contract -> retried.
    d_retry = _step(
        cp, "skribble", {"report_complete": True, "confidence": "CERTAIN", "reports_written": 1}
    )
    assert (
        d_retry["action"] == "invoke_agent"
        and d_retry["agent"] == "skribble"
        and d_retry["state_id"] == "report"
    )
    # With the narrative present, it advances to reflect.
    d_ok = _step(
        cp,
        "skribble",
        {
            "report_complete": True,
            "confidence": "CERTAIN",
            "reports_written": 1,
            "application_context": ["stored XSS in comments runs for every viewer of the thread"],
        },
    )
    assert d_ok["agent"] == "carren" and d_ok["state_id"] == "reflect"


def test_reflect_persists_learned_rules_for_sast_gaps(cp):
    # Self-improving SAST: carren emits new_rules for a confirmed miss; the
    # playbook persists them and surfaces the count in the completion payload.
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    _step(
        cp,
        "vera",
        {
            "verdict": "PASS",
            "gaps": [],
            "confidence": "CERTAIN",
            "evidence": ["poc transcript"],
            "verified_count": 1,
        },
    )
    _step(
        cp,
        "skribble",
        {
            "report_complete": True,
            "confidence": "CERTAIN",
            "reports_written": 1,
            "application_context": ["DOM XSS runs in the victim's authed session"],
        },
    )
    d = _step(
        cp,
        "carren",
        {
            "reflect_complete": True,
            "new_rules": [
                {
                    "filename": "dom_xss-createcontextualfragment.yaml",
                    "yaml_content": "rules:\n  - id: jsa-learned-x\n    pattern: $R.createContextualFragment($X)\n",
                    "vuln_class": "dom_xss",
                    "rationale": "confirmed miss in app.js",
                },
            ],
        },
    )
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["learned_rules_written"] == 1


def test_reflect_no_rules_when_scanner_missed_nothing(cp):
    # Empty new_rules is the honest normal case; nothing is persisted.
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    _step(
        cp,
        "vera",
        {
            "verdict": "PASS",
            "gaps": [],
            "confidence": "CERTAIN",
            "evidence": ["poc"],
            "verified_count": 1,
        },
    )
    _step(
        cp,
        "skribble",
        {
            "report_complete": True,
            "confidence": "CERTAIN",
            "reports_written": 1,
            "application_context": ["x"],
        },
    )
    d = _step(cp, "carren", {"reflect_complete": True})
    assert d["action"] == "complete"
    assert d["result"]["learned_rules_written"] == 0


def test_verify_missing_evidence_field_is_rejected(cp):
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    # `evidence` is REQUIRED (present, a list) so vera must report the transcripts
    # it ran; a SUMMARY with no evidence field is a contract violation, retried.
    d = _step(cp, "vera", {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN"})
    assert d["action"] == "invoke_agent" and d["agent"] == "vera" and d["state_id"] == "verify"


def test_verify_empty_evidence_advances_honestly(cp):
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    # An EMPTY transcript list is a valid honest outcome (clean target) — it
    # advances rather than pressuring a fabricated PoC.
    d = _step(cp, "vera", {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN", "evidence": []})
    assert d["action"] == "invoke_agent" and d["agent"] == "skribble" and d["state_id"] == "report"


def test_verify_claimed_positive_with_empty_evidence_is_gated(cp):
    # #T7b: a PASS claiming verified findings (verified_count>0) with an EMPTY transcript
    # list is now REJECTED by the conditional-evidence gate and vera is re-issued to
    # attach the executed-PoC transcripts — realizing the gate vera-base.md already
    # promises. Fires ONLY on the agent's own claimed positive, so clean targets stay free.
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    d = _step(
        cp,
        "vera",
        {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN", "evidence": [], "verified_count": 2},
    )
    assert d["action"] == "invoke_agent" and d["agent"] == "vera" and d["state_id"] == "verify"
    assert cp.load(RID).context.step_retries == 1


def test_verify_claimed_positive_with_evidence_advances(cp):
    # #T7b: verified_count>0 WITH attached PoC transcripts passes the gate -> advances.
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    d = _step(
        cp,
        "vera",
        {
            "verdict": "PASS", "gaps": [], "confidence": "CERTAIN",
            "evidence": ["PoC: navigated /x, payload fired, DOM mutated, screenshot p.png"],
            "verified_count": 2,
        },
    )
    assert d["action"] == "invoke_agent" and d["agent"] == "skribble" and d["state_id"] == "report"


def test_verify_clean_target_zero_count_empty_evidence_advances(cp):
    # #T7b: a clean target (verified_count==0) is NEVER pressured — empty evidence is fine.
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    d = _step(
        cp,
        "vera",
        {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN", "evidence": [], "verified_count": 0},
    )
    assert d["action"] == "invoke_agent" and d["agent"] == "skribble" and d["state_id"] == "report"


# ---------------------------------------------------------------------------
# Escalation: UNCERTAIN + needs_clarification, and clarify resume
# ---------------------------------------------------------------------------


def test_investigate_uncertain_escalates_then_clarify_resumes(cp):
    _to_investigate(cp)
    d = _step(cp, "annie", {"wave_complete": True, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "investigate"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "awaiting_clarification"
    d2 = _step(cp, "user", {"answer": "focus on the auth flow in app.js"})
    assert (
        d2["action"] == "invoke_agent"
        and d2["agent"] == "annie"
        and d2["state_id"] == "investigate"
    )


def test_verify_needs_clarification_escalates(cp):
    _through_merge(cp)
    _step(cp, "synthia", {"merge_complete": True, "confidence": "PROBABLE"})
    d = _step(
        cp,
        "vera",
        {
            "verdict": "FAIL",
            "gaps": ["blocked by WAF"],
            "confidence": "PROBABLE",
            "evidence": ["partial transcript"],
            "needs_clarification": True,
            "clarifying_questions": ["is the WAF in scope to bypass?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "is the WAF in scope to bypass?" in d["unknown_reason"]


# ---------------------------------------------------------------------------
# result_payload surfaces the mempalace-stub handoff
# ---------------------------------------------------------------------------


def test_result_payload_surfaces_mempalace_stubs(cp):
    class Stubbed(FakeJSA):
        canned_stubs = [
            {"wing": "wing_jsa", "room": f"{SID}-sast-findings", "content": "…"},
            {"wing": "wing_jsa", "room": f"{SID}-cve-research", "content": "…"},
        ]

    # Run the full de-gated pipeline to completion, then inspect the payload.
    _to_merge(cp, cls=Stubbed)
    _step(
        cp,
        "synthia",
        {"merge_complete": True, "confidence": "PROBABLE", "merged_count": 4},
        cls=Stubbed,
    )
    _step(
        cp,
        "vera",
        {
            "verdict": "PASS",
            "gaps": [],
            "confidence": "CERTAIN",
            "evidence": ["executed browser-PoC transcript"],
            "verified_count": 1,
        },
        cls=Stubbed,
    )
    _step(
        cp,
        "skribble",
        {
            "report_complete": True,
            "confidence": "CERTAIN",
            "reports_written": 1,
            "application_context": ["IDOR on /api/orders exposes other users' PII"],
        },
        cls=Stubbed,
    )
    d = _step(cp, "carren", {"reflect_complete": True}, cls=Stubbed)
    assert d["action"] == "complete"
    assert d["result"]["mempalace_stubs_count"] == 2
    assert d["result"]["wing"] == "wing_jsa"
    assert d["result"]["rooms"]["sast"] == f"{SID}-sast-findings"
    assert "memory_add_drawer" in d["result"]["mempalace_handoff"]


# ---------------------------------------------------------------------------
# Recovery (registered via setdefault so it passes before + after real registration)
# ---------------------------------------------------------------------------


def test_recovery_re_presents_intake_gate(cp):
    from orchestration import playbooks as pb_mod
    from orchestration.recovery import recover_pending

    _start(cp, constraints={})  # missing intake -> awaiting_user at the INTAKE gate
    orig = dict(pb_mod.PLAYBOOKS)
    pb_mod.PLAYBOOKS.setdefault("jsa", FakeJSA)
    try:
        directives = recover_pending(cp, session_id=SID, playbook="jsa")
    finally:
        pb_mod.PLAYBOOKS.clear()
        pb_mod.PLAYBOOKS.update(orig)
    assert len(directives) == 1
    assert (
        directives[0]["action"] == "escalate_to_user"
        and directives[0]["previous_state"] == "intake"
    )


def test_mid_tool_crash_recovers_by_rerunning_tool_loop(cp):
    from orchestration import playbooks as pb_mod
    from orchestration.recovery import recover_pending

    # Simulate a crash mid deterministic pipeline: persist running at 'structure'.
    pb = FakeJSA(cp)
    pb.ctx = RunContext(session_id=SID, run_id=RID, playbook="jsa")
    pb.ctx.extras["jsa"] = {
        "target_url": "https://example.com",
        "output_dir": "/tmp/jsa-example-com",
    }
    pb.sm = JSAMachine()
    pb.sm.current_state_value = "structure"
    cp.save(
        run_id=RID,
        session_id=SID,
        playbook="jsa",
        current_state_id="structure",
        context=pb.ctx,
        status=STATUS_RUNNING,
    )
    orig = dict(pb_mod.PLAYBOOKS)
    pb_mod.PLAYBOOKS["jsa"] = FakeJSA  # force the stubbed tool seam
    try:
        directives = recover_pending(cp, session_id=SID, playbook="jsa")
    finally:
        pb_mod.PLAYBOOKS.clear()
        pb_mod.PLAYBOOKS.update(orig)
    # Recovery re-drives structure -> slice -> investigate (tools are idempotent).
    assert len(directives) == 1
    assert directives[0]["action"] == "invoke_agent" and directives[0]["state_id"] == "investigate"
    assert cp.load(RID).context.extras["jsa"]["ran"] == ["structure", "slice"]
