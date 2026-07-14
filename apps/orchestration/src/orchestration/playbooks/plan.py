"""PlanPlaybook — the plan skill on the shared engine.

A faithful behavioral port of the legacy ~1400-line ``.pi/skills/plan`` orchestrator
onto ``BasePlaybook``: custom-named states (exploring[parallel fan-out]→planning→
[verify_gate]→critiquing⇄{exploring|planning}→taskifying), per-state SUMMARY
contracts, the CREST explore→plan→critique→taskify flow, a conditional high-stakes
verification gate on the engine's planned-gate seam, and needs-clarification
escalation.

Three deliberate behavior fixes vs. the legacy runtime:
  * the critique revision loop no longer force-sets ``verdict=APPROVE`` at the
    iteration cap (dishonest exhaustion). Instead a stalled loop (the same issues
    persisting) escalates to the user, and true budget exhaustion completes with
    ``met=False`` and the unresolved issues reported;
  * escalation resume no longer fabricates gate passage via transition replay —
    the durable checkpointer owns state and ``clarify`` resumes at ``scoping``;
  * the verify gate is a real engine gate (entered only when verification is
    warranted), not an in-band ``escalate_to_user`` the legacy path disarmed.

Bitter-lesson / atomic-loops compliance (2026-07-14):
  * **exploration topology is the model's runtime output** (arrangement 4). A
    ``scoping`` state (piper) emits ``explore_branches`` — the foci to fan out on
    — which ``route_after`` turns into ``ctx.extras["dynamic_branches"]``; the
    engine dispatches one echo branch per focus, bounded by
    ``constraints["max_fan_width"]`` (default 8). Branch agents are pinned to
    read-only ``echo`` (a consequence boundary, not a topology choice). The
    legacy fixed 3-branch split survives only as the tagged LOAN
    ``plan_default_explore_topology`` fallback (``PLAN_EXPLORE_DEFAULT``);
  * **critique is evidence-gated** (Rec 4): ``PLAN_CRITIQUE`` requires a
    non-empty ``evidence`` field — what carren actually examined — or the
    engine's contract rejects the verdict;
  * dial: routing stays code-owned on wire verdicts; topology is model-owned.
    ``fire_model_route`` is not used (every edge is verdict- or gate-determined).

Domain guidance stays in ``.pi/skills/plan/assets/prompts/<agent>.md``; the
mempalace room ``skills/plan-{session_id}`` and drawer headers are preserved
verbatim so SKILL.md's post-completion queries keep working.
"""

from __future__ import annotations

from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..loans import loan_enabled
from ..primitives.spec import ParallelSpec, PrimitiveSpec


def _c(required: dict, optional: dict | None = None, evidence: list | None = None) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        contract["evidence"] = evidence
    return contract


# JSON-safe echo branch contract (type NAMES) for runtime-emitted fan branches.
# Mirrors ``_ECHO_C`` so a dynamic branch validates identically to the default
# topology (the engine's ``parallel_spec_from_dict`` converts the names).
_ECHO_C_JSON = {
    "required": {"explore_complete": "bool"},
    "optional": {
        "findings_count": "int",
        "files_count": "int",
        "unknowns_count": "int",
        "mempalace_drawer": "str",
        "needs_clarification": "bool",
        "clarifying_questions": "list",
        "confidence": "str",
    },
}


