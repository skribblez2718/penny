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
    passed an unexpanded ``~`` tilde literal instead of an absolute path);
  * ``max_sub_queries`` is actually enforced at dispatch (the legacy launched
    however many sub-queries piper returned);
  * ``write_complete=false`` terminates honestly as ``incomplete`` with
    ``met=False`` instead of stalling or emitting a public success.

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

Domain guidance stays in ``.pi/skills/research/assets/prompts/<agent>.md``.
Every cognitive stage receives exact execution-owner artifact references from the
engine, reads them through ``artifact_read``, and returns complete output for owner
capture. SUMMARY objects remain routing data only. The final owner-captured
``report_writing`` output is the registered product artifact; the three report files
remain user-facing product files.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from statemachine import State, StateMachine

from ..artifacts import KIND_AGENT_OUTPUT, ArtifactError, ArtifactRef
from ..context import RunContext
from ..engine import BasePlaybook, tier_budget
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

# ---------------------------------------------------------------------------
# Mode as a BUDGET PRESET, not a set of hard-wired edges.
#
# Mode used to gate FSM edges directly (``if mode == "deep": critique``), which made
# rigor an author-time, three-valued quantization of a continuous question ("how much
# verification does THIS query need?") that could never change once the run started —
# a quick run that turned up contradictory sources was structurally forbidden from
# earning an adversarial read. Mode now expands to a BUDGET the routing spends, so:
#   * rigor is decoupled from the label (a caller can set ``critique_passes`` directly);
#   * rigor can be EARNED mid-run (see the rigor escalation in route_after);
#   * adding a rigor level is a table entry, not new routing code.
#
# ``critique_passes`` is a monotonic ladder, deliberately allocating the scarcer
# budget to the MORE valuable critique first:
#   >= 1  -> report critique (carren reads the actual output)
#   >= 2  -> plan critique as well (carren reads the plan)
#
# NOTE: ``max_sub_queries`` is deliberately ABSENT from this table. A per-mode
# sub-query count was deleted as a Bitter-Lesson violation and must not return:
# breadth is ONE budget the model spends within, not a number the mode dictates.
# Mode governs how much VERIFICATION is paid for, not how the model decomposes.
# ---------------------------------------------------------------------------

MODE_BUDGETS: dict[str, dict[str, int]] = {
    "quick": {"critique_passes": 0, "max_research_rounds": 2},
    "standard": {"critique_passes": 0, "max_research_rounds": 2},
    "deep": {"critique_passes": 2, "max_research_rounds": 3},
}
DEFAULT_MODE = "standard"
# Total research passes allowed per run: the initial fan plus evidence-seeking
# re-research rounds. A CEILING (code caps, the model spends), not a target — a run
# that never needs more evidence never spends a second round. Set to 1 to disable
# evidence-seeking entirely and restore the single-round pipeline.
DEFAULT_MAX_RESEARCH_ROUNDS = 2

# JSON-safe echo branch contract (type NAMES) for the runtime research fan —
# mirrors RESEARCH_EXPLORE so a dynamic branch validates identically.
_RESEARCH_EXPLORE_C_JSON = {
    "required": {"explore_complete": "bool"},
    "optional": {
        "confidence": "str",
        "needs_clarification": "bool",
        "clarifying_questions": "list",
    },
}


def _research_branches(sub_queries: list, *, start: int = 1, evidence: bool = False) -> dict | None:
    """One read-only echo branch per sub-query (arrangement 4). Returns ``None``
    when there are no usable sub-queries (the quick fast-path stays single-agent
    via PRIMITIVE_BY_STATE).

    ``start`` continues branch numbering across research rounds so every
    evidence-seeking branch has a distinct artifact identity (``sq4``, ``sq5``)
    instead of superseding an earlier branch.

    ``evidence=True`` marks the branch as filling a NAMED evidence gap the verifier
    diagnosed, rather than researching a fresh sub-query; ``_task_summary`` renders
    the two differently.
    """
    prefix = "RESEARCH_EVIDENCE_SQ" if evidence else "RESEARCH_EXPLORE_SQ"
    branches: dict = {}
    for offset, sq in enumerate(sub_queries):
        text = str(sq).strip()
        if not text:
            continue
        i = start + offset
        branches[f"sq{i}"] = {
            "agent": "echo",
            "name": f"{prefix}{i}",
            "task_hint": text,
            "summary_contract": _RESEARCH_EXPLORE_C_JSON,
        }
    return branches or None


