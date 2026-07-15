"""BasePlaybook — the shared FSM engine every playbook rides on.

Every domain skill is a thin ``BasePlaybook`` subclass with its OWN state names,
per-state SUMMARY contracts and routing. The base owns the whole protocol and is
domain-neutral — it never special-cases a state name:
  * ``start`` / ``step`` / ``status`` dispatch
  * the SUMMARY gatekeeper (validates each state against its spec's own contract)
  * two HITL paths: ``UNCERTAIN`` -> escalate (uncertainty), and PLANNED gates
    (a declared ``GATE_STATES`` pause with multi-way ``route_user`` resume)
  * parallel fan-out (a ``PARALLEL_BY_STATE`` state dispatches N branch agents and
    routes once on fan-in, aggregating by weakest confidence) — topology may also
    be DATA: runtime-emitted branches in ``ctx.extras["dynamic_branches"]`` via the
    ``parallel_spec`` seam, bounded by the ``max_fan_width`` budget
  * resume (direct rehydrate by run_id — NO transition replay)
  * checkpointing after every committed transition
  * best-effort observability emission (never blocks)
  * budgets (max_iterations loop cap + a global step cap) with an HONEST-EXHAUSTION
    backstop: routing past the iteration budget forces completion with
    ``met = done_predicate`` and an ``exhausted`` result flag — never a fake pass
  * self-recovery (bounded step-retry on transient failure); the malformed-SUMMARY
    retry is a tagged LOAN (``loans.py``) with an Ablate toggle
  * Recall (atom F2): distilled lessons retrieved at ``start()`` and seeded into
    the FIRST agent directive as advisory context (never gating)
  * default-on loop guards (loops.md Recs 1 & 2): the base ``progress_check``
    escalates a repeated retry strategy or a stalled gap set; the engine
    auto-records per-iteration digests; opt-out via ``LOOP_GUARDS = False``
  * model-owned routing as a small edit: ``fire_model_route`` fires a
    model-chosen event iff it is a declared, allowed, non-reserved transition

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

import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

from .checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_RUNNING,
    Checkpointer,
)
from .contracts import Confidence, Directives, validate_summary_contract, weakest_confidence
from .context import RunContext
from .loans import loan_enabled
from .outcome_writer import record_outcome
from .primitives.spec import ParallelSpec, PrimitiveSpec, parallel_spec_from_dict
from .recall import recall_lessons


def _autonomy_ask_reason(action_text: str) -> Optional[str]:
    """Graduated-autonomy gate for an about-to-run action state. Returns a reason
    to ASK a human, or None to proceed. Opt-in via ``PENNY_AUTONOMY_GATE`` — when
    unset (the default) this is dormant, so it can never change existing runs.
    Best-effort: any failure loading the autonomy module means no gating.

    Reversibility + earned per-domain trust decide act-vs-ask; irreversible /
    destructive goals and untrusted domains ASK (see scripts/system/autonomy/)."""
    if not os.environ.get("PENNY_AUTONOMY_GATE"):
        return None
    try:
        autonomy = str(Path(__file__).resolve().parents[4] / "scripts" / "system" / "autonomy")
        if autonomy not in sys.path:
            sys.path.insert(0, autonomy)
        from gate import ASK, decide_live  # type: ignore[import-not-found]

        decision = decide_live(action_text)
        return decision.reason if decision.action == ASK else None
    except Exception:  # noqa: BLE001 — no autonomy module ⇒ no gating
        return None


TERMINAL_STATES: frozenset[str] = frozenset({"complete", "error"})
_DEFAULT_STEP_CAP = 50


# ── #33: shared HITL gate-answer intent classifier ───────────────────────────
# Gate parsing keyword-matched the user's answer to approve/deny/refine; free text
# ("yep, ship it", "kill it") fell outside the sets and silently became a refine on
# the SAFETY seam. classify_gate_intent keeps the exact keyword fast-path (option
# clicks route unchanged) and, when PI_GATE_INTENT_MODEL is set, has a model read
# genuinely free-text answers. Approval requires model confidence; any ambiguity or
# failure yields "refine" (re-ask), so the seam never silently approves or denies.
_GATE_INTENT_MODEL_ENV = "PI_GATE_INTENT_MODEL"
_GATE_APPROVE = frozenset({
    "approve", "approved", "confirm", "confirmed", "proceed", "yes", "y",
    "accept", "accepted", "ok", "okay", "skip",
})
_GATE_DENY = frozenset({
    "deny", "denied", "no", "n", "abort", "cancel", "discard", "stop",
    "reject", "rejected",
})
# #26/#27: model-judged loop guards (gated; the string checks stay as the fallback).
_STALL_MODEL_ENV = "PI_STALL_MODEL"
_STRATEGY_MODEL_ENV = "PI_STRATEGY_MODEL"


def _load_detect():
    """Lazy-import the shared detect() primitive (scripts/system/lib, #8), or None."""
    try:
        for parent in Path(__file__).resolve().parents:
            lib = parent / "scripts" / "system" / "lib"
            if lib.is_dir():
                if str(lib) not in sys.path:
                    sys.path.insert(0, str(lib))
                from detect import detect as _detect  # type: ignore[import-not-found]
                return _detect
    except Exception:
        return None
    return None


def _needs_summary_restatement() -> bool:
    """#28: the SUMMARY-restatement directive is a crutch for weaker models that drop a
    mid-prompt output contract. A capability-tier deployment declares its models don't
    need it via ``PI_MODEL_TIER=strong`` — strong models stop paying for it; any other
    value (the default) keeps the restatement, the safe fallback."""
    return os.environ.get("PI_MODEL_TIER", "").strip().lower() != "strong"


# Budget boundary on fan width (code caps, the model spends): a dynamic fan-out
# may not exceed this many branches unless the caller raises
# ``constraints["max_fan_width"]``.
_DEFAULT_MAX_FAN_WIDTH = 8


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
    # Action-taking states gated by graduated autonomy: before dispatching, the
    # engine asks act-vs-ask (reversibility + earned trust) and escalates to the
    # human when the answer is ASK. MUST be a subset of ESCALATABLE_STATES.
    # Only consulted when PENNY_AUTONOMY_GATE is set (dormant by default).
    AUTONOMY_STATES: frozenset[str] = frozenset()
    STEP_CAP: int = _DEFAULT_STEP_CAP
    # Default-on loop-quality guards (loops.md Recs 1 & 2). A subclass that
    # cannot use the generic base ``progress_check`` sets this False (playbooks
    # with their own ``progress_check`` override are unaffected either way).
    LOOP_GUARDS: bool = True
    # Engine-owned FSM events a model-chosen route may never fire directly.
    RESERVED_EVENTS: frozenset[str] = frozenset({"to_unknown", "escalate", "clarify", "abort"})

    def done_predicate(self, ctx: RunContext) -> bool:  # noqa: D401
        """Whether the run's goal is MET at completion. The base default is
        ``False`` — success is never claimed on a Done claim alone (assembly
        invariant 3: at least one grounded exit; safe defaults never claim
        completion). Every playbook overrides this with its externally-grounded
        predicate (e.g. ``verify_verdict == PASS``)."""
        return False

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
        """Meta-cognitive progress gate (research/loop-research Recs 1 & 2) —
        DEFAULT-ON.

        Run in ``step`` AFTER the SUMMARY passes and the UNCERTAIN check, but
        BEFORE routing. Return a reason string to force escalation to the user,
        or ``None`` to proceed normally. Escalation only fires when ``state``
        is escalatable.

        The base enforces the two generic guards for any playbook that does not
        override this hook (the engine-level enforcement loops.md Rec 1 calls
        for — "the engine should reject a retry whose planned change is absent
        or ~identical"):

        * anti-paralysis — a retry SUMMARY that explicitly declares a
          ``strategy_change`` repeating the previously recorded one;
        * stall — a SUMMARY whose ``gaps`` list matches the last two recorded
          iterations' gaps (no measurable progress), escalating instead of
          burning the remaining budget.

        Both read ``ctx.iteration_history``, which the engine auto-records when
        a playbook advances ``ctx.iteration`` (see ``_auto_record_iteration``).
        Opt-out: ``LOOP_GUARDS = False``. A playbook with its own override
        (typically via ``strategy_repeated`` / ``is_stalled``) replaces this
        wholesale and is unaffected.
        """
        if not self.LOOP_GUARDS:
            return None
        if (
            ctx.iteration >= 1
            and "strategy_change" in summary
            and self.strategy_repeated(ctx, summary.get("strategy_change", ""))
        ):
            return "retry repeats a failed strategy — escalating (anti-paralysis guard)"
        gaps = summary.get("gaps")
        if isinstance(gaps, list) and self.is_stalled(ctx, gaps):
            return "no measurable progress across iterations — escalating (stall guard)"
        return None

    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        """Questions to surface when the run reaches a planned gate state.
        Required if ``GATE_STATES`` is non-empty."""
        raise NotImplementedError

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:
        """Route a user's answer to a planned gate by firing the FSM event.
        Required if ``GATE_STATES`` is non-empty."""
        raise NotImplementedError

    @staticmethod
    def classify_gate_intent(answer: Any, *, runner: Optional[Callable] = None) -> str:  # noqa: C901
        """Map a HITL gate answer to 'approve' | 'deny' | 'refine' (#33).

        Exact keyword answers (the option values a click produces) route instantly and
        unchanged. A genuinely free-text answer is classified by a model when
        PI_GATE_INTENT_MODEL is set; approval requires model confidence and any
        ambiguity/failure yields 'refine' (re-ask), so the safety seam never silently
        approves or denies. Never raises.
        """
        text = " ".join(str(answer or "").lower().split())
        if not text:
            return "refine"
        if text in _GATE_APPROVE:
            return "approve"
        if text in _GATE_DENY:
            return "deny"
        spec = os.environ.get(_GATE_INTENT_MODEL_ENV, "").strip()
        if not spec:
            return "refine"
        detect = _load_detect()
        if detect is None:
            return "refine"
        try:
            result = detect(
                text,
                "Does this answer APPROVE the proposed action, DENY/stop it, or ask to "
                "REFINE/change it?",
                model_spec=spec, labels=("approve", "deny", "refine"), runner=runner,
            )
        except Exception:  # noqa: BLE001 - gate parsing must never raise
            return "refine"
        if not result.get("ok"):
            return "refine"
        intent = str(result.get("answer", "")).strip().lower()
        confidence = str(result.get("confidence", "")).strip().upper()
        if intent == "approve" and confidence in ("CERTAIN", "PROBABLE"):
            return "approve"
        if intent == "deny":
            return "deny"
        return "refine"

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

    def strategy_repeated(
        self, ctx: RunContext, strategy_change: Any, *, runner: Optional[Callable] = None
    ) -> bool:
        """Anti-paralysis (Rec 1): a retry must change strategy. True when the proposed
        ``strategy_change`` is empty, or the SAME approach as the most recent recorded
        one — i.e. this retry would repeat a failed approach. #27: when
        PI_STRATEGY_MODEL is set a model judges "same approach?" semantically (a reworded
        but identical plan no longer slips through, a genuinely new plan phrased similarly
        is no longer blocked); unset or any failure falls back to normalized-string
        equality. Bounded either way by the hard iteration ceiling."""
        proposed = self._norm_text(strategy_change)
        if not proposed:
            return True
        prior = ""
        for prev in reversed(ctx.iteration_history):
            candidate = self._norm_text(prev.get("strategy_change", ""))
            if candidate:
                prior = candidate
                break
        if not prior:
            return False
        spec = os.environ.get(_STRATEGY_MODEL_ENV, "").strip()
        if spec:
            verdict = self._strategy_same_via_model(proposed, prior, spec, runner=runner)
            if verdict is not None:
                return verdict
        return prior == proposed

    def fire_model_route(self, summary: dict, field: str = "next_event") -> bool:
        """Model-owned routing (the control-flow dial): fire the FSM event the
        model chose in ``summary[field]`` — iff it is a declared, currently
        allowed transition of the machine (the graph still bounds the blast
        radius) and not an engine-reserved event (``RESERVED_EVENTS``). Returns
        True when the event fired; False with the FSM unmoved otherwise, so the
        caller decides the fallback (fixed routing, or escalate).

        This is what makes moving the dial toward the model a SMALL EDIT per
        state: ``route_after`` delegates to this helper and keeps its code-owned
        logic as the fallback — no rewrite, no new machinery.
        """
        event = summary.get(field)
        if not isinstance(event, str) or not event or event in self.RESERVED_EVENTS:
            return False
        try:
            allowed = {e.id for e in self.sm.allowed_events}
        except Exception:  # noqa: BLE001 — unknown machine introspection failure
            return False
        if event not in allowed:
            return False
        return self._safe_send(event)

    def is_stalled(
        self, ctx: RunContext, gaps: list | None = None, *, window: int = 2,
        runner: Optional[Callable] = None,
    ) -> bool:
        """Stall / progress-assessment (Rec 2): True when the last ``window`` recorded
        iterations show no measurable progress on the gaps, so the playbook can escalate
        instead of burning the remaining retry budget. #26: when PI_STALL_MODEL is set the
        verifier judges "did these iterations reduce the gap?" (paraphrased-identical gaps
        no longer read as progress, genuinely-shrinking-but-similar gaps no longer read as
        a stall); unset or any failure falls back to exact gap-set equality across the
        window. Bounded either way by the hard iteration ceiling."""
        if window < 1 or len(ctx.iteration_history) < window:
            return False
        current = frozenset(self._norm_text(g) for g in (gaps or []))
        if not current:
            return False
        spec = os.environ.get(_STALL_MODEL_ENV, "").strip()
        if spec:
            verdict = self._stall_via_model(ctx, list(gaps or []), window, spec, runner=runner)
            if verdict is not None:
                return verdict
        return all(
            frozenset(prev.get("gaps", [])) == current for prev in ctx.iteration_history[-window:]
        )

    def _stall_via_model(self, ctx, gaps, window, spec, *, runner=None):
        """#26: does the recent history show NO progress on the gaps? True (stalled) /
        False (progressing) / None on any failure (=> the string fallback decides)."""
        detect = _load_detect()
        if detect is None:
            return None
        prior = [
            "; ".join(str(g) for g in prev.get("gaps", []))
            for prev in ctx.iteration_history[-window:]
        ]
        artifact = (
            "PRIOR ITERATIONS (oldest→newest) — the gaps each still had:\n"
            + "\n".join(f"- iter {i + 1}: {p or '(none)'}" for i, p in enumerate(prior))
            + "\n\nCURRENT gaps after the latest iteration:\n"
            + ("; ".join(str(g) for g in gaps) or "(none)")
        )
        try:
            result = detect(
                artifact,
                "Across these iterations, is the work STALLED (the same gaps keep "
                "recurring, no measurable progress) or PROGRESSING (the gaps are being "
                "reduced or resolved)?",
                model_spec=spec, labels=("stalled", "progressing"), runner=runner,
            )
        except Exception:  # noqa: BLE001 - a guard must never raise
            return None
        if not result.get("ok"):
            return None
        answer = str(result.get("answer", "")).strip().lower()
        if answer == "stalled":
            return True
        if answer == "progressing":
            return False
        return None

    def _strategy_same_via_model(self, proposed, prior, spec, *, runner=None):
        """#27: is the proposed retry strategy the SAME approach as the prior one? True
        (repeat) / False (different) / None on any failure (=> the string fallback)."""
        detect = _load_detect()
        if detect is None:
            return None
        artifact = f"PRIOR strategy:\n{prior}\n\nPROPOSED next strategy:\n{proposed}"
        try:
            result = detect(
                artifact,
                "Is the PROPOSED strategy essentially the SAME approach as the PRIOR one "
                "(repeating it would likely fail the same way), or a genuinely DIFFERENT "
                "approach?",
                model_spec=spec, labels=("same", "different"), runner=runner,
            )
        except Exception:  # noqa: BLE001 - a guard must never raise
            return None
        if not result.get("ok"):
            return None
        answer = str(result.get("answer", "")).strip().lower()
        if answer == "same":
            return True
        if answer == "different":
            return False
        return None

    # -- lifecycle ---------------------------------------------------------
    def __init__(
        self, checkpointer: Checkpointer, obs: Any = None, max_step_retries: int = 2
    ) -> None:
        self.cp = checkpointer
        self.obs = obs if obs is not None else _NullObs()
        self.max_step_retries = max_step_retries
        self.ctx: RunContext | None = None
        self.sm: Any = None

    @property
    def _ctx(self) -> RunContext:
        """The active run context, type-narrowed. ``start``/``step`` set
        ``self.ctx`` before any internal helper runs; a None here is a protocol
        violation, not a recoverable state."""
        ctx = self.ctx
        if ctx is None:  # pragma: no cover — engine misuse
            raise RuntimeError("engine used before start()/step() set the run context")
        return ctx

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
        # Recall (atom F2): seed the run with distilled lessons from prior runs.
        # Best-effort and advisory — a failure or empty result never affects the
        # run, and no routing ever reads these (loops.md Rec 3).
        ctx.recall_lessons = recall_lessons(ctx)
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
        try:
            pspec = self.parallel_spec(state, self._ctx)
        except Exception as exc:
            return self._to_error(f"fan-out spec error at '{state}': {exc}")
        if pspec is not None:
            return self._step_parallel(state, pspec, agent, result)

        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        if agent != spec.agent:
            return self._to_error(
                f"agent '{agent}' does not match state '{state}' (expected '{spec.agent}')"
            )

        # The TS driver wraps every single-agent result as
        # {exitCode, summary, summary_missing, error} (skill/index.ts:1012-1021).
        # Unwrap it and honor the driver's flags, mirroring the parallel fan-in
        # path (_step_parallel reads entry["summary"] and checks entry["exitCode"]
        # at engine.py:489-492). A bare summary dict from a direct/programmatic
        # caller (unit tests) is accepted as-is. The triple-key signature is the
        # driver wrapper's and never collides with a playbook summary contract,
        # whose fields are domain-named (findings_count, verdict, ...).
        if isinstance(result, dict) and {"exitCode", "summary", "summary_missing"} <= result.keys():
            if result.get("exitCode", 0) not in (0, None):
                return self._retry_or_fail(state, result.get("error") or f"agent '{agent}' failed")
            if result.get("summary_missing"):
                return self._retry_malformed(
                    state, result.get("error") or "no parseable SUMMARY emitted"
                )
            inner = result.get("summary")
            summary = inner if isinstance(inner, dict) else {}
        else:
            summary = result if isinstance(result, dict) else {}
        ok, err = validate_summary_contract(spec.name, spec.summary_contract, summary)
        if not ok:
            # Transient: a malformed SUMMARY is retried (bounded) before failing.
            return self._retry_malformed(state, f"invalid SUMMARY: {err}")

        # A well-formed SUMMARY: retry budget resets.
        self.ctx.step_retries = 0
        self._capture_evidence(summary)
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
        pre_iteration = self._ctx.iteration
        try:
            self.route_after(state, self._ctx, summary)
        except Exception as exc:
            return self._to_error(f"routing error at '{state}': {exc}")
        self._auto_record_iteration(pre_iteration, summary)

        new_state = self.sm.current_state_value
        self.obs.transition(self.ctx, state, new_state, event="route")

        if new_state in TERMINAL_STATES:
            return self._finish(new_state)
        if self._ctx.iteration > self._ctx.max_iterations:
            return self._force_exhausted(new_state)
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
        payload dump (full data lives in MemPalace). Tagged LOAN
        ``task_digest_cap`` (a Compact/E2 mechanism): ablated, values pass
        through untruncated so scaffold-OFF runs can measure the mechanism."""
        if not loan_enabled("task_digest_cap"):
            return text
        return text if len(text) <= limit else text[:limit] + " …[truncated]"

    def parallel_spec(self, state: str, ctx: RunContext) -> ParallelSpec | None:
        """The fan-out topology for ``state`` — topology as DATA (assembly
        invariant 7: arrangement is data, chosen late).

        Runtime-emitted branches in ``ctx.extras["dynamic_branches"][state]``
        (a model's PLAN/Decide output in JSON-safe form — see
        ``parallel_spec_from_dict``) take precedence over the class-level
        ``PARALLEL_BY_STATE`` wiring, and survive checkpoint/resume because
        ``extras`` round-trips wholesale. Both are bounded by
        ``constraints["max_fan_width"]`` — a Budget boundary: code caps the
        width, the model spends it. Raises ``ValueError`` on malformed branch
        data or an over-width fan (call sites surface a parseable error
        directive)."""
        dynamic = (ctx.extras.get("dynamic_branches") or {}).get(state) if ctx else None
        spec = parallel_spec_from_dict(dynamic) if dynamic else self.PARALLEL_BY_STATE.get(state)
        if spec is not None:
            try:
                width_cap = int(ctx.constraints.get("max_fan_width", _DEFAULT_MAX_FAN_WIDTH))
            except (TypeError, ValueError):
                width_cap = _DEFAULT_MAX_FAN_WIDTH
            if len(spec.branches) > width_cap:
                raise ValueError(
                    f"fan-out at '{state}' has {len(spec.branches)} branches, over the "
                    f"max_fan_width budget ({width_cap})"
                )
        return spec

    def _capture_evidence(self, summary: dict) -> None:
        """Stash a capped digest of a SUMMARY's non-empty ``evidence`` field on
        the context (last-write-wins) so the outcome ledger records
        outcome+evidence, not outcome alone (atomic-loop checklist)."""
        ev = summary.get("evidence")
        if isinstance(ev, str):
            ev = [ev] if ev.strip() else []
        if isinstance(ev, (list, tuple)) and len(ev) > 0:
            self._ctx.verify_evidence = [
                s if len(s) <= 300 else s[:300] + " …[truncated]"
                for s in (str(e) for e in list(ev)[:5])
            ]

    def _auto_record_iteration(self, pre_iteration: int, summary: dict) -> None:
        """Ledger side of the default-on loop guards: when ``route_after``
        advanced ``ctx.iteration``, append the completed iteration's digest —
        unless the playbook already recorded it via ``record_iteration``
        (dedupe by iteration number). This keeps ``strategy_repeated`` /
        ``is_stalled`` fed for playbooks that never record themselves."""
        ctx = self._ctx
        if ctx.iteration <= pre_iteration:
            return
        if any(e.get("iteration") == pre_iteration for e in ctx.iteration_history):
            return
        gaps = summary.get("gaps")
        ctx.iteration_history.append(
            {
                "iteration": pre_iteration,
                "strategy_change": self._norm_text(summary.get("strategy_change", "")),
                "gaps": [self._norm_text(g) for g in (gaps if isinstance(gaps, list) else [])],
                "confidence": summary.get("confidence", ""),
            }
        )

    def _force_exhausted(self, state: str) -> dict:
        """Iteration-budget backstop (honest exhaustion, compliance rule 3): a
        playbook that routes PAST its iteration budget (``ctx.iteration >
        max_iterations`` at a non-terminal state) is terminated as complete with
        ``met = done_predicate(ctx)`` — never a fabricated pass, and never a
        silent loop-past that burns the global step cap. The result payload
        carries ``exhausted`` + the reason."""
        reason = (
            f"iteration budget exceeded (iteration {self._ctx.iteration} > "
            f"max_iterations {self._ctx.max_iterations}) at '{state}' — engine "
            "forced honest exhaustion"
        )
        self._ctx.extras["engine_exhausted"] = reason
        if self.sm.current_state_value != "complete":
            try:
                self.sm.current_state_value = "complete"
            except Exception:  # noqa: BLE001 — fall through; _finish persists complete
                pass
        return self._finish("complete")

    def _retry_malformed(self, state: str, reason: str) -> dict:
        """Format-repair retry — tagged LOAN ``malformed_summary_retry``: bounded
        re-issue when the agent emitted a malformed or missing SUMMARY. Ablated
        (scaffold-OFF), the step fails immediately so ablation runs measure
        whether current models still need the layer. Transport failures
        (non-zero exitCode) retry unconditionally via ``_retry_or_fail`` — that
        is plumbing, not a loan."""
        if not loan_enabled("malformed_summary_retry"):
            return self._to_error(f"step failed (format-repair retry ablated): {reason}")
        return self._retry_or_fail(state, reason)

    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        parts = [spec.task_hint, f"Goal: {self._cap(ctx.goal)}"]
        # Recall (F2): lessons ride ONLY the first directive of the run
        # (total_steps is 0 until the first step() ingests a result) — advisory
        # context for the entry agent, never a rule and never routing input.
        if ctx.recall_lessons and ctx.total_steps == 0:
            parts.append(
                "Lessons from prior runs (advisory — weigh against current evidence; "
                "they never override this run's goal or constraints):"
            )
            parts.extend(f"- {self._cap(lesson)}" for lesson in ctx.recall_lessons)
        parts.extend(self._cap(p) for p in self.task_context_parts(state, ctx))
        if ctx.iteration:
            parts.append(f"(retry iteration {ctx.iteration + 1}/{ctx.max_iterations})")
        if ctx.clarification_text:
            parts.append(self._cap(f"User clarification: {ctx.clarification_text}"))
        return "\n".join(parts)

    @staticmethod
    def _summary_contract_directive(spec: PrimitiveSpec) -> str:
        """Restate the state's SUMMARY contract as an explicit, typed schema, appended
        LAST to the agent task (recency). Tagged LOAN ``summary_schema_restatement``
        (see ``loans.py``): ablated, this returns "" so scaffold-OFF runs measure
        whether current models still need the restatement.

        Weaker (non-Claude) models reliably DROP a structured-output contract buried
        mid-prompt in the skill_context, and when reminded only generically they
        invent their own keys. Restating the EXACT keys + types as the FINAL directive
        fixes both failure modes (validated 2026-07-08; wing=penny ``decisions``
        drawer). The agent still fills values from its work + the richer per-mode
        example in its domain guidance; this only guarantees the key set, the JSON
        shape, and recency.
        """
        if not loan_enabled("summary_schema_restatement"):
            return ""
        if not _needs_summary_restatement():  # #28: strong tier doesn't need the crutch
            return ""
        contract = getattr(spec, "summary_contract", None) or {}
        required = contract.get("required", {}) or {}
        optional = contract.get("optional", {}) or {}
        if not required and not optional:
            return ""
        placeholder = {bool: "<true|false>", int: "<int>", str: "<string>", list: "<[...]>"}

        def _render(fields: dict) -> str:
            return ", ".join(
                f'"{key}": {placeholder.get(typ, "<value>")}' for key, typ in fields.items()
            )

        rendered = [chunk for chunk in (_render(required), _render(optional)) if chunk]
        schema = "{" + ", ".join(rendered) + "}"
        req_keys = ", ".join(required.keys()) or "(none)"
        return (
            "\n\nOUTPUT FORMAT — this is the FINAL and most important directive; obey it exactly.\n"
            "Your response MUST end with ONE line: `SUMMARY:` immediately followed by a single-line "
            "JSON object with these EXACT keys. Replace every `<...>` placeholder with a real value "
            "from your work and output valid JSON (booleans true/false and numbers unquoted, strings "
            f"quoted, arrays in []). Required keys (must be present): {req_keys}. Emit NOTHING after "
            "that line.\n"
            f"SUMMARY:{schema}"
        )

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
        try:
            pspec = self.parallel_spec(state, self._ctx)
        except Exception as exc:
            return self._to_error(f"fan-out spec error at '{state}': {exc}")
        if pspec is not None:
            for b in pspec.branches.values():
                self.obs.step_start(self.ctx, b.name, b.agent, state)
            self._save(STATUS_RUNNING, state)
            return self._directive_for_state(state)
        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        # Graduated-autonomy gate (opt-in, dormant unless PENNY_AUTONOMY_GATE):
        # before taking an action, ask act-vs-ask. ASK → escalate to the human via
        # the existing HITL path. Placed in _advance_to (forward transitions only),
        # NOT _directive_for_state, so recovery re-issues never re-trigger it.
        # ONE-SHOT per state per run (checkpointed in extras): after the human
        # answers the escalation, re-entry proceeds — the trust score is unchanged,
        # so re-asking would loop forever. Human approval overrides the gate once.
        if state in self.AUTONOMY_STATES and state in self.ESCALATABLE_STATES:
            gated = self.ctx.extras.setdefault("autonomy_gated", [])
            if state not in gated:
                gated.append(state)
                ask_reason = _autonomy_ask_reason(self.autonomy_action(state, self.ctx))
                if ask_reason:
                    return self._escalate(
                        state, spec, {"unknown_reason": f"Autonomy: {ask_reason}"}
                    )
        self.obs.step_start(self.ctx, spec.name, spec.agent, state)
        self._save(STATUS_RUNNING, state)
        return self._directive_for_state(state)

    def autonomy_action(self, state: str, ctx: RunContext) -> str:
        """The action text the autonomy gate classifies for ``state``. Default: the
        run's goal (the action being taken). Subclasses may refine per state."""
        return ctx.goal

    def _directive_for_state(self, state: str) -> dict:
        """Pure directive builder (no emission, no checkpoint) — safe for the
        auto-recovery scan to re-issue a pending step. For a parallel state it
        re-issues the whole fan-out (all branches), so a kill-and-resume re-runs
        every branch (branch agents must be idempotent)."""
        sc = self.skill_context(state, self.ctx)
        model = self.model_for_state(state, self.ctx)
        try:
            pspec = self.parallel_spec(state, self._ctx)
        except Exception as exc:
            return self._to_error(f"fan-out spec error at '{state}': {exc}")
        if pspec is not None:
            tasks = []
            for bid, b in pspec.branches.items():
                task = {
                    "branch_id": bid,
                    "agent": b.agent,
                    "task_summary": self._task_summary(state, b, self.ctx)
                    + self._summary_contract_directive(b),
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
            task_summary=self._task_summary(state, spec, self.ctx)
            + self._summary_contract_directive(spec),
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
                return self._retry_malformed(
                    state, f"parallel '{state}': invalid SUMMARY on branch '{bid}': {err}"
                )
            branches[bid] = summary

        missing = set(pspec.branches) - set(branches)
        if missing:
            return self._retry_or_fail(
                state, f"parallel '{state}': missing branches {sorted(missing)}"
            )

        self.ctx.step_retries = 0
        merged_evidence: list[Any] = []
        for s in branches.values():
            ev = s.get("evidence")
            if isinstance(ev, str) and ev.strip():
                merged_evidence.append(ev)
            elif isinstance(ev, (list, tuple)):
                merged_evidence.extend(str(e) for e in ev)
        if merged_evidence:
            self._capture_evidence({"evidence": merged_evidence})
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
        pre_iteration = self._ctx.iteration
        try:
            self.route_after(state, self._ctx, aggregated)
        except Exception as exc:
            return self._to_error(f"routing error at '{state}': {exc}")
        self._auto_record_iteration(pre_iteration, aggregated)
        new_state = self.sm.current_state_value
        self.obs.transition(self.ctx, state, new_state, event="route")
        if new_state in TERMINAL_STATES:
            return self._finish(new_state)
        if self._ctx.iteration > self._ctx.max_iterations:
            return self._force_exhausted(new_state)
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
        exhausted_reason = self._ctx.extras.get("engine_exhausted")
        if exhausted_reason:
            # Honest exhaustion is reported, never dressed as a pass.
            result.setdefault("exhausted", True)
            result.setdefault("exhausted_reason", exhausted_reason)
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
