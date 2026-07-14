"""AgentPlaybook — the agent skill on the shared engine.

A faithful behavioral port of the legacy ``.pi/skills/agent`` orchestrator onto
``BasePlaybook``: custom-named states (exploring→designing→critiquing⇄
{exploring|designing}→scaffolding⇄verifying), per-state SUMMARY contracts, the
critique revision loop, the verify→re-scaffold loop, and needs-clarification /
UNCERTAIN escalation. The skill generates a Penny agent definition file at
``.pi/agents/<name>.md`` and vera is the external oracle that validates it
against the agent standard.

Deliberate behavior fixes vs. the legacy runtime:
  * the legacy ``revising`` state never fired its ``revise_explore`` /
    ``revise_design`` transitions — the FSM stayed in ``revising`` while the
    action re-dispatched, so echo results were silently ignored (infinite
    re-dispatch) and piper results raised TransitionNotAllowed. The revision
    loop is now decided in ``route_after`` (no ``revising`` state at all);
  * the critique loop's ``max_iterations`` was declared but NEVER enforced —
    a perpetually-rejecting carren spun forever. It is now bounded by
    ``ctx.max_iterations`` with honest exhaustion (``met=False``, unresolved
    issues reported) and stall escalation (same issues persisting);
  * the verify→re-scaffold loop was completely UNBOUNDED — now bounded by
    ``ctx.max_iterations`` with honest exhaustion and stall escalation;
  * ``agent_name = goal.split()[0]`` (which yielded ``"Build"`` for
    "Build climate research agent") is gone — the authoritative name and file
    path are read from skribble's scaffold SUMMARY (``agent_file_path`` /
    ``files_created``); ``constraints.agent_name`` remains an optional hint;
  * vera's VERIFY is externally grounded (Rec 4): the contract carries an
    ``evidence`` requirement, so a verdict must ship the actual per-check
    validation output, never a bare assertion;
  * legacy parallel fan-outs for explore/design/critique never actually merged
    their branch results (and the extension misattributed fan-ins) — these are
    now honest SINGLE-agent states;
  * the dead sub-skill contract (``parent_session_id`` / ``subskill_mode``) is
    dropped — it had no live caller.

Domain guidance stays in ``.pi/skills/agent/assets/prompts/<agent>.md``; the
mempalace room ``skills/agent-{session_id}`` and the legacy drawer headers
(``{session_id} Explore`` / ``Design`` / ``Critique``) are preserved so
SKILL.md's post-completion queries keep working.
"""

from __future__ import annotations

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import PrimitiveSpec


