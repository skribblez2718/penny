"""PrdPlaybook — the prd skill on the shared engine.

A faithful behavioral port of the legacy ~1500-line ``.pi/skills/prd`` orchestrator
onto ``BasePlaybook``: custom-named states (generating[synthia, three modes]→
validating[vera]⇄generating), clarify-first HITL (the first generate always runs in
CLARIFICATION QUESTIONS mode and escalates with synthia's questions), and vera's
bounded evaluator-optimizer revision loop.

The legacy ``classify`` state is dropped deliberately: the legacy ``start()``
auto-skipped it on every fresh run (keyword-based ``detect_domain`` in the
constructor), so echo never actually ran. Domain detection is folded into
``initial_transition`` and stashed in ``ctx.extras["prd"]``.

Three deliberate behavior fixes vs. the legacy runtime:
  * the revision loop no longer force-sets ``valid=True`` at the iteration cap
    ("Max iterations reached — forcing completion"). True budget exhaustion now
    completes HONESTLY with ``met=False`` and the unresolved issues reported, and
    a stalled loop (the same issues persisting) escalates to the user instead;
  * ``_write_placeholder_artifacts`` — which force-completed by inserting
    metadata-only placeholders HARDCODED to an unrelated past project
    ("simply-rag") straight into chroma's sqlite tables — is deleted, not ported;
  * UNCERTAIN from vera now escalates coherently (validating has a real
    ``to_unknown`` edge and ``clarify`` resumes generation); the legacy path drove
    the FSM into terminal error while still presenting unusable resume options.

The direct chroma.sqlite3 artifact-verification gate is not ported either (it
silently passed whenever no DB was found or any exception fired); vera's
``ideal_state_valid`` verdict is the artifact oracle on the engine path.

Domain guidance stays in ``.pi/skills/prd/assets/prompts/<agent>.md``; the
mempalace room ``skills/prd-{session_id}`` and the task-message wording that
drives the drawer headers are preserved verbatim — the code skill reads
IDEAL_STATE from that room as a hard dependency.
"""

from __future__ import annotations

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import PrimitiveSpec


def _c(required: dict, optional: dict | None = None) -> dict:
    return {"required": required, "optional": optional or {}}


# ---------------------------------------------------------------------------
# Domain detection (ported verbatim from the legacy orchestrator; this is what
# the legacy start() actually used — the echo classify state never ran)
# ---------------------------------------------------------------------------

WEB_APP_KEYWORDS = [
    "react",
    "vue",
    "angular",
    "django",
    "flask",
    "fastapi",
    "next",
    "next.js",
    "nuxt",
    "streamlit",
    "frontend",
    "backend",
    "api",
    "web",
    "website",
    "spa",
    "ssr",
    "express",
    "node",
    "node.js",
    "postgres",
    "mysql",
    "supabase",
    "firebase",
    "tailwind",
    "bootstrap",
    "css",
    "html",
    "javascript",
    "typescript",
    "htmx",
    "graphql",
    "rest",
    "websocket",
    "svelte",
]