def _build_dynamic_branches(emitted: Any) -> dict | None:
    """Turn piper's ``explore_branches`` (``{branch_id: focus}`` or
    ``{branch_id: {focus/task_hint}}``) into the engine's JSON-safe
    ``dynamic_branches`` shape. Every branch is pinned to read-only ``echo``
    (consequence boundary) with the canonical echo contract; only the topology
    (how many branches, what foci) is the model's. Returns ``None`` when nothing
    valid was emitted (caller decides: LOAN default fallback or escalate)."""
    if not isinstance(emitted, dict) or not emitted:
        return None
    branches: dict = {}
    for bid, val in emitted.items():
        if isinstance(val, str):
            focus = val
        elif isinstance(val, dict):
            focus = str(val.get("focus") or val.get("task_hint") or "")
        else:
            focus = ""
        focus = focus.strip()
        if not focus:
            continue
        sid = str(bid).strip() or f"branch{len(branches)}"
        branches[sid] = {
            "agent": "echo",
            "name": f"PLAN_EXPLORE_{sid.upper()}",
            "task_hint": focus,
            "summary_contract": _ECHO_C_JSON,
        }
    return branches or None


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class PlanMachine(StateMachine):
    intake = State(initial=True)
    scoping = State()  # piper: emit the runtime exploration topology
    exploring = State()  # parallel echo fan-out (model-emitted or default focuses)
    planning = State()
    verify_gate = State()  # HITL: confirm high-stakes plan / revise
    critiquing = State()
    taskifying = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_scope = intake.to(scoping)
    start_explore = intake.to(exploring)  # caller-supplied topology skips scoping
    scope_done = scoping.to(exploring)
    explore_done = exploring.to(planning)
    plan_to_verify = planning.to(verify_gate)
    plan_to_critique = planning.to(critiquing)
    verify_confirm = verify_gate.to(critiquing)
    verify_revise = verify_gate.to(planning)
    critique_pass = critiquing.to(taskifying)
    critique_retry_explore = critiquing.to(exploring)  # gaps need more context
    critique_retry_plan = critiquing.to(planning)  # gaps fixable in the plan
    critique_exhausted = critiquing.to(taskifying)  # budget spent; met=False
    critique_blocked = critiquing.to(complete)  # categorically-unsafe plan; halt met=False
    taskify_done = taskifying.to(complete)

    # exploring is escalatable (a branch may need clarification), so it needs a
    # to_unknown edge for the engine's _escalate path to reach awaiting_clarification.
    to_unknown = (
        scoping.to(unknown)
        | exploring.to(unknown)
        | planning.to(unknown)
        | critiquing.to(unknown)
        | taskifying.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(scoping)  # re-scope after clarification
    abort = (
        intake.to(error)
        | scoping.to(error)
        | exploring.to(error)
        | planning.to(error)
        | verify_gate.to(error)
        | critiquing.to(error)
        | taskifying.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts (confidence optional — the plan agents drive
# escalation through needs_clarification, not a confidence field)
# ---------------------------------------------------------------------------

_ECHO_C = _c(
    {"explore_complete": bool},
    {
        "findings_count": int,
        "files_count": int,
        "unknowns_count": int,
        "mempalace_drawer": str,
        "needs_clarification": bool,
        "clarifying_questions": list,
        "confidence": str,
    },
)
PLAN_PLAN = PrimitiveSpec(
    "PLAN_PLAN",
    "piper",
    _c(
        {"plan_complete": bool, "plan_steps": list},
        {
            "step_count": int,
            "stakes": str,
            "alternatives": list,
            "counter_argument": str,
            "proposed_action": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Write an execution-grade plan; read explore findings from mempalace first. Emit plan_steps + stakes.",
)
PLAN_SCOPE = PrimitiveSpec(
    "PLAN_SCOPE",
    "piper",
    _c(
        {"scope_complete": bool, "explore_branches": dict, "confidence": str},
        {
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Decompose the goal into the exploration subtasks whose answers the plan needs. "
    "Emit explore_branches: a small map of branch_id -> focus. Every branch is "
    "read-only echo work; the topology (how many, what foci) is yours.",
)
PLAN_CRITIQUE = PrimitiveSpec(
    "PLAN_CRITIQUE",
    "carren",
    _c(
        # Evidence-gated (Rec 4): the verdict must carry what carren examined.
        {"verdict": str, "issues": list, "evidence": list},
        {
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
        evidence=["evidence"],
    ),
    "Critique the plan (CREST) as an interpreter of evidence. Verdict APPROVE or "
    "NEEDS_REVISION with issue titles + the evidence you examined.",
)
PLAN_TASKIFY = PrimitiveSpec(
    "PLAN_TASKIFY",
    "tabitha",
    _c(
        {"title": str, "step_count": int, "complete": bool},
        {
            "evidence": list,  # optional task-coverage enumeration
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Convert the approved plan into a structured task list. Emit title + step_count.",
)

# Default (LOAN fallback) exploration topology: three echo branches. Used only
# when scoping emits no valid runtime topology and the tagged LOAN
# ``plan_default_explore_topology`` is enabled; delete when the loan is repaid.
PLAN_EXPLORE_DEFAULT = ParallelSpec(
    branches={
        "entrypoints": PrimitiveSpec(
            "PLAN_EXPLORE_ENTRYPOINTS", "echo", _ECHO_C, "entry points and call graph"
        ),
        "tests": PrimitiveSpec("PLAN_EXPLORE_TESTS", "echo", _ECHO_C, "tests and build pipeline"),
        "config": PrimitiveSpec(
            "PLAN_EXPLORE_CONFIG", "echo", _ECHO_C, "configurations and dependencies"
        ),
    }
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders (mempalace headers ported verbatim)
# ---------------------------------------------------------------------------


def _room(ctx: RunContext) -> str:
    return f"skills/plan-{ctx.session_id}"


def _build_explore(pb: "PlanPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    focus = spec.task_hint
    plan = ctx.extras.get("plan", {})
    revision = plan.get("iteration", 0)
    room = _room(ctx)
    parts = [
        f"Session: {ctx.session_id}.",
        f"Goal: {pb._cap(ctx.goal)}.",
        f"Focus: {focus}.",
        f"Mempalace room: {room}.",
    ]
    if revision:
        issues = plan.get("critique_issues", [])
        parts.append(
            f"This is additional exploration (revision {revision}) requested because the critique "
            f"identified gaps: {'; '.join(str(i) for i in issues) or 'see the prior critique'}. "
            f"Focus on filling these gaps. Write findings to wing=penny room={room} with header: "
            f"{ctx.session_id} Explore (Revision {revision}) — {focus}."
        )
    else:
        parts.append(
            f"Write findings to wing=penny room={room} with header: {ctx.session_id} Explore — {focus}."
        )
    parts.append(f"Check room {room} for prior session results first.")
    return " ".join(parts)


def _build_plan(pb: "PlanPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    plan = ctx.extras.get("plan", {})
    revision = plan.get("iteration", 0)
    room = _room(ctx)
    if revision:
        issues = plan.get("critique_issues", [])
        return (
            f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. Mempalace room: {room}. "
            f"This is REVISION cycle {revision}. The prior critique identified these issues: "
            f"{'; '.join(str(i) for i in issues) or 'see the critique in mempalace'}. "
            f"Read the critique and the latest exploration from mempalace. Address EVERY issue and "
            f"note how you resolved it. Write the revised plan to wing=penny room={room} with header: "
            f"{ctx.session_id} Planner (Revision {revision}). Output a brief SUMMARY with plan steps."
        )
    return (
        f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. Mempalace room: {room}. "
        f"Read explore findings from wing=penny room={room}. Write the plan to wing=penny room={room} "
        f"with header: {ctx.session_id} Planner. Output a brief SUMMARY with plan steps and stakes."
    )


def _build_critique(pb: "PlanPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    plan = ctx.extras.get("plan", {})
    revision = plan.get("iteration", 0)
    room = _room(ctx)
    task = f"Session: {ctx.session_id}. Mempalace room: {room}. Read the plan from wing=penny room={room}. "
    if revision:
        task += (
            f"This is review cycle {revision + 1} — the plan was revised to address prior issues. "
            f"Apply revision-appropriate standards: block ONLY on Critical/High/Medium issues; note "
            f"Low-severity concerns but APPROVE with notes rather than blocking. "
        )
    task += (
        f"Write the critique to wing=penny room={room} with header: {ctx.session_id} Critique. "
        f"Output a brief SUMMARY with the verdict."
    )
    return task


def _build_taskify(pb: "PlanPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. Mempalace room: {room}. Read the plan and critique from "
        f"wing=penny room={room}. Write the structured plan to wing=penny room={room} with header: "
        f"{ctx.session_id} Taskifier. Output a brief SUMMARY with the step count."
    )


def _build_scope(pb: "PlanPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. Mempalace room: {room}. "
        f"Decompose the goal into the exploration foci whose answers the plan needs, and "
        f"emit them as explore_branches (branch_id -> focus). Every branch is read-only "
        f"echo work. Check room {room} for prior session results first."
    )


_TASK_BUILDERS = {
    "scoping": _build_scope,
    "exploring": _build_explore,
    "planning": _build_plan,
    "critiquing": _build_critique,
    "taskifying": _build_taskify,
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class PlanPlaybook(BasePlaybook):
    NAME = "plan"
    machine_cls = PlanMachine
    PRIMITIVE_BY_STATE = {
        "scoping": PLAN_SCOPE,
        "planning": PLAN_PLAN,
        "critiquing": PLAN_CRITIQUE,
        "taskifying": PLAN_TASKIFY,
    }
    # Class-level fallback topology; the engine's parallel_spec prefers a
    # runtime ``ctx.extras["dynamic_branches"]["exploring"]`` when present.
    PARALLEL_BY_STATE = {"exploring": PLAN_EXPLORE_DEFAULT}
    GATE_STATES = frozenset({"verify_gate"})
    ESCALATABLE_STATES = frozenset({"scoping", "exploring", "planning", "critiquing", "taskifying"})

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("plan skill requires a non-empty goal")
        ctx.extras.setdefault("plan", {})
        # Caller-supplied topology (constraints.explore_branches) skips scoping.
        caller = _build_dynamic_branches((ctx.constraints or {}).get("explore_branches"))
        if caller:
            ctx.extras.setdefault("dynamic_branches", {})["exploring"] = caller
            self.sm.send("start_explore")
            return "exploring"
        self.sm.send("start_scope")
        return "scoping"

    # -- progress / escalation gate (needs_clarification + stall) ----------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        if state == "scoping":
            # An invalid/empty topology with the default-fallback LOAN ablated has
            # nowhere to go but the user (arrangement 4 wants the model's output).
            if not _build_dynamic_branches(summary.get("explore_branches")) and not loan_enabled(
                "plan_default_explore_topology"
            ):
                return (
                    "scoping produced no valid exploration topology and the default-"
                    "topology fallback is ablated — clarify how to explore the goal"
                )
        if state == "critiquing" and summary.get("verdict") != "APPROVE":
            if self.is_stalled(ctx, summary.get("issues", [])):
                return (
                    "the same plan-critique issues have persisted across revisions with no "
                    "measurable progress — escalating rather than force-approving"
                )
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        plan = ctx.extras.setdefault("plan", {})
        if state == "scoping":
            built = _build_dynamic_branches(summary.get("explore_branches"))
            if built:
                ctx.extras.setdefault("dynamic_branches", {})["exploring"] = built
            # else: fall through to the class-level default topology (the tagged
            # LOAN; the ablated-invalid case already escalated in progress_check).
            self.sm.send("scope_done")
        elif state == "exploring":
            plan["explored"] = True
            self.sm.send("explore_done")
        elif state == "planning":
            ctx.plan_steps = summary.get("plan_steps", [])
            ctx.stakes = str(summary.get("stakes", "low"))
            plan["proposed_action"] = summary.get("proposed_action", "")
            plan["alternatives"] = summary.get("alternatives", [])
            plan["counter_argument"] = summary.get("counter_argument", "")
            if self._needs_verification(ctx):
                self.sm.send("plan_to_verify")
            else:
                self.sm.send("plan_to_critique")
        elif state == "critiquing":
            verdict = summary.get("verdict", "NEEDS_REVISION")
            plan["critique_verdict"] = verdict
            plan["critique_issues"] = summary.get("issues", [])
            if verdict == "APPROVE":
                self.sm.send("critique_pass")
            elif verdict == "BLOCKED":
                # A BLOCKED verdict = the plan is categorically unsafe. Revision
                # cannot un-block it and taskifying it would ship an unsafe plan,
                # so we do NOT retry or fall through to critique_exhausted's
                # taskify. Instead halt honestly: route straight to complete with
                # met=False (done_predicate requires verdict==APPROVE) and surface
                # the blocking issues. This mirrors the escalation seam's contract
                # (never fabricate success) at a terminal boundary.
                plan["blocked"] = True
                self.sm.send("critique_blocked")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=summary.get("issues", []))
                ctx.iteration += 1
                explore_rounds = plan.get("explore_rounds", 0)
                if explore_rounds < 2:
                    plan["explore_rounds"] = explore_rounds + 1
                    plan["iteration"] = ctx.iteration
                    self.sm.send("critique_retry_explore")
                else:
                    plan["iteration"] = ctx.iteration
                    self.sm.send("critique_retry_plan")
            else:
                plan["exhausted"] = True
                self.sm.send("critique_exhausted")
        elif state == "taskifying":
            plan["title"] = summary.get("title", "")
            plan["step_count"] = summary.get("step_count", 0)
            plan["structured_complete"] = summary.get("complete", False)
            self.sm.send("taskify_done")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        plan = ctx.extras.get("plan", {})
        return plan.get("critique_verdict") == "APPROVE" and bool(plan.get("structured_complete"))

    # -- high-stakes verification gate -------------------------------------
    def _needs_verification(self, ctx: RunContext) -> bool:
        """Port of the legacy needs_verification guard. UNCERTAIN would already
        have escalated (planning is escalatable), so this decides purely on the
        configured mode + stakes. Default mode is ``relaxed`` (no gate)."""
        mode = str(ctx.constraints.get("verification_mode", "relaxed"))
        stakes = ctx.stakes
        if mode == "off":
            return False
        if mode == "relaxed":
            return False
        if mode == "strict":
            return stakes in ("high", "medium")
        # default mode: gate only genuinely high-stakes plans
        return stakes == "high"

    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        plan = ctx.extras.setdefault("plan", {})
        pending = plan.get("proposed_action") or "The plan is ready but warrants your confirmation."
        alternatives = plan.get("alternatives") or ["(none provided)"]
        counter = plan.get("counter_argument") or "(no counter-argument generated)"
        return [
            {
                "id": "verification_action",
                "label": "Verify Plan",
                "prompt": (
                    "This plan is high-stakes; confirm before I taskify it.\n\n"
                    f"**Proposed approach:** {pending}\n\n"
                    f"**Stakes:** {ctx.stakes}\n\n"
                    f"**Counter-argument (why it might go wrong):** {counter}\n\n"
                    f"**Alternative approach:** {alternatives[0]}"
                ),
                "options": [
                    {
                        "value": "confirm",
                        "label": "Proceed",
                        "description": "Critique and taskify this plan",
                    },
                    {
                        "value": "revise",
                        "label": "Revise",
                        "description": "Send it back to planning with a note",
                    },
                ],
                "allowOther": True,
            }
        ]

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:
        value = (
            response.get("user_response") or response.get("answer")
            if isinstance(response, dict)
            else str(response)
        ) or ""
        value = str(value).strip().lower()
        if self.classify_gate_intent(value) == "approve":
            self.sm.send("verify_confirm")
        else:
            ctx.clarification_text = value
            self.sm.send("verify_revise")

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(self, ctx, spec)
            if builder
            else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        )
        # Recall (F2): seed the FIRST agent directive with distilled lessons
        # (this override replaces the base _task_summary, so re-add it).
        if ctx.recall_lessons and ctx.total_steps == 0:
            lessons = "\n".join(f"- {self._cap(lsn)}" for lsn in ctx.recall_lessons)
            base += (
                "\n\nLessons from prior runs (advisory — weigh against current evidence; "
                "they never override this run's goal or constraints):\n" + lessons
            )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def result_payload(self, ctx: RunContext) -> dict:
        plan = ctx.extras.get("plan", {})
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "title": plan.get("title", ""),
            "step_count": plan.get("step_count", 0),
            "steps": ctx.plan_steps,
            "goal": ctx.goal,
            "non_goals": ctx.constraints.get("non_goals", []),
            "session_id": ctx.session_id,
            "session_room": _room(ctx),
            "requires_approval": True,
            "critique_passed": plan.get("critique_verdict") == "APPROVE",
            "exhausted": plan.get("exhausted", False),
            "blocked": plan.get("blocked", False),
            "unresolved_issues": (
                plan.get("critique_issues", [])
                if plan.get("exhausted") or plan.get("blocked")
                else []
            ),
        }