# ---------------------------------------------------------------------------
# Deterministic grounding floor — the MEASUREMENT instrument for the cross-model
# question (independence.py's registered research exception).
# ---------------------------------------------------------------------------


def grounding_floor(claims: list, sources: list) -> list[str]:
    """Grounding defects decidable WITHOUT a model. Returns one reason per defect.

    These are ORACLES, not heuristics: a claim that cites nothing is unsupported no
    matter how capable the reader is, and a citation pointing at a source that is not
    in the findings is dangling by arithmetic. They therefore do NOT age as models
    improve — the Bitter-Lesson distinction between a meter (keep) and a hand-built
    knowledge table (prune).

    Why this exists: ``independence.py`` registers research's synthia->vera edge as a
    SAME_MODEL exception whose repayment is to *measure* same- vs cross-model catch
    rate. A second model adds nothing to a defect the deterministic floor already
    caught. So the population that could ever justify paying for a second
    model on every run is the JUDGEMENT RESIDUAL: claims that ARE cited, to a source
    that DOES exist and DOES have content, where only a reader can tell whether the
    source actually supports the claim.

    ``claims``: ``[{"id", "text", "cites": [source_id, ...]}, ...]``
    ``sources``: ``[{"id", "content"}, ...]``

    NOT WIRED INTO THE FSM. This is currently a measurement instrument only;
    promoting it to a pre-gate that runs before vera is a decision the measurement
    informs, not one taken in advance of it.
    """
    reasons: list[str] = []
    by_id = {str(s.get("id", "")): s for s in sources}
    for claim in claims:
        cid = str(claim.get("id", "?"))
        cites = [str(c).strip() for c in (claim.get("cites") or []) if str(c).strip()]
        if not cites:
            reasons.append(f"{cid}: no citation at all")
            continue
        for ref in cites:
            source = by_id.get(ref)
            if source is None:
                reasons.append(f"{cid}: dangling citation to unknown source '{ref}'")
            elif not str(source.get("content", "")).strip():
                reasons.append(
                    f"{cid}: cites '{ref}', which has no captured content to verify against"
                )
    return reasons


def _sanitize_topic(query: str) -> str:
    """A filesystem-safe, COLLISION-FREE directory name for a research query.

    The readable slug is truncated, so two long related queries sharing a prefix
    ("compare postgres and mysql replication strategies for production deployments
    **on aws**" vs "… **on gcp**") produced the SAME directory and the second run
    silently overwrote the first run's report.md — destroying the only durable
    artifact the run exists to produce, which is also the thing ``done_predicate``
    measures.

    A short digest of the FULL query disambiguates them. It is deterministic, so
    re-running the same query is still idempotent (same directory, refreshed
    report) rather than accumulating near-duplicate directories.
    """
    sanitized = re.sub(r"[^\w\s-]", "", query.lower())
    sanitized = re.sub(r"[-\s]+", "-", sanitized)
    slug = sanitized.strip("-")[:71]
    digest = hashlib.sha256(query.strip().encode("utf-8")).hexdigest()[:8]
    return f"{slug}-{digest}" if slug else digest


def _apply_mode_budget(research: dict, mode: str, constraints: dict) -> None:
    """Expand a mode label into the run's rigor budget.

    An EXPLICIT caller constraint always wins over the preset, so rigor can be set
    independently of the label (``constraints={"critique_passes": 1}`` gives a standard
    run an adversarial report read without paying for deep's plan critique).
    """
    preset = MODE_BUDGETS.get(mode, MODE_BUDGETS[DEFAULT_MODE])
    for key, value in preset.items():
        raw = constraints.get(key)
        if raw is None:
            research[key] = value
            continue
        try:
            research[key] = max(0, int(raw))
        except (TypeError, ValueError):
            research[key] = value
    research["max_research_rounds"] = max(1, int(research.get("max_research_rounds", 2)))


def _report_dir(ctx: RunContext) -> str:
    """ABSOLUTE report directory under the project root, never a hardcoded path.

    Prefers the run's ``ctx.project_root`` (populated from the CLI ``--project-root``),
    falling back to ``$PROJECT_ROOT`` then the cwd — always absolute, never a tilde."""
    root = ctx.project_root or os.environ.get("PROJECT_ROOT") or str(Path.cwd())
    return str(Path(root).expanduser() / "research" / _sanitize_topic(ctx.goal))


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


