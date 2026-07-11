"""LearnPlaybook — the learn skill on the shared engine.

Transforms a set of raw learning material (lecture transcripts, slides,
notebooks, textbook chapters) into a complete, self-consistent study companion:
per-lesson study guides + practice answers, per-lesson practice exams + answer
keys, and course-wide final-prep material — authored to the pedagogy spec in
``.pi/skills/learn/resources/pedagogy-spec.md`` (three-phase teaching, everyday
analogies, canonical callouts, conventions canon) and gated by mechanical +
mathematical verification before completion.

The workflow encodes the methodology proven on the quantum-information course
build (2026-07): conventions are decided ONCE, globally, before any authoring
(the single biggest drift source); every answer artifact is recomputed, not
trusted; and verification always runs against the whole corpus, because
cross-file forks are invisible to single-file checks.

Flow: intake → ingesting[parallel echo ×3] → designing → charter_gate(HITL) →
authoring(per-lesson loop) → assessing(per-lesson loop) → synthesizing →
verifying ⇄ fixing → critiquing → complete. Honest exhaustion: a spent fix
budget completes with ``met=False`` and the unresolved violations reported —
never a fabricated pass.
"""

from __future__ import annotations

from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import ParallelSpec, PrimitiveSpec


def _c(required: dict, optional: dict | None = None) -> dict:
    return {"required": required, "optional": optional or {}}


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class LearnMachine(StateMachine):
    intake = State(initial=True)
    ingesting = State()  # parallel echo fan-out (content / conventions / assessment)
    designing = State()  # annie: curriculum design + conventions canon
    charter_gate = State()  # HITL: approve the design before mass authoring
    authoring = State()  # skribble: study guide + practice answers, one lesson per pass
    assessing = State()  # skribble: practice exam + answer key, one lesson per pass
    synthesizing = State()  # synthia: course-wide final prep
    verifying = State()  # vera: mechanical conformance + math recomputation
    fixing = State()  # skribble: apply verified fixes
    critiquing = State()  # carren: pedagogical quality judgment
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_ingest = intake.to(ingesting)
    ingest_done = ingesting.to(designing)
    design_done = designing.to(charter_gate)
    gate_approve = charter_gate.to(authoring)
    gate_refine = charter_gate.to(designing)
    gate_deny = charter_gate.to(error)
    author_next = authoring.to.itself()  # next lesson
    author_done = authoring.to(assessing)
    assess_next = assessing.to.itself()  # next lesson
    assess_done = assessing.to(synthesizing)
    synth_done = synthesizing.to(verifying)
    verify_clean = verifying.to(critiquing)
    verify_fix = verifying.to(fixing)
    verify_exhausted = verifying.to(complete)  # budget spent; met=False
    fix_done = fixing.to(verifying)  # fixes ALWAYS re-verify (whole corpus)
    critique_pass = critiquing.to(complete)
    critique_fix = critiquing.to(fixing)
    critique_exhausted = critiquing.to(complete)  # budget spent; met=False

    to_unknown = (
        ingesting.to(unknown)
        | designing.to(unknown)
        | authoring.to(unknown)
        | assessing.to(unknown)
        | synthesizing.to(unknown)
        | verifying.to(unknown)
        | fixing.to(unknown)
        | critiquing.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(designing)
    abort = (
        intake.to(error)
        | ingesting.to(error)
        | designing.to(error)
        | charter_gate.to(error)
        | authoring.to(error)
        | assessing.to(error)
        | synthesizing.to(error)
        | verifying.to(error)
        | fixing.to(error)
        | critiquing.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts
# ---------------------------------------------------------------------------

_COMMON_OPT = {
    "mempalace_drawer": str,
    "needs_clarification": bool,
    "clarifying_questions": list,
    "confidence": str,
}

_ECHO_C = _c(
    {"explore_complete": bool},
    {"lessons_found": int, "topics_found": int, "notes_count": int, **_COMMON_OPT},
)

LEARN_INGEST = ParallelSpec(
    branches={
        "content": PrimitiveSpec(
            "LEARN_INGEST_CONTENT",
            "echo",
            _ECHO_C,
            "content inventory: lessons, topics, formats, dependency hints",
        ),
        "conventions": PrimitiveSpec(
            "LEARN_INGEST_CONVENTIONS",
            "echo",
            _ECHO_C,
            "notation and conventions used by the source material (symbols, "
            "orderings, naming) — every place two conventions could collide",
        ),
        "assessment": PrimitiveSpec(
            "LEARN_INGEST_ASSESSMENT",
            "echo",
            _ECHO_C,
            "audience, prerequisites, and assessment style: what the target "
            "exams test and how",
        ),
    }
)

LEARN_DESIGN = PrimitiveSpec(
    "LEARN_DESIGN",
    "annie",
    _c(
        {"design_complete": bool, "lesson_count": int},
        {
            "topic_count": int,
            "conventions": list,
            "analogy_count": int,
            "open_questions": list,
            **_COMMON_OPT,
        },
    ),
    "Design the curriculum: lessons, per-lesson topic lists in dependency order, "
    "the conventions canon, and the analogy registry. Emit lesson_count.",
)

LEARN_AUTHOR = PrimitiveSpec(
    "LEARN_AUTHOR",
    "skribble",
    _c(
        {"lesson_complete": bool, "lesson_index": int},
        {"lesson_title": str, "files_written": list, "topic_count": int, **_COMMON_OPT},
    ),
    "Author ONE lesson's study guide and companion practice answers per the "
    "pedagogy spec. Emit lesson_index and files_written.",
)

LEARN_ASSESS = PrimitiveSpec(
    "LEARN_ASSESS",
    "skribble",
    _c(
        {"lesson_complete": bool, "lesson_index": int},
        {"files_written": list, "problem_count": int, **_COMMON_OPT},
    ),
    "Author ONE lesson's practice exam and answer key per the exam canon. "
    "Emit lesson_index and files_written.",
)

LEARN_SYNTH = PrimitiveSpec(
    "LEARN_SYNTH",
    "synthia",
    _c(
        {"synthesis_complete": bool},
        {"files_written": list, **_COMMON_OPT},
    ),
    "Synthesize the course-wide final prep: comprehensive review, notation "
    "reference, and final practice exam + answer key.",
)

LEARN_VERIFY = PrimitiveSpec(
    "LEARN_VERIFY",
    "vera",
    _c(
        {"verified": bool, "violations": list},
        {"checks_run": int, "math_checked": bool, "files_checked": int, **_COMMON_OPT},
    ),
    "Run the FULL verification suite against the WHOLE corpus: mechanical "
    "conformance checks plus recomputation of every quantitative answer. "
    "Emit verified plus the violation list.",
)

LEARN_FIX = PrimitiveSpec(
    "LEARN_FIX",
    "skribble",
    _c(
        {"fixes_complete": bool},
        {"fixed_count": int, "files_touched": list, **_COMMON_OPT},
    ),
    "Apply the listed fixes across ALL affected files (cross-file sync), "
    "touching nothing else.",
)

LEARN_CRITIQUE = PrimitiveSpec(
    "LEARN_CRITIQUE",
    "carren",
    _c(
        {"verdict": str, "issues": list},
        _COMMON_OPT,
    ),
    "Judge the learner experience against the teaching philosophy. "
    "Verdict APPROVE or NEEDS_REVISION with issue titles.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders
# ---------------------------------------------------------------------------


def _room(ctx: RunContext) -> str:
    return f"skills/learn-{ctx.session_id}"


def _paths(ctx: RunContext) -> str:
    learn = ctx.extras.get("learn", {})
    return (
        f"Source material: {learn.get('source_dir', '(see constraints)')}. "
        f"Output directory: {learn.get('output_dir', '(see constraints)')}."
    )


def _build_ingest(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. {_paths(ctx)} "
        f"Focus: {spec.task_hint}. Read the source material and inventory your focus area. "
        f"Write full findings to wing=penny room={room} with header: "
        f"{ctx.session_id} Ingest — {spec.name.split('_')[-1].lower()}. "
        f"Check room {room} for prior session results first."
    )


def _build_design(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    base = (
        f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. {_paths(ctx)} "
        f"Mempalace room: {room}. Read all three Ingest drawers from wing=penny room={room}. "
        f"Produce the course charter: lesson list, per-lesson topic lists in dependency order, "
        f"the conventions canon (EVERY notation/ordering/naming decision, made once, globally), "
        f"and the analogy registry (one everyday analogy per concept). "
        f"Write it to wing=penny room={room} with header: {ctx.session_id} Charter. "
        f"Emit lesson_count in your SUMMARY."
    )
    if ctx.clarification_text:
        base += f" User clarification to incorporate: {ctx.clarification_text}"
    return base


def _build_author(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    learn = ctx.extras.get("learn", {})
    idx = learn.get("authored", 0)
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. {_paths(ctx)} Mempalace room: {room}. "
        f"Read the Charter from wing=penny room={room} (conventions canon and analogy "
        f"registry are BINDING). Author lesson index {idx} (zero-based) of "
        f"{learn.get('lesson_count', '?')}: the study guide and its companion practice "
        f"answers, per the pedagogy spec and file structure in this skill's resources. "
        f"Use 'Recall from ...' references to earlier lessons only. "
        f"Write a completion note to wing=penny room={room} with header: "
        f"{ctx.session_id} Author — lesson {idx}. Emit lesson_index={idx} in your SUMMARY."
    )


def _build_assess(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    learn = ctx.extras.get("learn", {})
    idx = learn.get("assessed", 0)
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. {_paths(ctx)} Mempalace room: {room}. "
        f"Read the Charter from wing=penny room={room}. Author the practice exam and "
        f"answer key for lesson index {idx} (zero-based) of {learn.get('lesson_count', '?')}, "
        f"per the exam canon: every problem maps to a taught guide section, fresh parameters "
        f"(never copies of guide examples), difficulty ramps, answer keys use "
        f"Approach / Step-by-Step Solution / Key Formula. "
        f"Write a completion note to wing=penny room={room} with header: "
        f"{ctx.session_id} Assess — lesson {idx}. Emit lesson_index={idx} in your SUMMARY."
    )


def _build_synth(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. {_paths(ctx)} Mempalace room: {room}. "
        f"Read the Charter and all lesson notes from wing=penny room={room}. "
        f"Synthesize the course-wide final prep: comprehensive review (balanced across "
        f"ALL lessons), notation reference (cross-notation translation tables), and a "
        f"final practice exam + answer key with proportional lesson coverage. "
        f"Write a completion note to wing=penny room={room} with header: "
        f"{ctx.session_id} Synthesize."
    )


def _build_verify(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. {_paths(ctx)} Mempalace room: {room}. "
        f"Run the FULL verification protocol from this skill's resources against the "
        f"WHOLE output corpus (never single files — cross-file forks are invisible "
        f"otherwise): all mechanical conformance checks, guide-to-answers alignment, "
        f"exam-teaches-what-guides-teach audit, and RECOMPUTE every quantitative answer "
        f"(scripted where possible). Write the report to wing=penny room={room} with "
        f"header: {ctx.session_id} Verify (round {ctx.iteration}). "
        f"Emit verified plus the exact violation list in your SUMMARY."
    )


def _build_fix(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    learn = ctx.extras.get("learn", {})
    violations = learn.get("violations", [])
    room = _room(ctx)
    listing = "; ".join(str(v) for v in violations[:20]) or "see the Verify report in mempalace"
    return (
        f"Session: {ctx.session_id}. {_paths(ctx)} Mempalace room: {room}. "
        f"Fix these verified violations, syncing every affected file (guide + answers + "
        f"exams + references together — never one file of a linked pair): {listing}. "
        f"Read the full Verify/Critique reports from wing=penny room={room} first. "
        f"Write a fix log to wing=penny room={room} with header: "
        f"{ctx.session_id} Fix (round {ctx.iteration})."
    )


def _build_critique(pb: "LearnPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. {_paths(ctx)} Mempalace room: {room}. "
        f"The corpus passed mechanical verification. Now judge the LEARNER EXPERIENCE "
        f"against the teaching philosophy: does each topic genuinely deliver intuition "
        f"before formalism, are the analogies meaningful (structure, not just mechanics), "
        f"do forward hooks and Why-This-Matters bridges land, would the target learner "
        f"pass the target exams? Write the critique to wing=penny room={room} with "
        f"header: {ctx.session_id} Critique. Emit verdict APPROVE or NEEDS_REVISION."
    )


_TASK_BUILDERS = {
    "ingesting": _build_ingest,
    "designing": _build_design,
    "authoring": _build_author,
    "assessing": _build_assess,
    "synthesizing": _build_synth,
    "verifying": _build_verify,
    "fixing": _build_fix,
    "critiquing": _build_critique,
}

_PROMPT_BY_STATE = {
    "ingesting": "echo",
    "designing": "annie",
    "authoring": "skribble-author",
    "assessing": "skribble-assess",
    "synthesizing": "synthia",
    "verifying": "vera",
    "fixing": "skribble-fix",
    "critiquing": "carren",
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class LearnPlaybook(BasePlaybook):
    NAME = "learn"
    machine_cls = LearnMachine
    PRIMITIVE_BY_STATE = {
        "designing": LEARN_DESIGN,
        "authoring": LEARN_AUTHOR,
        "assessing": LEARN_ASSESS,
        "synthesizing": LEARN_SYNTH,
        "verifying": LEARN_VERIFY,
        "fixing": LEARN_FIX,
        "critiquing": LEARN_CRITIQUE,
    }
    PARALLEL_BY_STATE = {"ingesting": LEARN_INGEST}
    GATE_STATES = frozenset({"charter_gate"})
    ESCALATABLE_STATES = frozenset(
        {
            "ingesting",
            "designing",
            "authoring",
            "assessing",
            "synthesizing",
            "verifying",
            "fixing",
            "critiquing",
        }
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("learn skill requires a non-empty goal")
        source_dir = str(ctx.constraints.get("source_dir", "")).strip()
        if not source_dir:
            raise RuntimeError(
                "learn skill requires constraints.source_dir — the directory holding "
                "the raw learning material (transcripts, slides, notebooks, chapters). "
                "Optionally pass constraints.output_dir (default: <source_dir>/../study_materials) "
                "and constraints.spec_docs (existing teaching-approach/spec docs to reuse)."
            )
        output_dir = str(ctx.constraints.get("output_dir", "")).strip() or (
            source_dir.rstrip("/") + "/../study_materials"
        )
        ctx.extras["learn"] = {
            "source_dir": source_dir,
            "output_dir": output_dir,
            "authored": 0,
            "assessed": 0,
        }
        self.sm.send("start_ingest")
        return "ingesting"

    # -- progress / escalation gate ----------------------------------------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        if state == "verifying" and not summary.get("verified", False):
            if self.is_stalled(ctx, summary.get("violations", [])):
                return (
                    "the same verification violations have persisted across fix rounds "
                    "with no measurable progress — escalating rather than looping"
                )
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        learn = ctx.extras.setdefault("learn", {})
        if state == "ingesting":
            learn["ingested"] = True
            self.sm.send("ingest_done")
        elif state == "designing":
            learn["lesson_count"] = max(1, int(summary.get("lesson_count", 1)))
            learn["topic_count"] = int(summary.get("topic_count", 0))
            learn["conventions"] = summary.get("conventions", [])
            learn["analogy_count"] = int(summary.get("analogy_count", 0))
            learn["open_questions"] = summary.get("open_questions", [])
            learn["design_complete"] = bool(summary.get("design_complete", False))
            self.sm.send("design_done")
        elif state == "authoring":
            learn["authored"] = learn.get("authored", 0) + 1
            learn.setdefault("files_written", []).extend(summary.get("files_written", []))
            if learn["authored"] < learn.get("lesson_count", 1):
                self.sm.send("author_next")
            else:
                self.sm.send("author_done")
        elif state == "assessing":
            learn["assessed"] = learn.get("assessed", 0) + 1
            learn.setdefault("files_written", []).extend(summary.get("files_written", []))
            if learn["assessed"] < learn.get("lesson_count", 1):
                self.sm.send("assess_next")
            else:
                self.sm.send("assess_done")
        elif state == "synthesizing":
            learn["synthesis_complete"] = bool(summary.get("synthesis_complete", False))
            learn.setdefault("files_written", []).extend(summary.get("files_written", []))
            self.sm.send("synth_done")
        elif state == "verifying":
            verified = bool(summary.get("verified", False))
            violations = summary.get("violations", [])
            learn["verified_clean"] = verified
            learn["violations"] = violations
            if verified:
                self.sm.send("verify_clean")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=violations)
                ctx.iteration += 1
                self.sm.send("verify_fix")
            else:
                learn["exhausted"] = True
                self.sm.send("verify_exhausted")
        elif state == "fixing":
            learn["last_fix_count"] = int(summary.get("fixed_count", 0))
            self.sm.send("fix_done")
        elif state == "critiquing":
            verdict = summary.get("verdict", "NEEDS_REVISION")
            learn["critique_verdict"] = verdict
            learn["critique_issues"] = summary.get("issues", [])
            if verdict == "APPROVE":
                self.sm.send("critique_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=summary.get("issues", []))
                ctx.iteration += 1
                # pedagogical issues become the fix list; fixes then re-verify
                learn["violations"] = summary.get("issues", [])
                self.sm.send("critique_fix")
            else:
                learn["exhausted"] = True
                self.sm.send("critique_exhausted")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        learn = ctx.extras.get("learn", {})
        n = learn.get("lesson_count", 0)
        return (
            n > 0
            and learn.get("authored", 0) >= n
            and learn.get("assessed", 0) >= n
            and bool(learn.get("synthesis_complete"))
            and bool(learn.get("verified_clean"))
            and learn.get("critique_verdict") == "APPROVE"
        )

    # -- charter gate (HITL before mass authoring) ---------------------------
    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        learn = ctx.extras.setdefault("learn", {})
        conventions = learn.get("conventions") or ["(none listed — that is itself a concern)"]
        open_qs = learn.get("open_questions") or []
        open_block = (
            "\n\n**Open questions from the designer:** " + "; ".join(str(q) for q in open_qs)
            if open_qs
            else ""
        )
        return [
            {
                "id": "charter_action",
                "label": "Approve Charter",
                "prompt": (
                    "The course charter is ready. Authoring is expensive — conventions "
                    "locked now cannot drift later, so review before I write anything.\n\n"
                    f"**Lessons:** {learn.get('lesson_count', '?')} — "
                    f"**Topics:** {learn.get('topic_count', '?')} — "
                    f"**Registered analogies:** {learn.get('analogy_count', '?')}\n\n"
                    f"**Conventions canon:** {'; '.join(str(c) for c in conventions)}"
                    f"{open_block}\n\n"
                    "Full charter is in mempalace room "
                    f"skills/learn-{ctx.session_id}."
                ),
                "options": [
                    {
                        "value": "approve",
                        "label": "Approve",
                        "description": "Author the full study companion to this charter",
                    },
                    {
                        "value": "refine",
                        "label": "Refine",
                        "description": "Send the charter back to design with a note",
                    },
                    {
                        "value": "deny",
                        "label": "Deny",
                        "description": "Terminate the run; nothing is authored",
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
        if value in ("approve", "yes", "proceed", "confirm"):
            self.sm.send("gate_approve")
        elif value in ("deny", "no", "abort", "cancel"):
            self.sm.send("gate_deny")
        else:
            ctx.clarification_text = value if value not in ("refine",) else ctx.clarification_text
            if value != "refine" and value:
                ctx.clarification_text = value
            self.sm.send("gate_refine")

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(self, ctx, spec)
            if builder
            else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        )
        if ctx.clarification_text and state == "designing":
            pass  # already folded into _build_design
        elif ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def skill_context(self, state: str, ctx: RunContext) -> str | None:
        name = _PROMPT_BY_STATE.get(state)
        return f"assets/prompts/{name}.md" if name else None

    def result_payload(self, ctx: RunContext) -> dict:
        learn = ctx.extras.get("learn", {})
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "goal": ctx.goal,
            "session_id": ctx.session_id,
            "session_room": _room(ctx),
            "source_dir": learn.get("source_dir", ""),
            "output_dir": learn.get("output_dir", ""),
            "lesson_count": learn.get("lesson_count", 0),
            "lessons_authored": learn.get("authored", 0),
            "lessons_assessed": learn.get("assessed", 0),
            "synthesis_complete": learn.get("synthesis_complete", False),
            "verified_clean": learn.get("verified_clean", False),
            "critique_verdict": learn.get("critique_verdict", ""),
            "files_written": learn.get("files_written", []),
            "exhausted": learn.get("exhausted", False),
            "unresolved_violations": (
                learn.get("violations", []) if learn.get("exhausted") else []
            ),
        }
