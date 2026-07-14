"""ResearchPlaybook — the research skill on the shared engine.

A faithful behavioral port of the legacy 1184-line ``.pi/skills/research``
orchestrator onto ``BasePlaybook``: three modes (quick / standard / deep) that are
caller- or model-declared (the keyword ``detect_mode`` router was deleted per the
Bitter-Lesson gate — a caller ``constraints["mode"]`` wins, else piper declares the
mode in its plan SUMMARY; explicit ``mode=="quick"`` takes the researching
fast-path, everything else transits planning), custom-named states
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

Researching is a **dynamic fan** (arrangement 4): ``route_after("planning")`` turns
the plan's sub-queries into ``ctx.extras["dynamic_branches"]["researching"]`` — one
read-only echo branch per sub-query — and the engine dispatches them in parallel,
bounded by ``constraints["max_fan_width"]`` (default 8). The explicit-quick
fast-path (no planning ran) stays a single echo agent via ``PRIMITIVE_BY_STATE``;
the engine's ``parallel_spec`` precedence (dynamic > class > primitive) makes the
state shape-polymorphic with zero machine changes. The per-mode sub-query table
is replaced by one ``max_sub_queries`` budget (default 4, clamped to the fan
width) — code caps, the model spends.

A ``validating`` state (vera) is the final gate before ``report_writing`` in ALL
three modes: an independent, evidence-based citation-grounding pass that verifies
every material claim in the synthesis is supported by a cited source in the
findings — distinct from carren's *subjective* report critique. A FAIL loops back
to ``synthesizing`` to re-ground (bounded by ``ctx.max_iterations``, with the same
honest-exhaustion + stall-escalation contract as the critique loops); a PASS
proceeds to the report. This restores the independent verifier the legacy FSM
dropped — the generator is never its own only verifier.

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


def _c(required: dict, optional: dict | None = None, evidence: list | None = None) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        contract["evidence"] = evidence
    return contract


# ---------------------------------------------------------------------------
# Modes (a wire vocabulary) + the dynamic research-fan topology. The keyword
# ``detect_mode`` router and the per-mode ``MAX_SUB_QUERIES_BY_MODE`` table were
# deleted (Bitter-Lesson gate): mode is caller/model-declared, and the sub-query
# count is one budget the model spends within.
# ---------------------------------------------------------------------------

MODES = ("quick", "standard", "deep")
DEFAULT_MAX_SUB_QUERIES = 4

# JSON-safe echo branch contract (type NAMES) for the runtime research fan —
# mirrors RESEARCH_EXPLORE so a dynamic branch validates identically.
_RESEARCH_EXPLORE_C_JSON = {
    "required": {"explore_complete": "bool"},
    "optional": {
        "findings_count": "int",
        "sources_count": "int",
        "confidence": "str",
        "mempalace_drawer": "str",
        "needs_clarification": "bool",
        "clarifying_questions": "list",
    },
}


def _research_branches(sub_queries: list) -> dict | None:
    """One read-only echo branch per sub-query (arrangement 4). Returns ``None``
    when there are no usable sub-queries (the quick fast-path stays single-agent
    via PRIMITIVE_BY_STATE)."""
    branches: dict = {}
    for i, sq in enumerate(sub_queries, 1):
        text = str(sq).strip()
        if not text:
            continue
        branches[f"sq{i}"] = {
            "agent": "echo",
            "name": f"RESEARCH_EXPLORE_SQ{i}",
            "task_hint": text,
            "summary_contract": _RESEARCH_EXPLORE_C_JSON,
        }
    return branches or None


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
    validating = State()  # vera — evidence-based citation-grounding gate (all modes)
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
    synth_to_validate = synthesizing.to(validating)  # standard/quick + deep post-critique
    report_critique_pass = critiquing_report.to(validating)
    report_critique_revise = critiquing_report.to(synthesizing)  # bounded revise loop
    report_critique_exhausted = critiquing_report.to(validating)  # budget spent
    validate_pass = validating.to(report_writing)
    validate_revise = validating.to(synthesizing)  # bounded re-grounding loop
    validate_exhausted = validating.to(report_writing)  # budget spent
    report_done = report_writing.to(complete)

    to_unknown = (
        planning.to(unknown)
        | critiquing_plan.to(unknown)
        | researching.to(unknown)
        | synthesizing.to(unknown)
        | critiquing_report.to(unknown)
        | validating.to(unknown)
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
        | validating.to(error)
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
            "mode": str,  # model-declared rigor/budget preset (R1) when no caller sets it
            "sub_queries": list,
            "confidence": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Decompose the research query into focused, independently researchable sub-queries; "
    "declare the mode (quick/standard/deep) unless the caller fixed it.",
)

_CRITIQUE_C = _c(
    # Evidence-gated (Rec 4): the verdict must carry what carren examined.
    {"verdict": str, "issues": list, "evidence": list},
    {
        "mempalace_drawer": str,
        "confidence": str,
        "needs_clarification": bool,
        "clarifying_questions": list,
    },
    evidence=["evidence"],
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
    "Research the sub-queries with web_search + web_fetch, including a YouTube-targeted search and youtube_transcript pull for relevant video sources; write tiered, cited findings to mempalace.",
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
RESEARCH_VALIDATE = PrimitiveSpec(
    "RESEARCH_VALIDATE",
    "vera",
    _c(
        # Evidence-gated citation-grounding (Rec 4): the verdict must carry the
        # captured claim->source checks (quotes, fetched spot-checks).
        {"verdict": str, "unsupported_claims": list, "evidence": list},
        {
            "mempalace_drawer": str,
            "confidence": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
        evidence=["evidence"],
    ),
    "Verify every material claim in the synthesis is grounded in a cited source. Verdict PASS or FAIL with the unsupported claims listed.",
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
    # validation_revision and report_revision are separate keys, each popped when
    # its loop closes, so at most one is set on any given synthesis entry.
    val_revision = research.get("validation_revision", 0)
    if val_revision:
        vissues = research.get("validation_issues", [])
        task += (
            f"\n\nThis is a VALIDATION revision (cycle {val_revision}). The verifier (vera) flagged "
            f"these claims as unsupported by the cited sources: "
            f"{'; '.join(str(i) for i in vissues) or 'see the validation drawer'}. "
            f"Read the validation report from mempalace room: {room}. Re-ground or REMOVE every "
            f"flagged claim — cite a supporting source or drop the claim. Do not introduce new "
            f"unsupported claims."
        )
    return task


def _build_validating(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    room = _room(ctx)
    task = (
        f"Verify the synthesized research report for: {pb._cap(ctx.goal)}\n\n"
        f"Read the synthesis ('{ctx.session_id} Synthesis') and the cited research findings "
        f"('{ctx.session_id}-echo-<n> Research Findings') from mempalace room: {room}\n\n"
        f"For every material claim in the synthesis, confirm it is grounded in a source cited in "
        f"the findings that actually supports it. Flag unsupported, overclaimed, fabricated, or "
        f"mis-cited claims. Verdict PASS only if all material claims are source-grounded; "
        f"otherwise FAIL and list each unsupported claim."
    )
    revision = research.get("validation_revision", 0)
    if revision:
        issues = research.get("validation_issues", [])
        task += (
            f"\n\nThis is re-validation cycle {revision + 1} — the synthesis was revised to "
            f"re-ground prior flagged claims: "
            f"{'; '.join(str(i) for i in issues) or 'see prior verdict'}. "
            f"Re-check those claims specifically, then the report as a whole."
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
    "validating": _build_validating,
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
        "validating": RESEARCH_VALIDATE,
        "report_writing": RESEARCH_REPORT,
    }
    ESCALATABLE_STATES = frozenset(
        {
            "planning",
            "critiquing_plan",
            "researching",
            "synthesizing",
            "critiquing_report",
            "validating",
        }
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("research skill requires a non-empty goal (the research query)")
        research = ctx.extras.setdefault("research", {})
        # Mode: caller constraint wins; otherwise piper declares it in the plan
        # SUMMARY (captured in route_after). No keyword detection.
        caller_mode = str(ctx.constraints.get("mode", ""))
        research["mode"] = caller_mode if caller_mode in MODES else ""
        # One sub-query budget (replaces the per-mode table), clamped to the fan
        # width since sub-queries become fan branches. Code caps; model spends.
        try:
            max_sub_queries = int(ctx.constraints.get("max_sub_queries", DEFAULT_MAX_SUB_QUERIES))
        except (TypeError, ValueError):
            max_sub_queries = DEFAULT_MAX_SUB_QUERIES
        try:
            fan_width = int(ctx.constraints.get("max_fan_width", 8))
        except (TypeError, ValueError):
            fan_width = 8
        research["max_sub_queries"] = max(
            1, min(max_sub_queries or DEFAULT_MAX_SUB_QUERIES, fan_width)
        )
        research["report_format"] = str(ctx.constraints.get("report_format", "default"))
        # Only an EXPLICIT caller quick mode takes the single-agent fast-path; a
        # model-declared quick still transits planning (it decomposes there).
        if caller_mode == "quick":
            self.sm.send("start_research")
            return "researching"
        self.sm.send("start_plan")
        return "planning"

    # -- progress / escalation gate (needs_clarification + honest stalls) ---
    def progress_check(  # noqa: C901
        self, state: str, ctx: RunContext, summary: dict
    ) -> str | None:
        if summary.get("needs_clarification"):
            questions = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in questions)}" if questions else ""
            return f"{state} agent requested clarification{detail}"
        if state == "planning" and not summary.get("plan_complete"):
            return (
                "planning reported plan_complete=false — the query could not be decomposed; "
                "clarify the research scope"
            )
        if state == "researching":
            # Fan-in aggregates per-branch summaries under "branches"; the
            # single-agent fast path reports explore_complete directly.
            if "branches" in summary:
                complete = all(
                    b.get("explore_complete") for b in (summary.get("branches") or {}).values()
                )
            else:
                complete = bool(summary.get("explore_complete"))
            if not complete:
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
        if state == "validating" and summary.get("verdict") != "PASS":
            if self.is_stalled(ctx, summary.get("unsupported_claims", [])):
                return (
                    "the same validation issues have persisted across revisions with no measurable "
                    "progress — escalating rather than shipping unverified claims"
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
        # The report-critique loop is over; the next synthesis (if any) belongs to
        # the validation gate, not another critique pass.
        research["phase"] = "validation"
        ctx.iteration = 0
        ctx.iteration_history = []

    @staticmethod
    def _end_validation_loop(ctx: RunContext, research: dict) -> None:
        research["validation_revisions"] = ctx.iteration
        research.pop("validation_revision", None)
        ctx.iteration = 0
        ctx.iteration_history = []

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        research = ctx.extras.setdefault("research", {})
        mode = research.get("mode", "standard")
        if state == "planning":
            # Capture the model-declared mode (R1) unless a caller constraint
            # already fixed it; an unknown declaration falls back to standard.
            if not research.get("mode"):
                declared = str(summary.get("mode") or "")
                research["mode"] = declared if declared in MODES else "standard"
                mode = research["mode"]
            steps = summary.get("plan_steps") or summary.get("sub_queries") or []
            cap = int(research.get("max_sub_queries", 0)) or len(steps)
            over = len(steps) > cap
            research["sub_queries"] = list(steps)[:cap]  # budget enforced at dispatch
            if over:
                research.setdefault("warnings", []).append(
                    f"plan proposed {len(steps)} sub-queries; capped to max_sub_queries={cap}"
                )
            ctx.plan_steps = research["sub_queries"]
            # Fan-out research (arrangement 4): one echo branch per sub-query.
            # None -> the researching state falls back to the single-agent primitive.
            branches = _research_branches(research["sub_queries"])
            dyn = ctx.extras.setdefault("dynamic_branches", {})
            if branches:
                dyn["researching"] = branches
            else:
                dyn.pop("researching", None)
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
            # Handle BOTH shapes: the aggregated fan-in ({branches, confidence})
            # and the single-agent fast-path SUMMARY (explore_complete gated in
            # progress_check for both).
            if "branches" in summary:
                bmap = summary.get("branches") or {}
                research["research_complete"] = all(
                    b.get("explore_complete") for b in bmap.values()
                )
                research["research_drawers"] = [
                    b.get("mempalace_drawer", "") for b in bmap.values()
                ]
                research["research_branch_count"] = len(bmap)
            else:
                research["research_complete"] = True
                research["research_drawer"] = summary.get("mempalace_drawer", "")
            self.sm.send("research_done")
        elif state == "synthesizing":
            research["synthesis_complete"] = True  # synthesis_complete gated in progress_check
            research["report_word_count"] = summary.get("report_word_count", 0)
            research["synthesis_drawer"] = summary.get("mempalace_drawer", "")
            # Deep mode runs carren's subjective report critique BEFORE the
            # validation gate; once that loop closes (phase="validation") a
            # validation-driven re-synthesis routes straight back to vera.
            if mode == "deep" and research.get("phase") != "validation":
                self.sm.send("synth_to_critique")
            else:
                self.sm.send("synth_to_validate")
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
        elif state == "validating":
            verdict = summary.get("verdict", "FAIL")
            issues = summary.get("unsupported_claims", [])
            research["validation_verdict"] = verdict
            research["validation_issues"] = issues
            if verdict == "PASS":
                self._end_validation_loop(ctx, research)
                self.sm.send("validate_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=issues)
                ctx.iteration += 1
                research["validation_revision"] = ctx.iteration
                self.sm.send("validate_revise")
            else:
                # HONEST exhaustion: research must still deliver a report. Proceed
                # with a recorded warning and the unverified claims surfaced in
                # result — never silently ship them as verified.
                research["validation_exhausted"] = True
                research.setdefault("warnings", []).append(
                    f"validation budget exhausted after {ctx.max_iterations} review cycles; "
                    f"writing the report with unverified claims: "
                    f"{'; '.join(str(i) for i in issues) or '(none listed)'}"
                )
                self._end_validation_loop(ctx, research)
                self.sm.send("validate_exhausted")
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
            # clarify re-enters planning and re-runs the pipeline from scratch, so
            # phase / revision / exhaustion markers from the interrupted run must
            # not leak into the fresh pass (a stale phase="validation" would make
            # deep synthesis skip its report critique).
            research = self.ctx.extras.get("research", {})
            for _k in (
                "phase",
                "plan_revision",
                "report_revision",
                "validation_revision",
                "plan_critique_exhausted",
                "report_critique_exhausted",
                "validation_exhausted",
            ):
                research.pop(_k, None)
        return super()._resume(state, result)

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        research = ctx.extras.get("research", {})
        # A dynamic research FAN branch (name RESEARCH_EXPLORE_SQ<n>) researches
        # its OWN sub-query (spec.task_hint) and writes a branch-tagged drawer;
        # the single-agent fast path uses the "research ALL" builder.
        if state == "researching" and getattr(spec, "name", "").startswith("RESEARCH_EXPLORE_SQ"):
            room = _room(ctx)
            n = spec.name.rsplit("SQ", 1)[-1] or "1"
            base = (
                f"Research this sub-query for: {self._cap(ctx.goal)}\n\n"
                f"Sub-query: {spec.task_hint}\n\n"
                f"Write findings to mempalace room: {room} with header: "
                f"{ctx.session_id}-echo-{n} Research Findings."
            )
        else:
            builder = _TASK_BUILDERS.get(state)
            base = (
                builder(self, ctx, research)
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
        research = ctx.extras.get("research", {})
        unresolved: list = []
        if research.get("plan_critique_exhausted"):
            unresolved.extend(research.get("plan_critique_issues", []))
        if research.get("report_critique_exhausted"):
            unresolved.extend(research.get("report_critique_issues", []))
        if research.get("validation_exhausted"):
            unresolved.extend(research.get("validation_issues", []))
        return {
            "met": ctx.met,
            "iterations": (
                research.get("plan_revisions", 0)
                + research.get("report_revisions", 0)
                + research.get("validation_revisions", 0)
            ),
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
            "validation_exhausted": research.get("validation_exhausted", False),
            "unresolved_issues": unresolved,
        }
