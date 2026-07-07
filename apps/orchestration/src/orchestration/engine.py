"""BasePlaybook — the shared FSM engine every playbook rides on.

Every domain skill is a thin ``BasePlaybook`` subclass with its OWN state names,
per-state SUMMARY contracts and routing. The base owns the whole protocol and is
domain-neutral — it never special-cases a state name:
  * ``start`` / ``step`` / ``status`` dispatch
  * the SUMMARY gatekeeper (validates each state against its spec's own contract)
  * two HITL paths: ``UNCERTAIN`` -> escalate (uncertainty), and PLANNED gates
    (a declared ``GATE_STATES`` pause with multi-way ``route_user`` resume)
  * parallel fan-out (a ``PARALLEL_BY_STATE`` state dispatches N branch agents and
    routes once on fan-in, aggregating by weakest confidence)
  * resume (direct rehydrate by run_id — NO transition replay)
  * checkpointing after every committed transition
  * best-effort observability emission (never blocks)
  * budgets (max_iterations loop cap + a global step cap)
  * self-recovery (bounded step-retry on transient failure)

A subclass provides: ``NAME``, ``machine_cls`` (a python-statemachine class),
``PRIMITIVE_BY_STATE`` (and optionally ``PARALLEL_BY_STATE`` / ``GATE_STATES``),
``ESCALATABLE_STATES``, ``done_predicate``, ``route_after`` and
``initial_transition`` — plus optional hooks ``task_context_parts``,
``result_payload``, ``gate_questions`` and ``route_user``.

Machine contract (so the base stays generic): states include ``intake``
(initial), the playbook's own working states, ``unknown``,
``awaiting_clarification``, ``complete`` (final), ``error`` (final); the STANDARD
events ``to_unknown`` / ``escalate`` / ``clarify`` / ``abort``; and every gate
state carries its own resume transitions plus an ``abort`` edge. State names are
playbook-owned; the base never hardcodes them.
"""

from __future__ import annotations

from typing import Any

from .checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_RUNNING,
    Checkpointer,
)
from .contracts import Confidence, Directives, validate_summary_contract, weakest_confidence
from .context import RunContext
from .outcome_writer import record_outcome
from .primitives.spec import ParallelSpec, PrimitiveSpec

TERMINAL_STATES: frozenset[str] = frozenset({"complete", "error"})
_DEFAULT_STEP_CAP = 50


class _NullObs:
    """No-op observability sink (used when no ObsClient is injected)."""

    def run_start(self, *a: Any, **k: Any) -> None: ...
    def step_start(self, *a: Any, **k: Any) -> None: ...
    def step_end(self, *a: Any, **k: Any) -> None: ...
    def transition(self, *a: Any, **k: Any) -> None: ...
    def escalation(self, *a: Any, **k: Any) -> None: ...
    def run_end(self, *a: Any, **k: Any) -> None: ...


