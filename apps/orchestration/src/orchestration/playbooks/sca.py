"""ScaPlaybook — the sca (Secure-Code Analysis) skill on the shared engine.

A faithful behavioral port of the legacy ~3,400-line ``.pi/skills/sca``
orchestrator (SCAPipelineOrchestrator + fsm.SCAPhaseMachine) onto
``BasePlaybook``. sca is a resumable, SECURITY-CRITICAL, strictly-sequential
13-phase pipeline with 6 human gates and a locked-down Docker PoC sandbox. This
migration preserves every gate, the augmentation-loop cap, and the single-shot
non-fabricating PoC contract; the durable SQLite checkpointer replaces the
legacy /tmp/sca-<session_id>.json state file (obviating the bespoke anti-tamper).

State map (lowercase custom names → legacy phase → agent):
  charter(P0,echo)·[charter_gate] → census(P1,echo) → baseline_scan(P2,TOOL)
  → context(P3,synthia)·[context_gate] → architecture(P4,synthia)
  → requirements(P5,synthia) → threat_model(P6,tabitha)·[threat_gate]
  → targeted_scan(P7,TOOL) → triage(P8,annie)·[triage_gate]
  → deep_dive(P9,annie) ⇄ targeted_scan (bounded augment loop, cap=3)
  → [verification_gate] → verification(P10,vera, single-shot PoC batch)
  → fix_verification(P11,vera) → [report_gate] → report(P12,skribble) → complete

Gate seams (all on the engine's planned-gate protocol, each pauses exactly once):
  * GATE_AFTER {charter,context,threat_model,triage}: the phase's agent result
    routes to a *_gate state that pauses; approve advances, revise re-runs the
    phase. A gate cleared once STAYS cleared (so the augment loop re-entering
    triage does NOT re-gate — matches the legacy cleared_gates semantics).
  * GATE_BEFORE {verification_gate}: pauses BEFORE dispatching vera; approve
    enters ``verification`` which dispatches vera exactly once.
  * GATE_AT {report_gate}: pauses on entering the report phase; approve enters
    ``report`` which builds the deterministic artifacts + dispatches skribble
    exactly once; completion happens on skribble's return.

Deterministic tool phases (baseline_scan / targeted_scan) run in-process with NO
agent via ``run_tool_state`` and overridable ``_run_baseline`` / ``_run_targeted``
seams (tests subclass and override them so real semgrep/osv/gitleaks never run).
baseline HARD-BLOCKS to error only when ALL required tools are missing; targeted
never blocks. The heavy domain logic (census, charter draft, augment-rule
writing, PoC processing, report artifacts) lives in the skill-dir module
``.pi/skills/sca/scripts/sca_domain.py``, imported LAZILY after the skill dir is
put on sys.path.

Honesty invariants preserved: PoCs are recorded ``poc_executed_pending_review``
(never auto pass/fail); a capped augment loop is disclosed in the report; a
missing skribble narrative writes an HONEST fallback; coverage gaps are recorded,
never fabricated. The needs_clarification / UNCERTAIN-confidence escalation the
legacy declared-but-ignored is now wired through progress_check → the engine's
HITL path.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import PrimitiveSpec

# ---------------------------------------------------------------------------
# Skill-dir domain-tool loading (the flat-importing scanner + domain modules
# live in .pi/skills/sca/scripts and are imported LAZILY after this runs).
# ---------------------------------------------------------------------------


def _ensure_skill_tools(project_root: str, skill: str) -> None:
    d = os.path.join(project_root or os.getcwd(), ".pi", "skills", skill, "scripts")
    if d and d not in sys.path:
        sys.path.insert(0, d)


DEFAULT_AUGMENT_CAP = 3
MEMPALACE_WING = "wing_sca"

# lowercase state -> legacy phase name (room naming + phase-result capture keys).
STATE_TO_PHASE = {
    "charter": "P0_CHARTER",
    "census": "P1_CENSUS",
    "baseline_scan": "P2_BASELINE_SCAN",
    "context": "P3_CONTEXT",
    "architecture": "P4_ARCHITECTURE",
    "requirements": "P5_REQUIREMENTS",
    "threat_model": "P6_THREAT_MODEL",
    "targeted_scan": "P7_TARGETED_SCAN",
    "triage": "P8_TRIAGE",
    "deep_dive": "P9_DEEP_DIVE",
    "verification": "P10_VERIFICATION",
    "fix_verification": "P11_FIX_VERIFICATION",
    "report": "P12_REPORT",
}

# Per-state domain-guidance prompt file (skill-relative). sca uses phase-specific
# prompts (echo-charter vs echo-census, …), so the driver's bare {agent}.md
# fallback would miss them — the playbook names the exact file via skill_context.
_PROMPT_BY_STATE = {
    "charter": "echo-charter",
    "census": "echo-census",
    "context": "synthia-context",
    "architecture": "synthia-architecture",
    "requirements": "synthia-requirements",
    "threat_model": "tabitha-threat-model",
    "triage": "annie-triage",
    "deep_dive": "annie-deep-dive",
    "verification": "vera-verification",
    "fix_verification": "vera-fix-verification",
    "report": "skribble-report",
}

PHASE_DESC = {
    "P0_CHARTER": "Establish the analysis charter, scope, and rules of engagement",
    "P1_CENSUS": "Inventory the repository: languages, entry points, dependencies",
    "P3_CONTEXT": "Gather business/domain context for the target",
    "P4_ARCHITECTURE": "Reconstruct the architecture and trust boundaries",
    "P5_REQUIREMENTS": "Derive security requirements from context and architecture",
    "P6_THREAT_MODEL": "Build the threat model against requirements",
    "P8_TRIAGE": "Triage findings: dedup, prioritize, filter false positives",
    "P9_DEEP_DIVE": "Deep-dive suspicious findings; surface new targets",
    "P10_VERIFICATION": "Verify exploitability of confirmed findings",
    "P11_FIX_VERIFICATION": "Verify proposed fixes close the findings",
    "P12_REPORT": "Assemble the final secure-code-analysis report",
}

_APPROVE_WORDS = frozenset({"approve", "approved", "confirm", "proceed", "yes", "accept"})


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class SCAMachine(StateMachine):
    # Set by ScaPlaybook._resume before the base fires ``clarify`` so the
    # UNCERTAIN/needs-clarification resume lands back on the escalating phase.
    resume_target: str = ""

    intake = State(initial=True)
    charter = State()
    charter_gate = State()
    census = State()
    baseline_scan = State()  # TOOL (deterministic scan, no agent)
    context = State()
    context_gate = State()
    architecture = State()
    requirements = State()
    threat_model = State()
    threat_gate = State()
    targeted_scan = State()  # TOOL (deterministic scan, no agent; augment target)
    triage = State()
    triage_gate = State()
    deep_dive = State()
    verification_gate = State()  # GATE_BEFORE vera
    verification = State()
    fix_verification = State()
    report_gate = State()  # GATE_AT skribble
    report = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    # -- linear + gate transitions ----------------------------------------
    start_charter = intake.to(charter)

    charter_gate_ev = charter.to(charter_gate)
    charter_skip = charter.to(census)  # gate already cleared (defensive)
    charter_ok = charter_gate.to(census)
    charter_revise = charter_gate.to(charter)

    census_done = census.to(baseline_scan)
    baseline_done = baseline_scan.to(context)

    context_gate_ev = context.to(context_gate)
    context_skip = context.to(architecture)
    context_ok = context_gate.to(architecture)
    context_revise = context_gate.to(context)

    architecture_done = architecture.to(requirements)
    requirements_done = requirements.to(threat_model)

    threat_gate_ev = threat_model.to(threat_gate)
    threat_skip = threat_model.to(targeted_scan)
    threat_ok = threat_gate.to(targeted_scan)
    threat_revise = threat_gate.to(threat_model)

    targeted_done = targeted_scan.to(triage)

    triage_gate_ev = triage.to(triage_gate)
    triage_skip = triage.to(deep_dive)  # gate already cleared (augment re-entry)
    triage_ok = triage_gate.to(deep_dive)
    triage_revise = triage_gate.to(triage)

    dd_augment = deep_dive.to(targeted_scan)  # bounded augment loop
    dd_verify = deep_dive.to(verification_gate)

    vgate_ok = verification_gate.to(verification)
    verification_done = verification.to(fix_verification)
    fix_done = fix_verification.to(report_gate)
    rgate_ok = report_gate.to(report)
    report_done = report.to(complete)

    # -- escalation (only agent phases are escalatable) -------------------
    to_unknown = (
        charter.to(unknown)
        | census.to(unknown)
        | context.to(unknown)
        | architecture.to(unknown)
        | requirements.to(unknown)
        | threat_model.to(unknown)
        | triage.to(unknown)
        | deep_dive.to(unknown)
        | verification.to(unknown)
        | fix_verification.to(unknown)
        | report.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    # Conditional multi-target resume: back to whichever phase escalated
    # (resume_target set by the playbook), with a conservative fallback.
    clarify = (
        awaiting_clarification.to(charter, cond="rt_charter")
        | awaiting_clarification.to(census, cond="rt_census")
        | awaiting_clarification.to(context, cond="rt_context")
        | awaiting_clarification.to(architecture, cond="rt_architecture")
        | awaiting_clarification.to(requirements, cond="rt_requirements")
        | awaiting_clarification.to(threat_model, cond="rt_threat_model")
        | awaiting_clarification.to(triage, cond="rt_triage")
        | awaiting_clarification.to(deep_dive, cond="rt_deep_dive")
        | awaiting_clarification.to(verification, cond="rt_verification")
        | awaiting_clarification.to(fix_verification, cond="rt_fix_verification")
        | awaiting_clarification.to(report, cond="rt_report")
        | awaiting_clarification.to(context)  # fallback (should never fire)
    )

    abort = (
        intake.to(error)
        | charter.to(error)
        | charter_gate.to(error)
        | census.to(error)
        | baseline_scan.to(error)
        | context.to(error)
        | context_gate.to(error)
        | architecture.to(error)
        | requirements.to(error)
        | threat_model.to(error)
        | threat_gate.to(error)
        | targeted_scan.to(error)
        | triage.to(error)
        | triage_gate.to(error)
        | deep_dive.to(error)
        | verification_gate.to(error)
        | verification.to(error)
        | fix_verification.to(error)
        | report_gate.to(error)
        | report.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )

    # -- clarify guards (read resume_target) ------------------------------
    def rt_charter(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "charter"

    def rt_census(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "census"

    def rt_context(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "context"

    def rt_architecture(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "architecture"

    def rt_requirements(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "requirements"

    def rt_threat_model(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "threat_model"

    def rt_triage(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "triage"

    def rt_deep_dive(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "deep_dive"

    def rt_verification(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "verification"

    def rt_fix_verification(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "fix_verification"

    def rt_report(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "report"


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts (custom-named; validated against spec.summary_contract)
# ---------------------------------------------------------------------------


def _c(required: dict, optional: dict | None = None, evidence: tuple[str, ...] = ()) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        contract["evidence"] = evidence
    return contract


_CLARIFY_OPT = {"needs_clarification": bool, "clarifying_questions": list, "confidence": str}

SCA_CHARTER = PrimitiveSpec(
    "SCA_CHARTER",
    "echo",
    _c(
        {"charter_confirmed": bool},
        {
            "lockfiles_ok": bool,
            "workspace_count": int,
            "scope_gaps": list,
            "recommended_out_of_scope": list,
            "out_of_scope": list,
            "mempalace_drawer": str,
            **_CLARIFY_OPT,
        },
    ),
    "Establish the analysis charter + scope. Confirm the deterministic charter draft.",
)
SCA_CENSUS = PrimitiveSpec(
    "SCA_CENSUS",
    "echo",
    _c(
        {"census_confirmed": bool},
        {
            "entry_points": list,
            "frameworks": list,
            "key_dependencies": list,
            "coverage_gaps": list,
            "mempalace_drawer": str,
            **_CLARIFY_OPT,
        },
    ),
    "Confirm the pre-computed repository census; surface entry points + frameworks.",
)
SCA_CONTEXT = PrimitiveSpec(
    "SCA_CONTEXT",
    "synthia",
    _c(
        {},
        {
            "confidence": str,
            "actors": list,
            "data_classes": list,
            "pii_processed": bool,
            "pii_evidence": str,
            "external_integrations": list,
            "assumptions": list,
            "unknowns": list,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Reconstruct business/domain context: actors, data classes, PII, integrations.",
)
SCA_ARCHITECTURE = PrimitiveSpec(
    "SCA_ARCHITECTURE",
    "synthia",
    _c(
        {},
        {
            "confidence": str,
            "components": list,
            "data_flows": list,
            "trust_boundaries": list,
            "entry_points": list,
            "assumptions": list,
            "unknowns": list,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Reconstruct architecture + trust boundaries from the context.",
)
SCA_REQUIREMENTS = PrimitiveSpec(
    "SCA_REQUIREMENTS",
    "synthia",
    _c(
        {},
        {
            "confidence": str,
            "security_requirements": list,
            "count": int,
            "unknowns": list,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Derive structured SR-### security requirements from context + architecture.",
)
SCA_THREAT_MODEL = PrimitiveSpec(
    "SCA_THREAT_MODEL",
    "tabitha",
    _c(
        {},
        {
            "confidence": str,
            "threats": int,
            "stride": bool,
            "linddun": bool,
            "linddun_reason": str,
            "cwe_mapped": int,
            "owasp_api_mapped": int,
            "ungrounded": int,
            "known_gaps": list,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Build the STRIDE/LINDDUN threat model against the derived requirements.",
)
SCA_TRIAGE = PrimitiveSpec(
    "SCA_TRIAGE",
    "annie",
    _c(
        {},
        {
            "confidence": str,
            "triaged": int,
            "confirmed": int,
            "needs_deep_dive": int,
            "false_positive": int,
            "by_severity": dict,
            "evidence_basis": dict,
            "secrets_redacted": int,
            "coverage_gaps": list,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Triage the merged scan findings: dedup, prioritize, filter false positives.",
)
SCA_DEEP_DIVE = PrimitiveSpec(
    "SCA_DEEP_DIVE",
    "annie",
    _c(
        {},
        {
            "confidence": str,
            "augment": bool,
            "new_rules": int,
            "deep_dived": int,
            "tool_blind_findings": dict,
            "new_confirmed": int,
            "augment_requested": bool,
            "evidence_basis": dict,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Deep-dive suspicious findings; optionally author targeted rules (augment=true).",
)
SCA_VERIFICATION = PrimitiveSpec(
    "SCA_VERIFICATION",
    "vera",
    _c(
        {"run_pocs": list},
        {
            "confidence": str,
            "pocs_requested": int,
            "findings_covered": int,
            "non_destructive_all": bool,
            "single_shot": bool,
            "notes": str,
            "mempalace_drawer": str,
        },
        # Externally-grounded VERIFY (Rec 4): ``run_pocs`` is required as a list so
        # vera must report the PoC batch it executed — but it is NOT forced
        # non-empty. A repo with no confirmed-exploitable findings legitimately
        # produces an empty batch (recorded as a coverage note), and forcing a
        # non-empty batch would pressure fabricating exploits — the exact failure
        # the loop research warns against for security verifiers.
    ),
    "Return a run_pocs batch of NON-DESTRUCTIVE PoCs (may be empty with a coverage note if nothing is exploitable); each runs ONCE in the sandbox.",
)
SCA_FIX_VERIFICATION = PrimitiveSpec(
    "SCA_FIX_VERIFICATION",
    "vera",
    _c(
        {},
        {
            "confidence": str,
            "findings_reviewed": int,
            "appear_remediated": int,
            "appear_open": int,
            "indeterminate": int,
            "rescan_performed": bool,
            "notes": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Note whether prior findings appear remediated (enrichment only; no re-scan).",
)
SCA_REPORT = PrimitiveSpec(
    "SCA_REPORT",
    "skribble",
    _c(
        {},
        {
            "report_md": str,
            "report_md_returned": bool,
            "total_findings": int,
            "references_real_data": bool,
            "notes": str,
            "mempalace_drawer": str,
        },
    ),
    "Return the human-readable narrative under result key report_md (a markdown string).",
)


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class ScaPlaybook(BasePlaybook):
    NAME = "sca"
    machine_cls = SCAMachine
    STEP_CAP = 80
    PRIMITIVE_BY_STATE = {
        "charter": SCA_CHARTER,
        "census": SCA_CENSUS,
        "context": SCA_CONTEXT,
        "architecture": SCA_ARCHITECTURE,
        "requirements": SCA_REQUIREMENTS,
        "threat_model": SCA_THREAT_MODEL,
        "triage": SCA_TRIAGE,
        "deep_dive": SCA_DEEP_DIVE,
        "verification": SCA_VERIFICATION,
        "fix_verification": SCA_FIX_VERIFICATION,
        "report": SCA_REPORT,
    }
    TOOL_STATES = frozenset({"baseline_scan", "targeted_scan"})
    GATE_STATES = frozenset(
        {
            "charter_gate",
            "context_gate",
            "threat_gate",
            "triage_gate",
            "verification_gate",
            "report_gate",
        }
    )
    ESCALATABLE_STATES = frozenset(
        {
            "charter",
            "census",
            "context",
            "architecture",
            "requirements",
            "threat_model",
            "triage",
            "deep_dive",
            "verification",
            "fix_verification",
            "report",
        }
    )

    # -- domain-module accessor (lazy; ensures the skill dir is importable) --
    def _domain(self, ctx: RunContext):
        _ensure_skill_tools(ctx.project_root, "sca")
        import sca_domain  # skill-dir module (.pi/skills/sca/scripts/sca_domain.py)

        return sca_domain

    def _meta(self, ctx: RunContext) -> dict:
        return ctx.extras.setdefault("sca", {})

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        d = self._domain(ctx)
        meta = self._meta(ctx)
        constraints = ctx.constraints or {}
        target = constraints.get("target_path") or (ctx.goal or "").strip()
        target_path = str(target) if target else ""
        err = d.validate_target(target_path)
        if err:
            raise RuntimeError("; ".join(err))
        requested_output = constraints.get("output_dir", "")
        if requested_output:
            output_dir = d.safe_output_dir(requested_output, target_path)
        else:
            output_dir = d.default_output_dir(target_path)
        meta["session_id"] = ctx.session_id
        meta["target_path"] = target_path
        meta["output_dir"] = output_dir
        meta.setdefault("cleared_gates", [])
        meta.setdefault("phase_results", {})
        meta.setdefault("mempalace_stubs", [])
        d.build_charter_draft(meta)  # populates census_preview + charter draft
        self.sm.send("start_charter")
        return "charter"

    # -- escalation resume: land back on the escalating phase --------------
    def _resume(self, state: str, result: Any) -> dict:
        if state == "awaiting_clarification":
            try:
                self.sm.resume_target = self.ctx.previous_state or "context"
            except Exception:  # pragma: no cover - defensive
                pass
        return super()._resume(state, result)

    # -- progress gate: wire the (legacy-ignored) needs_clarification ------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        return None

    # -- deterministic tool states (P2 / P7) -------------------------------
    def run_tool_state(self, state: str, ctx: RunContext) -> None:
        meta = self._meta(ctx)
        if state == "baseline_scan":
            self._run_baseline_state(ctx, meta)
            self.sm.send("baseline_done")
        elif state == "targeted_scan":
            self._run_targeted_state(ctx, meta)
            self.sm.send("targeted_done")
        else:  # pragma: no cover - defensive
            raise RuntimeError(f"run_tool_state: unknown tool state '{state}'")

    def _run_baseline_state(self, ctx: RunContext, meta: dict) -> None:
        existing = meta.get("baseline_scan")
        if isinstance(existing, dict) and existing.get("completed"):
            return  # idempotent: never re-run the real scanners on resume
        result = self._run_baseline(ctx)
        if result.get("blocked"):
            # HARD BLOCK: ZERO required tools available. Raise -> engine routes to
            # error (never silently degrade to a clean-looking empty findings set).
            raise RuntimeError(
                "; ".join(
                    result.get("errors")
                    or ["P2_BASELINE_SCAN blocked: no required tools available."]
                )
            )
        meta["baseline_scan"] = {
            "completed": True,
            "available": result.get("available", []),
            "missing_required": result.get("missing_required", []),
            "coverage_gaps": result.get("coverage_gaps", []),
            "severity_counts": result.get("severity_counts", {}),
            "tool_versions": result.get("tool_versions", {}),
            "findings_count": len(result.get("findings", [])),
            "findings_path": result.get("findings_path"),
            "coverage_path": result.get("coverage_path"),
            "mempalace": result.get("mempalace"),
        }
        self._record_mempalace(meta, "P2_BASELINE_SCAN", result.get("mempalace"))

    def _run_targeted_state(self, ctx: RunContext, meta: dict) -> None:
        result = self._run_targeted(ctx)  # P7 NEVER blocks (best-effort semgrep)
        meta["targeted_scan"] = {
            "completed": True,
            "semgrep_available": result.get("semgrep_available", False),
            "available": result.get("available", []),
            "coverage_gaps": result.get("coverage_gaps", []),
            "severity_counts": result.get("severity_counts", {}),
            "tool_versions": result.get("tool_versions", {}),
            "prior_findings_count": result.get("prior_findings_count", 0),
            "new_findings_count": result.get("new_findings_count", 0),
            "findings_count": len(result.get("findings", [])),
            "targeted_rule_files": result.get("targeted_rule_files", []),
            "findings_path": result.get("findings_path"),
            "coverage_path": result.get("coverage_path"),
            "mempalace": result.get("mempalace"),
        }
        self._record_mempalace(meta, "P7_TARGETED_SCAN", result.get("mempalace"))

    # -- OVERRIDABLE tool-execution seams (tests subclass + override these so
    #    real semgrep/osv-scanner/gitleaks/docker never run) ---------------
    def _run_baseline(self, ctx: RunContext) -> dict:
        _ensure_skill_tools(ctx.project_root, "sca")
        import baseline_scan

        meta = self._meta(ctx)
        return baseline_scan.execute_baseline_scan(
            meta["target_path"], meta["output_dir"], ctx.session_id
        )

    def _run_targeted(self, ctx: RunContext) -> dict:
        _ensure_skill_tools(ctx.project_root, "sca")
        import targeted_scan

        meta = self._meta(ctx)
        return targeted_scan.execute_targeted_scan(
            meta["target_path"], meta["output_dir"], ctx.session_id
        )

    def _run_pocs(self, ctx: RunContext, summary: dict) -> dict:
        return self._domain(ctx).process_verification_pocs(self._meta(ctx), summary)

    def _write_augment_rules(self, ctx: RunContext, summary: dict) -> list:
        domain = self._domain(ctx)
        meta = self._meta(ctx)
        written = domain.write_augment_rules(meta, summary)  # within-run (output_dir)
        # Also persist validated rules to the shared learned/sca dir so FUTURE
        # sca runs load them (self-improving SAST across runs).
        domain.persist_learned_rules(meta, summary)
        return written

    def _build_report(self, ctx: RunContext) -> dict:
        return self._domain(ctx).build_report_artifacts(self._meta(ctx))

    def _write_report(self, ctx: RunContext, summary: dict) -> bool:
        return self._domain(ctx).write_skribble_report(self._meta(ctx), summary)

    def _record_mempalace(self, meta: dict, phase: str, stub: Any) -> None:
        if isinstance(stub, dict) and stub:
            meta.setdefault("mempalace_stubs", []).append(
                {
                    "phase": phase,
                    "wing": stub.get("wing"),
                    "room": stub.get("room"),
                    "content": stub.get("content"),
                }
            )

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        d = self._domain(ctx)
        meta = self._meta(ctx)
        phase = STATE_TO_PHASE.get(state)
        if phase:
            d.capture_phase_result(meta, phase, summary)
        if state == "charter":
            self._route_gate_after(meta, "charter", "charter_gate_ev", "charter_skip")
        elif state == "census":
            self.sm.send("census_done")
        elif state == "context":
            self._route_gate_after(meta, "context", "context_gate_ev", "context_skip")
        elif state == "architecture":
            self.sm.send("architecture_done")
        elif state == "requirements":
            self.sm.send("requirements_done")
        elif state == "threat_model":
            self._route_gate_after(meta, "threat_model", "threat_gate_ev", "threat_skip")
        elif state == "triage":
            self._route_gate_after(meta, "triage", "triage_gate_ev", "triage_skip")
        elif state == "deep_dive":
            self._route_deep_dive(ctx, meta, summary)
        elif state == "verification":
            # BEFORE-gate cleared + vera identity verified by the engine: execute
            # the single-shot PoC batch ONCE, then advance (NO loop, NO re-dispatch).
            self._run_pocs(ctx, summary)
            self.sm.send("verification_done")
        elif state == "fix_verification":
            self.sm.send("fix_done")
        elif state == "report":
            # AT-gate cleared: persist skribble's narrative (or an HONEST fallback).
            self._write_report(ctx, summary)
            self.sm.send("report_done")
        else:  # pragma: no cover - defensive
            raise ValueError(f"route_after: unexpected state '{state}'")

    def _route_gate_after(
        self, meta: dict, gate_key: str, gate_event: str, skip_event: str
    ) -> None:
        """A GATE_AFTER phase: pause at the gate unless it was already cleared
        (a cleared gate stays cleared — the augment loop re-entering triage must
        NOT re-gate)."""
        if gate_key in meta.setdefault("cleared_gates", []):
            self.sm.send(skip_event)
        else:
            self.sm.send(gate_event)

    def _route_deep_dive(self, ctx: RunContext, meta: dict, summary: dict) -> None:
        """P9 augmentation loop, CAP-ENFORCED in code (never a prose promise)."""
        if bool(summary.get("augment")):
            iterations = self._augment_iterations(meta)
            cap = self._augment_cap(ctx)
            if iterations < cap:
                # GRANT: write P9-authored rules (contained) then re-run P7.
                self._write_augment_rules(ctx, summary)
                meta["augment_iterations"] = iterations + 1
                self.record_iteration(
                    ctx,
                    gaps=summary.get("tool_blind_findings", []),
                    confidence=summary.get("confidence", ""),
                )
                self.sm.send("dd_augment")
                return
            # CAP REACHED: refuse, record for the report's residual-risk honesty,
            # and fall through to verification.
            meta["augment_capped"] = True
        self.sm.send("dd_verify")

    def _augment_iterations(self, meta: dict) -> int:
        try:
            return int(meta.get("augment_iterations", 0) or 0)
        except (TypeError, ValueError, OverflowError):  # pragma: no cover - defensive
            return 0

    def _augment_cap(self, ctx: RunContext) -> int:
        raw = (ctx.constraints or {}).get("augment_cap", DEFAULT_AUGMENT_CAP)
        try:
            cap = int(raw)
        except (TypeError, ValueError, OverflowError):
            return DEFAULT_AUGMENT_CAP
        return cap if cap >= 0 else DEFAULT_AUGMENT_CAP

    def done_predicate(self, ctx: RunContext) -> bool:
        meta = ctx.extras.get("sca", {})
        return bool(meta.get("report")) and bool(meta.get("report_md_present"))

    def skill_context(self, state: str, ctx: RunContext) -> str | None:
        name = _PROMPT_BY_STATE.get(state)
        return f"assets/prompts/{name}.md" if name else None

    # -- planned-gate HITL -------------------------------------------------
    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        d = self._domain(ctx)
        meta = self._meta(ctx)
        if state == "charter_gate":
            return d.charter_questions(meta)  # structured charter questionnaire
        labels = {
            "context_gate": "Approve the reconstructed business/domain context",
            "threat_gate": "Approve the threat model",
            "triage_gate": "Approve the triage results",
            "verification_gate": (
                "Approve running PoC verification in the sandbox — this EXECUTES "
                "target-adjacent code in a locked-down Docker container"
            ),
            "report_gate": "Approve assembling + signing off the final report",
        }
        label = labels.get(state, "Approve gate")
        return [
            {
                "id": state,
                "label": "Approve gate",
                "prompt": f"{label}. Approve to continue, or provide direction.",
                "options": [
                    {"value": "approve", "label": "Approve and continue"},
                    {"value": "revise", "label": "Request revisions"},
                ],
                "allowOther": True,
            }
        ]

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:  # noqa: C901
        d = self._domain(ctx)
        meta = self._meta(ctx)
        approved = self._user_approved(response)
        if state == "charter_gate":
            if approved:
                d.merge_charter_answer(meta, response)
                self._mark_cleared(meta, "charter")
                # Compute the deterministic P1 census HERE (persisted by the
                # subsequent _advance_to save) rather than at census-dispatch time
                # (a _task_summary mutation would land after the checkpoint save).
                self._ensure_census(ctx, meta)
                self.sm.send("charter_ok")
            else:
                self._record_revision(ctx, meta, "charter", response)
                self.sm.send("charter_revise")
        elif state == "context_gate":
            if approved:
                self._mark_cleared(meta, "context")
                self.sm.send("context_ok")
            else:
                self._record_revision(ctx, meta, "context", response)
                self.sm.send("context_revise")
        elif state == "threat_gate":
            if approved:
                self._mark_cleared(meta, "threat_model")
                self.sm.send("threat_ok")
            else:
                self._record_revision(ctx, meta, "threat_model", response)
                self.sm.send("threat_revise")
        elif state == "triage_gate":
            if approved:
                self._mark_cleared(meta, "triage")
                self.sm.send("triage_ok")
            else:
                self._record_revision(ctx, meta, "triage", response)
                self.sm.send("triage_revise")
        elif state == "verification_gate":
            # GATE_BEFORE: approve dispatches vera exactly once; a rejection
            # re-asks (fire nothing -> the engine re-enters the gate).
            if approved:
                self.sm.send("vgate_ok")
        elif state == "report_gate":
            # GATE_AT: approve dispatches skribble exactly once; reject re-asks.
            if approved:
                # Build the deterministic report artifacts HERE so meta['report']
                # is persisted by the subsequent _advance_to save (a dispatch-time
                # _task_summary mutation would be lost after the checkpoint).
                self._build_report(ctx)
                self.sm.send("rgate_ok")
        # else: unrecognized gate -> fire nothing -> engine re-asks.

    # -- gate helpers ------------------------------------------------------
    def _user_answer(self, response: Any) -> str:
        if isinstance(response, dict):
            for k in ("user_response", "answer", "p0_charter_gate", "response", "value"):
                v = response.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            return ""
        return str(response).strip()

    def _user_approved(self, response: Any) -> bool:
        return self._user_answer(response).lower() in _APPROVE_WORDS

    def _ensure_census(self, ctx: RunContext, meta: dict) -> None:
        if not (isinstance(meta.get("census"), dict) and meta.get("census")):
            meta["census"] = self._domain(ctx).compute_census(meta.get("target_path", ""))

    def _mark_cleared(self, meta: dict, gate_key: str) -> None:
        cleared = meta.setdefault("cleared_gates", [])
        if gate_key not in cleared:
            cleared.append(gate_key)

    def _record_revision(self, ctx: RunContext, meta: dict, gate_key: str, response: Any) -> None:
        note = self._user_answer(response)
        meta.setdefault("gate_revision_notes", {}).setdefault(gate_key, []).append(note)
        counts = meta.setdefault("gate_revision_counts", {})
        counts[gate_key] = counts.get(gate_key, 0) + 1
        ctx.clarification_text = note  # surfaced to the re-run task_summary

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        d = self._domain(ctx)
        meta = self._meta(ctx)
        phase = STATE_TO_PHASE.get(state, state)
        room = f"{ctx.session_id}-{phase.lower()}"
        desc = PHASE_DESC.get(phase, spec.task_hint)
        target = meta.get("target_path") or "(unset)"
        task = (
            f"[{phase}] {desc}. Target: {target}. "
            f"Write ALL mempalace entries to wing={MEMPALACE_WING}, room={room}."
        )
        if state == "census":
            task = d.enrich_census_task(meta, task)
        elif state == "context":
            task = d.enrich_context_task(meta, task)
        elif state == "architecture":
            task = task + "\n\n" + d.prior_phase_block(meta, "P3_CONTEXT")
        elif state == "requirements":
            task = (
                task
                + "\n\n"
                + d.prior_phase_block(meta, "P3_CONTEXT")
                + "\n\n"
                + d.prior_phase_block(meta, "P4_ARCHITECTURE")
            )
        elif state == "triage":
            task = d.enrich_triage_task(meta, task)
        elif state == "deep_dive":
            task = task + "\n\n" + d.prior_phase_block(meta, "P8_TRIAGE")
        elif state == "fix_verification":
            task = d.enrich_fix_verification_task(meta, task)
        elif state == "report":
            # Reuse the report summary built on the (persisted) report-gate approve;
            # rebuild only if this is a side-effect-free re-issue with none present.
            report_summary = meta.get("report") or self._build_report(ctx)
            task = d.enrich_report_task(meta, task, report_summary)
        if ctx.clarification_text:
            task += f"\n\nUser clarification: {self._cap(ctx.clarification_text)}"
        return task

    def result_payload(self, ctx: RunContext) -> dict:
        meta = ctx.extras.get("sca", {})
        report = meta.get("report", {}) if isinstance(meta.get("report"), dict) else {}
        output_dir = meta.get("output_dir", "")
        report_dir = os.path.join(output_dir, "report") if output_dir else ""
        return {
            "met": ctx.met,
            "output_dir": output_dir,
            "report_dir": report_dir,
            "findings_summary": {
                "findings_source": report.get("findings_source", "none"),
                "total_findings": report.get("total_findings", 0),
                "severity_counts": report.get("severity_counts", {}),
            },
            "augment_capped": bool(meta.get("augment_capped", False)),
            "augment_iterations": self._augment_iterations(meta),
            "requires_approval": True,
            "report_md_present": bool(meta.get("report_md_present")),
            "cleared_gates": list(meta.get("cleared_gates", [])),
            # The subprocess cannot call MCP tools, so each scan emits a mempalace
            # drawer STUB persisted here for Penny to replay post-completion.
            "mempalace_stubs": list(meta.get("mempalace_stubs", [])),
            "errors": list(ctx.errors),
        }