def detect_domain(goal: str) -> str:
    """Detect domain from goal text via keyword scan.

    Returns 'web-app' if any WEB_APP_KEYWORD is found, 'generic' otherwise.
    """
    goal_lower = goal.lower()
    for keyword in WEB_APP_KEYWORDS:
        if keyword in goal_lower:
            return "web-app"
    return "generic"


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class PrdMachine(StateMachine):
    intake = State(initial=True)
    generating = State()  # synthia: clarification-questions / synthesis / revision
    validating = State()  # vera: schema + quality + traceability
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_generate = intake.to(generating)
    synthesize = generating.to.itself()  # clarification pass yielded nothing -> full synthesis
    generate_done = generating.to(validating)
    validate_pass = validating.to(complete)
    revise = validating.to(generating)  # issues found && within budget
    validate_exhausted = validating.to(complete)  # budget spent; met=False

    to_unknown = generating.to(unknown) | validating.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(generating)
    abort = (
        intake.to(error)
        | generating.to(error)
        | validating.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts. Only ``complete`` / ``valid`` are required — the
# synthia prompt's three modes share ``complete`` but differ on everything else,
# and escalation rides needs_clarification via progress_check (plus the
# confidence field when the agent emits it).
# ---------------------------------------------------------------------------

PRD_GENERATE = PrimitiveSpec(
    "PRD_GENERATE",
    "synthia",
    _c(
        {"complete": bool},
        {
            "requirement_count": int,
            "narrative_sections": int,
            "verification_matrix_complete": bool,
            "ideal_state_valid": bool,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "resolved_issues": list,
            "confidence": str,
        },
    ),
    "Produce the layered PRD (narrative, requirement catalog, verification matrix, "
    "IDEAL_STATE); the mode is signaled in the task. Write every artifact to mempalace.",
)
PRD_VALIDATE = PrimitiveSpec(
    "PRD_VALIDATE",
    "vera",
    _c(
        {"valid": bool},
        {
            "ideal_state_valid": bool,
            "issues": list,
            "complete": bool,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Validate the PRD artifacts: IDEAL_STATE schema, 12 narrative sections, catalog "
    "quality, matrix coverage, cross-artifact traceability. Emit valid + issues.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders (legacy wording preserved verbatim; the room +
# the wing=penny mempalace instructions drive the drawer headers the synthia/vera
# prompts write, which the code skill depends on)
# ---------------------------------------------------------------------------


def _room(ctx: RunContext) -> str:
    return f"skills/prd-{ctx.session_id}"


def _effective_mode(ctx: RunContext) -> str:
    """The synthia mode for the NEXT generating dispatch. ``mode`` lives in
    ctx.extras['prd']; a clarify resume (which sets ctx.clarification_text)
    promotes the clarify-first mode to a full synthesis."""
    prd = ctx.extras.get("prd", {})
    mode = prd.get("mode", "clarification")
    if mode == "clarification" and ctx.clarification_text:
        return "synthesis"
    return mode


def _build_generate(pb: "PrdPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    prd = ctx.extras.get("prd", {})
    room = _room(ctx)
    domain = prd.get("domain", "generic")
    mode = _effective_mode(ctx)
    if mode == "clarification":
        return (
            f"Session: {ctx.session_id}. "
            f"Goal: {pb._cap(ctx.goal)}. "
            f"Domain: {domain}. "
            f"Mempalace room: {room}. "
            f"Mode: CLARIFICATION QUESTIONS. "
            f"Analyze the goal and domain to identify information gaps. "
            f"Generate domain-specific clarifying questions. "
            f"Read any prior classification context from mempalace wing=penny "
            f"room={room}. "
            f"Return needs_clarification: true with clarifying_questions array."
        )
    if mode == "revision":
        issues_str = "; ".join(str(i) for i in prd.get("issues", []))
        return (
            f"Session: {ctx.session_id}. "
            f"Goal: {pb._cap(ctx.goal)}. "
            f"Domain: {domain}. "
            f"Mempalace room: {room}. "
            f"Mode: REVISION. Fix the following issues: {issues_str}. "
            f"Read the existing PRD artifacts from mempalace wing=penny "
            f"room={room}. "
            f"Re-emit all 4 artifacts (narrative, requirement catalog, "
            f"verification matrix, ideal_state) with fixes applied."
        )
    return (
        f"Session: {ctx.session_id}. "
        f"Goal: {pb._cap(ctx.goal)}. "
        f"Domain: {domain}. "
        f"Mempalace room: {room}. "
        f"Mode: SYNTHESIS. "
        f"Read prior context from mempalace wing=penny room={room}. "
        f"Produce all 4 PRD artifacts: narrative prose, atomic requirement "
        f"catalog, verification/traceability matrix, and IDEAL_STATE JSON. "
        f"Write each artifact to mempalace wing=penny room={room}. "
        f"Return SUMMARY with requirement_count, narrative_sections, "
        f"verification_matrix_complete, and ideal_state_valid."
    )


def _build_validate(pb: "PrdPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    prd = ctx.extras.get("prd", {})
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. "
        f"Goal: {pb._cap(ctx.goal)}. "
        f"Domain: {prd.get('domain', 'generic')}. "
        f"Mempalace room: {room}. "
        f"Read all PRD artifacts from mempalace wing=penny room={room}. "
        f"Validate: (a) IDEAL_STATE matches canonical schema, "
        f"(b) all 12 PRD sections present in narrative, "
        f"(c) all requirements have IDs, priorities, acceptance criteria, "
        f"(d) verification matrix covers every REQ, "
        f"(e) IDEAL_STATE success_criteria trace to PRD success metrics. "
        f"Return SUMMARY with valid, issues, and confidence."
    )


_TASK_BUILDERS = {
    "generating": _build_generate,
    "validating": _build_validate,
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class PrdPlaybook(BasePlaybook):
    NAME = "prd"
    machine_cls = PrdMachine
    PRIMITIVE_BY_STATE = {
        "generating": PRD_GENERATE,
        "validating": PRD_VALIDATE,
    }
    ESCALATABLE_STATES = frozenset({"generating", "validating"})

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("prd skill requires a non-empty goal")
        if "max_iterations" not in (ctx.constraints or {}):
            ctx.max_iterations = 5  # legacy prd default revision budget
        prd = ctx.extras.setdefault("prd", {})
        prd["domain"] = detect_domain(ctx.goal)
        prd["mode"] = "clarification"  # clarify-first HITL: questions before artifacts
        self.sm.send("start_generate")
        return "generating"

    # -- progress / escalation gate (needs_clarification + stall) ----------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            prd = ctx.extras.setdefault("prd", {})
            qs = [str(q) for q in (summary.get("clarifying_questions") or [])]
            if qs:
                prd["clarifying_questions"] = qs
            detail = f": {'; '.join(qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        if state == "validating" and not (
            summary.get("valid") and summary.get("ideal_state_valid", False)
        ):
            if self.is_stalled(ctx, summary.get("issues", [])):
                return (
                    "the same PRD validation issues have persisted across revisions with no "
                    "measurable progress — escalating rather than fabricating a valid PRD"
                )
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        prd = ctx.extras.setdefault("prd", {})
        if state == "generating":
            prd["requirement_count"] = summary.get("requirement_count", 0)
            prd["narrative_sections"] = summary.get("narrative_sections", 0)
            prd["verification_matrix_complete"] = summary.get("verification_matrix_complete", False)
            prd["ideal_state_valid"] = summary.get("ideal_state_valid", False)
            if _effective_mode(ctx) == "clarification" and prd["requirement_count"] == 0:
                # A clarification pass that produced neither questions
                # (needs_clarification would have escalated in progress_check)
                # nor artifacts: dispatch a full synthesis instead of sending
                # vera an empty room. One-shot — mode leaves "clarification"
                # permanently, so this self-loop cannot spin.
                prd["mode"] = "synthesis"
                self.sm.send("synthesize")
            else:
                prd["mode"] = "synthesis"
                self.sm.send("generate_done")
        elif state == "validating":
            valid = summary["valid"]
            ideal_ok = summary.get("ideal_state_valid", False)
            issues = summary.get("issues", [])
            prd["valid"] = valid
            prd["ideal_state_valid"] = ideal_ok  # vera's verdict overrides synthia's claim
            prd["issues"] = issues
            if valid and ideal_ok:
                self.sm.send("validate_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                # Record the iteration digest so the next validation's
                # progress_check can detect a stalled revision loop (Rec 2).
                self.record_iteration(ctx, gaps=issues, confidence=summary.get("confidence", ""))
                ctx.iteration += 1
                prd["mode"] = "revision"
                self.sm.send("revise")
            else:
                # Honest exhaustion (fix vs. legacy "forcing completion"):
                # complete with met=False + the unresolved issues, never a
                # fabricated valid=True.
                prd["exhausted"] = True
                self.sm.send("validate_exhausted")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        prd = ctx.extras.get("prd", {})
        return bool(prd.get("valid")) and bool(prd.get("ideal_state_valid"))

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(self, ctx, spec)
            if builder
            else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def result_payload(self, ctx: RunContext) -> dict:
        prd = ctx.extras.get("prd", {})
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "prd_summary": {
                "goal": ctx.goal,
                "domain": prd.get("domain", "generic"),
                "requirement_count": prd.get("requirement_count", 0),
                "narrative_sections": prd.get("narrative_sections", 0),
                "verification_matrix_complete": prd.get("verification_matrix_complete", False),
                "ideal_state_valid": prd.get("ideal_state_valid", False),
                "session_id": ctx.session_id,
                "requires_approval": True,
            },
            "session_room": _room(ctx),
            # legacy parity: the extension's chain handler injects prd_room into
            # the next chain step's constraints from session_room/room.
            "mempalace_drawers": {"wing": "penny", "room": _room(ctx)},
            "exhausted": prd.get("exhausted", False),
            "unresolved_issues": prd.get("issues", []) if prd.get("exhausted") else [],
        }