# Where a clarification RESUMES, keyed by the state that escalated.
#
# Producer-oriented, not position-oriented: resume at the agent that can actually ACT
# on the user's answer. A stalled critique is the clearest case — re-running carren on
# the same unchanged artifact cannot use the clarification, so the answer belongs to
# the producer (piper / synthia) that can change the artifact.
#
# The previous behaviour re-entered ``planning`` from EVERYWHERE, which discarded the
# plan, its critique cycles, and every completed research branch on any clarification
# — in deep mode that is a full re-plan plus up to max_iterations critique rounds
# thrown away to answer one scoping question.
_RESUME_TARGET_BY_STATE: dict[str, str] = {
    "planning": "planning",
    "critiquing_plan": "planning",  # the plan must change; re-critiquing it cannot help
    "researching": "researching",  # keep the plan, re-research WITH the clarification
    "synthesizing": "synthesizing",
    "critiquing_report": "synthesizing",  # the report must change
    "validating": "synthesizing",  # the synthesis must change
}


class ResearchMachine(StateMachine):
    # Set by the playbook before firing ``clarify``; read by the rt_* guards below.
    resume_target: str = ""

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
    validate_research = validating.to(researching)  # bounded EVIDENCE-SEEKING loop
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
    # Conditional multi-target resume returns to whichever producer can act on
    # the answer, with planning as the conservative fallback.
    clarify = (
        awaiting_clarification.to(researching, cond="rt_researching")
        | awaiting_clarification.to(synthesizing, cond="rt_synthesizing")
        | awaiting_clarification.to(planning)  # fallback / explicit planning target
    )

    # -- clarify guards (read resume_target) -------------------------------
    def rt_researching(self, *a: object, **k: object) -> bool:
        return self.resume_target == "researching"

    def rt_synthesizing(self, *a: object, **k: object) -> bool:
        return self.resume_target == "synthesizing"

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
#
# NOTE on ``task_hint``: this playbook overrides ``_task_summary`` and routes every
# registered state through ``_TASK_BUILDERS``, so these hints are DESCRIPTIVE ONLY —
# they are not delivered to any agent. They are kept (rather than emptied) so that
# removing a builder degrades gracefully to a sane generic task instead of an empty
# one. The ONE place a ``task_hint`` is live is the dynamic research fan, where
# ``_research_branches`` puts the SUB-QUERY TEXT in the branch spec's hint and
# ``_task_summary`` renders it — there it is data, not instruction.
#
# Do NOT restore procedural mandates here. A hint that named a required tool
# sequence ("including a YouTube-targeted search and youtube_transcript pull")
# was removed: mandating a modality sweep on every run is knowledge-constraint
# scaffolding that spends calls where they may be noise. Tool AVAILABILITY is
# conveyed in the agent's domain guidance (assets/prompts/echo.md) as an
# affordance the model spends when applicable — capability disclosure scales,
# mandated procedure does not.
# ---------------------------------------------------------------------------

