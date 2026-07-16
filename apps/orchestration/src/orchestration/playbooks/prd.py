"""PrdPlaybook — the prd skill on the shared engine.

A faithful behavioral port of the legacy ~1500-line ``.pi/skills/prd`` orchestrator
onto ``BasePlaybook``: custom-named states (generating[synthia, three modes]→
validating[vera]⇄generating), clarify-first HITL (the first generate always runs in
CLARIFICATION QUESTIONS mode and escalates with synthia's questions), and vera's
bounded evaluator-optimizer revision loop.

The legacy ``classify`` state is dropped deliberately: the legacy ``start()``
auto-skipped it on every fresh run, so echo never actually ran. Domain selection
is now **model-owned** (bitter-lesson: the keyword ``detect_domain`` table was
deleted): the code lists the available guidance packs under ``resources/`` and
synthia declares the best-fit ``domain`` in its SUMMARY; a caller
``constraints["domain"]`` short-circuits the choice. Resolved domain is stashed
in ``ctx.extras["prd"]``.

Control-flow dial: code-owned evaluator-optimizer (generating ⇄ validating). The
verdict (``valid``) is a rules-tier wire signal the engine routes on; there is no
free routing choice for the model, so ``fire_model_route`` is deliberately not
used. ``validating`` is evidence-gated (Rec 4): vera's PASS must carry captured
evidence or the engine's contract rejects it.

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

import os
import sys
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
# Domain packs (model-owned selection). Code lists what guidance EXISTS under
# the skill's resources/; the model chooses. This is an interface (a directory
# listing), not the deleted keyword router.
# ---------------------------------------------------------------------------


def available_domains(ctx: RunContext) -> list[str]:
    """Domain guidance packs available to synthia: the directory names under the
    prd skill's ``resources/`` (always including ``generic``). Prefers
    ``constraints['skill_dir']`` when the driver supplies it, else walks up to the
    repo's ``.pi/skills/prd/resources``. Best-effort: a scan failure degrades to
    ``['generic']`` (never raises — domain selection must not wedge a run)."""
    names: set[str] = {"generic"}
    roots: list[Path] = []
    skill_dir = str((ctx.constraints or {}).get("skill_dir", ""))
    if skill_dir:
        roots.append(Path(skill_dir) / "resources")
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / ".pi" / "skills" / "prd" / "resources"
        if cand.is_dir():
            roots.append(cand)
            break
    for root in roots:
        try:
            for p in root.iterdir():
                if p.is_dir():
                    names.add(p.name)
        except Exception:  # noqa: BLE001 — best-effort listing
            continue
    return sorted(names)


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
            "domain": str,  # model-declared best-fit guidance pack (R1)
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
    "Produce the layered PRD to the artifact interface in your guidance; the mode is "
    "signaled in the task. Write every artifact to mempalace.",
)
PRD_VALIDATE = PrimitiveSpec(
    "PRD_VALIDATE",
    "vera",
    _c(
        # Evidence-gated (Rec 4): a PASS must carry captured evidence (schema-check
        # output, section/coverage counts) or the engine's contract rejects it.
        {"valid": bool, "evidence": list, "confidence": str},
        {
            "ideal_state_valid": bool,
            "issues": list,
            "complete": bool,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
        evidence=["evidence"],
    ),
    "Validate the PRD artifacts against the check obligations in your guidance; emit "
    "valid + issues + the evidence you captured.",
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


def _domain_line(prd: dict) -> str:
    """Run fact: the resolved domain, or an instruction to declare one from the
    available packs (model-owned selection). No keyword table."""
    domain = prd.get("domain") or ""
    if domain:
        return f"Domain: {domain}. "
    available = prd.get("available_domains") or ["generic"]
    return (
        f"Available domain guidance packs: {', '.join(available)}. Choose the best fit "
        f"for the goal and declare it as `domain` in your SUMMARY. "
    )


def _build_generate(pb: "PrdPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    """Run facts only (R3): session, goal, domain, room, mode. The artifact
    interface lives once in synthia.md — not restated here as procedure."""
    prd = ctx.extras.get("prd", {})
    room = _room(ctx)
    mode = _effective_mode(ctx)
    head = f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. {_domain_line(prd)}"
    tail = f"Mempalace room: {room} (wing=penny). "
    if mode == "clarification":
        return head + tail + "Mode: CLARIFICATION QUESTIONS."
    if mode == "revision":
        issues_str = "; ".join(str(i) for i in prd.get("issues", []))
        return (
            head + tail + "Mode: REVISION. Address every issue below, and address it "
            f"differently from the attempt that failed: {pb._cap(issues_str)}."
        )
    return head + tail + "Mode: SYNTHESIS."


def _build_validate(pb: "PrdPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    """Run facts only (R3): the check obligations live once in vera.md."""
    prd = ctx.extras.get("prd", {})
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. Goal: {pb._cap(ctx.goal)}. "
        f"Domain: {prd.get('domain') or 'generic'}. "
        f"Mempalace room: {room} (wing=penny). "
        f"Validate the PRD artifacts and emit valid + issues + captured evidence."
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
        prd["available_domains"] = available_domains(ctx)
        # Caller constraint wins; otherwise the domain is model-declared (captured
        # in route_after from synthia's SUMMARY). No keyword detection.
        caller_domain = str((ctx.constraints or {}).get("domain", ""))
        prd["domain"] = caller_domain if caller_domain else ""
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
            # Capture the model-declared domain (R1) unless a caller constraint
            # already fixed it. Unknown declarations fall back to generic
            # (fail-safe, not fail-loud — an odd domain must not kill a run).
            if not prd.get("domain"):
                declared = str(summary.get("domain") or "")
                available = prd.get("available_domains") or ["generic"]
                prd["domain"] = declared if declared in available else "generic"
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
            issues = list(summary.get("issues", []) or [])
            # T4: a deterministic CODE schema-floor beneath vera's quality judgement — a
            # schema-malformed IDEAL_STATE is rejected by RULES (validate_ideal_state), never
            # on vera's say-so. Unreadable (not yet written / test) -> skipped, vera stands.
            schema_ok, schema_errors = self._schema_check_ideal_state(ctx)
            if schema_ok is False:
                ideal_ok = False
                issues = issues + [f"schema: {e}" for e in schema_errors]
                prd["schema_evidence"] = schema_errors
            prd["schema_checked"] = schema_ok is not None
            prd["valid"] = valid
            prd["ideal_state_valid"] = ideal_ok  # code schema-floor stacked on vera's verdict
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

    # -- T4: deterministic IDEAL_STATE schema-floor beneath vera's judgement ------
    def _read_ideal_state(self, ctx: RunContext):
        """The IDEAL_STATE this prd run produced, read from its mempalace room, or None.
        Skipped under pytest (hermetic) unless a test overrides this; production reuses the
        code skill's loader (room read + chunk reassembly). Best-effort, never raises."""
        if "PYTEST_CURRENT_TEST" in os.environ:
            return None
        try:
            from .code import load_ideal_state
            return load_ideal_state({"prd_room": f"skills/prd-{ctx.session_id}"}, ctx.project_root)
        except Exception:
            return None

    def _schema_check_ideal_state(self, ctx: RunContext):
        """(True, []) valid / (False, [errors]) schema-malformed / (None, []) unreadable => skip.
        The rules-tier floor: validate_ideal_state.validate_json is deterministic CODE, so a
        schema-malformed IDEAL_STATE cannot pass on vera's say-so. Never raises."""
        ideal = self._read_ideal_state(ctx)
        if not isinstance(ideal, dict):
            return None, []
        try:
            for parent in Path(__file__).resolve().parents:
                cand = parent / "scripts" / "validate_ideal_state.py"
                if cand.is_file():
                    if str(cand.parent) not in sys.path:
                        sys.path.insert(0, str(cand.parent))
                    from validate_ideal_state import validate_json  # type: ignore[import-not-found]
                    ok, errors = validate_json(ideal)
                    return bool(ok), [str(e) for e in (errors or [])]
        except Exception:
            return None, []
        return None, []

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
        # Recall (F2): seed the FIRST agent directive with distilled lessons.
        # This override replaces the base _task_summary, so it re-adds the
        # advisory injection the base provides (R5.5).
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
