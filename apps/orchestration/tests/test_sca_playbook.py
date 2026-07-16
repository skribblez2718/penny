"""Integration tests for the migrated sca skill (ScaPlaybook) on the engine.

Exercises the strictly-sequential 13-phase pipeline, the 6 human gates
(GATE_AFTER charter/context/threat/triage, GATE_BEFORE verification, GATE_AT
report), the in-process deterministic tool phases (baseline/targeted scan) with
the baseline all-tools-missing HARD BLOCK, the bounded P9→P7 augmentation loop
with honest cap disclosure, the single-shot evidence-grounded PoC verification,
needs_clarification / UNCERTAIN escalation + resume, and the recovery contract.

Every real scanner / Docker / report-writing seam is OVERRIDDEN by a stub
subclass so tests NEVER run semgrep / osv-scanner / gitleaks / docker. The
lightweight deterministic domain helpers (census, charter draft) DO run against
a tmp target dir — they are pure filesystem reads.
"""

from pathlib import Path

import pytest

import orchestration.playbooks as pb_mod
from orchestration.checkpointer import STATUS_AWAITING_USER, STATUS_ERROR, Checkpointer
from orchestration.playbooks.sca import ScaPlaybook

SID, RID = "sess-sca", "run-sca"
REPO_ROOT = str(Path(__file__).resolve().parents[3])  # .../penny


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


@pytest.fixture
def target(tmp_path):
    """A minimal on-disk source tree (so census/charter draft have real data)."""
    d = tmp_path / "app"
    d.mkdir()
    (d / "index.js").write_text("console.log('hi')\n", encoding="utf-8")
    (d / "package-lock.json").write_text("{}\n", encoding="utf-8")
    return str(d)


# ---------------------------------------------------------------------------
# Stub playbook: overrides every real-tool seam with canned deterministic data.
# ---------------------------------------------------------------------------


class StubSca(ScaPlaybook):
    blocked_baseline = False

    def _run_baseline(self, ctx):
        if self.blocked_baseline:
            return {"blocked": True, "completed": False, "errors": ["no required tools"]}
        return {
            "blocked": False,
            "available": ["semgrep"],
            "missing_required": [],
            "coverage_gaps": [],
            "severity_counts": {"high": 1},
            "tool_versions": {},
            "findings": [{"id": "f1", "severity": "high"}],
            "findings_path": None,
            "coverage_path": None,
            "mempalace": {"wing": "wing_sca", "room": "r2", "content": "baseline stub"},
        }

    def _run_targeted(self, ctx):
        return {
            "blocked": False,
            "semgrep_available": True,
            "available": ["semgrep"],
            "coverage_gaps": [],
            "severity_counts": {"high": 1},
            "tool_versions": {},
            "prior_findings_count": 1,
            "new_findings_count": 0,
            "findings": [{"id": "f1", "severity": "high"}],
            "targeted_rule_files": [],
            "findings_path": None,
            "coverage_path": None,
            "mempalace": {"wing": "wing_sca", "room": "r7", "content": "targeted stub"},
        }

    poc_batches = None  # optional queue of executed-results, popped per _run_pocs call (tests)

    def _run_pocs(self, ctx, summary):
        meta = ctx.extras["sca"]
        if type(self).poc_batches:
            result = type(self).poc_batches.pop(0)
        else:
            result = {
                "executed": [{"name": "p1", "verification_status": "poc_executed_pending_review"}],
                "skipped": [],
                "sandbox_available": True,
                "poc_requested_count": 1,
                "poc_executed_count": 1,
                "poc_skipped_count": 0,
            }
        meta["verification"] = result
        return result

    def _write_augment_rules(self, ctx, summary):
        ctx.extras["sca"].setdefault("augment_rules_written", []).append("stub.yml")
        return ["stub.yml"]

    def _build_report(self, ctx):
        meta = ctx.extras["sca"]
        summary = {
            "report_dir": (meta.get("output_dir", "") + "/report"),
            "findings_source": "targeted",
            "findings_source_degraded": False,
            "total_findings": 1,
            "severity_counts": {"high": 1},
            "augment_capped": bool(meta.get("augment_capped", False)),
            "sandbox_available": True,
            "verification_present": True,
        }
        meta["report"] = summary
        return summary

    def _write_report(self, ctx, summary):
        meta = ctx.extras["sca"]
        report_md = summary.get("report_md")
        present = isinstance(report_md, str) and report_md.strip() != ""
        meta.setdefault("report", {})["report_md_written"] = True
        meta["report_md_present"] = present
        return present