class BasePlaybook:
    # -- subclass provides -------------------------------------------------
    NAME: str = ""
    machine_cls: type = None  # a statemachine.StateMachine subclass
    PRIMITIVE_BY_STATE: dict[str, PrimitiveSpec] = {}
    PARALLEL_BY_STATE: dict[str, ParallelSpec] = {}  # fan-out states
    TOOL_STATES: frozenset[str] = frozenset()  # deterministic in-process states (no agent)
    GATE_STATES: frozenset[str] = frozenset()  # planned HITL pause states
    ESCALATABLE_STATES: frozenset[str] = frozenset()
    STEP_CAP: int = _DEFAULT_STEP_CAP

    def done_predicate(self, ctx: RunContext) -> bool:  # noqa: D401
        return True

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        """Capture the primitive's SUMMARY into ctx and fire the FSM event(s)."""
        raise NotImplementedError

    def run_tool_state(self, state: str, ctx: RunContext) -> None:
        """Execute a deterministic in-process tool state (no agent dispatch),
        stash its results in ``ctx.extras``, then fire the FSM event to the next
        state. Required if ``TOOL_STATES`` is non-empty. Must be SAFE TO RE-RUN:
        a crash-resume re-issues the pending tool state, so tool ops should be
        idempotent (re-scanning / overwriting is fine)."""
        raise NotImplementedError

    def initial_transition(self, ctx: RunContext) -> str:
        """Fire the start event(s) and return the entry state id."""
        raise NotImplementedError

    # -- optional subclass hooks (cycle-neutral defaults) ------------------
    def task_context_parts(self, state: str, ctx: RunContext) -> list[str]:
        """Extra per-state lines for the agent task message (e.g. gaps to
        address, criteria to judge against). Base: none — the base engine knows
        no state names."""
        return []

    def result_payload(self, ctx: RunContext) -> dict:
        """The ``result`` object of the terminal ``complete`` directive.
        Cycle-neutral default; subclasses add their domain fields."""
        return {"met": ctx.met, "iterations": ctx.iteration}

    def skill_context(self, state: str, ctx: RunContext) -> str | None:
        """Skill-relative path to the domain-guidance prompt for this state's
        agent (e.g. ``"assets/prompts/echo-charter.md"``). Emitted as
        ``skillContext`` on the invoke_agent directive; the TS driver resolves it
        against the skill dir and injects it as ``<skill_context>``. Default
        ``None`` -> the driver falls back to ``assets/prompts/{agent}.md``. Needed
        by skills whose states map to per-state prompt files (sca, jsa)."""
        return None

    def model_for_state(self, state: str, ctx: RunContext) -> str | None:
        """Optional per-state model override (e.g. jsa INVESTIGATE -> a local
        coder model). Emitted as ``model`` on the invoke_agent directive; the TS
        driver honors it. Default ``None`` -> the agent's configured model."""
        return None

    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        """Meta-cognitive progress gate (research/loop-research Recs 1 & 2).

        Run in ``step`` AFTER the SUMMARY passes and the UNCERTAIN check, but
        BEFORE routing. Return a reason string to force escalation to the user
        (e.g. a retry whose strategy is unchanged, or N identical failing
        iterations with no progress), or ``None`` to proceed normally. Escalation
        only fires when ``state`` is escalatable. The base returns ``None`` — no
        gate — so a playbook opts in by overriding this, typically using the
        ``strategy_repeated`` / ``is_stalled`` helpers below.
        """
        return None

    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        """Questions to surface when the run reaches a planned gate state.
        Required if ``GATE_STATES`` is non-empty."""
        raise NotImplementedError

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:
        """Route a user's answer to a planned gate by firing the FSM event.
        Required if ``GATE_STATES`` is non-empty."""
        raise NotImplementedError

    # -- loop-quality guards (opt-in; called by a playbook's route_after /
    #    progress_check to implement anti-paralysis + stall detection) --------
    @staticmethod
    def _norm_text(value: Any) -> str:
        """Whitespace/case-normalized text, for comparing declared strategies and
        gap descriptions across iterations."""
        return " ".join(str(value).lower().split())

    def record_iteration(
        self,
        ctx: RunContext,
        *,
        strategy_change: str = "",
        gaps: list | None = None,
        confidence: str = "",
    ) -> None:
        """Append one per-iteration digest to ``ctx.iteration_history``. A
        retrying playbook calls this once per completed iteration (typically in
        the retry branch of ``route_after``) so ``strategy_repeated`` and
        ``is_stalled`` have history to compare against."""
        ctx.iteration_history.append(
            {
                "iteration": ctx.iteration,
                "strategy_change": self._norm_text(strategy_change),
                "gaps": [self._norm_text(g) for g in (gaps or [])],
                "confidence": confidence,
            }
        )

    def strategy_repeated(self, ctx: RunContext, strategy_change: Any) -> bool:
        """Anti-paralysis (Rec 1): a retry must change strategy. True when the
        proposed ``strategy_change`` is empty, or ~identical to the most recent
        recorded one — i.e. this retry would repeat a failed approach."""
        proposed = self._norm_text(strategy_change)
        if not proposed:
            return True
        for prev in reversed(ctx.iteration_history):
            prior = self._norm_text(prev.get("strategy_change", ""))
            if prior:
                return prior == proposed
        return False

    def is_stalled(self, ctx: RunContext, gaps: list | None = None, *, window: int = 2) -> bool:
        """Stall / progress-assessment (Rec 2): True when the last ``window``
        recorded iterations show the SAME non-empty gaps as the current ones — no
        measurable progress — so the playbook can escalate instead of burning the
        remaining retry budget."""
        if window < 1 or len(ctx.iteration_history) < window:
            return False
        current = frozenset(self._norm_text(g) for g in (gaps or []))
        if not current:
            return False
        return all(
            frozenset(prev.get("gaps", [])) == current for prev in ctx.iteration_history[-window:]
        )

    # -- lifecycle ---------------------------------------------------------
    def __init__(
        self, checkpointer: Checkpointer, obs: Any = None, max_step_retries: int = 2
    ) -> None:
        self.cp = checkpointer
        self.obs = obs if obs is not None else _NullObs()
        self.max_step_retries = max_step_retries
        self.ctx: RunContext | None = None
        self.sm: Any = None

    # -- public protocol ---------------------------------------------------
    def start(
        self,
        *,
        session_id: str,
        run_id: str,
        goal: str = "",
        constraints: dict | None = None,
        project_root: str = "",
    ) -> dict:
        constraints = constraints or {}
        ctx = RunContext(
            session_id=session_id,
            run_id=run_id,
            playbook=self.NAME,
            project_root=project_root,
            goal=goal,
            constraints=constraints,
        )
        try:
            ctx.max_iterations = int(constraints.get("max_iterations", 3))
        except (TypeError, ValueError):
            ctx.max_iterations = 3
        self.ctx = ctx
        self.sm = self.machine_cls()
        try:
            entry = self.initial_transition(ctx)
        except Exception as exc:
            # A failed precondition (e.g. an unmet input dependency) must surface
            # as a parseable error directive, not a raw traceback the driver
            # cannot read.
            return self._to_error(f"start failed: {exc}")
        self._save(STATUS_RUNNING, entry)
        self.obs.run_start(ctx)
        return self._advance_to(entry)

    def step(self, *, session_id: str, run_id: str, agent: str, result: Any) -> dict:  # noqa: C901
        rec = self.cp.load(run_id)
        if rec is None:
            return self._plain_error(session_id, run_id, f"unknown run_id '{run_id}'")
        self.ctx = rec.context
        self.sm = self.machine_cls()
        try:
            self.sm.current_state_value = rec.current_state_id
        except Exception as exc:
            return self._plain_error(
                session_id, run_id, f"cannot rehydrate state '{rec.current_state_id}': {exc}"
            )
        state = rec.current_state_id

        # Resume from a HITL pause.
        if agent == "user":
            return self._resume(state, result)

        if state in TERMINAL_STATES:
            return self._plain_error(session_id, run_id, f"run already terminal ({state})")

        # Global step-cap budget.
        self.ctx.total_steps += 1
        if self.ctx.total_steps > self.STEP_CAP:
            return self._to_error(f"global step cap ({self.STEP_CAP}) exceeded")

        # Parallel fan-out states buffer per-branch SUMMARYs and route once on
        # fan-in (see _step_parallel).
        pspec = self.PARALLEL_BY_STATE.get(state)
        if pspec is not None:
            return self._step_parallel(state, pspec, agent, result)

        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        if agent != spec.agent:
            return self._to_error(
                f"agent '{agent}' does not match state '{state}' (expected '{spec.agent}')"
            )

        summary = result if isinstance(result, dict) else {}
        ok, err = validate_summary_contract(spec.name, spec.summary_contract, summary)
        if not ok:
            # Transient: a malformed SUMMARY is retried (bounded) before failing.
            return self._retry_or_fail(state, f"invalid SUMMARY: {err}")

        # A well-formed SUMMARY: retry budget resets.
        self.ctx.step_retries = 0
        confidence = summary.get("confidence", "")

        # Escalation: UNCERTAIN on an escalatable state -> single HITL path.
        if Confidence.is_uncertain(confidence) and state in self.ESCALATABLE_STATES:
            return self._escalate(state, spec, summary)

        # Progress-assessment gate (Recs 1 & 2): a playbook may force escalation
        # before routing — e.g. a retry whose strategy is unchanged, or repeated
        # no-progress iterations. Only escalatable states can reach the HITL path;
        # the reason overrides the escalation's unknown_reason.
        stall_reason = self.progress_check(state, self.ctx, summary)
        if stall_reason and state in self.ESCALATABLE_STATES:
            return self._escalate(state, spec, {**summary, "unknown_reason": stall_reason})

        # step_end digest (digests only).
        digest: dict[str, Any] = {}
        if "verdict" in summary:
            digest["verdict"] = summary["verdict"]
        if "gaps" in summary and isinstance(summary["gaps"], list):
            digest["gaps_count"] = len(summary["gaps"])
        self.obs.step_end(self.ctx, spec.name, digest, confidence)

        # Route (subclass fires the FSM event(s)).
        try:
            self.route_after(state, self.ctx, summary)
        except Exception as exc:
            return self._to_error(f"routing error at '{state}': {exc}")

        new_state = self.sm.current_state_value
        self.obs.transition(self.ctx, state, new_state, event="route")

        if new_state in TERMINAL_STATES:
            return self._finish(new_state)
        return self._advance_to(new_state)

    def status(self, *, session_id: str, run_id: str) -> dict:
        rec = self.cp.load(run_id)
        if rec is None:
            return Directives.status(
                state="unknown", complete=False, session_id=session_id, run_id=run_id
            )
        return Directives.status(
            state=rec.current_state_id,
            complete=rec.status in (STATUS_COMPLETE, STATUS_ERROR),
            session_id=session_id,
            run_id=run_id,
        )

    # -- internals ---------------------------------------------------------
    def _save(self, status: str, state_id: str) -> None:
        self.cp.save(
            run_id=self.ctx.run_id,
            session_id=self.ctx.session_id,
            playbook=self.NAME,
            current_state_id=state_id,
            context=self.ctx,
            status=status,
        )

    @staticmethod
    def _cap(text: str, limit: int = 600) -> str:
        """Bound an embedded value so the task message stays a digest, not a
        payload dump (full data lives in MemPalace)."""
        return text if len(text) <= limit else text[:limit] + " …[truncated]"

    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        parts = [spec.task_hint, f"Goal: {self._cap(ctx.goal)}"]
        parts.extend(self._cap(p) for p in self.task_context_parts(state, ctx))
        if ctx.iteration:
            parts.append(f"(retry iteration {ctx.iteration + 1}/{ctx.max_iterations})")
        if ctx.clarification_text:
            parts.append(self._cap(f"User clarification: {ctx.clarification_text}"))
        return "\n".join(parts)

    def _advance_to(self, state: str) -> dict:  # noqa: C901
        """Emit step_start (advancing the seq), then CHECKPOINT so the advanced
        seq survives the start/step subprocess boundary, then return the
        directive. This ordering (persist AFTER emission) is what keeps the
        observability seq globally monotonic across subprocesses."""
        # Deterministic tool states run in-process with NO agent dispatch. Loop
        # through any run of consecutive tool states, executing + advancing each,
        # until an agent/gate/parallel/terminal state (mirrors the legacy inline
        # tool-phase execution). A crash mid-tool re-issues the tool on resume,
        # so run_tool_state must be idempotent.
        for _ in range(self.STEP_CAP + 1):
            if state not in self.TOOL_STATES:
                break
            self.obs.step_start(self.ctx, state, "tool", state)
            self._save(STATUS_RUNNING, state)  # recoverable at the tool state
            try:
                self.run_tool_state(state, self.ctx)
            except Exception as exc:
                return self._to_error(f"tool state '{state}' failed: {exc}")
            new_state = self.sm.current_state_value
            if new_state == state:
                return self._to_error(f"tool state '{state}' did not advance")
            self.obs.step_end(self.ctx, state, {"tool": True}, "")
            self.obs.transition(self.ctx, state, new_state, event="tool")
            if new_state in TERMINAL_STATES:
                return self._finish(new_state)
            state = new_state
        else:
            return self._to_error(f"tool-state loop exceeded budget at '{state}'")
        # A planned gate pauses the run for the user — no agent dispatch.
        if state in self.GATE_STATES:
            return self._enter_gate(state)
        # A parallel state announces step_start for every branch, then fans out.
        pspec = self.PARALLEL_BY_STATE.get(state)
        if pspec is not None:
            for b in pspec.branches.values():
                self.obs.step_start(self.ctx, b.name, b.agent, state)
            self._save(STATUS_RUNNING, state)
            return self._directive_for_state(state)
        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        self.obs.step_start(self.ctx, spec.name, spec.agent, state)
        self._save(STATUS_RUNNING, state)
        return self._directive_for_state(state)

    def _directive_for_state(self, state: str) -> dict:
        """Pure directive builder (no emission, no checkpoint) — safe for the
        auto-recovery scan to re-issue a pending step. For a parallel state it
        re-issues the whole fan-out (all branches), so a kill-and-resume re-runs
        every branch (branch agents must be idempotent)."""
        sc = self.skill_context(state, self.ctx)
        model = self.model_for_state(state, self.ctx)
        pspec = self.PARALLEL_BY_STATE.get(state)
        if pspec is not None:
            tasks = []
            for bid, b in pspec.branches.items():
                task = {
                    "branch_id": bid,
                    "agent": b.agent,
                    "task_summary": self._task_summary(state, b, self.ctx),
                }
                if sc:
                    task["skillContext"] = sc
                if model:
                    task["model"] = model
                tasks.append(task)
            return Directives.invoke_agents_parallel(
                tasks=tasks,
                state_id=state,
                session_id=self.ctx.session_id,
                run_id=self.ctx.run_id,
            )
        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        return Directives.invoke_agent(
            agent=spec.agent,
            task_summary=self._task_summary(state, spec, self.ctx),
            state_id=state,
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
            skill_context=sc,
            model=model,
        )

    def _retry_or_fail(self, state: str, reason: str) -> dict:
        self.ctx.step_retries += 1
        if self.ctx.step_retries <= self.max_step_retries:
            return self._advance_to(state)  # re-issue; persists retry count + seq
        return self._to_error(f"step failed after {self.max_step_retries} retries: {reason}")

    def _step_parallel(  # noqa: C901
        self, state: str, pspec: ParallelSpec, agent: str, result: Any
    ) -> dict:
        """Ingest the BATCH of branch SUMMARYs for a parallel fan-out state.

        The driver spawns one agent per branch, then feeds ALL results back in a
        single step: ``agent="__parallel__"`` and ``result`` a list of
        ``{branch_id, agent, summary, exitCode}`` entries. Each branch is
        validated against its OWN contract; the branch SUMMARYs are aggregated
        into ``{"branches": {branch_id: SUMMARY}, "confidence": <weakest>}`` and
        routed exactly once — just like a single-primitive state. A whole
        kill-and-resume re-issues the fan-out (branch agents must be idempotent)."""
        if agent != "__parallel__":
            return self._to_error(
                f"parallel state '{state}' expects the fan-in agent '__parallel__', got '{agent}'"
            )
        entries = result if isinstance(result, list) else []
        if not entries:
            return self._retry_or_fail(
                state, f"parallel state '{state}' received no branch results"
            )

        branches: dict[str, dict] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                return self._retry_or_fail(state, f"parallel '{state}': malformed branch entry")
            bid = str(entry.get("branch_id", ""))
            branch = pspec.branches.get(bid)
            if branch is None:
                return self._retry_or_fail(state, f"parallel '{state}': unknown branch_id '{bid}'")
            if entry.get("exitCode", 0) not in (0, None):
                return self._retry_or_fail(state, f"parallel '{state}': branch '{bid}' failed")
            summary = entry.get("summary")
            summary = summary if isinstance(summary, dict) else {}
            ok, err = validate_summary_contract(branch.name, branch.summary_contract, summary)
            if not ok:
                return self._retry_or_fail(
                    state, f"parallel '{state}': invalid SUMMARY on branch '{bid}': {err}"
                )
            branches[bid] = summary

        missing = set(pspec.branches) - set(branches)
        if missing:
            return self._retry_or_fail(
                state, f"parallel '{state}': missing branches {sorted(missing)}"
            )

        self.ctx.step_retries = 0
        for bid, s in branches.items():
            self.obs.step_end(
                self.ctx, pspec.branches[bid].name, {"branch_id": bid}, s.get("confidence", "")
            )
        aggregated = {
            "branches": branches,
            "confidence": weakest_confidence(s.get("confidence", "") for s in branches.values()),
        }
        if Confidence.is_uncertain(aggregated["confidence"]) and state in self.ESCALATABLE_STATES:
            weak = next(
                b
                for b, s in branches.items()
                if not Confidence.is_valid(s.get("confidence"))
                or Confidence.is_uncertain(s.get("confidence"))
            )
            return self._escalate(state, pspec.branches[weak], aggregated)
        try:
            self.route_after(state, self.ctx, aggregated)
        except Exception as exc:
            return self._to_error(f"routing error at '{state}': {exc}")
        new_state = self.sm.current_state_value
        self.obs.transition(self.ctx, state, new_state, event="route")
        if new_state in TERMINAL_STATES:
            return self._finish(new_state)
        return self._advance_to(new_state)

    def _escalate(self, state: str, spec: PrimitiveSpec, summary: dict) -> dict:
        self.ctx.previous_state = state
        self.ctx.last_confidence = Confidence.UNCERTAIN
        self.ctx.unknown_reason = (
            summary.get("unknown_reason")
            or f"{spec.name} ({spec.agent}) reported UNCERTAIN confidence at '{state}'"
        )
        self._safe_send("to_unknown")
        self._safe_send("escalate")
        # Fail loud if the machine did not actually reach awaiting_clarification
        # (e.g. a subclass whose ESCALATABLE_STATES is not a subset of the
        # to_unknown/escalate event sources). Persisting awaiting_user at the
        # wrong state_id would wedge the run: _resume would later reject the
        # user's answer. Route to a terminal error instead of a silent wedge.
        if self.sm.current_state_value != "awaiting_clarification":
            return self._to_error(
                f"escalation did not reach awaiting_clarification from '{state}' "
                f"(check ESCALATABLE_STATES vs the machine's to_unknown/escalate events)"
            )
        self.obs.escalation(self.ctx, self.ctx.unknown_reason, questions_count=1)
        self._save(STATUS_AWAITING_USER, "awaiting_clarification")
        return self.escalation_directive()

    def escalation_directive(self) -> dict:
        """Build the escalate_to_user directive from the current ctx. Reused by
        the auto-recovery scan to re-present a pending question."""
        questions = [
            {
                "id": "clarify",
                "label": "Clarify",
                "prompt": self.ctx.unknown_reason + "  How should the run proceed?",
                "options": [],
                "allowOther": True,
            }
        ]
        return Directives.escalate_to_user(
            questions=questions,
            previous_state=self.ctx.previous_state,
            unknown_reason=self.ctx.unknown_reason,
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
        )

    def gate_directive(self, state: str) -> dict:
        """Pure builder for a planned-gate escalate_to_user directive (no
        emission, no checkpoint) — safe for the auto-recovery scan to re-issue."""
        return Directives.escalate_to_user(
            questions=self.gate_questions(state, self.ctx),
            previous_state=state,
            unknown_reason=f"gate:{state}",
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
        )

    def _enter_gate(self, state: str) -> dict:
        """Pause the run at a planned gate: persist AWAITING_USER at the gate
        state id and surface the gate's questions. Distinct from _escalate,
        which is only for UNCERTAIN confidence."""
        self.ctx.previous_state = state
        questions = self.gate_questions(state, self.ctx)
        self.obs.escalation(self.ctx, f"gate:{state}", questions_count=len(questions))
        self._save(STATUS_AWAITING_USER, state)
        return Directives.escalate_to_user(
            questions=questions,
            previous_state=state,
            unknown_reason=f"gate:{state}",
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
        )

    def pending_user_directive(self, state: str) -> dict:
        """Re-present whatever the run is waiting on (planned gate or UNCERTAIN
        escalation) — used by the auto-recovery scan."""
        return (
            self.gate_directive(state) if state in self.GATE_STATES else self.escalation_directive()
        )

    def _resume(self, state: str, result: Any) -> dict:
        # Planned gate: the user's answer selects the resume transition.
        if state in self.GATE_STATES:
            return self._resume_gate(state, result)
        if state != "awaiting_clarification":
            return self._plain_error(
                self.ctx.session_id,
                self.ctx.run_id,
                f"cannot resume: run is at '{state}', not awaiting_clarification",
            )
        if isinstance(result, dict):
            self.ctx.clarification_text = str(
                result.get("answer") or result.get("clarification") or result
            )
        else:
            self.ctx.clarification_text = str(result)
        self._safe_send("clarify")
        new_state = self.sm.current_state_value
        self.obs.transition(self.ctx, "awaiting_clarification", new_state, event="clarify")
        return self._advance_to(new_state)

    def _resume_gate(self, state: str, result: Any) -> dict:
        """Resume from a planned gate: the subclass's route_user fires the FSM
        event chosen by the user's answer (multi-target resume)."""
        try:
            self.route_user(state, self.ctx, result)
        except Exception as exc:
            return self._to_error(f"gate routing error at '{state}': {exc}")
        new_state = self.sm.current_state_value
        if new_state == state:
            # route_user fired nothing (e.g. an unrecognized answer): re-ask.
            return self._enter_gate(state)
        self.obs.transition(self.ctx, state, new_state, event="gate")
        if new_state in TERMINAL_STATES:
            return self._finish(new_state)
        return self._advance_to(new_state)

    def _finish(self, new_state: str) -> dict:
        # Terminal paths (_finish/_to_error) intentionally persist BEFORE emitting
        # run_end — the opposite of _advance_to/_escalate. That is safe because a
        # terminal run has no subsequent subprocess that reads last_seq, so the
        # un-persisted run_end seq is harmless.
        if new_state == "error":
            return self._to_error("routed to error state")
        self.ctx.met = self.done_predicate(self.ctx)
        self.ctx.complete = True
        self._save(STATUS_COMPLETE, "complete")
        record_outcome(self.ctx)  # best-effort capture into penny/outcomes
        self.obs.run_end(self.ctx, STATUS_COMPLETE, self.ctx.met, self.ctx.iteration)
        result = self.result_payload(self.ctx)
        return Directives.complete(
            result=result, session_id=self.ctx.session_id, run_id=self.ctx.run_id
        )

    def _to_error(self, reason: str) -> dict:
        self.ctx.errors.append(reason)
        self._safe_send("abort")
        if self.sm.current_state_value != "error":
            try:
                self.sm.current_state_value = "error"
            except Exception:
                pass
        self.ctx.complete = True
        self.ctx.met = False
        self._save(STATUS_ERROR, "error")
        record_outcome(self.ctx)  # best-effort capture into penny/outcomes
        self.obs.run_end(self.ctx, STATUS_ERROR, False, self.ctx.iteration)
        return Directives.error(
            errors=self.ctx.errors, session_id=self.ctx.session_id, run_id=self.ctx.run_id
        )

    def _safe_send(self, event: str) -> bool:
        try:
            self.sm.send(event)
            return True
        except Exception:
            return False

    @staticmethod
    def _plain_error(session_id: str, run_id: str, reason: str) -> dict:
        return Directives.error(errors=[reason], session_id=session_id, run_id=run_id)