RESEARCH_PLAN = PrimitiveSpec(
    "RESEARCH_PLAN",
    "piper",
    _c(
        {"plan_steps": list, "plan_complete": bool},
        {
            "mode": str,  # model-declared rigor/budget preset (R1) when no caller sets it
            "confidence": str,
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
            "confidence": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Research the assigned sub-query and return complete tiered, cited findings.",
)
RESEARCH_SYNTHESIZE = PrimitiveSpec(
    "RESEARCH_SYNTHESIZE",
    "synthia",
    _c(
        {"synthesis_complete": bool},
        {
            "confidence": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Synthesize the exact research artifacts into a complete thematic, cited report.",
)
RESEARCH_VALIDATE = PrimitiveSpec(
    "RESEARCH_VALIDATE",
    "vera",
    _c(
        # Evidence-gated citation-grounding (Rec 4): the verdict must carry the
        # captured claim->source checks (quotes, fetched spot-checks).
        {"verdict": str, "unsupported_claims": list, "evidence": list},
        {
            # What is MISSING, phrased as researchable questions. The verifier
            # DIAGNOSES the gap; echo fills it. A verifier that sourced its own
            # evidence would be judging material it authored.
            "evidence_needed": list,
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
    _c({"write_complete": bool}),
    "Write report.md, sources.md and README.md to the research output directory.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders. Revision context carries the prior critique's
# actionable issues into the next pass.
# ---------------------------------------------------------------------------


def _build_planning(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    task = f"Research planning: decompose '{ctx.goal}' into sub-queries."
    # An empty mode means the CALLER did not fix one, so piper declares it. Saying
    # "Mode: ." (the previous rendering) told the model nothing and silently dropped
    # the instruction that it owns the decision.
    mode = research.get("mode") or ""
    mode_line = (
        f"\nMode: {mode}."
        if mode
        else "\nMode: NOT fixed by the caller — YOU declare it (quick / standard / deep) "
        "in your SUMMARY, chosen by what the query actually needs."
    )
    task += (
        f"{mode_line} "
        f"Produce at most {research.get('max_sub_queries', DEFAULT_MAX_SUB_QUERIES)} "
        f"sub-queries."
    )
    revision = research.get("plan_revision", 0)
    if revision:
        issues = research.get("plan_critique_issues", [])
        task += (
            f"\n\nThis is REVISION cycle {revision}. The prior critique identified these issues: "
            f"{'; '.join(str(i) for i in issues) or 'inspect the exact critique artifact'}. "
            "Address EVERY issue and note how you resolved it."
        )
    return task


def _build_critiquing_plan(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    task = f"Critique the exact research plan artifact for: {ctx.goal}"
    revision = research.get("plan_revision", 0)
    if revision:
        task += (
            f"\n\nThis is review cycle {revision + 1} — the plan was revised to address prior "
            f"issues. Block ONLY on significant coverage/feasibility issues; note minor concerns "
            f"but APPROVE with notes rather than blocking."
        )
    return task


def _build_researching(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    """The SINGLE-AGENT research task (the explicit-quick fast path).

    Any run whose plan yielded usable sub-queries is dispatched as a dynamic FAN
    (one echo branch per sub-query, rendered by ``_task_summary``), so this builder
    only ever serves the single-agent path.
    """
    return f"Quick research: {ctx.goal}"


def _build_synthesizing(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    format_note = ""
    report_format = research.get("report_format", "default")
    if report_format != "default":
        format_note = f" Use {report_format} format."
    task = f"Synthesize the exact research artifacts for: {ctx.goal}.{format_note}"
    revision = research.get("report_revision", 0)
    if revision:
        issues = research.get("report_critique_issues", [])
        task += (
            f"\n\nThis is REVISION cycle {revision}. The prior critique identified these issues: "
            f"{'; '.join(str(i) for i in issues) or 'inspect the exact critique artifact'}. "
            "Address EVERY issue and note how you resolved it."
        )
    # validation_revision and report_revision are separate keys, each popped when
    # its loop closes, so at most one is set on any given synthesis entry.
    val_revision = research.get("validation_revision", 0)
    if val_revision:
        vissues = research.get("validation_issues", [])
        task += (
            f"\n\nThis is a VALIDATION revision (cycle {val_revision}). The verifier (vera) "
            f"flagged these claims as unsupported by the cited sources: "
            f"{'; '.join(str(i) for i in vissues) or 'inspect the exact validation artifact'}. "
            "Re-ground or REMOVE every flagged claim — cite a supporting source or drop the "
            "claim. Do not introduce new unsupported claims."
        )
    if research.get("research_round", 1) > 1:
        task += (
            "\n\nAn EVIDENCE-SEEKING research round ran since your last synthesis. Re-read ALL "
            "task-provided research artifacts, including the newly captured branches, and "
            "re-ground the flagged claims against them. Where a researcher reported that NO "
            "adequate source exists, DROP the claim rather than softening it into something the "
            "sources still do not support."
        )
    return task


def _build_validating(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    task = (
        f"Verify the synthesized research report for: {ctx.goal}\n\n"
        "For every material claim in the exact synthesis artifact, confirm it is grounded in a "
        "source captured in the exact research artifacts that actually supports it. Flag "
        "unsupported, overclaimed, fabricated, or mis-cited claims. Verdict PASS only if all "
        "material claims are source-grounded; otherwise FAIL and list each unsupported claim."
    )
    revision = research.get("validation_revision", 0)
    if revision:
        issues = research.get("validation_issues", [])
        task += (
            f"\n\nThis is re-validation cycle {revision + 1} — the synthesis was revised to "
            f"re-ground prior flagged claims: "
            f"{'; '.join(str(i) for i in issues) or 'inspect the prior exact verdict artifact'}. "
            f"Re-check those claims specifically, then the report as a whole."
        )
    return task


def _build_critiquing_report(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    task = f"Critique the exact synthesized research report artifact for: {ctx.goal}"
    revision = research.get("report_revision", 0)
    if revision:
        task += (
            f"\n\nThis is review cycle {revision + 1} — the report was revised to address prior "
            f"issues. Block ONLY on significant overclaiming/bias/fairness issues; note minor "
            f"concerns but APPROVE with notes rather than blocking."
        )
    return task


def _build_report_writing(pb: "ResearchPlaybook", ctx: RunContext, research: dict) -> str:
    return (
        f"Write the final research report for: {ctx.goal}\n\n"
        f"Write all files to: {_report_dir(ctx)}\n\n"
        "Produce report.md (main report), sources.md (bibliography), and README.md (quick "
        "reference). Also include the COMPLETE contents of all three products in your final "
        "response so the execution owner's captured agent-output is the registered product "
        "artifact."
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

_ARTIFACT_HANDOFF = (
    "Read every reference in the task-provided input_artifacts with artifact_read before "
    "working. If the list is empty, this stage has no predecessor artifact. Treat those exact "
    "bytes as the sole prior-stage handoff. Put your COMPLETE stage output in this response; "
    "the execution owner captures it. SUMMARY is routing data only: never claim artifact "
    "persistence or registration."
)

# A downstream stage often needs more than the immediately preceding reviewer output.
# The generic engine checkpoints every selected ref; this playbook selects the exact
# phase set each research consumer needs without copying payloads into RunContext.
_INPUT_PHASES_BY_STATE: dict[str, tuple[str, ...]] = {
    "planning": ("planning", "critiquing_plan"),
    "critiquing_plan": ("planning",),
    "researching": ("planning", "critiquing_plan", "synthesizing", "validating"),
    "synthesizing": ("researching", "synthesizing", "critiquing_report", "validating"),
    "critiquing_report": ("researching", "synthesizing"),
    "validating": ("researching", "synthesizing", "critiquing_report"),
    "report_writing": ("researching", "synthesizing", "critiquing_report", "validating"),
    "complete": ("report_writing",),
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

    def _selected_artifact_refs(self, phases: tuple[str, ...]) -> tuple[ArtifactRef, ...]:
        selected = [
            ArtifactRef.from_dict(value) for value in self._artifact_state()["selected_refs"]
        ]
        ordered: list[ArtifactRef] = []
        for phase in phases:
            ordered.extend(
                sorted(
                    (ref for ref in selected if ref.phase == phase),
                    key=lambda ref: (ref.branch_id or "", ref.version, ref.artifact_id),
                )
            )
        return tuple(ordered)

    def artifact_input_phases(self, ctx: RunContext) -> dict[str, tuple[str, ...]]:
        """Declare every retained research phase each later consumer inspects.

        The base engine combines this map with direct FSM successors and validates
        every pair for graph reachability before it mints a consumer scope.
        """
        return _INPUT_PHASES_BY_STATE

    @staticmethod
    def _final_output_artifact_ref(ctx: RunContext) -> ArtifactRef | None:
        protocol = ctx.extras.get("artifact_protocol") or {}
        values = protocol.get("selected_refs") if isinstance(protocol, dict) else None
        if not isinstance(values, list):
            return None
        matches = [
            ref
            for ref in (ArtifactRef.from_dict(value) for value in values)
            if ref.phase == "report_writing"
            and ref.branch_id is None
            and ref.kind == KIND_AGENT_OUTPUT
        ]
        return matches[0] if len(matches) == 1 else None

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
            fan_width = int(ctx.constraints.get("max_fan_width", 8))
        except (TypeError, ValueError):
            fan_width = 8
        # #25: with no caller override the sub-query count is a TIER-SCALED budget (a
        # strong/long-context model fans wider, a cheap one narrower), bounded by the fan
        # width as the hard ceiling; an explicit constraint always wins.
        raw_sub_queries = ctx.constraints.get("max_sub_queries")
        if raw_sub_queries is None:
            max_sub_queries = tier_budget(DEFAULT_MAX_SUB_QUERIES, ceiling=fan_width)
        else:
            try:
                max_sub_queries = int(raw_sub_queries)
            except (TypeError, ValueError):
                max_sub_queries = DEFAULT_MAX_SUB_QUERIES
        research["max_sub_queries"] = max(
            1, min(max_sub_queries or DEFAULT_MAX_SUB_QUERIES, fan_width)
        )
        research["report_format"] = str(ctx.constraints.get("report_format", "default"))
        research["research_round"] = 1
        # Rigor budget. When the caller fixed the mode we can expand it now; otherwise
        # piper declares the mode at planning and route_after expands it there. A
        # provisional default keeps the budget defined if planning never runs.
        _apply_mode_budget(research, caller_mode or DEFAULT_MODE, ctx.constraints)
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
                research["mode"] = declared if declared in MODES else DEFAULT_MODE
                mode = research["mode"]
                # The model just chose the rigor level: expand it into the budget
                # (an explicit caller constraint still wins inside the helper).
                _apply_mode_budget(research, mode, ctx.constraints)
            steps = summary.get("plan_steps") or []
            # Normalize at the boundary: only NON-BLANK sub-queries are usable.
            # ``_research_branches`` already skips blank entries, so without this
            # filter a whitespace-only plan produced an empty fan while leaving a
            # truthy ``sub_queries`` list — the one path that could dispatch a
            # single agent a task listing blank sub-queries. Filtering here makes
            # both functions agree by construction.
            steps = [s for s in steps if str(s).strip()]
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
                research["echo_branches_dispatched"] = len(branches)
            else:
                dyn.pop("researching", None)
                research["echo_branches_dispatched"] = 0
            # Budget-driven, not mode-driven: a plan critique costs the 2nd pass.
            if int(research.get("critique_passes", 0)) >= 2:
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
                research["research_branch_count"] = len(bmap)
            else:
                research["research_complete"] = True
            # An evidence-seeking round is over once its findings are in; the next
            # synthesis re-grounds against them and returns to the gate.
            research.pop("evidence_needed", None)
            self.sm.send("research_done")
        elif state == "synthesizing":
            research["synthesis_complete"] = True  # synthesis_complete gated in progress_check
            # A report critique costs the 1st critique pass — so a run that EARNED a
            # pass mid-run (rigor escalation) gets carren's adversarial read even
            # though its mode label never said "deep". Once the critique loop closes
            # (phase="validation") a validation-driven re-synthesis goes back to vera.
            if (
                int(research.get("critique_passes", 0)) >= 1
                and research.get("phase") != "validation"
            ):
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
            # The run's REAL quality signal, surfaced on the CONTEXT so the outcome
            # ledger records GROUNDING and not merely delivery. Without this the
            # ledger saw an empty ``verify_gaps`` for every research run, so
            # the failure mode fell through to "other" and a report
            # shipped with unsupported claims was indistinguishable from a fully
            # grounded one — the learning loop had no signal to learn from.
            # ``verify_evidence`` is already captured by the engine
            # (``_capture_evidence``); verdict + gaps were the missing half.
            # Last-write-wins across re-validation cycles, so the values reflect
            # the FINAL verdict: [] on a PASS, the surviving claims on exhaustion.
            ctx.verify_verdict = str(verdict)
            ctx.verify_gaps = list(issues)
            needed = [
                str(n).strip() for n in (summary.get("evidence_needed") or []) if str(n).strip()
            ]
            if verdict == "PASS":
                self._end_validation_loop(ctx, research)
                self.sm.send("validate_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=issues)
                ctx.iteration += 1
                rounds_used = int(research.get("research_round", 1))
                max_rounds = int(research.get("max_research_rounds", DEFAULT_MAX_RESEARCH_ROUNDS))
                if needed and rounds_used < max_rounds:
                    # EVIDENCE-SEEKING (the iterative research loop): the verifier
                    # named what is missing and a research round remains, so spend
                    # more SEARCH on the gap rather than only re-writing the report.
                    # Without this edge the only remedy for an unsupported claim is
                    # to DROP it (the synthesizer has no web tools by design), so the
                    # gate could only ever make the report thinner, never better
                    # grounded.
                    cap = int(research.get("max_sub_queries", DEFAULT_MAX_SUB_QUERIES))
                    start = int(research.get("echo_branches_dispatched", 0)) + 1
                    branches = _research_branches(needed[:cap], start=start, evidence=True)
                    if branches:
                        research["research_round"] = rounds_used + 1
                        research["evidence_needed"] = needed[:cap]
                        research["echo_branches_dispatched"] = start - 1 + len(branches)
                        research.pop("validation_revision", None)
                        ctx.extras.setdefault("dynamic_branches", {})["researching"] = branches
                        self.sm.send("validate_research")
                        return
                # RIGOR ESCALATION (OPT-IN, once per run): the gate keeps failing, no
                # research round can help, and this run was never budgeted an adversarial
                # read. Rather than let a low mode label permanently forbid deeper
                # scrutiny of a run that is visibly struggling, grant ONE report-critique
                # pass — rigor EARNED by evidence of difficulty rather than fixed at
                # intake by a three-valued label.
                #
                # DEFAULT OFF, deliberately. Enabling it by default rewrites the
                # published quick/standard validation loop (validating -> synthesizing ->
                # validating becomes validating -> synthesizing -> critiquing_report),
                # and no measurement yet shows the extra pass recovers runs that the
                # re-grounding loop would not. Same discipline as the cross-model verify
                # hook: ship the mechanism, measure, then argue about the default.
                if (
                    ctx.constraints.get("rigor_escalation")
                    and int(research.get("critique_passes", 0)) < 1
                    and not research.get("rigor_escalated")
                    and research.get("phase") != "validation"
                ):
                    research["critique_passes"] = 1
                    research["rigor_escalated"] = True
                    research.setdefault("warnings", []).append(
                        "validation failed with no researchable gap; escalated rigor to grant "
                        "one report-critique pass (mode "
                        f"'{research.get('mode', DEFAULT_MODE)}' had none budgeted)"
                    )
                # No researchable gap named (or the round budget is spent): fall back
                # to re-grounding from the findings already gathered.
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
            research["report_dir"] = _report_dir(ctx)
            research["report_files"] = (
                [
                    str(Path(research["report_dir"]) / "report.md"),
                    str(Path(research["report_dir"]) / "sources.md"),
                    str(Path(research["report_dir"]) / "README.md"),
                ]
                if research["report_written"]
                else []
            )
            # Complete either way; done_predicate reports the honest outcome
            # (met=False when the write failed) — never a fabricated success.
            self.sm.send("report_done")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def _captured_product_is_complete(self, ctx: RunContext) -> bool:
        ref = self._final_output_artifact_ref(ctx)
        if ref is None:
            return False
        try:
            output = self._artifact_store.read_bytes(
                ref,
                expected_run_id=ctx.run_id,
                expected_phase="report_writing",
                expected_branch_id=None,
                expected_producer="agent:skribble",
                require_selected=True,
            ).decode("utf-8")
        except (ArtifactError, UnicodeDecodeError):
            return False
        body = output.rsplit("\nSUMMARY:", 1)[0]
        markers = ("# report.md", "# sources.md", "# README.md")
        positions = [body.find(marker) for marker in markers]
        if positions != sorted(positions) or any(position < 0 for position in positions):
            return False
        boundaries = positions[1:] + [len(body)]
        return all(
            body[position + len(marker) : boundary].strip()
            for marker, position, boundary in zip(markers, positions, boundaries)
        )

    def done_predicate(self, ctx: RunContext) -> bool:
        research = ctx.extras.get("research", {})
        report_written = bool(research.get("report_written"))
        grounded = research.get("validation_verdict") == "PASS"
        # Canonical success requires both useful delivery and the required grounding
        # outcome. A validation-exhausted report remains available but is incomplete.
        return (
            grounded
            and report_written
            and (self._captured_product_is_complete(ctx) or self.allow_programmatic_results)
        )

    # -- HITL resume -------------------------------------------------------
    def _resume(self, state: str, result: object) -> dict:
        """Reset the bounded-loop counters and choose WHERE to resume.

        The escalation path (to_unknown -> escalate) never closes the active loop via
        ``_end_*_loop``, so ``ctx.iteration`` / ``ctx.iteration_history`` are left
        mid-loop. They are always reset: the user's answer is new information, so the
        loop earns a fresh budget. Without this a stale ``ctx.iteration`` makes
        ``route_after`` fire ``*_exhausted`` on the FIRST visit (a false "budget
        exhausted" warning with zero cycles run) and stale history poisons
        ``is_stalled``.

        Resume TARGET is producer-oriented (``_RESUME_TARGET_BY_STATE``): the run
        returns to the agent that can act on the answer instead of restarting from
        ``planning`` and discarding the plan, its critique cycles and every completed
        research branch.
        """
        if state == "awaiting_clarification":
            self.ctx.iteration = 0
            self.ctx.iteration_history = []
            research = self.ctx.extras.get("research", {})
            target = _RESUME_TARGET_BY_STATE.get(str(self.ctx.previous_state or ""), "planning")
            self.sm.resume_target = target
            # An interrupted revision loop restarts, so its counters go either way.
            for _k in ("plan_revision", "report_revision", "validation_revision"):
                research.pop(_k, None)
            if target == "planning":
                # A full restart of the pipeline: phase and exhaustion markers from the
                # abandoned pass must not leak into the fresh one (a stale
                # phase="validation" would make deep synthesis skip its report critique).
                for _k in (
                    "phase",
                    "plan_critique_exhausted",
                    "report_critique_exhausted",
                    "validation_exhausted",
                ):
                    research.pop(_k, None)
            # Resuming mid-pipeline CONTINUES the same run, so `phase` and the
            # exhaustion flags are preserved: they are historical facts the result
            # must still report honestly, not state belonging to an abandoned pass.
            previous = str(self.ctx.previous_state or "")
            self._set_state_inputs(target, self._selected_artifact_refs((previous,)))
        return super()._resume(state, result)

    # -- cross-model verification hook -------------------------------------
    def model_for_state(self, state: str, ctx: RunContext) -> str | None:
        """Opt-in cross-model verification hook for the citation gate.

        ``independence.py`` classifies research's synthia-to-vera edge SAME_MODEL:
        both agents currently resolve to the same model, so correlated errors can
        slip a false PASS through. The gate is evidence-based, which partly
        mitigates the risk. This hook lets a caller or operator choose a different
        validation model.

        Precedence for ``validating``: ``constraints['validate_model']`` -> the
        ``RESEARCH_VERA`` / ``RESEARCH_DEFAULT`` environment tier -> ``None``
        (vera's configured model). Research has one verify state: ``validating``.

        UNSET IS UNCHANGED: with no constraint and no env var this returns ``None`` for
        every state, so every agent runs the model its own ``.pi/agents/*.md``
        frontmatter declares. An opt-in hook, never a default reassignment (changing the
        default is a cost/latency shift that needs loan registration + ablation), so the
        edge correctly stays SAME_MODEL and remains a registered, dated exception until
        cross-model is measured to be worth making the default.
        """
        if state == "validating":
            chosen = str((ctx.constraints or {}).get("validate_model", "")).strip()
            if chosen:
                return chosen
        return self._env_model_override("RESEARCH", state)

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        research = ctx.extras.get("research", {})
        # A dynamic research FAN branch (name RESEARCH_EXPLORE_SQ<n>) researches
        # its OWN sub-query; the execution owner captures one exact artifact per branch.
        spec_name = getattr(spec, "name", "")
        if state == "researching" and spec_name.startswith("RESEARCH_EVIDENCE_SQ"):
            # Evidence-seeking round: fill a gap the VERIFIER diagnosed. Framed as a
            # falsifiable errand (find a source that settles it, or report that none
            # exists) so a fruitless search returns an honest negative instead of a
            # weak source dragged in to make the claim survive.
            base = (
                f"EVIDENCE-SEEKING round for: {ctx.goal}\n\n"
                f"The citation gate found a claim in the draft report that no cited source "
                f"supports. Your job is to settle it with evidence.\n\n"
                f"Evidence needed: {spec.task_hint}\n\n"
                f"Find a source that directly supports or refutes it, and cite it. If after a "
                f"genuine search NO adequate source exists, say so plainly — 'no supporting "
                f"source found' is a USEFUL result that lets the claim be dropped honestly. Do "
                f"NOT stretch a weak or tangential source to make the claim survive."
            )
        elif state == "researching" and spec_name.startswith("RESEARCH_EXPLORE_SQ"):
            base = f"Research this sub-query for: {ctx.goal}\n\nSub-query: {spec.task_hint}"
        else:
            builder = _TASK_BUILDERS.get(state)
            base = (
                builder(self, ctx, research) if builder else f"{spec.task_hint}\nGoal: {ctx.goal}"
            )
        base += f"\n\n{_ARTIFACT_HANDOFF}"
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
        final_ref = self._final_output_artifact_ref(ctx)
        return {
            "met": ctx.met,
            "research_rounds": research.get("research_round", 1),
            "critique_passes": research.get("critique_passes", 0),
            "rigor_escalated": bool(research.get("rigor_escalated", False)),
            # Canonical ``met`` is true only when the required grounded outcome and
            # delivery both succeeded. ``grounded`` remains explicit so an incomplete
            # but useful artifact explains which criterion failed.
            "grounded": research.get("validation_verdict") == "PASS",
            "iterations": (
                research.get("plan_revisions", 0)
                + research.get("report_revisions", 0)
                + research.get("validation_revisions", 0)
            ),
            "query_sha256": hashlib.sha256(ctx.goal.encode("utf-8")).hexdigest(),
            "query_bytes": len(ctx.goal.encode("utf-8")),
            "mode": research.get("mode", ""),
            "sub_queries": research.get("sub_queries", []),
            "output_artifact_ref": final_ref.to_dict() if final_ref is not None else None,
            "report_dir": research.get("report_dir", ""),
            "report_files": research.get("report_files", []),
            "warnings": research.get("warnings", []),
            "plan_critique_exhausted": research.get("plan_critique_exhausted", False),
            "report_critique_exhausted": research.get("report_critique_exhausted", False),
            "validation_exhausted": research.get("validation_exhausted", False),
            "unresolved_issues": unresolved,
        }