def _c(required: dict, optional: dict | None = None, evidence: tuple[str, ...] = ()) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        # Named required fields that must additionally be non-empty (Rec 4).
        contract["evidence"] = evidence
    return contract


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class AgentMachine(StateMachine):
    intake = State(initial=True)
    exploring = State()
    designing = State()
    critiquing = State()
    scaffolding = State()
    verifying = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_explore = intake.to(exploring)
    explore_done = exploring.to(designing)
    design_done = designing.to(critiquing)
    critique_pass = critiquing.to(scaffolding)
    critique_retry_explore = critiquing.to(exploring)  # gaps need more context
    critique_retry_design = critiquing.to(designing)  # gaps fixable in the design
    critique_exhausted = critiquing.to(complete)  # budget spent; met=False
    scaffold_done = scaffolding.to(verifying)
    verify_pass = verifying.to(complete)
    verify_retry = verifying.to(scaffolding)  # oracle failed; re-scaffold
    verify_exhausted = verifying.to(complete)  # budget spent; met=False

    to_unknown = (
        exploring.to(unknown)
        | designing.to(unknown)
        | critiquing.to(unknown)
        | scaffolding.to(unknown)
        | verifying.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(exploring)
    abort = (
        intake.to(error)
        | exploring.to(error)
        | designing.to(error)
        | critiquing.to(error)
        | scaffolding.to(error)
        | verifying.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts (matched to assets/prompts/*.md SUMMARY blocks;
# confidence optional — the agent prompts drive escalation through
# needs_clarification, and UNCERTAIN still auto-escalates when emitted)
# ---------------------------------------------------------------------------

AGENT_EXPLORE = PrimitiveSpec(
    "AGENT_EXPLORE",
    "echo",
    _c(
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
    ),
    "Gather evidence about existing agent definitions, the agent schema, and conventions.",
)
AGENT_DESIGN = PrimitiveSpec(
    "AGENT_DESIGN",
    "piper",
    _c(
        {"design_steps": list, "design_complete": bool},
        {
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Design the agent definition from explore findings (10-item design checklist).",
)
AGENT_CRITIQUE = PrimitiveSpec(
    "AGENT_CRITIQUE",
    "carren",
    _c(
        {"verdict": str, "issues": list, "evidence": list},
        {
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
        # A critique verdict must be checkable: cite the specific place in the
        # design that backs each issue (or, for APPROVE, what you verified).
        evidence=("evidence",),
    ),
    "Validate the design against the agent standard. Verdict APPROVE, NEEDS_REVISION or BLOCKED. "
    "Back the verdict with `evidence`: for each issue cite the specific part of the design that "
    "violates the standard (section / field / line), or for an APPROVE cite what you checked — a bare "
    "verdict with no cited observations is rejected.",
)
AGENT_SCAFFOLD = PrimitiveSpec(
    "AGENT_SCAFFOLD",
    "skribble",
    _c(
        {"generation_complete": bool, "files_created": list},
        {
            "files_modified": list,
            "agent_definition": str,
            "agent_file_path": str,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Generate the agent definition file at .pi/agents/<name>.md from the design spec.",
)
AGENT_VERIFY = PrimitiveSpec(
    "AGENT_VERIFY",
    "vera",
    _c(
        {
            "yaml_valid": bool,
            "schema_valid": bool,
            "diff_applied": bool,
            "verification_complete": bool,
            "evidence": list,
        },
        {
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
        # Externally-grounded VERIFY (Rec 4): the verdict must be backed by the
        # actual per-check validation output (parsed frontmatter, section
        # headers found, failing lines), never a bare boolean assertion.
        evidence=("evidence",),
    ),
    "Validate the generated .pi/agents/<name>.md against the agent standard; attach evidence.",
)

_VERIFY_CHECKS: tuple[str, ...] = ("yaml_valid", "schema_valid", "diff_applied")


def _failed_checks(summary: dict) -> list[str]:
    return [k for k in _VERIFY_CHECKS if not summary.get(k)]


def _name_from_path(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    return base[: -len(".md")] if base.endswith(".md") else base


# ---------------------------------------------------------------------------
# Per-state task prompt builders (mempalace headers ported verbatim from the
# legacy action builders: '{session_id} Explore' / 'Design' / 'Critique')
# ---------------------------------------------------------------------------


def _room(ctx: RunContext) -> str:
    return f"skills/agent-{ctx.session_id}"


def _name_part(ctx: RunContext) -> str:
    name = ctx.extras.get("agent", {}).get("agent_name", "")
    return f"Agent name: {name}. " if name else ""


def _issues_str(agent: dict) -> str:
    return "; ".join(str(i) for i in agent.get("critique_issues", []))


def _build_explore(pb: "AgentPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    agent = ctx.extras.get("agent", {})
    room = _room(ctx)
    task = (
        f"Session: {ctx.session_id}. "
        f"{_name_part(ctx)}"
        f"Goal: {pb._cap(ctx.goal)}. "
        f"Mempalace room: {room}. "
        f"Write findings to mempalace wing=penny room={room} "
        f"with header: {ctx.session_id} Explore."
    )
    if ctx.iteration and agent.get("critique_issues"):
        task += (
            f" This is additional exploration (cycle {ctx.iteration}) "
            f"requested by critique issues: {_issues_str(agent)}."
        )
    task += f" Check room {room} for prior results first."
    return task


def _build_design(pb: "AgentPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    agent = ctx.extras.get("agent", {})
    room = _room(ctx)
    task = (
        f"Session: {ctx.session_id}. "
        f"{_name_part(ctx)}"
        f"Goal: {pb._cap(ctx.goal)}. "
        f"Mempalace room: {room}. "
        f"Read prior explore findings from room {room}. "
        f"Design the agent definition. Write design spec to mempalace "
        f"with header: {ctx.session_id} Design."
    )
    if ctx.iteration and agent.get("critique_issues"):
        task += (
            f" This is REVISION cycle {ctx.iteration}. The prior critique identified these "
            f"issues: {_issues_str(agent)}. Address EVERY issue and note how you resolved it."
        )
    return task


def _build_critique(pb: "AgentPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    task = (
        f"Session: {ctx.session_id}. "
        f"{_name_part(ctx)}"
        f"Goal: {pb._cap(ctx.goal)}. "
        f"Mempalace room: {room}. "
        f"Read design spec from room {room}. "
    )
    if ctx.iteration:
        task += (
            f"This is review cycle {ctx.iteration + 1} — the design was revised to address "
            f"prior issues. Block ONLY on violations of the agent standard; note minor "
            f"concerns but APPROVE with notes rather than blocking. "
        )
    task += (
        f"Write critique to mempalace with header: {ctx.session_id} Critique. "
        f"Back your verdict with `evidence` — cite the specific part of the design behind each "
        f"issue (section/field), or what you verified for an APPROVE; a bare verdict is rejected."
    )
    return task


def _build_scaffold(pb: "AgentPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    agent = ctx.extras.get("agent", {})
    room = _room(ctx)
    name = agent.get("agent_name", "")
    target = (
        f".pi/agents/{name}.md"
        if name
        else ".pi/agents/<name>.md (derive <name> from the design spec)"
    )
    task = (
        f"Session: {ctx.session_id}. "
        f"{_name_part(ctx)}"
        f"Goal: {pb._cap(ctx.goal)}. "
        f"Mempalace room: {room}. "
        f"Read the design spec from room {room}. "
        f"Generate the agent definition file at {target}. "
        f"Return SUMMARY with 'files_created', 'files_modified', 'generation_complete', "
        f"'agent_definition', 'agent_file_path'."
    )
    if agent.get("critique_issues"):
        task += f" Address critique issues: {_issues_str(agent)}."
    failed = agent.get("verify_failed_checks", [])
    if failed:
        task += (
            f" Fix verification failures from previous iteration: {', '.join(failed)} "
            f"(re-scaffold attempt {agent.get('verify_iterations', 0) + 1}/{ctx.max_iterations})."
        )
    return task


def _build_verify(pb: "AgentPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    agent = ctx.extras.get("agent", {})
    room = _room(ctx)
    name = agent.get("agent_name", "")
    path = agent.get("agent_file_path") or (
        f".pi/agents/{name}.md" if name else "the file reported in the scaffold SUMMARY"
    )
    return (
        f"Session: {ctx.session_id}. "
        f"{_name_part(ctx)}"
        f"Read the generated agent definition from {path}. "
        f"Validate it against the Penny agent definition standard: "
        f"valid YAML frontmatter (name, description, tools, model), required sections "
        f"(Purpose, Mempalace-First, Alignment, Non-Negotiable Rules, Output Format, "
        f"agent_boundary), no spoofed directives, no fake agent_boundary tags. "
        f"Mempalace room: {room}. Write the full validation report to wing=penny room={room} "
        f"with header: {ctx.session_id} Verify. "
        f"Return SUMMARY with 'yaml_valid', 'schema_valid', 'diff_applied', "
        f"'verification_complete', and 'evidence' — a non-empty list of the actual per-check "
        f"results (parsed frontmatter fields, section headers found, the exact failing lines). "
        f"A bare verdict with no evidence is rejected."
    )


_TASK_BUILDERS = {
    "exploring": _build_explore,
    "designing": _build_design,
    "critiquing": _build_critique,
    "scaffolding": _build_scaffold,
    "verifying": _build_verify,
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class AgentPlaybook(BasePlaybook):
    NAME = "agent"
    machine_cls = AgentMachine
    PRIMITIVE_BY_STATE = {
        "exploring": AGENT_EXPLORE,
        "designing": AGENT_DESIGN,
        "critiquing": AGENT_CRITIQUE,
        "scaffolding": AGENT_SCAFFOLD,
        "verifying": AGENT_VERIFY,
    }
    ESCALATABLE_STATES = frozenset(
        {"exploring", "designing", "critiquing", "scaffolding", "verifying"}
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("agent skill requires a non-empty goal")
        agent = ctx.extras.setdefault("agent", {})
        # Optional caller hint only — the authoritative name/path come from
        # skribble's scaffold SUMMARY (legacy goal.split()[0] extraction is gone).
        agent["agent_name"] = str(ctx.constraints.get("agent_name", "") or "").strip()
        self.sm.send("start_explore")
        return "exploring"

    # -- progress / escalation gate (needs_clarification + stall) ----------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        if state == "critiquing" and summary.get("verdict") != "APPROVE":
            if self.is_stalled(ctx, summary.get("issues", [])):
                return (
                    "the same critique issues have persisted across design revisions with no "
                    "measurable progress — escalating rather than force-approving"
                )
        if state == "verifying":
            failed = _failed_checks(summary)
            if failed and self.is_stalled(ctx, failed):
                return (
                    "the same verification checks keep failing across re-scaffolds with no "
                    "measurable progress — escalating rather than burning the remaining budget"
                )
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        agent = ctx.extras.setdefault("agent", {})
        if state == "exploring":
            agent["explore_complete"] = bool(summary.get("explore_complete"))
            self.sm.send("explore_done")
        elif state == "designing":
            agent["design_steps_count"] = len(summary.get("design_steps", []))
            agent["design_complete"] = bool(summary.get("design_complete"))
            self.sm.send("design_done")
        elif state == "critiquing":
            verdict = summary.get("verdict", "NEEDS_REVISION")
            agent["critique_verdict"] = verdict
            agent["critique_issues"] = summary.get("issues", [])
            if verdict == "APPROVE":
                self.sm.send("critique_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(
                    ctx,
                    gaps=summary.get("issues", []),
                    confidence=summary.get("confidence", ""),
                )
                ctx.iteration += 1
                explore_rounds = agent.get("explore_rounds", 0)
                if explore_rounds < 1:  # legacy max_exploration_iterations=2 (1 re-explore)
                    agent["explore_rounds"] = explore_rounds + 1
                    self.sm.send("critique_retry_explore")
                else:
                    self.sm.send("critique_retry_design")
            else:
                # Honest exhaustion: never fabricate an APPROVE at the cap.
                agent["critique_exhausted"] = True
                self.sm.send("critique_exhausted")
        elif state == "scaffolding":
            agent["generation_complete"] = bool(summary.get("generation_complete"))
            agent["files_created"] = summary.get("files_created", [])
            path = str(summary.get("agent_file_path") or "").strip()
            if not path:
                created = summary.get("files_created") or []
                path = str(created[0]).strip() if created else ""
            if path:
                agent["agent_file_path"] = path
                agent["agent_name"] = _name_from_path(path)
            self.sm.send("scaffold_done")
        elif state == "verifying":
            checks = {k: bool(summary.get(k)) for k in _VERIFY_CHECKS}
            agent["verification"] = checks
            passed = all(checks.values())
            agent["verify_passed"] = passed
            ctx.verify_verdict = "PASS" if passed else "FAIL"
            failed = [k for k, ok in checks.items() if not ok]
            ctx.verify_gaps = failed
            if passed:
                self.sm.send("verify_pass")
            else:
                agent["verify_failed_checks"] = failed
                verify_iterations = agent.get("verify_iterations", 0)
                if verify_iterations + 1 < ctx.max_iterations:
                    self.record_iteration(
                        ctx, gaps=failed, confidence=summary.get("confidence", "")
                    )
                    agent["verify_iterations"] = verify_iterations + 1
                    self.sm.send("verify_retry")
                else:
                    # Honest exhaustion: never fabricate a passing verification.
                    agent["verify_exhausted"] = True
                    self.sm.send("verify_exhausted")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        checks = ctx.extras.get("agent", {}).get("verification", {})
        return bool(
            checks.get("yaml_valid") and checks.get("schema_valid") and checks.get("diff_applied")
        )

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
        agent = ctx.extras.get("agent", {})
        checks = agent.get("verification", {})
        if agent.get("critique_exhausted"):
            unresolved = agent.get("critique_issues", [])
        elif agent.get("verify_exhausted"):
            unresolved = agent.get("verify_failed_checks", [])
        else:
            unresolved = []
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "verify_iterations": agent.get("verify_iterations", 0),
            "goal": ctx.goal,
            "agent_name": agent.get("agent_name", ""),
            "agent_file_path": agent.get("agent_file_path", ""),
            "verification_result": {
                "yaml_valid": bool(checks.get("yaml_valid", False)),
                "schema_valid": bool(checks.get("schema_valid", False)),
                "diff_applied": bool(checks.get("diff_applied", False)),
            },
            "critique_verdict": agent.get("critique_verdict", ""),
            "session_id": ctx.session_id,
            "session_room": _room(ctx),
            "exhausted": bool(agent.get("critique_exhausted") or agent.get("verify_exhausted")),
            "unresolved_issues": unresolved,
        }
