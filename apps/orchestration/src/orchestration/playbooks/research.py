"""ResearchPlaybook — the research skill on the shared engine.

A faithful behavioral port of the legacy 1184-line ``.pi/skills/research``
orchestrator onto ``BasePlaybook``: three modes (quick / standard / deep) picked
at intake by the legacy keyword heuristics, custom-named states
(planning→[deep: critiquing_plan⇄planning]→researching→synthesizing→
[deep: critiquing_report⇄synthesizing]→report_writing), per-state SUMMARY
contracts matching the assets/prompts SUMMARY blocks, and needs-clarification /
UNCERTAIN escalation on the engine's single HITL seam.

Deliberate behavior fixes vs. the legacy runtime:
  * BOTH critique revise loops (plan and report) were UNBOUNDED — a perpetually
    rejecting carren spun forever. They are now bounded by ``ctx.max_iterations``
    with HONEST exhaustion: the run proceeds to the next stage with a recorded
    warning and the unresolved issues reported (research must still produce a
    report; ``met`` reflects only whether the report was actually written);
  * a stalled critique loop (the same issues persisting across revisions)
    escalates to the user instead of burning the remaining budget;
  * the escalation resume is no longer severed — the legacy path dropped the
    user's ``user_response`` and force-replayed transitions back to planning.
    ``clarify`` now resumes at ``planning`` with the clarification text carried
    into the task (a quick-mode resume also goes through planning, which then
    routes straight on to researching);
  * the legacy report-critique dead-end (NEEDS_REVISION with an empty issues
    list matched no transition and hard-errored) is fixed: any non-APPROVE
    verdict routes to a bounded revision;
  * ``report_writing``'s output directory is a real ABSOLUTE path (the legacy
    passed an unexpanded ``~/projects/penny/research/...`` literal);
  * ``max_sub_queries`` is actually enforced at dispatch (the legacy launched
    however many sub-queries piper returned);
  * ``write_complete=false`` completes honestly with ``met=False`` instead of
    stalling into a generic error.

Researching is a SINGLE echo agent instructed to research ALL sub-queries (the
legacy fanned out one echo per sub-query, but the branch count is dynamic, which
does not fit the engine's fixed ``ParallelSpec``). Vera is NOT invoked — the
validating state was removed from the legacy FSM before this port.

Domain guidance stays in ``.pi/skills/research/assets/prompts/<agent>.md``; the
mempalace room ``skills/research-{session_id}`` and the drawer conventions
(``<sid> Planner`` / ``<sid>-echo-<n> Research Findings`` / ``<sid> Synthesis``
/ ``<sid> Critique`` / ``<sid> Report Files``) are preserved verbatim.
"""

from __future__ import annotations

import re
from pathlib import Path

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import PrimitiveSpec


def _c(required: dict, optional: dict | None = None) -> dict:
    return {"required": required, "optional": optional or {}}


# ---------------------------------------------------------------------------
# Mode detection + topic sanitization (ported verbatim from the legacy
# ResearchOrchestrator; only max_sub_queries survives from MODE_DEFAULTS — the
# min_* keys were never read by any code)
# ---------------------------------------------------------------------------

MODES = ("quick", "standard", "deep")
MAX_SUB_QUERIES_BY_MODE = {"quick": 1, "standard": 3, "deep": 4}


def detect_mode(query: str) -> str:
    query_lower = query.lower()
    deep_keywords = [
        "deep research",
        "comprehensive",
        "thorough",
        "in-depth",
        "detailed analysis",
        "exhaustive",
        "extensive research",
    ]
    if any(kw in query_lower for kw in deep_keywords):
        return "deep"
    quick_keywords = [
        "quick",
        "briefly",
        "summary",
        "tldr",
        "what is",
        "define",
        "explain briefly",
        "overview",
    ]
    if any(kw in query_lower for kw in quick_keywords):
        return "quick"
    word_count = len(re.findall(r"\w+", query))
    question_count = query.count("?")
    if word_count <= 10 and question_count == 1:
        return "quick"
    return "standard"


def _sanitize_topic(query: str) -> str:
    """Sanitize a research query into a filesystem-safe directory name."""
    sanitized = re.sub(r"[^\w\s-]", "", query.lower())
    sanitized = re.sub(r"[-\s]+", "-", sanitized)
    return sanitized.strip("-")[:80]


