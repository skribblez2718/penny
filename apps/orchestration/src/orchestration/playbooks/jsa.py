"""JSAPlaybook — the jsa JavaScript security-analysis skill on the shared engine.

A faithful behavioral port of the legacy self-orchestrating jsa driver
(``.pi/skills/jsa/scripts/orchestrate.py`` ~3047 lines + ``fsm.py`` ~3023 lines)
onto ``BasePlaybook``. The legacy pipeline is a strictly linear phase machine with
two runtime quirks the engine now models cleanly:

  * the many DETERMINISTIC phases (acquire → cve_research → sast_scan → normalize →
    dedup_within_source → correlate_evidence → agent_review → sast_validate →
    structure → slice, plus collect) run in-process with no agent — they are
    engine ``TOOL_STATES`` executed inline by ``_advance_to`` (mirrors the legacy
    ``_build_action`` auto-advance through None-directive phases);
  * the AGENT phases (investigate/annie, merge/synthia, verify/vera, report/
    skribble, reflect/carren) are real primitive states;
  * the HUMAN GATE (INTAKE schema questionnaire) is an engine ``GATE_STATE`` with
    ``route_user`` resume — replacing the legacy skill-extension
    ``escalate_to_user`` protocol. After the INVESTIGATE wave loop the pipeline
    flows straight into collect → merge with no further human gate.

Deliberate honesty upgrades over the legacy runtime (documented, not hidden):
  * the INVESTIGATE wave loop is a bounded fan-through over ``needs_llm`` findings
    (``total_waves = max(1, ceil(needs_llm / WAVE_SIZE))``); annie runs at least
    one wave (the general sweep) even with zero SAST-derived candidates rather
    than silently skipping investigation. Findings still unverified after the
    waves are reported honestly (``unverified_after_waves``) — NO verifier gate is
    invented that could fabricate an exploit;
  * VERIFY (vera, browser PoC) is the external oracle: its SUMMARY carries a
    REQUIRED ``evidence`` list (Rec 4) — vera must report the captured browser-PoC
    transcript for any finding it marks verified (``verified_count>0``). The
    contract type-checks the field (a SUMMARY that OMITS ``evidence`` is rejected)
    but does NOT force it non-empty: an empty list is the honest outcome for a
    clean / no-repro target, and forcing non-empty would pressure PoC fabrication —
    the exact failure loop-research warns about for security verifiers. So a bare
    ``verdict: PASS`` with ``verified_count>0`` and ``evidence: []`` is NOT
    independently rejected by the engine; vera is on its honor to attach a
    transcript per verified finding;
  * agent phases escalate on UNCERTAIN / needs_clarification to the engine HITL
    seam instead of proceeding blind.

The bespoke on-disk ``session.json`` checkpointer is replaced by the engine's
SQLite checkpointer (FSM position + lean domain state in ``ctx.extras["jsa"]``).
Heavy domain artifacts (cards, findings, scan output) still live on disk under
``output_dir``; the deterministic tool bodies bridge to the skill-dir modules
lazily via ``.pi/skills/jsa/scripts/jsa_domain.py`` (never imported in tests —
the tool seam ``_domain_run`` is overridden). The mempalace-stub handoff hack is
preserved: the subprocess cannot call MCP tools, so SAST/CVE results are written
to ``{output_dir}/mempalace_stubs.json`` and the completion ``result`` instructs
Penny to replay ``memory_add_drawer`` for each stub into ``wing_jsa``.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook, tier_budget
from ..primitives.spec import PrimitiveSpec

# ---------------------------------------------------------------------------
# Constants (ported verbatim)
# ---------------------------------------------------------------------------

_DEFAULT_WAVE_SIZE = 10  # default findings per annie wave (a tunable Budget, not a
#                          frozen threshold): constraints["wave_size"] overrides.


def _wave_size(ctx: "RunContext") -> int:
    """Findings per annie wave — a tunable Budget (code caps the batch, the model
    spends the waves). ``constraints["wave_size"]`` overrides the default; clamped
    to >= 1. With no override the default is a TIER-SCALED budget (#25) bounded by a
    ceiling. The frozen ``WAVE_SIZE = 10`` constant is gone (Bitter-Lesson gate)."""
    raw = (ctx.constraints or {}).get("wave_size")
    if raw is None:
        return tier_budget(_DEFAULT_WAVE_SIZE, ceiling=_DEFAULT_WAVE_SIZE * 2)
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return _DEFAULT_WAVE_SIZE


WING = "wing_jsa"

# Per-state domain-guidance prompt file (skill-relative). jsa's worker prompts are
# named <agent>-base.md, so the driver's bare {agent}.md fallback would miss them.
_PROMPT_BY_STATE = {
    "investigate": "annie-base",
    "merge": "synthia-base",
    "verify": "vera-base",
    "reverify": "vera-base",
    "report": "skribble-base",
    "reflect": "carren-base",
}


def _ensure_skill_tools(project_root: str, skill: str) -> None:
    """Put the skill-dir ``scripts/`` on sys.path so its FLAT-imported domain
    modules (fsm, dedup, correlate_evidence, …) resolve. Called lazily inside the
    ``_domain_run`` seam — never at import time, never in tests."""
    d = os.path.join(project_root or os.getcwd(), ".pi", "skills", skill, "scripts")
    if d and d not in sys.path:
        sys.path.insert(0, d)


def _rooms(session_id: str) -> dict[str, str]:
    """MemPalace room names (preserved verbatim from the legacy directives)."""
    return {
        "mesh": f"{session_id}-mesh",
        "feed": f"{session_id}-feed",
        "findings": f"{session_id}-findings",
        "merged": f"{session_id}-merged",
        "sast": f"{session_id}-sast-findings",
        "cve": f"{session_id}-cve-research",
        "verified": f"{session_id}-verified",
        "reports": f"{session_id}-reports",
        "learnings": "jsa-learnings",  # persistent, cross-session
    }


def _c(required: dict, optional: dict | None = None, evidence: tuple[str, ...] = ()) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        contract["evidence"] = evidence
    return contract


# ---------------------------------------------------------------------------
# INTAKE schema (ported from orchestrate._INTAKE_SCHEMA). Kept in the playbook
# (pure Python, no disk) so the gate is fully testable without the skill-dir
# modules. #15: session_management is free text (its options are SUGGESTIONS, not
# a whitelist) so novel/hybrid auth schemes can be described instead of hard-
# rejected; the model interprets the free text downstream. Only genuine invariants
# are hard-validated (target_url is http(s); auth_instructions present when
# authenticated testing is requested).
# ---------------------------------------------------------------------------

INTAKE_SCHEMA: list[dict] = [
    {
        "key": "target_url",
        "label": "Target URL",
        "prompt": "What is the target URL for the security analysis?",
        "options": [],
        "validate": lambda v: isinstance(v, str)
        and (v.startswith("http://") or v.startswith("https://")),
    },
    {
        "key": "authenticated_testing",
        "label": "Auth mode",
        "prompt": "How should authenticated testing be handled?",
        "options": [
            {"value": "anonymous_only", "label": "Anonymous only — no authenticated testing"},
            {"value": "both", "label": "Anonymous + Authenticated — test both contexts"},
            {
                "value": "authenticated_only",
                "label": "Authenticated only — all testing with credentials",
            },
        ],
        "validate": lambda v: v in ("anonymous_only", "both", "authenticated_only"),
    },
    {
        "key": "session_management",
        "label": "Sessions",
        "prompt": (
            "How does the application manage sessions? Pick the closest option or "
            "describe it in your own words \u2014 novel/hybrid schemes are welcome "
            "(e.g. 'passkeys + rotating refresh token', 'signed cookie + JWT')."
        ),
        "options": [
            {"value": "cookie", "label": "Cookie-based sessions (Set-Cookie header)"},
            {"value": "jwt_header", "label": "JWT in Authorization header (Bearer token)"},
            {"value": "oauth2", "label": "OAuth 2.0 / OpenID Connect"},
            {"value": "custom_header", "label": "Custom header (e.g., X-Session-Token)"},
            {"value": "mixed", "label": "Mixed / Multiple mechanisms"},
            {"value": "other", "label": "Other \u2014 describe it (free text)"},
        ],
        # #15: accept ANY non-empty description; the options above are suggestions,
        # not a whitelist. The old enum hard-failed novel/hybrid auth so a real
        # target could not even be described. Genuine invariants stay enforced by
        # the other entries.
        "validate": lambda v: isinstance(v, str) and len(v.strip()) > 0,
    },
    {
        "key": "auth_instructions",
        "label": "Auth details",
        "prompt": (
            "Provide authentication details: login URL, method, credentials, "
            "token/cookie names, session lifetime. Example: "
            "`POST /login with username=carlos password=hunter2 — cookie sessionid`"
        ),
        "options": [],  # free text only
        "validate": lambda v: isinstance(v, str) and len(v.strip()) > 0,
        "required_when": lambda intake: (intake.get("authenticated_testing") or "")
        in ("both", "authenticated_only"),
    },
]

# Keys we lift out of a questionnaire/constraints response into the intake record.
_INTAKE_KEYS = (
    "target_url",
    "authenticated_testing",
    "session_management",
    "auth_instructions",
    "out_of_scope",
    "roles",
    "session_details",
)


def validate_intake(intake: dict) -> tuple[bool, list[str]]:
    """Validate an intake record against INTAKE_SCHEMA (ported from
    orchestrate.validate_intake). Returns ``(is_valid, missing_keys)``."""
    missing: list[str] = []
    for entry in INTAKE_SCHEMA:
        key = entry["key"]
        required_when = entry.get("required_when")
        if callable(required_when) and not required_when(intake):
            continue
        value = intake.get(key)
        if not isinstance(value, str) or not value.strip():
            missing.append(key)
            continue
        validate = entry.get("validate")
        if callable(validate) and not validate(value):
            missing.append(key)
    return (len(missing) == 0, missing)


def _schema_meta(key: str) -> dict | None:
    for entry in INTAKE_SCHEMA:
        if entry["key"] == key:
            return entry
    return None


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class JSAMachine(StateMachine):
    intake = State(initial=True)  # HUMAN GATE — schema questionnaire
    # deterministic tool states (no agent) --------------------------------
    acquire = State()
    cve_research = State()
    sast_scan = State()
    normalize = State()
    dedup_within_source = State()
    correlate_evidence = State()
    agent_review = State()  # LOCAL heuristic despite the name
    sast_validate = State()  # LOCAL heuristic
    structure = State()
    slice = State()
    # agent states ---------------------------------------------------------
    investigate = State()  # annie, WAVE LOOP (self-transition)
    collect = State()  # local no-op tool state
    merge = State()  # synthia
    verify = State()  # vera, browser PoC (evidence oracle)
    reverify = State()  # vera#2 (different model) — optional dual-verify agreement (Rec 5)
    report = State()  # skribble
    reflect = State()  # carren
    # engine control states ------------------------------------------------
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    # Linear tool/agent progression (one event each).
    go_acquire = intake.to(acquire)
    acquire_done = acquire.to(cve_research)
    cve_done = cve_research.to(sast_scan)
    sast_done = sast_scan.to(normalize)
    normalize_done = normalize.to(dedup_within_source)
    dedup_done = dedup_within_source.to(correlate_evidence)
    correlate_done = correlate_evidence.to(agent_review)
    review_done = agent_review.to(sast_validate)
    validate_done = sast_validate.to(structure)
    structure_done = structure.to(slice)
    slice_done = slice.to(investigate)
    # INVESTIGATE wave loop: self-transition while waves remain.
    investigate_wave = investigate.to(investigate)
    # When the waves are exhausted the pipeline flows straight into collect —
    # no human gate. (The event keeps its name so route_after is unchanged.)
    investigate_done = investigate.to(collect)
    collect_done = collect.to(merge)
    merge_done = merge.to(verify)
    verify_done = verify.to(report)
    verify_reverify = verify.to(reverify)  # dual_verify on + first pass PASS
    reverify_done = reverify.to(report)
    report_done = report.to(reflect)
    reflect_done = reflect.to(complete)

    # Escalation seam — ONLY the agent states (UNCERTAIN / needs_clarification).
    to_unknown = (
        investigate.to(unknown)
        | merge.to(unknown)
        | verify.to(unknown)
        | reverify.to(unknown)
        | report.to(unknown)
        | reflect.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    # Fixed clarify target: resume the agent portion at investigate (mirrors the
    # worked examples' single clarify edge; the deterministic pipeline is not re-run).
    clarify = awaiting_clarification.to(investigate)

    abort = (
        intake.to(error)
        | acquire.to(error)
        | cve_research.to(error)
        | sast_scan.to(error)
        | normalize.to(error)
        | dedup_within_source.to(error)
        | correlate_evidence.to(error)
        | agent_review.to(error)
        | sast_validate.to(error)
        | structure.to(error)
        | slice.to(error)
        | investigate.to(error)
        | collect.to(error)
        | merge.to(error)
        | verify.to(error)
        | reverify.to(error)
        | report.to(error)
        | reflect.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts (custom-named; validated against spec.summary_contract)
# ---------------------------------------------------------------------------

JSA_INVESTIGATE = PrimitiveSpec(
    "JSA_INVESTIGATE",
    "annie",
    _c(
        {"wave_complete": bool, "confidence": str},
        {
            "findings_count": int,
            "verified_count": int,
            "unverified_count": int,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Investigate this wave's findings + general sweep; verify with your tools; post verdicts. Always emit confidence.",
)
JSA_MERGE = PrimitiveSpec(
    "JSA_MERGE",
    "synthia",
    _c(
        {"merge_complete": bool, "confidence": str},
        {
            "merged_count": int,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Deduplicate/stitch/promote raw findings into consolidated findings. Always emit confidence.",
)
JSA_VERIFY = PrimitiveSpec(
    "JSA_VERIFY",
    "vera",
    _c(
        {"verdict": str, "gaps": list, "confidence": str, "evidence": list},
        {
            "verified_count": int,
            "refuted_count": int,
            "out_of_scope_count": int,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
        # Externally-grounded VERIFY (Rec 4): `evidence` is required as a list so
        # vera must report the browser-PoC transcripts it ran — but it is NOT
        # forced non-empty. A clean target (nothing to verify) legitimately yields
        # an empty transcript list; forcing non-empty would pressure fabricating a
        # PoC, the exact failure the loop research warns about for security
        # verifiers.
    ),
    "Run browser-based PoC per merged finding (transcripts may be empty for a clean target); confirm/refute honestly; ENFORCE out_of_scope. Attach the executed-PoC transcripts as evidence. Always emit confidence.",
)
JSA_REPORT = PrimitiveSpec(
    "JSA_REPORT",
    "skribble",
    _c(
        # `application_context` is REQUIRED (present + a list) so skribble must
        # carry, per verified finding, a description of the vulnerability within
        # the target application — its exploitability and concrete impact — not
        # just a CVSS score. Kept in `required` (NOT the evidence tuple) so a
        # zero-finding run can honestly emit an empty list without pressure to
        # fabricate, mirroring VERIFY's `evidence` design.
        {"report_complete": bool, "confidence": str, "application_context": list},
        {
            "reports_written": int,
            "cvss_scored": int,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Write structured findings for each verified finding: a CVSS 4.0 vector AND a "
    "description of the vulnerability within the target application — its exploitability "
    "and concrete impact (data/users/functions at risk, chainability), not just a score. "
    "Attach that per-finding application-context narrative as `application_context`. "
    "Always emit confidence.",
)
JSA_REFLECT = PrimitiveSpec(
    "JSA_REFLECT",
    "carren",
    _c(
        {"reflect_complete": bool},
        {
            "confidence": str,
            "patterns_count": int,
            # Self-improving SAST: new semgrep rules for genuine detection gaps
            # this run exposed (a confirmed vuln the scanner missed). Each entry:
            # {"filename": "<slug>.yaml", "yaml_content": "<semgrep rule YAML>",
            #  "vuln_class": str, "rationale": str}. Persisted (after validation)
            # to the shared learned-rules dir so future runs catch it deterministically.
            "new_rules": list,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Identify FP/FN patterns and write corrections to jsa-learnings. For each "
    "CONFIRMED vulnerability the deterministic SAST scanner MISSED this run, author "
    "a new semgrep rule that would catch that pattern and emit it in `new_rules` — "
    "so the scanner gets permanently more robust. Emit confidence if uncertain.",
)


# TOOL_STATE -> the FSM event that advances past it.
_TOOL_EVENT = {
    "acquire": "acquire_done",
    "cve_research": "cve_done",
    "sast_scan": "sast_done",
    "normalize": "normalize_done",
    "dedup_within_source": "dedup_done",
    "correlate_evidence": "correlate_done",
    "agent_review": "review_done",
    "sast_validate": "validate_done",
    "structure": "structure_done",
    "slice": "slice_done",
    "collect": "collect_done",
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class JSAPlaybook(BasePlaybook):
    NAME = "jsa"
    machine_cls = JSAMachine
    STEP_CAP = 80  # long deterministic tool run + bounded wave loop + agent tail
    TOOL_STATES = frozenset(_TOOL_EVENT)
    PRIMITIVE_BY_STATE = {
        "investigate": JSA_INVESTIGATE,
        "merge": JSA_MERGE,
        "verify": JSA_VERIFY,
        "reverify": JSA_VERIFY,  # optional second independent verifier (Rec 5)
        "report": JSA_REPORT,
        "reflect": JSA_REFLECT,
    }
    GATE_STATES = frozenset({"intake"})
    ESCALATABLE_STATES = frozenset(
        {"investigate", "merge", "verify", "reverify", "report", "reflect"}
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        """Seed intake from constraints. If already valid, skip the gate and fire
        into the deterministic pipeline; otherwise land on the INTAKE gate."""
        jsa = ctx.extras.setdefault("jsa", {})
        jsa.setdefault("wing", WING)
        jsa.setdefault("rooms", _rooms(ctx.session_id))
        intake = self._intake_from_constraints(ctx.constraints)
        jsa["intake"] = intake
        ok, _missing = validate_intake(intake)
        if ok:
            self._apply_intake(ctx, intake)
            self.sm.send("go_acquire")
            return "acquire"
        return "intake"  # HUMAN GATE

    def _intake_from_constraints(self, constraints: dict) -> dict:
        """Build an intake record from constraints (a nested ``intake`` dict wins,
        with top-level keys as fallback). Mirrors the legacy intake seeding."""
        constraints = constraints or {}
        nested = constraints.get("intake") if isinstance(constraints.get("intake"), dict) else {}
        intake: dict = {}
        for key in _INTAKE_KEYS:
            if key in (nested or {}):
                intake[key] = nested[key]
            elif key in constraints:
                intake[key] = constraints[key]
        return intake

    def _apply_intake(self, ctx: RunContext, intake: dict) -> None:
        """Persist target_url + output_dir into the lean domain state once intake
        is valid."""
        jsa = ctx.extras.setdefault("jsa", {})
        target = str(intake.get("target_url", "")).strip()
        jsa["target_url"] = target
        jsa["output_dir"] = self._derive_output_dir(ctx, target)
        # Surface effective scope so downstream (verify) can enforce it.
        oos = intake.get("out_of_scope") or ctx.constraints.get("out_of_scope") or []
        if isinstance(oos, str):
            oos = [line.strip() for line in oos.split("\n") if line.strip()]
        jsa["out_of_scope"] = list(oos)
        jsa["auth_mode"] = intake.get("authenticated_testing", "anonymous_only")

    @staticmethod
    def _derive_output_dir(ctx: RunContext, target_url: str) -> str:
        explicit = str((ctx.constraints or {}).get("output_dir", "")).strip()
        if explicit:
            return explicit
        try:
            from urllib.parse import urlparse

            host = urlparse(target_url).netloc.split(":")[0].replace(".", "-") or "unknown"
        except Exception:
            host = "unknown"
        return f"/tmp/jsa-{host}"

    # -- deterministic TOOL states ----------------------------------------
    def run_tool_state(self, state: str, ctx: RunContext) -> None:
        """Execute one deterministic phase (idempotent) via its overridable
        ``_run_<state>`` method, then fire exactly ONE FSM event to the next
        state. Tests override the shared ``_domain_run`` seam so no real scanner
        (semgrep / jsluice / OSV / joern / katana) ever runs."""
        runner = getattr(self, f"_run_{state}", None)
        if runner is None:
            raise RuntimeError(f"no tool runner for state '{state}'")
        runner(ctx)
        event = _TOOL_EVENT[state]
        self.sm.send(event)

    # Each deterministic phase is its own overridable method (all delegate to the
    # single ``_domain_run`` seam so a test can override either granularity).
    def _run_acquire(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "acquire")

    def _run_cve_research(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "cve_research")

    def _run_sast_scan(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "sast_scan")

    def _run_normalize(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "normalize")

    def _run_dedup_within_source(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "dedup_within_source")

    def _run_correlate_evidence(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "correlate_evidence")

    def _run_agent_review(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "agent_review")

    def _run_sast_validate(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "sast_validate")

    def _run_structure(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "structure")

    def _run_slice(self, ctx: RunContext) -> None:
        # slice_handler + the F0 PythonVerifier pre-pass; sets the wave plan.
        self._domain_run(ctx, "slice")
        self._seed_wave_plan(ctx)

    def _run_collect(self, ctx: RunContext) -> None:
        self._domain_run(ctx, "collect")

    def _domain_run(self, ctx: RunContext, phase: str) -> None:
        """THE overridable tool-execution seam. Default: bridge to the skill-dir
        domain module (imported lazily) which runs the legacy fsm.py handlers /
        scan modules and returns lean counts. Tests override this to inject canned
        results without importing the skill-dir or running any scanner."""
        _ensure_skill_tools(ctx.project_root, "jsa")
        import jsa_domain  # skill-dir module (flat imports internally)

        jsa = ctx.extras.setdefault("jsa", {})
        jsa_domain.run_phase(phase, jsa, ctx.constraints or {})

    def _seed_wave_plan(self, ctx: RunContext) -> None:
        """Compute the INVESTIGATE wave plan from the F0 verification counts. Runs
        after slice (deterministic). ``total_waves = max(1, ceil(needs_llm /
        wave_size))`` — annie always runs at least one wave (the general sweep).
        ``wave_size`` is a tunable Budget (``constraints["wave_size"]``)."""
        jsa = ctx.extras.setdefault("jsa", {})
        inv = jsa.setdefault("investigate", {})
        needs_llm = int(inv.get("needs_llm", jsa.get("needs_llm", 0)) or 0)
        wave_size = _wave_size(ctx)
        total = max(1, -(-needs_llm // wave_size)) if needs_llm > 0 else 1
        inv.setdefault("wave", 0)
        inv["needs_llm"] = needs_llm
        inv["wave_size"] = wave_size  # effective budget, recorded for the pass
        inv["total_waves"] = int(inv.get("total_waves") or total)
        inv.setdefault("unverified", 0)

    # -- progress / escalation gate (needs_clarification) ------------------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        return None

    # -- routing (agent states + wave loop) --------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        jsa = ctx.extras.setdefault("jsa", {})
        if state == "investigate":
            inv = jsa.setdefault("investigate", {"wave": 0, "total_waves": 1})
            inv["wave"] = int(inv.get("wave", 0)) + 1
            inv["unverified"] = int(inv.get("unverified", 0)) + int(
                summary.get("unverified_count", 0) or 0
            )
            inv["findings"] = int(inv.get("findings", 0)) + int(
                summary.get("findings_count", 0) or 0
            )
            total_waves = max(1, int(inv.get("total_waves", 1) or 1))
            if inv["wave"] < total_waves:
                self.sm.send("investigate_wave")  # more waves — re-dispatch annie
            else:
                inv["waves_completed"] = inv["wave"]
                self.sm.send("investigate_done")
        elif state == "merge":
            jsa["merge"] = {
                "complete": bool(summary.get("merge_complete", False)),
                "merged_count": int(summary.get("merged_count", 0) or 0),
            }
            self.sm.send("merge_done")
        elif state == "verify":
            verdict = str(summary.get("verdict", ""))
            ctx.verify_verdict = verdict
            ctx.verify_gaps = summary.get("gaps", [])
            jsa["verify"] = {
                "verdict": verdict,
                "verified_count": int(summary.get("verified_count", 0) or 0),
                "refuted_count": int(summary.get("refuted_count", 0) or 0),
                "out_of_scope_count": int(summary.get("out_of_scope_count", 0) or 0),
            }
            # Dual-verify (Rec 5, opt-in): a PASS runs a SECOND independent
            # verifier and reports as verified only what both confirm.
            if bool((ctx.constraints or {}).get("dual_verify")) and verdict == "PASS":
                self.sm.send("verify_reverify")
            else:
                self.sm.send("verify_done")
        elif state == "reverify":
            verdict = str(summary.get("verdict", ""))
            first = jsa.get("verify", {}).get("verdict", "")
            agreed = verdict == "PASS" and first == "PASS"
            jsa["reverify"] = {
                "verdict": verdict,
                "verified_count": int(summary.get("verified_count", 0) or 0),
                "could_not_reproduce": summary.get("gaps", []),
            }
            jsa["dual_verify_agreed"] = agreed
            # The engine records agreement; the report reads the (independently
            # re-checked) verified room, so disagreements are surfaced honestly.
            self.sm.send("reverify_done")
        elif state == "report":
            jsa["report"] = {
                "complete": bool(summary.get("report_complete", False)),
                "reports_written": int(summary.get("reports_written", 0) or 0),
            }
            self.sm.send("report_done")
        elif state == "reflect":
            persisted = self._persist_learned_rules(ctx, summary.get("new_rules") or [])
            jsa["reflect"] = {
                "complete": bool(summary.get("reflect_complete", False)),
                "learned_rules_written": len(persisted.get("written", [])),
                "learned_rules_rejected": len(persisted.get("rejected", [])),
                "learned_rules_dir": persisted.get("dir", ""),
            }
            self.sm.send("reflect_done")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        """Met = the full pipeline reached REFLECT with findings verified (VERIFY
        ran and produced a verdict)."""
        jsa = ctx.extras.get("jsa", {})
        return bool(jsa.get("reflect", {}).get("complete")) and bool(
            jsa.get("verify", {}).get("verdict")
        )

    def skill_context(self, state: str, ctx: RunContext) -> str | None:
        name = _PROMPT_BY_STATE.get(state)
        return f"assets/prompts/{name}.md" if name else None

    # -- planned-gate HITL (INTAKE questionnaire) -------------------------
    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        # INTAKE is the only human gate; the pipeline runs autonomously after it.
        return self._intake_questions(ctx)

    def _intake_questions(self, ctx: RunContext) -> list[dict]:
        jsa = ctx.extras.setdefault("jsa", {})
        intake = jsa.setdefault("intake", {})
        _ok, missing = validate_intake(intake)
        questions: list[dict] = []
        for key in missing:
            entry = _schema_meta(key)
            if entry is None:
                continue
            questions.append(
                {
                    "id": key,
                    "label": entry["label"],
                    "prompt": entry["prompt"],
                    "options": list(entry.get("options") or []),
                    "allowOther": True,
                }
            )
        if not questions:
            # Defensive: never surface an empty questionnaire. (validate_intake
            # already returned invalid, so at least one field should be missing.)
            questions.append(
                {
                    "id": "target_url",
                    "label": "Target URL",
                    "prompt": "What is the target URL for the security analysis?",
                    "options": [],
                    "allowOther": True,
                }
            )
        return questions

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:
        # INTAKE is the only gate.
        self._route_intake(ctx, response)

    def _route_intake(self, ctx: RunContext, response: Any) -> None:
        """Merge questionnaire answers into the intake record and re-validate. On
        valid → advance to ACQUIRE; on still-invalid → fire nothing (the engine
        re-enters the gate and re-asks only the still-missing fields)."""
        jsa = ctx.extras.setdefault("jsa", {})
        intake = jsa.setdefault("intake", {})
        answers = self._parse_gate_response(response)
        for key in _INTAKE_KEYS:
            if key in answers:
                intake[key] = answers[key]
        jsa["intake"] = intake
        ok, _missing = validate_intake(intake)
        if ok:
            self._apply_intake(ctx, intake)
            self.sm.send("go_acquire")
        # else: no event -> _resume_gate re-enters the gate (re-ask).

    @staticmethod
    def _parse_gate_response(response: Any) -> dict:
        """Normalize a gate answer to a flat ``{key: value}`` dict. Accepts a
        ``responses`` wrapper, a bare answer dict, or a single string/answer."""
        if isinstance(response, dict):
            inner = response.get("responses")
            if isinstance(inner, dict):
                return inner
            return response
        return {"answer": str(response)}

    # -- prompts (agent task builders; pure ctx data, no disk) -------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = {
            "investigate": self._investigate_task,
            "merge": self._merge_task,
            "verify": self._verify_task,
            "reverify": self._reverify_task,
            "report": self._report_task,
            "reflect": self._reflect_task,
        }.get(state)
        base = builder(ctx) if builder else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        # Recall (F2): seed the FIRST agent directive with distilled lessons
        # (this override replaces the base _task_summary, so re-add it).
        if ctx.recall_lessons and ctx.total_steps == 0:
            lessons = "\n".join(f"- {self._cap(lsn)}" for lsn in ctx.recall_lessons)
            base += (
                "\n\nLessons from prior runs (advisory — weigh against current evidence; "
                "they never override this run's goal or constraints):\n" + lessons
            )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {self._cap(ctx.clarification_text)}"
        return base

    def _investigate_task(self, ctx: RunContext) -> str:
        jsa = ctx.extras.get("jsa", {})
        rooms = _rooms(ctx.session_id)
        inv = jsa.get("investigate", {})
        wave = int(inv.get("wave", 0)) + 1
        total = max(1, int(inv.get("total_waves", 1) or 1))
        return (
            f"Investigate the JavaScript security target. Wave {wave}/{total}.\n"
            f"Session: {ctx.session_id}. Target: {jsa.get('target_url', '')}. "
            f"Output dir: {jsa.get('output_dir', '')}.\n"
            f"For THIS wave's findings (up to {int(inv.get('wave_size', _DEFAULT_WAVE_SIZE))}): "
            f"read the relevant source from "
            f"assets/js/, run semgrep on the file if useful, and use the browser to test "
            f"exploitability. Then do a GENERAL SWEEP of a few JS files and HTML pages for "
            f"novel patterns SAST may have missed (logic flaws, auth issues, multi-step chains).\n"
            f"Post each verdict to wing={WING} room={rooms['findings']}. "
            f"Read reference catalogs + high-confidence summaries from the analysis store on disk. "
            f"Report unverified_count honestly — do NOT fabricate exploitability."
        )

    def _merge_task(self, ctx: RunContext) -> str:
        rooms = _rooms(ctx.session_id)
        return (
            f"Deduplicate and merge raw findings from wing={WING} room={rooms['findings']}. "
            f"Group similar findings, stitch cross-source findings, promote confidence for "
            f"corroborated findings, resolve conflicts. "
            f"Post merged findings to wing={WING} room={rooms['merged']}. Session: {ctx.session_id}."
        )

    def _verify_task(self, ctx: RunContext) -> str:
        jsa = ctx.extras.get("jsa", {})
        rooms = _rooms(ctx.session_id)
        scope = jsa.get("out_of_scope", [])
        scope_bullets = (
            "\n".join(f"- `{p}`" for p in scope)
            if scope
            else "  (none configured — all reachable URLs on the target host are in scope)"
        )
        return (
            f"For EACH merged finding in wing={WING} room={rooms['merged']}, perform browser-based "
            f"PoC verification: navigate to the target page, inject payloads, test bypass variants, "
            f"capture screenshots. Confirm or refute each finding, and attach the executed-PoC "
            f"transcript as EVIDENCE for every finding you mark verified (any verified_count>0). "
            f"Leave the evidence list empty ONLY for a genuinely clean / no-repro target — never "
            f"fabricate a PoC to fill it. A bare PASS is NOT auto-rejected by the engine, so you "
            f"are on your honor to carry a transcript per verified finding. "
            f"Post results to wing={WING} room={rooms['verified']}.\n\n"
            f"**SCOPE (HARD CONSTRAINT):** the following URL substrings are OUT OF SCOPE — do NOT "
            f"navigate to, fetch, or interact with them. Substring match is enforced. If a finding's "
            f"verification would require out-of-scope interaction, mark it "
            f"`verification_status: out_of_scope` and skip the PoC.\n{scope_bullets}\n"
            f"Target: {jsa.get('target_url', '')}. Session: {ctx.session_id}."
        )

    def _reverify_task(self, ctx: RunContext) -> str:
        """Second, INDEPENDENT verification pass (dual-verify, Rec 5): a different
        verifier (ideally a different model via ``model_for_state``) reproduces the
        first pass's verified findings from scratch and flags any it cannot
        confirm. Only findings BOTH passes confirm should be reported as
        verified."""
        jsa = ctx.extras.get("jsa", {})
        rooms = _rooms(ctx.session_id)
        return (
            f"INDEPENDENT re-verification (dual-verify). Another verifier already marked findings "
            f"in wing={WING} room={rooms['verified']}. WITHOUT trusting their verdict, reproduce "
            f"the browser-based PoC for each finding they marked verified: confirm it independently "
            f"or flag that you could not reproduce it. Attach your own executed-PoC transcript as "
            f"EVIDENCE for every finding you confirm; list any you could NOT reproduce in `gaps`. "
            f"Enforce the same out-of-scope constraints. A finding only ONE pass confirms is NOT "
            f"reliably verified. Post your independent results to wing={WING} "
            f"room={rooms['verified']}. Target: {jsa.get('target_url', '')}. Session: {ctx.session_id}."
        )

    def model_for_state(self, state: str, ctx: RunContext) -> str | None:
        """Dual-verify independence: the second verifier (`reverify`) runs on a
        DIFFERENT model when the caller supplies ``constraints["reverify_model"]``
        — the point of Rec 5 is an independent judge, so correlated single-model
        errors don't slip a false PASS through. Unset → the agent's default model
        (still catches non-determinism, but note the reduced independence)."""
        if state == "reverify":
            model = str((ctx.constraints or {}).get("reverify_model", "")).strip()
            return model or None
        return None

    def _report_task(self, ctx: RunContext) -> str:
        jsa = ctx.extras.get("jsa", {})
        rooms = _rooms(ctx.session_id)
        return (
            f"For each verified finding in wing={WING} room={rooms['verified']}, write a structured "
            f"vulnerability report: title; a description of the vulnerability WITHIN THE CONTEXT OF "
            f"THIS APPLICATION — what it puts at risk here, how it is exploited, and its concrete "
            f"impact (data/users/functions affected, chainability with other findings); steps to "
            f"reproduce; code analysis; remediation guidance; and a CVSS 4.0 vector (the score does "
            f"NOT replace the application-context impact narrative). Save each as report.md under "
            f"{jsa.get('output_dir', '')}/findings/, plus a consolidated report at the output root. "
            f"Carry each finding's application-context narrative in the SUMMARY `application_context` "
            f"list. Post to wing={WING} room={rooms['reports']}. Session: {ctx.session_id}."
        )

    def _reflect_task(self, ctx: RunContext) -> str:
        rooms = _rooms(ctx.session_id)
        return (
            "Review the full jsa pipeline results. Identify false-positive and false-negative "
            "patterns: what did SAST miss that annie found? what did annie miss that vera caught? "
            f"Write pattern corrections for future analysis to wing={WING} room={rooms['learnings']}.\n"
            "SELF-IMPROVING SAST: for each CONFIRMED vulnerability the deterministic semgrep scan "
            "MISSED this run, author a NEW semgrep rule that would have caught it and return it in "
            "the SUMMARY `new_rules` list ({filename:'<vuln_class>-<slug>.yaml', yaml_content:'<valid "
            "semgrep rule YAML, id prefixed jsa-learned->', vuln_class, rationale}). Keep each rule "
            "TIGHT — match the specific missed pattern, not a broad shape that would flood future "
            "runs with false positives. Only propose a rule for a concrete miss you can point to; "
            "an empty list is correct when the scanner caught everything. Validated rules are "
            "persisted to the shared semgrep rules tree and load automatically on future runs. "
            f"Session: {ctx.session_id}."
        )

    # -- mempalace-stub handoff (subprocess cannot call MCP tools) ---------
    def _read_mempalace_stubs(self, ctx: RunContext) -> list[dict]:
        """Read {output_dir}/mempalace_stubs.json so the completion result can
        instruct Penny to replay them. Overridable; tests return a canned list."""
        jsa = ctx.extras.get("jsa", {})
        output_dir = jsa.get("output_dir", "")
        if not output_dir:
            return []
        _ensure_skill_tools(ctx.project_root, "jsa")
        try:
            import jsa_domain

            return jsa_domain.read_mempalace_stubs(output_dir)
        except Exception:
            return []

    def _persist_learned_rules(self, ctx: RunContext, new_rules: list) -> dict:
        """Validate + persist carren's proposed semgrep rules to the shared
        learned-rules dir (self-improving SAST). Bridges to the skill-dir
        ``jsa_domain.write_learned_rules``. Overridable; tests return a canned
        result without importing the skill-dir or running semgrep."""
        if not new_rules:
            return {"written": [], "rejected": [], "dir": ""}
        _ensure_skill_tools(ctx.project_root, "jsa")
        try:
            import jsa_domain

            return jsa_domain.write_learned_rules(new_rules)
        except Exception:
            return {"written": [], "rejected": [], "dir": ""}

    def result_payload(self, ctx: RunContext) -> dict:
        jsa = ctx.extras.get("jsa", {})
        inv = jsa.get("investigate", {})
        stubs = self._read_mempalace_stubs(ctx)
        handoff = (
            "MEMPALACE HANDOFF REQUIRED: the jsa subprocess cannot call MCP tools, so SAST + CVE "
            f"results were written as stubs. Penny: for each stub in mempalace_stubs, call "
            f"memory_add_drawer(wing=s['wing'], room=s['room'], content=s['content']) to populate "
            f"{_rooms(ctx.session_id)['sast']} and {_rooms(ctx.session_id)['cve']} in {WING}."
            if stubs
            else ""
        )
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "output_dir": jsa.get("output_dir", ""),
            "target_url": jsa.get("target_url", ""),
            "wing": WING,
            "rooms": _rooms(ctx.session_id),
            "verify_verdict": jsa.get("verify", {}).get("verdict", ""),
            # Dual-verify (Rec 5): present only when the second independent pass ran.
            **(
                {
                    "dual_verify": True,
                    "dual_verify_agreed": bool(jsa.get("dual_verify_agreed")),
                    "reverify_verdict": jsa.get("reverify", {}).get("verdict", ""),
                }
                if "reverify" in jsa
                else {}
            ),
            "counts": {
                "merged": jsa.get("merge", {}).get("merged_count", 0),
                "verified": jsa.get("verify", {}).get("verified_count", 0),
                "reports": jsa.get("report", {}).get("reports_written", 0),
            },
            "waves_completed": inv.get("waves_completed", inv.get("wave", 0)),
            "unverified_after_waves": inv.get("unverified", 0),
            "learned_rules_written": jsa.get("reflect", {}).get("learned_rules_written", 0),
            "mempalace_stubs_count": len(stubs),
            "mempalace_stubs": stubs,
            "mempalace_handoff": handoff,
        }