def _start(cp, target, cls=StubSca, constraints=None):
    c = {"target_path": target}
    c.update(constraints or {})
    return cls(cp).start(
        session_id=SID, run_id=RID, goal="analyze", constraints=c, project_root=REPO_ROOT
    )


def _step(cp, agent, result, cls=StubSca):
    return cls(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _approve(cp, cls=StubSca):
    return _step(cp, "user", {"user_response": "approve"}, cls=cls)


# ---------------------------------------------------------------------------
# start + target validation
# ---------------------------------------------------------------------------


def test_start_dispatches_charter_echo(cp, target):
    d = _start(cp, target)
    assert d["action"] == "invoke_agent" and d["agent"] == "echo"
    assert d["state_id"] == "charter"
    assert "wing_sca" in d["task_summary"]


def test_recall_lessons_render_in_first_directive(cp, target):
    from orchestration.playbooks.sca import SCA_CHARTER

    pb = StubSca(cp)
    pb.start(
        session_id=SID,
        run_id=RID,
        goal="analyze",
        constraints={"target_path": target},
        project_root=REPO_ROOT,
    )
    ctx = cp.load(RID).context
    ctx.recall_lessons = ["prefer an executed PoC over an asserted severity"]
    txt = pb._task_summary("charter", SCA_CHARTER, ctx)
    assert "Lessons from prior runs" in txt
    assert "executed PoC" in txt


def test_start_rejects_url_target(cp):
    d = StubSca(cp).start(
        session_id=SID,
        run_id=RID,
        goal="analyze",
        constraints={"target_path": "https://example.com/repo.git"},
        project_root=REPO_ROOT,
    )
    assert d["action"] == "error"
    assert any("LOCAL source trees" in e for e in d["errors"])


# ---------------------------------------------------------------------------
# charter GATE_AFTER (structured questionnaire) + gate approve
# ---------------------------------------------------------------------------


def test_charter_result_opens_charter_gate(cp, target):
    _start(cp, target)
    d = _step(cp, "echo", {"charter_confirmed": True})
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "charter_gate"
    # structured charter questionnaire (not the generic approve/revise only)
    assert any(q.get("id") == "p0_charter_gate" for q in d["questions"])
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "charter_gate"


def test_charter_approve_advances_to_census(cp, target):
    _start(cp, target)
    _step(cp, "echo", {"charter_confirmed": True})
    d = _step(cp, "user", {"user_response": "approve", "out_of_scope": "vendor/\n"})
    assert d["action"] == "invoke_agent" and d["agent"] == "echo" and d["state_id"] == "census"
    # the submitted out_of_scope was merged into the charter
    rec = cp.load(RID)
    assert rec.context.extras["sca"]["charter"]["out_of_scope"] == ["vendor/"]
    assert "charter" in rec.context.extras["sca"]["cleared_gates"]


def test_charter_revise_reruns_charter(cp, target):
    _start(cp, target)
    _step(cp, "echo", {"charter_confirmed": True})
    d = _step(cp, "user", {"user_response": "narrow scope to /src"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "charter"
    assert "User clarification: narrow scope to /src" in d["task_summary"]


# ---------------------------------------------------------------------------
# census -> baseline_scan (TOOL, inline) -> context
# ---------------------------------------------------------------------------


def _to_census(cp, target, cls=StubSca, constraints=None):
    _start(cp, target, cls=cls, constraints=constraints)
    _step(cp, "echo", {"charter_confirmed": True}, cls=cls)
    _approve(cp, cls=cls)  # charter gate


def test_census_runs_baseline_tool_then_dispatches_context(cp, target):
    _to_census(cp, target)
    d = _step(cp, "echo", {"census_confirmed": True})
    # baseline_scan tool ran inline; the run lands on the synthia context phase.
    assert d["action"] == "invoke_agent" and d["agent"] == "synthia"
    assert d["state_id"] == "context"
    rec = cp.load(RID)
    meta = rec.context.extras["sca"]
    assert meta["baseline_scan"]["completed"] is True
    # scan mempalace drawer STUB captured for Penny to replay post-completion.
    assert any(s["phase"] == "P2_BASELINE_SCAN" for s in meta["mempalace_stubs"])


def test_baseline_hard_block_all_tools_missing_errors(cp, target):
    class Blocked(StubSca):
        blocked_baseline = True

    _to_census(cp, target, cls=Blocked)
    d = _step(cp, "echo", {"census_confirmed": True}, cls=Blocked)
    assert d["action"] == "error"
    rec = cp.load(RID)
    assert rec.status == STATUS_ERROR


# ---------------------------------------------------------------------------
# full happy path to complete
# ---------------------------------------------------------------------------


# Real emitted SUMMARY shapes (match the assets/prompts/*.md templates exactly):
# scalar/dict counts, NOT lists. These exercise the corrected optional-field types.
_CONTEXT_SUMMARY = {
    "confidence": "CERTAIN",
    "actors": [{"name": "user", "trust": "low"}],
    "data_classes": ["pii"],
    "pii_processed": True,
    "pii_evidence": "email + name stored in users table",  # STR (one line), not list
    "external_integrations": ["stripe"],
}
_THREAT_SUMMARY = {
    "confidence": "CERTAIN",
    "threats": 4,  # INT count
    "stride": True,  # BOOL
    "linddun": False,  # BOOL
    "linddun_reason": "no privacy-relevant data flows",
    "cwe_mapped": 3,  # INT count
    "owasp_api_mapped": 2,  # INT count
    "ungrounded": 0,  # INT count
    "known_gaps": ["no SR-### ledger yet"],
}
_TRIAGE_SUMMARY = {
    "confidence": "CERTAIN",
    "triaged": 5,
    "confirmed": 2,
    "needs_deep_dive": 1,  # INT count
    "false_positive": 2,  # INT count
    "by_severity": {"critical": 0, "high": 1, "medium": 1, "low": 0},
    "evidence_basis": {"observed": 3, "inferred": 1, "assumed": 1, "unknown": 0},  # DICT
    "secrets_redacted": 0,  # INT count
    "coverage_gaps": ["no dynamic analysis"],
}
_DEEP_DIVE_SUMMARY = {
    "confidence": "CERTAIN",
    "deep_dived": 1,
    "tool_blind_findings": {
        "idor": 1,
        "authz": 0,
        "business_logic": 0,
        "race_condition": 0,
    },  # DICT
    "new_confirmed": 0,
    "augment_requested": False,
    "new_rules": 0,  # INT count
    "evidence_basis": {"observed": 1, "inferred": 0, "assumed": 0, "unknown": 0},  # DICT
}


def _walk_to_deep_dive(cp, target, cls=StubSca, constraints=None):
    _to_census(cp, target, cls=cls, constraints=constraints)
    _step(cp, "echo", {"census_confirmed": True}, cls=cls)  # -> baseline -> context
    _step(cp, "synthia", dict(_CONTEXT_SUMMARY), cls=cls)  # context -> context_gate
    _approve(cp, cls=cls)  # context gate -> architecture
    _step(cp, "synthia", {"confidence": "CERTAIN"}, cls=cls)  # architecture -> requirements
    _step(cp, "synthia", {"confidence": "CERTAIN"}, cls=cls)  # requirements -> threat_model
    _step(cp, "tabitha", dict(_THREAT_SUMMARY), cls=cls)  # threat -> threat_gate
    _approve(cp, cls=cls)  # threat gate -> targeted_scan (tool) -> triage
    _step(cp, "annie", dict(_TRIAGE_SUMMARY), cls=cls)  # triage -> triage_gate
    d = _approve(cp, cls=cls)  # triage gate -> deep_dive
    return d


def test_walk_reaches_deep_dive(cp, target):
    d = _walk_to_deep_dive(cp, target)
    assert d["action"] == "invoke_agent" and d["agent"] == "annie"
    assert d["state_id"] == "deep_dive"


def test_full_happy_path_to_complete(cp, target):
    _walk_to_deep_dive(cp, target)
    # deep_dive (no augment) -> verification_gate (GATE_BEFORE)
    d = _step(cp, "annie", dict(_DEEP_DIVE_SUMMARY))
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "verification_gate"
    # approve -> dispatch vera exactly once
    d = _approve(cp)
    assert (
        d["action"] == "invoke_agent" and d["agent"] == "vera" and d["state_id"] == "verification"
    )
    # vera returns an executed-PoC batch (evidence-grounded) -> fix_verification.
    # findings_covered is an INT count (matches vera-verification.md template).
    d = _step(
        cp,
        "vera",
        {
            "run_pocs": [{"name": "p1"}],
            "confidence": "CERTAIN",
            "pocs_requested": 1,
            "findings_covered": 1,
            "non_destructive_all": True,
            "single_shot": True,
        },
    )
    assert d["agent"] == "vera" and d["state_id"] == "fix_verification"
    # fix_verification -> report_gate (GATE_AT). appear_* / indeterminate are INT
    # counts (matches vera-fix-verification.md template).
    d = _step(
        cp,
        "vera",
        {
            "confidence": "CERTAIN",
            "findings_reviewed": 2,
            "appear_remediated": 1,
            "appear_open": 0,
            "indeterminate": 1,
            "rescan_performed": False,
        },
    )
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "report_gate"
    # approve -> dispatch skribble exactly once
    d = _approve(cp)
    assert d["agent"] == "skribble" and d["state_id"] == "report"
    # skribble returns the narrative -> complete
    d = _step(cp, "skribble", {"report_md": "# SCA Report\n\nfindings...\n"})
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["report_md_present"] is True
    assert d["result"]["findings_summary"]["total_findings"] == 1
    assert d["result"]["augment_capped"] is False


def test_dual_verify_runs_a_second_independent_reverification(cp, target):
    _walk_to_deep_dive(
        cp, target, constraints={"dual_verify": True, "reverify_model": "other/model"}
    )
    d = _step(cp, "annie", dict(_DEEP_DIVE_SUMMARY))  # deep_dive -> verification_gate
    assert d["action"] == "escalate_to_user"
    d = _approve(cp)  # -> verification (vera)
    assert d["agent"] == "vera" and d["state_id"] == "verification"
    # first PoC batch -> a SECOND independent verifier (reverification), not fix_verification
    d1 = _step(cp, "vera", {"run_pocs": [{"name": "p1"}], "confidence": "CERTAIN"})
    assert d1["agent"] == "vera" and d1["state_id"] == "reverification"
    assert d1["model"] == "other/model"  # independent judge
    assert "DUAL-VERIFY" in d1["task_summary"]
    # second batch -> fix_verification; agreement recorded
    d2 = _step(cp, "vera", {"run_pocs": [{"name": "p1"}], "confidence": "CERTAIN"})
    assert d2["state_id"] == "fix_verification"
    assert cp.load(RID).context.extras["sca"]["dual_verify_agreed"] is True


def test_dual_verify_off_by_default_goes_straight_to_fix_verification(cp, target):
    _walk_to_deep_dive(cp, target)  # no dual_verify
    _step(cp, "annie", dict(_DEEP_DIVE_SUMMARY))
    _approve(cp)  # -> verification
    d = _step(cp, "vera", {"run_pocs": [{"name": "p1"}], "confidence": "CERTAIN"})
    assert d["state_id"] == "fix_verification"
    assert "reverification" not in cp.load(RID).context.extras["sca"]


def test_missing_run_pocs_field_is_rejected(cp, target):
    # run_pocs is REQUIRED (present, a list) so vera must report the PoC batch it
    # executed; a SUMMARY with no run_pocs field is a contract violation and is
    # re-issued (retried) rather than advancing.
    _walk_to_deep_dive(cp, target)
    _step(cp, "annie", {"confidence": "CERTAIN"})  # -> verification_gate
    _approve(cp)  # -> verification (dispatch vera)
    d = _step(cp, "vera", {"confidence": "CERTAIN"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "verification"


def test_empty_run_pocs_batch_advances_honestly(cp, target):
    # An EMPTY run_pocs batch is a valid honest outcome (nothing exploitable) —
    # it advances to fix_verification rather than pressuring a fabricated PoC.
    _walk_to_deep_dive(cp, target)
    _step(cp, "annie", {"confidence": "CERTAIN"})  # -> verification_gate
    _approve(cp)  # -> verification (dispatch vera)
    d = _step(cp, "vera", {"run_pocs": [], "confidence": "CERTAIN"})
    assert d["action"] == "invoke_agent" and d["state_id"] == "fix_verification"


def test_report_without_report_md_completes_honestly(cp, target):
    _walk_to_deep_dive(cp, target)
    _step(cp, "annie", {"confidence": "CERTAIN"})
    _approve(cp)
    _step(cp, "vera", {"run_pocs": [{"name": "p1"}], "confidence": "CERTAIN"})
    _step(cp, "vera", {"confidence": "CERTAIN"})
    _approve(cp)  # -> report (skribble)
    d = _step(cp, "skribble", {"notes": "no narrative produced"})
    assert d["action"] == "complete"
    # honest exhaustion: report built but no narrative -> met=False, fallback used
    assert d["result"]["met"] is False
    assert d["result"]["report_md_present"] is False


# ---------------------------------------------------------------------------
# bounded augmentation loop (cap-enforced, honest disclosure)
# ---------------------------------------------------------------------------


def test_augment_loop_capped_and_disclosed(cp, target):
    _walk_to_deep_dive(cp, target, constraints={"augment_cap": 2})
    # new_rules in the SUMMARY is an INT count (matches annie-deep-dive.md); the
    # actual rule specs travel at the top level of the result and are consumed by
    # write_augment_rules — stubbed here, so the loop mechanics don't depend on them.
    aug = {
        "confidence": "CERTAIN",
        "augment": True,
        "tool_blind_findings": {"idor": 1, "authz": 0, "business_logic": 0, "race_condition": 0},
        "new_rules": 1,
    }
    # grant #1: re-run targeted scan then re-triage (annie) — gate stays cleared.
    d = _step(cp, "annie", aug)
    assert d["state_id"] == "triage" and d["agent"] == "annie"
    d = _step(cp, "annie", {"confidence": "CERTAIN"})  # cleared gate -> deep_dive (skip)
    assert d["state_id"] == "deep_dive"
    # grant #2
    d = _step(cp, "annie", aug)
    assert d["state_id"] == "triage"
    d = _step(cp, "annie", {"confidence": "CERTAIN"})
    assert d["state_id"] == "deep_dive"
    # request #3 exceeds the cap -> REFUSED, augment_capped set, advance to verify.
    d = _step(cp, "annie", aug)
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "verification_gate"
    rec = cp.load(RID)
    meta = rec.context.extras["sca"]
    assert meta["augment_capped"] is True
    assert meta["augment_iterations"] == 2


# ---------------------------------------------------------------------------
# needs_clarification + UNCERTAIN escalation, resume at the escalating phase
# ---------------------------------------------------------------------------


def _to_context(cp, target):
    _to_census(cp, target)
    _step(cp, "echo", {"census_confirmed": True})  # -> baseline -> context


def test_needs_clarification_escalates(cp, target):
    _to_context(cp, target)
    d = _step(
        cp,
        "synthia",
        {
            "confidence": "CERTAIN",
            "needs_clarification": True,
            "clarifying_questions": ["monolith or microservices?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "monolith or microservices?" in d["unknown_reason"]
    assert d["previous_state"] == "context"


def test_uncertain_confidence_escalates(cp, target):
    _to_context(cp, target)
    d = _step(cp, "synthia", {"confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"


def test_clarify_resumes_at_escalating_phase(cp, target):
    _to_context(cp, target)
    _step(cp, "synthia", {"confidence": "UNCERTAIN"})
    d = _step(cp, "user", {"answer": "target the monolith"})
    # resumes back at the SAME phase that escalated (context), not the pipeline top.
    assert d["action"] == "invoke_agent" and d["agent"] == "synthia" and d["state_id"] == "context"
    assert "target the monolith" in d["task_summary"]


# ---------------------------------------------------------------------------
# recovery re-presents a pending gate (uses the REAL registered playbook)
# ---------------------------------------------------------------------------


def test_recovery_re_presents_charter_gate(cp, target):
    from orchestration.recovery import recover_pending

    # Reach the charter gate with the real playbook (no scanners needed at P0).
    ScaPlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal="analyze",
        constraints={"target_path": target},
        project_root=REPO_ROOT,
    )
    ScaPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="echo", result={"charter_confirmed": True}
    )
    # Register so recovery resolves the playbook before AND after real registration.
    orig = dict(pb_mod.PLAYBOOKS)
    pb_mod.PLAYBOOKS.setdefault("sca", ScaPlaybook)
    try:
        directives = recover_pending(cp, session_id=SID, playbook="sca")
    finally:
        pb_mod.PLAYBOOKS.clear()
        pb_mod.PLAYBOOKS.update(orig)
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "charter_gate"


# ---------------------------------------------------------------------------
# T5/T6/T7a: per-finding dual-verify agreement from sandbox PoC exit codes
# ---------------------------------------------------------------------------


def test_demonstrated_ids_uses_unfabricatable_exit_code():
    from orchestration.playbooks.sca import _demonstrated_ids

    result = {
        "executed": [
            {"finding_id": "A", "sandbox_used": True, "timed_out": False, "exit_code": 0},   # demonstrated
            {"finding_id": "B", "sandbox_used": True, "timed_out": False, "exit_code": 1},   # non-zero -> no
            {"finding_id": "C", "sandbox_used": True, "timed_out": True, "exit_code": 0},    # timed out -> no
            {"finding_id": "D", "sandbox_used": False, "timed_out": False, "exit_code": 0},  # no sandbox -> no
            {"finding_id": None, "sandbox_used": True, "timed_out": False, "exit_code": 0},  # no finding_id -> no
        ]
    }
    assert _demonstrated_ids(result) == ["A"]
    assert _demonstrated_ids({}) == []


def _poc_batch(ids):
    return {
        "executed": [
            {"name": f"p{i}", "finding_id": i, "sandbox_used": True, "timed_out": False, "exit_code": 0}
            for i in ids
        ],
        "skipped": [],
        "sandbox_available": True,
        "poc_requested_count": len(ids),
        "poc_executed_count": len(ids),
        "poc_skipped_count": 0,
    }


def test_dual_verify_per_finding_agreement_from_exit_codes(cp, target):
    # T5/T7a: pass1 demonstrates {A,B}; pass2 demonstrates {B,C} (all exit 0, sandbox, no
    # timeout). Agreement = INTERSECTION {B}; A and C are single-pass -> UNCONFIRMED. The
    # coarse executed-count parity would have falsely reported "agreed" (both ran 2 PoCs).
    StubSca.poc_batches = [_poc_batch(["A", "B"]), _poc_batch(["B", "C"])]
    try:
        _walk_to_deep_dive(
            cp, target, constraints={"dual_verify": True, "reverify_model": "other/model"}
        )
        _step(cp, "annie", dict(_DEEP_DIVE_SUMMARY))
        _approve(cp)  # -> verification
        _step(cp, "vera", {"run_pocs": [{"name": "pA"}], "confidence": "CERTAIN"})  # -> reverification
        d = _step(cp, "vera", {"run_pocs": [{"name": "pB"}], "confidence": "CERTAIN"})  # -> fix_verification
        assert d["state_id"] == "fix_verification"
        sca = cp.load(RID).context.extras["sca"]
        assert sca["dual_verify_agreed_findings"] == ["B"]
        assert sca["dual_verify_unconfirmed_findings"] == ["A", "C"]
        assert sca["dual_verify_agreed"] is False
    finally:
        StubSca.poc_batches = None


class _GateSca(StubSca):
    def _domain(self, ctx):  # the report_gate prompt path doesn't use the domain
        return None


def test_report_gate_surfaces_dual_verify_disagreement(cp):
    from orchestration.context import RunContext

    pb = _GateSca(cp)
    ctx = RunContext(session_id="s", run_id="r", playbook="sca")
    ctx.extras["sca"] = {
        "dual_verify_unconfirmed_findings": ["A"],
        "dual_verify_agreed_findings": ["B"],
    }
    prompt = pb.gate_questions("report_gate", ctx)[0]["prompt"]
    assert "DUAL-VERIFY DISAGREEMENT" in prompt
    assert "UNCONFIRMED" in prompt and "'A'" in prompt and "'B'" in prompt


def test_report_gate_no_disagreement_is_plain(cp):
    from orchestration.context import RunContext

    pb = _GateSca(cp)
    ctx = RunContext(session_id="s", run_id="r", playbook="sca")
    ctx.extras["sca"] = {}
    prompt = pb.gate_questions("report_gate", ctx)[0]["prompt"]
    assert "DUAL-VERIFY DISAGREEMENT" not in prompt