def _room(ctx: RunContext) -> str:
    return f"skills/research-{ctx.session_id}"


def _report_dir(ctx: RunContext) -> str:
    """ABSOLUTE report directory (fix: the legacy passed an unexpanded tilde)."""
    return str(Path("~/projects/penny/research").expanduser() / _sanitize_topic(ctx.goal))


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class ResearchMachine(StateMachine):
    intake = State(initial=True)
    planning = State()  # piper — standard/deep (quick skips straight to researching)
    critiquing_plan = State()  # carren — deep only
    researching = State()  # echo — single agent, all sub-queries
    synthesizing = State()  # synthia
    critiquing_report = State()  # carren — deep only
    report_writing = State()  # skribble
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_plan = intake.to(planning)
    start_research = intake.to(researching)  # quick mode
    plan_to_critique = planning.to(critiquing_plan)  # deep
    plan_to_research = planning.to(researching)  # quick/standard (+ deep post-clarify)
    plan_critique_pass = critiquing_plan.to(researching)
    plan_critique_revise = critiquing_plan.to(planning)  # bounded revise loop
    plan_critique_exhausted = critiquing_plan.to(researching)  # budget spent; warning
    research_done = researching.to(synthesizing)
    synth_to_critique = synthesizing.to(critiquing_report)  # deep
    synth_to_report = synthesizing.to(report_writing)
    report_critique_pass = critiquing_report.to(report_writing)
    report_critique_revise = critiquing_report.to(synthesizing)  # bounded revise loop
    report_critique_exhausted = critiquing_report.to(report_writing)  # budget spent
    report_done = report_writing.to(complete)

    to_unknown = (
        planning.to(unknown)
        | critiquing_plan.to(unknown)
        | researching.to(unknown)
        | synthesizing.to(unknown)
        | critiquing_report.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(planning)
    abort = (
        intake.to(error)
        | planning.to(error)
        | critiquing_plan.to(error)
        | researching.to(error)
        | synthesizing.to(error)
        | critiquing_report.to(error)
        | report_writing.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts (matched to the assets/prompts SUMMARY blocks —
# confidence is optional everywhere; piper does not even emit one, so agent-side
# escalation rides needs_clarification / an UNCERTAIN confidence when present)
# ---------------------------------------------------------------------------

RESEARCH_PLAN = PrimitiveSpec(
    "RESEARCH_PLAN",
    "piper",
    _c(
        {"plan_steps": list, "plan_complete": bool},
        {
            "sub_queries": list,
            "confidence": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Decompose the research query into focused, independently researchable sub-queries.",
)

_CRITIQUE_C = _c(
    {"verdict": str, "issues": list},
    {
        "mempalace_drawer": str,
        "confidence": str,
        "needs_clarification": bool,
        "clarifying_questions": list,
    },
)
RESEARCH_CRITIQUE_PLAN = PrimitiveSpec(
    "RESEARCH_CRITIQUE_PLAN",
    "carren",
    _CRITIQUE_C,
    "Critique the research plan: coverage, redundancy, feasibility. Verdict APPROVE or NEEDS_REVISION with issue titles.",
)
RESEARCH_CRITIQUE_REPORT = PrimitiveSpec(
    "RESEARCH_CRITIQUE_REPORT",
    "carren",
    _CRITIQUE_C,
    "Critique the research report: overclaiming, bias, fairness, uncertainty. Verdict APPROVE or NEEDS_REVISION with issue titles.",
)
RESEARCH_EXPLORE = PrimitiveSpec(
    "RESEARCH_EXPLORE",
    "echo",
    _c(
        {"explore_complete": bool},
        {
            "findings_count": int,
            "sources_count": int,
            "confidence": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Research the sub-queries with web_search + web_fetch; write tiered, cited findings to mempalace.",
)
RESEARCH_SYNTHESIZE = PrimitiveSpec(
    "RESEARCH_SYNTHESIZE",
    "synthia",
    _c(
        {"synthesis_complete": bool},
        {
            "theme_count": int,
            "source_count": int,
            "report_word_count": int,
            "confidence": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Synthesize all research findings into a single thematic, cited report in mempalace.",
)
RESEARCH_REPORT = PrimitiveSpec(
    "RESEARCH_REPORT",
    "skribble",
    _c(
        {"write_complete": bool, "files_written": list},
        {
            "word_count": int,
            "confidence": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Write report.md, sources.md and README.md to the research output directory.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders (legacy task text + mempalace room preserved
# verbatim; revision context mirrors the plan skill's revision blocks)
# ---------------------------------------------------------------------------


def _build_planning(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    task = (
        f"Research planning: decompose '{pb._cap(ctx.goal)}' into sub-queries\n\n"
        f"Write your plan to mempalace room: {room}"
    )
    task += (
        f"\nMode: {research.get('mode', 'standard')}. "
        f"Produce at most {research.get('max_sub_queries', 3)} sub-queries."
    )
    revision = research.get("plan_revision", 0)
    if revision:
        issues = research.get("plan_critique_issues", [])
        task += (
            f"\n\nThis is REVISION cycle {revision}. The prior critique identified these issues: "
            f"{'; '.join(str(i) for i in issues) or 'see the critique in mempalace'}. "
            f"Read the critique from mempalace room: {room}. Address EVERY issue and note how "
            f"you resolved it."
        )
    return task


def _build_critiquing_plan(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    task = (
        f"Critique research plan for: {pb._cap(ctx.goal)}\n\n"
        f"Read the plan from mempalace room: {room}"
    )
    revision = research.get("plan_revision", 0)
    if revision:
        task += (
            f"\n\nThis is review cycle {revision + 1} — the plan was revised to address prior "
            f"issues. Block ONLY on significant coverage/feasibility issues; note minor concerns "
            f"but APPROVE with notes rather than blocking."
        )
    return task


def _build_researching(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    sub_queries = research.get("sub_queries", [])
    if research.get("mode") == "quick" or not sub_queries:
        return f"Quick research: {pb._cap(ctx.goal)}\n\nWrite findings to mempalace room: {room}"
    lines = [f"Research ALL of the following sub-queries for: {pb._cap(ctx.goal)}"]
    for i, sub_query in enumerate(sub_queries, 1):
        lines.append(f"Research sub-query {i}: {sub_query}")
    lines.append("")
    lines.append(f"Write findings to mempalace room: {room}")
    lines.append(
        f"Write ONE findings drawer per sub-query with header: "
        f"{ctx.session_id}-echo-<n> Research Findings "
        f"(e.g. '## {ctx.session_id}-echo-1 Research Findings' for sub-query 1)."
    )
    return "\n".join(lines)


def _build_synthesizing(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    format_note = ""
    report_format = research.get("report_format", "default")
    if report_format != "default":
        format_note = f" Use {report_format} format."
    task = (
        f"Synthesize research report for: {pb._cap(ctx.goal)}.{format_note}\n\n"
        f"Read findings and validation from mempalace room: {room}"
    )
    revision = research.get("report_revision", 0)
    if revision:
        issues = research.get("report_critique_issues", [])
        task += (
            f"\n\nThis is REVISION cycle {revision}. The prior critique identified these issues: "
            f"{'; '.join(str(i) for i in issues) or 'see the critique in mempalace'}. "
            f"Read the critique from mempalace room: {room}. Address EVERY issue and note how "
            f"you resolved it."
        )
    return task


def _build_critiquing_report(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    task = (
        f"Critique research report for: {pb._cap(ctx.goal)}\n\n"
        f"Read the report from mempalace room: {room}"
    )
    revision = research.get("report_revision", 0)
    if revision:
        task += (
            f"\n\nThis is review cycle {revision + 1} — the report was revised to address prior "
            f"issues. Block ONLY on significant overclaiming/bias/fairness issues; note minor "
            f"concerns but APPROVE with notes rather than blocking."
        )
    return task


def _build_report_writing(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    return (
        f"Write the final research report for: {pb._cap(ctx.goal)}\n\n"
        f"Write all files to: {_report_dir(ctx)}\n\n"
        f"Read the synthesized report from mempalace room: {room}\n\n"
        f"Produce: report.md (main report), sources.md (bibliography), "
        f"README.md (quick reference)."
    )


_TASK_BUILDERS = {
    "planning": _build_planning,
    "critiquing_plan": _build_critiquing_plan,
    "researching": _build_researching,
    "synthesizing": _build_synthesizing,
    "critiquing_report": _build_critiquing_report,
    "report_writing": _build_report_writing,
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class ResearchPlaybook(BasePlaybook):
    NAME = "research"
    machine_cls = ResearchMachine
    PRIMITIVE_BY_STATE = {
        "planning": RESEARCH_PLAN,
        "critiquing_plan": RESEARCH_CRITIQUE_PLAN,
        "researching": RESEARCH_EXPLORE,
        "synthesizing": RESEARCH_SYNTHESIZE,
        "critiquing_report": RESEARCH_CRITIQUE_REPORT,
        "report_writing": RESEARCH_REPORT,
    }
    ESCALATABLE_STATES = frozenset(
        {"planning", "critiquing_plan", "researching", "synthesizing", "critiquing_report"}
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("research skill requires a non-empty goal (the research query)")
        research = ctx.extras.setdefault("research", {})
        mode = str(ctx.constraints.get("mode", "auto"))
        if mode not in MODES:
            mode = detect_mode(ctx.goal)
        research["mode"] = mode
        try:
            max_sub_queries = int(ctx.constraints.get("max_sub_queries", 0))
        except (TypeError, ValueError):
            max_sub_queries = 0
        research["max_sub_queries"] = max_sub_queries or MAX_SUB_QUERIES_BY_MODE[mode]
        research["report_format"] = str(ctx.constraints.get("report_format", "default"))
        if mode == "quick":
            self.sm.send("start_research")
            return "researching"
        self.sm.send("start_plan")
        return "planning"

    # -- progress / escalation gate (needs_clarification + honest stalls) ---
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            questions = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in questions)}" if questions else ""
            return f"{state} agent requested clarification{detail}"
        if state == "planning" and not summary.get("plan_complete"):
            return (
                "planning reported plan_complete=false — the query could not be decomposed; "
                "clarify the research scope"
            )
        if state == "researching" and not summary.get("explore_complete"):
            return (
                "researching reported explore_complete=false — the sub-queries could not be "
                "researched; clarify the research scope"
            )
        if state == "synthesizing" and not summary.get("synthesis_complete"):
            return (
                "synthesizing reported synthesis_complete=false — the findings could not be "
                "synthesized; clarify how to proceed"
            )
        if (
            state in ("critiquing_plan", "critiquing_report")
            and summary.get("verdict") != "APPROVE"
        ):
            if self.is_stalled(ctx, summary.get("issues", [])):
                return (
                    "the same critique issues have persisted across revisions with no measurable "
                    "progress — escalating rather than force-approving"
                )
        return None

    # -- bounded-loop bookkeeping -------------------------------------------
    @staticmethod
    def _end_plan_loop(ctx: RunContext, research: dict) -> None:
        """Close the plan-critique loop: bank its revision count and reset the
        shared iteration counters so the report-critique loop starts fresh (and
        plan-loop gaps cannot contaminate the report loop's stall detection)."""
        research["plan_revisions"] = ctx.iteration
        research.pop("plan_revision", None)
        ctx.iteration = 0
        ctx.iteration_history = []

    @staticmethod
    def _end_report_loop(ctx: RunContext, research: dict) -> None:
        research["report_revisions"] = ctx.iteration
        research.pop("report_revision", None)
        ctx.iteration = 0
        ctx.iteration_history = []

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        research = ctx.extras.setdefault("research", {})
        mode = research.get("mode", "standard")
        if state == "planning":
            steps = summary.get("plan_steps") or summary.get("sub_queries") or []
            cap = int(research.get("max_sub_queries", 0)) or len(steps)
            research["sub_queries"] = list(steps)[:cap]  # budget enforced at dispatch
            ctx.plan_steps = research["sub_queries"]
            if mode == "deep":
                self.sm.send("plan_to_critique")
            else:
                self.sm.send("plan_to_research")
        elif state == "critiquing_plan":
            verdict = summary.get("verdict", "NEEDS_REVISION")
            issues = summary.get("issues", [])
            research["plan_critique_verdict"] = verdict
            research["plan_critique_issues"] = issues
            if verdict == "APPROVE":
                self._end_plan_loop(ctx, research)
                self.sm.send("plan_critique_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=issues)
                ctx.iteration += 1
                research["plan_revision"] = ctx.iteration
                self.sm.send("plan_critique_revise")
            else:
                # HONEST exhaustion (fix: this loop was unbounded in the legacy
                # FSM). Research must still produce a report — proceed with a
                # recorded warning and the unresolved issues surfaced in result.
                research["plan_critique_exhausted"] = True
                research.setdefault("warnings", []).append(
                    f"plan critique budget exhausted after {ctx.max_iterations} review cycles; "
                    f"proceeding to research with unresolved issues: "
                    f"{'; '.join(str(i) for i in issues) or '(none listed)'}"
                )
                self._end_plan_loop(ctx, research)
                self.sm.send("plan_critique_exhausted")
        elif state == "researching":
            research["research_complete"] = True  # explore_complete gated in progress_check
            research["research_drawer"] = summary.get("mempalace_drawer", "")
            self.sm.send("research_done")
        elif state == "synthesizing":
            research["synthesis_complete"] = True  # synthesis_complete gated in progress_check
            research["report_word_count"] = summary.get("report_word_count", 0)
            research["synthesis_drawer"] = summary.get("mempalace_drawer", "")
            if mode == "deep":
                self.sm.send("synth_to_critique")
            else:
                self.sm.send("synth_to_report")
        elif state == "critiquing_report":
            verdict = summary.get("verdict", "NEEDS_REVISION")
            issues = summary.get("issues", [])
            research["report_critique_verdict"] = verdict
            research["report_critique_issues"] = issues
            if verdict == "APPROVE":
                self._end_report_loop(ctx, research)
                self.sm.send("report_critique_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                # Fix vs. legacy: any non-APPROVE verdict revises (the legacy
                # dead-ended NEEDS_REVISION with an empty issues list into error).
                self.record_iteration(ctx, gaps=issues)
                ctx.iteration += 1
                research["report_revision"] = ctx.iteration
                self.sm.send("report_critique_revise")
            else:
                research["report_critique_exhausted"] = True
                research.setdefault("warnings", []).append(
                    f"report critique budget exhausted after {ctx.max_iterations} review cycles; "
                    f"writing the report with unresolved issues: "
                    f"{'; '.join(str(i) for i in issues) or '(none listed)'}"
                )
                self._end_report_loop(ctx, research)
                self.sm.send("report_critique_exhausted")
        elif state == "report_writing":
            research["report_written"] = bool(summary.get("write_complete"))
            research["report_files"] = summary.get("files_written", [])
            research["report_dir"] = _report_dir(ctx)
            # Complete either way; done_predicate reports the honest outcome
            # (met=False when the write failed) — never a fabricated success.
            self.sm.send("report_done")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        return bool(ctx.extras.get("research", {}).get("report_written"))

    # -- HITL resume -------------------------------------------------------
    def _resume(self, state: str, result) -> dict:
        """Reset the shared bounded-loop counters before resuming from a HITL
        pause. The escalation path (to_unknown -> escalate) never closes the
        active critique loop via _end_plan_loop/_end_report_loop, so ``ctx.iteration``
        and ``ctx.iteration_history`` are left mid-loop. ``clarify`` re-enters at
        ``planning`` and re-runs the full deep pipeline from scratch, so each
        bounded loop must start clean — otherwise a stale ``ctx.iteration`` makes
        ``route_after`` fire ``plan_critique_exhausted`` on the FIRST visit (a
        false "budget exhausted" warning with zero cycles run) and the stale
        ``iteration_history`` poisons ``is_stalled``."""
        if state == "awaiting_clarification":
            self.ctx.iteration = 0
            self.ctx.iteration_history = []
        return super()._resume(state, result)

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        research = ctx.extras.get("research", {})
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(self, ctx, research)
            if builder
            else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def result_payload(self, ctx: RunContext) -> dict:
        research = ctx.extras.get("research", {})
        unresolved: list = []
        if research.get("plan_critique_exhausted"):
            unresolved.extend(research.get("plan_critique_issues", []))
        if research.get("report_critique_exhausted"):
            unresolved.extend(research.get("report_critique_issues", []))
        return {
            "met": ctx.met,
            "iterations": research.get("plan_revisions", 0) + research.get("report_revisions", 0),
            "query": ctx.goal,
            "mode": research.get("mode", ""),
            "sub_queries": research.get("sub_queries", []),
            "report_drawer_id": f"{ctx.session_id} Synthesis",
            "report_dir": research.get("report_dir", ""),
            "report_files": research.get("report_files", []),
            "room": _room(ctx),
            "warnings": research.get("warnings", []),
            "plan_critique_exhausted": research.get("plan_critique_exhausted", False),
            "report_critique_exhausted": research.get("report_critique_exhausted", False),
            "unresolved_issues": unresolved,
        }
