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

import hashlib
import hmac
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional, cast

from .artifacts import (
    INPUT_ARTIFACTS_SCHEMA_VERSION,
    KIND_AGENT_OUTPUT,
    OUTPUT_ARTIFACT_SCHEMA_VERSION,
    ArtifactEnvelope,
    ArtifactError,
    ArtifactRef,
    ArtifactStore,
    ArtifactValidationError,
    InputArtifactBinding,
    InputArtifactsV1,
    OutputArtifactMetadata,
    ResultProtocolV2,
    canonical_json,
)
from .checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_RUNNING,
    Checkpointer,
)
from .contracts import (
    Confidence,
    Directives,
    artifact_dispatch_control,
    validate_summary_contract,
    weakest_confidence,
)
from .context import RunContext
from .execution_receipts import (
    receipt_signing_key,
    sign_receipt,
    validate_execution_receipt,
)
from .loans import loan_enabled
from .paths import skill_root
from .primitives.spec import ParallelSpec, PrimitiveSpec, parallel_spec_from_dict

TERMINAL_STATES: frozenset[str] = frozenset({"complete", "error"})
# States/events that route control but never receive artifact payload grants.
_ARTIFACT_CONTROL_STATES: frozenset[str] = frozenset(
    {"intake", "unknown", "awaiting_clarification", "error"}
)
_DEFAULT_STEP_CAP = 50
_ARTIFACT_CONTEXT_KEY = "artifact_protocol"
_ARTIFACT_CONTEXT_SCHEMA_VERSION = 2
_PROGRAMMATIC_RESULT_ENV = "PENNY_ORCH_TEST_ALLOW_PROGRAMMATIC_RESULTS"
_AGENT_OUTPUT_MEDIA_TYPE = "text/markdown; charset=utf-8"
_TRUSTED_INVOCATION_KEYS = frozenset(
    {
        "schema_version",
        "invocation_id",
        "run_id",
        "state_id",
        "agent_identity",
        "model",
        "execution_owner_identity",
        "started_at",
        "ended_at",
        "signature_algorithm",
        "signature",
    }
)


def _has_valid_owner_signature(value: dict[str, Any]) -> bool:
    key = receipt_signing_key()
    signature = value.get("signature")
    return bool(
        key is not None
        and isinstance(signature, str)
        and len(signature) == 64
        and hmac.compare_digest(signature, sign_receipt(value, key))
    )


def _missing_invocation_field(value: dict[str, Any]) -> str | None:
    for field in (
        "invocation_id",
        "model",
        "execution_owner_identity",
        "started_at",
        "ended_at",
    ):
        if not isinstance(value.get(field), str) or not value[field]:
            return field
    return None


def _ordered_invocation_timestamps(value: dict[str, Any]) -> bool:
    started_at = value.get("started_at")
    ended_at = value.get("ended_at")
    if not isinstance(started_at, str) or not isinstance(ended_at, str):
        return False
    try:
        started = datetime.fromisoformat(started_at)
        ended = datetime.fromisoformat(ended_at)
    except ValueError:
        return False
    return bool(started.tzinfo is not None and ended.tzinfo is not None and ended >= started)


def _artifact_receipt_id(metadata: OutputArtifactMetadata) -> str:
    identity = {
        "branch_id": metadata.branch_id,
        "kind": metadata.kind,
        "operation_id": metadata.operation_id,
        "phase": metadata.phase,
        "run_id": metadata.run_id,
        "version": metadata.version,
    }
    return f"artifact-receipt:{hashlib.sha256(canonical_json(identity)).hexdigest()}"


def _extract_artifact_summary(content: bytes) -> dict[str, Any]:
    """Parse the final exact ``SUMMARY:{...}`` line from owner-captured bytes."""
    try:
        output = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ArtifactValidationError("agent output artifact is not valid UTF-8") from exc
    marker = "SUMMARY:"
    position = output.rfind(marker)
    if position < 0:
        raise ArtifactValidationError("agent output artifact has no SUMMARY marker")
    raw = output[position + len(marker) :].lstrip()
    try:
        parsed, end = json.JSONDecoder().raw_decode(raw)
    except json.JSONDecodeError as exc:
        raise ArtifactValidationError("agent output artifact SUMMARY is invalid JSON") from exc
    if raw[end:].strip():
        raise ArtifactValidationError("agent output artifact has content after SUMMARY")
    if not isinstance(parsed, dict):
        raise ArtifactValidationError("agent output artifact SUMMARY must be an object")
    return dict(parsed)


def _validate_trusted_invocation(
    value: Any, *, run_id: str, state_id: str, agent: str
) -> tuple[dict[str, Any] | None, str]:
    """Validate driver-owned invocation provenance carried beside agent output."""
    if not isinstance(value, dict) or frozenset(value) != _TRUSTED_INVOCATION_KEYS:
        return (
            None,
            "trusted invocation provenance has missing, unknown, or stale fields",
        )
    if value.get("schema_version") != 1:
        return None, "trusted invocation provenance schema version is unsupported"
    if value.get("run_id") != run_id or value.get("state_id") != state_id:
        return None, "trusted invocation provenance is bound to the wrong run or state"
    if value.get("agent_identity") != f"agent:{agent}":
        return None, "trusted invocation provenance is bound to the wrong agent"
    if value.get("signature_algorithm") != "hmac-sha256":
        return None, "trusted invocation provenance signature algorithm is unsupported"
    if not _has_valid_owner_signature(value):
        return None, "trusted invocation provenance signature is missing or invalid"
    missing_field = _missing_invocation_field(value)
    if missing_field is not None:
        return None, f"trusted invocation provenance {missing_field} must be non-empty"
    if not _ordered_invocation_timestamps(value):
        return None, "trusted invocation provenance timestamps are missing or reordered"
    return dict(value), ""


# ── #33: shared HITL gate-answer intent classifier ───────────────────────────
# Gate parsing keyword-matched the user's answer to approve/deny/refine; free text
# ("yep, ship it", "kill it") fell outside the sets and silently became a refine on
# the SAFETY seam. classify_gate_intent keeps the exact keyword fast-path (option
# clicks route unchanged) and, when PI_GATE_INTENT_MODEL is set, has a model read
# genuinely free-text answers. Approval requires model confidence; any ambiguity or
# failure yields "refine" (re-ask), so the seam never silently approves or denies.
_GATE_INTENT_MODEL_ENV = "PI_GATE_INTENT_MODEL"
_GATE_APPROVE = frozenset(
    {
        "approve",
        "approved",
        "confirm",
        "confirmed",
        "proceed",
        "yes",
        "y",
        "accept",
        "accepted",
        "ok",
        "okay",
        "skip",
    }
)
_GATE_DENY = frozenset(
    {
        "deny",
        "denied",
        "no",
        "n",
        "abort",
        "cancel",
        "discard",
        "stop",
        "reject",
        "rejected",
    }
)
# #26/#27: model-judged loop guards (gated; the string checks stay as the fallback).
_STALL_MODEL_ENV = "PI_STALL_MODEL"
_STRATEGY_MODEL_ENV = "PI_STRATEGY_MODEL"

# Spend COMPUTE before spending HUMAN ATTENTION on an UNCERTAIN confidence.
#
# The engine's only answer to uncertainty was to stop and ask a person. Human
# attention is the one resource that does not scale with compute, and an agent that
# honestly reports UNCERTAIN is the one being punished with an interrupt — a tax on
# exactly the calibration the system depends on. One bounded re-attempt, with the
# uncertainty named, converts many of those interrupts into compute.
#
# DORMANT by default (opt-in via the env var), so it can never change an existing
# deployment's behaviour until someone turns it on.
#
# DELIBERATELY NARROW. It fires ONLY on an UNCERTAIN confidence. It never touches:
#   * ``needs_clarification`` — a genuine question only the user can answer;
#   * planned GATE_STATES — human approval seams (safety, not capability);
#   * ``progress_check`` stalls — the run is stuck, so re-running it is the one thing
#     already known not to work;
# Uncertainty is not the same thing as high stakes; only the latter warrants a human.
_UNCERTAINTY_RETRY_ENV = "PENNY_UNCERTAINTY_RETRY"


def _load_detect() -> Callable[..., dict[str, Any]] | None:
    """Lazy-import the shared detect() primitive (scripts/system/lib, #8), or None."""
    try:
        for parent in Path(__file__).resolve().parents:
            lib = parent / "scripts" / "system" / "lib"
            if lib.is_dir():
                if str(lib) not in sys.path:
                    sys.path.insert(0, str(lib))
                from detect import detect as _detect

                return cast(Callable[..., dict[str, Any]], _detect)
    except Exception:
        return None
    return None


def _needs_summary_restatement() -> bool:
    """#28: the SUMMARY-restatement directive is a crutch for weaker models that drop a
    mid-prompt output contract. A capability-tier deployment declares its models don't
    need it via ``PI_MODEL_TIER=strong`` — strong models stop paying for it; any other
    value (the default) keeps the restatement, the safe fallback."""
    return os.environ.get("PI_MODEL_TIER", "").strip().lower() != "strong"


_TIER_BUDGET_FACTOR = {"strong": 2.0, "cheap": 0.5}


def tier_budget(base: int, *, ceiling: int) -> int:
    """(#25) Scale an operating-point BUDGET by the model's capability tier (PI_MODEL_TIER),
    bounded by a hard ceiling. A strong/long-context model does more per wave / fans wider;
    a cheap one does less. Unset (the default) => ``base`` unchanged. The result is clamped
    to [1, ceiling] — the constant stays a safety MAX, only the operating point is adaptive;
    an explicit caller constraint still overrides this upstream."""
    tier = os.environ.get("PI_MODEL_TIER", "").strip().lower()
    factor = _TIER_BUDGET_FACTOR.get(tier, 1.0)
    return max(1, min(int(ceiling), round(base * factor)))


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
    machine_cls: type[Any]  # a statemachine.StateMachine subclass
    PRIMITIVE_BY_STATE: dict[str, PrimitiveSpec] = {}
    PARALLEL_BY_STATE: dict[str, ParallelSpec] = {}  # fan-out states
    TOOL_STATES: frozenset[str] = frozenset()  # deterministic in-process states (no agent)
    GATE_STATES: frozenset[str] = frozenset()  # planned HITL pause states
    ESCALATABLE_STATES: frozenset[str] = frozenset()
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

    def artifact_input_phases(self, ctx: RunContext) -> dict[str, tuple[str, ...]]:
        """Declare retained artifact phases consumed by later states.

        Direct FSM successors and same-state retry/fan-in consumers are derived
        by the engine. A playbook uses this seam only when a later state must
        inspect selected artifacts older than the immediately preceding output.
        The engine validates every declared producer and consumer against the
        actual FSM graph and fails closed on unknown or unreachable pairs.
        """
        return {}

    def result_payload(self, ctx: RunContext) -> dict:
        """The structured terminal result. Subclasses add their domain fields."""
        return {"met": ctx.met, "iterations": ctx.iteration}

    def terminal_directive(self, result: dict[str, Any]) -> dict[str, Any]:
        """Build the public terminal directive.

        The compatibility default retains the historic ``complete`` action even
        for an honest met=False exhaustion. Security-sensitive playbooks may
        override this to emit ``incomplete`` so no public complete signal exists.
        """
        return Directives.complete(
            result=result, session_id=self._ctx.session_id, run_id=self._ctx.run_id
        )

    def skill_context(self, state: str, ctx: RunContext) -> str | None:
        """Skill-relative path to the domain-guidance prompt for this state's
        agent (e.g. ``"assets/prompts/echo-charter.md"``). Emitted as
        ``skillContext`` on the invoke_agent directive; the TS driver resolves it
        against the skill dir and injects it as ``<skill_context>``. Default
        ``None`` -> the driver falls back to ``assets/prompts/{agent}.md``. Useful
        when states map to distinct per-state prompt files."""
        return None

    def model_for_state(self, state: str, ctx: RunContext) -> str | None:
        """Optional per-state model override.

        Emitted as ``model`` on the invoke-agent directive; the TypeScript driver
        honors it. Default ``None`` uses the agent's configured model.
        """
        return None

    @staticmethod
    def _is_valid_provider_model(value: str) -> bool:
        """True iff ``value`` is a well-formed ``provider/model`` override: a
        non-empty provider before the FIRST ``/``, a non-empty model after it,
        and no whitespace. Anything else is treated as invalid so the caller
        falls back (an unset var or a typo never breaks a run)."""
        if not value or any(c.isspace() for c in value):
            return False
        provider, sep, model = value.partition("/")
        return bool(sep) and bool(provider) and bool(model)

    def _env_model_override(self, skill_prefix: str, state: str) -> str | None:
        """Per-skill/per-agent model+provider override read from the environment.

        Value format is ``provider/model`` (e.g. ``ollama/glm``); the agent-runner
        splits it so the explicit provider WINS over the agent's frontmatter
        ``provider:``. Resolution precedence for ``state``'s agent:
        ``{SKILL}_{AGENT}`` -> ``{SKILL}_DEFAULT`` -> ``None`` (the agent's own
        model+provider from ``.pi/agents/<agent>.md``). A value that is unset OR
        not a valid ``provider/model`` pair falls through to the next tier, so a
        typo can never break a run.
        """
        by_state = getattr(self, "PRIMITIVE_BY_STATE", {}) or {}
        spec = by_state.get(state)
        agent = getattr(spec, "agent", None)
        keys: list[str] = []
        if agent:
            keys.append(f"{skill_prefix}_{str(agent).upper()}")
        keys.append(f"{skill_prefix}_DEFAULT")
        for key in keys:
            raw = os.environ.get(key, "").strip()
            if self._is_valid_provider_model(raw):
                return raw
        return None

    def prepare_recovery(self, ctx: RunContext) -> bool:
        """Apply the additive artifact-checkpoint v2 migration on recovery."""
        existed = _ARTIFACT_CONTEXT_KEY in ctx.extras
        self._artifact_state(ctx)
        return not existed

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
    def classify_gate_intent(  # noqa: C901 - explicit fail-closed gate grammar
        answer: Any, *, runner: Optional[Callable] = None
    ) -> str:
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
                model_spec=spec,
                labels=("approve", "deny", "refine"),
                runner=runner,
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
        self,
        ctx: RunContext,
        strategy_change: Any,
        *,
        runner: Optional[Callable] = None,
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
        self,
        ctx: RunContext,
        gaps: list | None = None,
        *,
        window: int = 2,
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

    def _stall_via_model(
        self,
        ctx: RunContext,
        gaps: list[Any],
        window: int,
        spec: str,
        *,
        runner: Optional[Callable[..., Any]] = None,
    ) -> bool | None:
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
                model_spec=spec,
                labels=("stalled", "progressing"),
                runner=runner,
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

    def _strategy_same_via_model(
        self,
        proposed: str,
        prior: str,
        spec: str,
        *,
        runner: Optional[Callable[..., Any]] = None,
    ) -> bool | None:
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
                model_spec=spec,
                labels=("same", "different"),
                runner=runner,
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
        self,
        checkpointer: Checkpointer,
        obs: Any = None,
        max_step_retries: int = 2,
        *,
        allow_programmatic_results: bool | None = None,
    ) -> None:
        self.cp = checkpointer
        self.obs = obs if obs is not None else _NullObs()
        self.max_step_retries = max_step_retries
        self.allow_programmatic_results = (
            bool(os.environ.get(_PROGRAMMATIC_RESULT_ENV))
            if allow_programmatic_results is None
            else allow_programmatic_results
        )
        self._context: RunContext | None = None
        self._artifact_store_instance: ArtifactStore | None = None
        self.sm: Any = None

    @property
    def ctx(self) -> RunContext:
        """Return the active context or fail on engine protocol misuse."""
        if self._context is None:  # pragma: no cover — engine misuse
            raise RuntimeError("engine used before start()/step() set the run context")
        return self._context

    @ctx.setter
    def ctx(self, value: RunContext) -> None:
        self._context = value

    @property
    def _ctx(self) -> RunContext:
        """Compatibility alias for call sites that explicitly request narrowing."""
        return self.ctx

    @staticmethod
    def _selection_key(value: ArtifactRef | OutputArtifactMetadata) -> tuple[str, str, str]:
        return (value.phase, value.branch_id or "", value.kind)

    def _artifact_state(  # noqa: C901 - strict checkpoint migration/validation
        self, ctx: RunContext | None = None
    ) -> dict[str, Any]:
        """Return strict checkpoint metadata; v1 contexts migrate additively to v2."""
        active = ctx or self.ctx
        raw = active.extras.get(_ARTIFACT_CONTEXT_KEY)
        if raw is None:
            raw = {
                "schema_version": _ARTIFACT_CONTEXT_SCHEMA_VERSION,
                "selected_refs": [],
                "state_inputs": {},
                "parallel_fan_in": {},
            }
            active.extras[_ARTIFACT_CONTEXT_KEY] = raw
        if not isinstance(raw, dict):
            raise ArtifactValidationError("artifact checkpoint state must be an object")
        expected_fields = {
            "schema_version",
            "selected_refs",
            "state_inputs",
            "parallel_fan_in",
        }
        if set(raw) != expected_fields:
            raise ArtifactValidationError(
                "artifact checkpoint state has missing, unknown, or stale fields"
            )
        if type(raw["schema_version"]) is not int or raw["schema_version"] != 2:
            raise ArtifactValidationError(
                f"unsupported artifact checkpoint schema version: {raw['schema_version']}"
            )

        selected_values = raw["selected_refs"]
        state_inputs = raw["state_inputs"]
        fan_in = raw["parallel_fan_in"]
        if not isinstance(selected_values, list):
            raise ArtifactValidationError("artifact checkpoint selected_refs must be an array")
        if not isinstance(state_inputs, dict) or not isinstance(fan_in, dict):
            raise ArtifactValidationError("artifact checkpoint maps must be objects")

        selected = [ArtifactRef.from_dict(value) for value in selected_values]
        if any(ref.run_id != active.run_id for ref in selected):
            raise ArtifactValidationError("selected artifact ref is bound to a different run")
        if len({self._selection_key(ref) for ref in selected}) != len(selected):
            raise ArtifactValidationError("selected artifact refs contain duplicate selection keys")

        for state, values in state_inputs.items():
            if not isinstance(state, str) or not state or not isinstance(values, list):
                raise ArtifactValidationError("artifact state_inputs entries are malformed")
            refs = [ArtifactRef.from_dict(value) for value in values]
            if any(ref.run_id != active.run_id for ref in refs):
                raise ArtifactValidationError("artifact state input is bound to a different run")
            if len({ref.artifact_id for ref in refs}) != len(refs):
                raise ArtifactValidationError("artifact state inputs contain duplicate refs")

        for state, branches in fan_in.items():
            if not isinstance(state, str) or not state or not isinstance(branches, dict):
                raise ArtifactValidationError("parallel artifact fan-in is malformed")
            for branch_id, value in branches.items():
                if not isinstance(branch_id, str) or not branch_id:
                    raise ArtifactValidationError("parallel artifact branch_id is malformed")
                ref = ArtifactRef.from_dict(value)
                if ref.run_id != active.run_id or ref.phase != state or ref.branch_id != branch_id:
                    raise ArtifactValidationError("parallel artifact fan-in ref identity is stale")
        return raw

    @property
    def _artifact_store(self) -> ArtifactStore:
        if self._artifact_store_instance is None:
            self._artifact_store_instance = ArtifactStore()
        return self._artifact_store_instance

    def _selected_ref(
        self, state: str, branch_id: str | None, kind: str = KIND_AGENT_OUTPUT
    ) -> ArtifactRef | None:
        key = (state, branch_id or "", kind)
        for value in self._artifact_state()["selected_refs"]:
            ref = ArtifactRef.from_dict(value)
            if self._selection_key(ref) == key:
                return ref
        return None

    def _set_selected_ref(self, ref: ArtifactRef) -> None:
        artifact_state = self._artifact_state()
        values = [ArtifactRef.from_dict(value) for value in artifact_state["selected_refs"]]
        values = [
            value for value in values if self._selection_key(value) != self._selection_key(ref)
        ]
        values.append(ref)
        values.sort(key=self._selection_key)
        artifact_state["selected_refs"] = [value.to_dict() for value in values]

    def _state_input_refs(self, state: str) -> tuple[ArtifactRef, ...]:
        values = self._artifact_state()["state_inputs"].get(state, [])
        return tuple(ArtifactRef.from_dict(value) for value in values)

    def _machine_state_ids(self) -> frozenset[str]:
        try:
            return frozenset(str(state.id) for state in self.sm.states)
        except Exception as exc:  # pragma: no cover - invalid machine implementation
            raise ArtifactValidationError("artifact scope cannot inspect FSM states") from exc

    def _artifact_transition_graph(self) -> dict[str, frozenset[str]]:
        """Return domain transitions only; control/error edges never grant bytes."""
        graph: dict[str, set[str]] = {state: set() for state in self._machine_state_ids()}
        try:
            for source in self.sm.states:
                source_id = str(source.id)
                for transition in source.transitions:
                    event = str(transition.event)
                    target_id = str(transition.target.id)
                    if event in self.RESERVED_EVENTS or target_id in _ARTIFACT_CONTROL_STATES:
                        continue
                    graph[source_id].add(target_id)
        except Exception as exc:  # pragma: no cover - invalid machine implementation
            raise ArtifactValidationError("artifact scope cannot inspect FSM transitions") from exc
        return {state: frozenset(targets) for state, targets in graph.items()}

    @staticmethod
    def _artifact_reachable(graph: dict[str, frozenset[str]], producer: str, consumer: str) -> bool:
        if producer == consumer:
            return True
        pending = list(graph.get(producer, ()))
        visited: set[str] = set()
        while pending:
            state = pending.pop()
            if state == consumer:
                return True
            if state in visited:
                continue
            visited.add(state)
            pending.extend(graph.get(state, ()))
        return False

    def _validated_artifact_input_phases(  # noqa: C901 - explicit fail-closed seam validation
        self,
    ) -> dict[str, tuple[str, ...]]:
        """Validate the explicit retained-input seam against this machine."""
        declared = self.artifact_input_phases(self.ctx)
        if not isinstance(declared, dict):
            raise ArtifactValidationError("artifact_input_phases must return a mapping")
        state_ids = self._machine_state_ids()
        graph = self._artifact_transition_graph()
        validated: dict[str, tuple[str, ...]] = {}
        for consumer, phases in declared.items():
            if not isinstance(consumer, str) or consumer not in state_ids:
                raise ArtifactValidationError(
                    "artifact_input_phases contains an unknown consumer state"
                )
            if consumer in _ARTIFACT_CONTROL_STATES:
                raise ArtifactValidationError(
                    "artifact_input_phases cannot grant a control consumer state"
                )
            if not isinstance(phases, tuple):
                raise ArtifactValidationError(
                    "artifact_input_phases values must be immutable tuples"
                )
            if len(phases) != len(set(phases)):
                raise ArtifactValidationError(
                    "artifact_input_phases must not contain duplicate producer phases"
                )
            for producer in phases:
                if not isinstance(producer, str) or producer not in state_ids:
                    raise ArtifactValidationError(
                        "artifact_input_phases contains an unknown producer state"
                    )
                if producer in _ARTIFACT_CONTROL_STATES or producer == "complete":
                    raise ArtifactValidationError(
                        "artifact_input_phases contains a non-producing phase"
                    )
                if not self._artifact_reachable(graph, producer, consumer):
                    raise ArtifactValidationError(
                        f"artifact phase '{producer}' cannot legally reach consumer '{consumer}'"
                    )
            validated[consumer] = phases
        return validated

    def _set_state_inputs(self, state: str, refs: tuple[ArtifactRef, ...]) -> None:
        declared = self._validated_artifact_input_phases()
        retained_phases = declared.get(state, ())
        retained: tuple[ArtifactRef, ...] = ()
        if retained_phases:
            selected = [
                ArtifactRef.from_dict(value) for value in self._artifact_state()["selected_refs"]
            ]
            retained = tuple(
                ref for phase in retained_phases for ref in selected if ref.phase == phase
            )
        unique: dict[str, ArtifactRef] = {ref.artifact_id: ref for ref in (*retained, *refs)}
        self._artifact_state()["state_inputs"][state] = [ref.to_dict() for ref in unique.values()]

    def _consumer_scope(self, state: str) -> tuple[str, ...]:
        """Bind output to truthful retry/fan-in, FSM-successor, and retained consumers."""
        graph = self._artifact_transition_graph()
        if state not in graph or state in _ARTIFACT_CONTROL_STATES or state == "complete":
            raise ArtifactValidationError(f"artifact producer state '{state}' is not legal")

        # The producing state is a legal immediate consumer only for a bounded
        # retry or parallel fan-in. Domain successors come from the real FSM;
        # unknown/clarification/error control edges were removed above.
        consumers = {state, *graph[state]}
        for consumer, phases in self._validated_artifact_input_phases().items():
            if state in phases:
                consumers.add(consumer)
        return tuple(sorted(f"state:{consumer}" for consumer in consumers))

    def _operation_id(self, state: str, branch_id: str | None) -> str:
        identity = {
            "branch_id": branch_id,
            "kind": KIND_AGENT_OUTPUT,
            "run_id": self.ctx.run_id,
            "state": state,
        }
        digest = hashlib.sha256(canonical_json(identity)).hexdigest()
        return f"agent-operation:{digest}"

    def _output_metadata(
        self, state: str, agent: str, branch_id: str | None
    ) -> OutputArtifactMetadata:
        selected = self._selected_ref(state, branch_id)
        operation_id = self._operation_id(state, branch_id)
        if selected is not None and selected.operation_id != operation_id:
            raise ArtifactValidationError("selected artifact operation identity is stale")
        return OutputArtifactMetadata(
            schema_version=OUTPUT_ARTIFACT_SCHEMA_VERSION,
            run_id=self.ctx.run_id,
            phase=state,
            branch_id=branch_id,
            kind=KIND_AGENT_OUTPUT,
            operation_id=operation_id,
            version=(selected.version + 1) if selected else 1,
            producer=f"agent:{agent}",
            consumer_scope=self._consumer_scope(state),
            media_type=_AGENT_OUTPUT_MEDIA_TYPE,
            parent_ref=selected,
            upstream_refs=self._state_input_refs(state),
        )

    def _input_artifacts(self, state: str) -> InputArtifactsV1:
        refs = self._state_input_refs(state)
        return InputArtifactsV1(
            schema_version=INPUT_ARTIFACTS_SCHEMA_VERSION,
            run_id=self.ctx.run_id,
            consumer=f"state:{state}",
            artifacts=tuple(
                InputArtifactBinding(slot=f"upstream-{index:04d}", ref=ref)
                for index, ref in enumerate(refs)
            ),
        )

    def _accept_protocol_result(  # noqa: C901 - trust, receipt, store, and CAS checks
        self,
        *,
        state: str,
        agent: str,
        expected: OutputArtifactMetadata,
        wrapper: ResultProtocolV2,
    ) -> tuple[ArtifactRef, dict[str, Any]]:
        """Validate, CAS-select, and checkpoint one real execution-owner output."""
        ref = wrapper.output_artifact_ref
        expected_identity = (
            expected.run_id,
            expected.phase,
            expected.branch_id,
            expected.kind,
            expected.operation_id,
            expected.version,
            expected.producer,
            expected.consumer_scope,
            expected.media_type,
        )
        actual_identity = (
            ref.run_id,
            ref.phase,
            ref.branch_id,
            ref.kind,
            ref.operation_id,
            ref.version,
            ref.producer,
            ref.consumer_scope,
            ref.media_type,
        )
        if actual_identity != expected_identity:
            raise ArtifactValidationError("output artifact ref does not match its directive")

        invocation, invocation_error = _validate_trusted_invocation(
            wrapper.trusted_invocation,
            run_id=self.ctx.run_id,
            state_id=state,
            agent=agent,
        )
        if invocation is None:
            raise ArtifactValidationError(invocation_error)
        if wrapper.exit_code != 0:
            raise ArtifactValidationError(wrapper.error or f"agent '{agent}' failed")

        key = receipt_signing_key()
        valid_receipt, receipt_error = validate_execution_receipt(
            wrapper.execution_receipt,
            run_id=self.ctx.run_id,
            obligation_id=f"state:{state}",
            key=key,
            allowed_working_root=self.ctx.project_root or None,
        )
        if not valid_receipt:
            raise ArtifactValidationError(receipt_error)
        receipt = wrapper.execution_receipt
        canonical_ref = canonical_json(ref.to_dict()).decode("utf-8")
        expected_receipt_id = _artifact_receipt_id(expected)
        if receipt.get("output_artifact_ref") != canonical_ref:
            raise ArtifactValidationError("execution receipt is not bound to the canonical ref")
        if receipt.get("receipt_id") != expected_receipt_id:
            raise ArtifactValidationError("execution receipt identity does not match the operation")
        if receipt.get("state_id") != state:
            raise ArtifactValidationError("execution receipt is bound to the wrong state")
        if receipt.get("argv") != ["pi-agent", "--agent", agent]:
            raise ArtifactValidationError("execution receipt argv does not match the agent")
        if receipt.get("executor_identity") != f"agent:{agent}":
            raise ArtifactValidationError("execution receipt executor does not match the agent")
        if receipt.get("execution_owner_identity") != "skill-extension-execution-owner":
            raise ArtifactValidationError("execution receipt owner identity is unsupported")
        if invocation.get("invocation_id") != expected_receipt_id:
            raise ArtifactValidationError("trusted invocation identity does not match the receipt")
        if invocation.get("execution_owner_identity") != receipt.get("execution_owner_identity"):
            raise ArtifactValidationError("trusted invocation and receipt owners differ")
        if invocation.get("started_at") != receipt.get("started_at") or invocation.get(
            "ended_at"
        ) != receipt.get("ended_at"):
            raise ArtifactValidationError("trusted invocation and receipt timestamps differ")

        envelope: ArtifactEnvelope = self._artifact_store.validate(
            ref,
            expected_run_id=self.ctx.run_id,
            expected_phase=state,
            expected_branch_id=expected.branch_id,
            expected_producer=f"agent:{agent}",
        )
        if (
            envelope.ref != ref
            or envelope.parent_ref != expected.parent_ref
            or envelope.upstream_refs != expected.upstream_refs
            or envelope.consumer_scope != expected.consumer_scope
            or envelope.media_type != expected.media_type
        ):
            raise ArtifactValidationError(
                "stored artifact envelope violates the directive contract"
            )

        self._artifact_store.select(ref, expected=expected.parent_ref)
        self._set_selected_ref(ref)
        invocation_key = state if expected.branch_id is None else f"{state}:{expected.branch_id}"
        self.ctx.extras.setdefault("trusted_invocations", {})[invocation_key] = invocation
        # Load-bearing ordering: exact selected ref is durable in the FSM checkpoint
        # before model SUMMARY data can route, escalate, or trigger a retry.
        self._save(STATUS_RUNNING, state)

        content = self._artifact_store.read_bytes(
            ref,
            expected_run_id=self.ctx.run_id,
            expected_phase=state,
            expected_branch_id=expected.branch_id,
            expected_producer=f"agent:{agent}",
            require_selected=True,
        )
        captured_summary = {} if wrapper.summary_missing else _extract_artifact_summary(content)
        if captured_summary != wrapper.summary:
            raise ArtifactValidationError(
                "driver summary does not match the exact owner-captured artifact"
            )
        return ref, captured_summary

    def _artifact_protocol_failure(self, state: str, exc: ArtifactError) -> dict:
        message = str(exc)
        if "unsupported" in message or "compare-and-swap" in message or "stale" in message:
            return self._to_error(f"artifact protocol failure at '{state}': {message}")
        return self._retry_or_fail(state, f"artifact protocol failure: {message}")

    def _parallel_fan_in(self, state: str) -> dict[str, dict[str, object]]:
        fan_in = self._artifact_state()["parallel_fan_in"]
        value = fan_in.setdefault(state, {})
        if not isinstance(value, dict):  # validated above; narrows for type checkers
            raise ArtifactValidationError("parallel artifact fan-in is malformed")
        return value

    def _clear_parallel_progress(self, state: str) -> None:
        self._artifact_state()["parallel_fan_in"].pop(state, None)

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
        self._artifact_state(ctx)
        # NOTE: agent directives are built from the playbook's own run facts ONLY.
        # Nothing is retrieved from MemPalace and injected here. A former run-start
        # "recall" step seeded the first directive with whatever a MemPalace query
        # returned, which put unreviewed stored text into agent prompts through a
        # path with no approval gate on it. Agent context comes from
        # .pi/agents/<agent>.md plus skill orchestration. Do not reintroduce.
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
        paused = self._dispatch_pause_directive(
            state=rec.current_state_id,
            run_status=rec.status,
            session_id=rec.session_id,
            run_id=rec.run_id,
        )
        if paused is not None:
            # Ignore even a well-formed owner result while paused. In particular,
            # do not validate/select its artifact, advance counters, route the FSM,
            # or rewrite the checkpoint. A later fresh-process recover rebuilds the
            # pending directive from the unchanged record.
            return paused
        self.ctx = rec.context
        self.sm = self.machine_cls()
        try:
            self.sm.current_state_value = rec.current_state_id
        except Exception as exc:
            return self._plain_error(
                session_id,
                run_id,
                f"cannot rehydrate state '{rec.current_state_id}': {exc}",
            )
        state = rec.current_state_id
        try:
            self._artifact_state()
        except ArtifactError as exc:
            return self._to_error(f"artifact checkpoint validation failed: {exc}")

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

        selected_output: ArtifactRef | None = None
        owner_fields = {
            "protocol_version",
            "output_artifact_ref",
            "execution_receipt",
            "trusted_invocation",
        }
        is_owner_result = isinstance(result, dict) and bool(owner_fields & set(result))
        if is_owner_result:
            try:
                wrapper = ResultProtocolV2.from_dict(result)
                expected = self._output_metadata(state, agent, None)
                selected_output, summary = self._accept_protocol_result(
                    state=state,
                    agent=agent,
                    expected=expected,
                    wrapper=wrapper,
                )
            except ArtifactError as exc:
                return self._artifact_protocol_failure(state, exc)
            if wrapper.summary_missing:
                return self._retry_malformed(state, wrapper.error or "no parseable SUMMARY emitted")
            # Receipts are validated owner transport, not model SUMMARY data. Keep
            # their output excerpts out of RunContext/checkpoints.
        elif self.allow_programmatic_results:
            # Explicit test/programmatic compatibility only. The production CLI
            # never sets PENNY_ORCH_TEST_ALLOW_PROGRAMMATIC_RESULTS.
            if (
                isinstance(result, dict)
                and {"exitCode", "summary", "summary_missing"} <= result.keys()
            ):
                if result.get("exitCode", 0) not in (0, None):
                    return self._retry_or_fail(
                        state, result.get("error") or f"agent '{agent}' failed"
                    )
                if result.get("summary_missing"):
                    return self._retry_malformed(
                        state, result.get("error") or "no parseable SUMMARY emitted"
                    )
                inner = result.get("summary")
                summary = dict(inner) if isinstance(inner, dict) else {}
            else:
                summary = result if isinstance(result, dict) else {}
        else:
            return self._retry_or_fail(state, "result-protocol-v2 owner wrapper is required")
        ok, err = validate_summary_contract(spec.name, spec.summary_contract, summary)
        if not ok:
            # Transient: a malformed SUMMARY is retried (bounded) before failing.
            return self._retry_malformed(state, f"invalid SUMMARY: {err}")

        # A well-formed SUMMARY: retry budget resets.
        self.ctx.step_retries = 0
        self._capture_evidence(summary)
        confidence = summary.get("confidence", "")

        # Escalation: UNCERTAIN on an escalatable state -> single HITL path, unless a
        # bounded compute retry is available (opt-in; see _UNCERTAINTY_RETRY_ENV).
        if Confidence.is_uncertain(confidence) and state in self.ESCALATABLE_STATES:
            retry = self._maybe_retry_uncertain(state, summary)
            if retry is not None:
                return retry
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
        if selected_output is not None:
            self._set_state_inputs(new_state, (selected_output,))
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
    @staticmethod
    def _dispatch_pause_directive(
        *,
        state: str,
        run_status: str,
        session_id: str,
        run_id: str,
    ) -> dict[str, Any] | None:
        """Return a typed non-terminal pause, or ``None`` when dispatch is active."""
        control = artifact_dispatch_control()
        if control.dispatch_allowed:
            return None
        return Directives.paused(
            state_id=state,
            run_status=run_status,
            session_id=session_id,
            run_id=run_id,
            control=control,
        )

    def _save(self, status: str, state_id: str) -> None:
        self.cp.save(
            run_id=self.ctx.run_id,
            session_id=self.ctx.session_id,
            playbook=self.NAME,
            current_state_id=state_id,
            context=self.ctx,
            status=status,
        )

    # NOTE: the former ``_cap`` helper (LOAN ``task_digest_cap``) is DELETED. It bounded
    # every value embedded in an agent task message at 600 chars "so directives stay
    # digests", justified by "full data lives in MemPalace". That premise was false for
    # the most important value it truncated: ``ctx.goal``. A 1,967-char goal reached the
    # agent as 613 chars — 69% of the specification discarded, silently, with no way for
    # the agent to recover it. Agents must receive their FULL input; a fixed character
    # threshold was scaffolding for smaller-context models and is not reintroduced.
    # Guarded by tests/test_no_truncation.py.

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
        """Stash a SUMMARY's non-empty ``evidence`` field on the context (last-write-wins)
        so a run records outcome+evidence, not outcome alone.

        Captured VERBATIM and COMPLETE. This previously kept only the first 5 items,
        each clipped to 300 chars — which discarded exactly the captured tool output
        (schema-check results, counts, test transcripts) that makes a verdict auditable,
        and starved the learning loop of the detail it needs to distil anything useful.
        """
        ev = summary.get("evidence")
        if isinstance(ev, str):
            ev = [ev] if ev.strip() else []
        if isinstance(ev, (list, tuple)) and len(ev) > 0:
            self._ctx.verify_evidence = [str(e) for e in ev]

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
        parts = [spec.task_hint, f"Goal: {ctx.goal}"]
        # No retrieved-memory injection here (see start()): a directive carries this
        # run's facts, never distilled content from prior runs.
        parts.extend(p for p in self.task_context_parts(state, ctx))
        if ctx.iteration:
            parts.append(f"(retry iteration {ctx.iteration + 1}/{ctx.max_iterations})")
        if ctx.clarification_text:
            parts.append(f"User clarification: {ctx.clarification_text}")
        return "\n".join(parts)

    def _skill_root_line(self, ctx: RunContext) -> str:
        """One run fact appended to EVERY agent directive: the absolute skill root.

        An agent is spawned with ``cwd = project_root`` — the TARGET repo — so a
        skill-relative path mentioned in its static prompt file (``resources/x.md``,
        ``scripts/y.py``) resolves into the wrong tree and is silently unreadable.
        A prompt file is static markdown and cannot interpolate a runtime path, so the
        engine states the root once here and tells the agent what to anchor to.
        Empty when unresolvable — never emit a broken path.
        """
        root = skill_root(ctx, self.NAME)
        if not root:
            return ""
        return (
            f"\n\nSkill root (ABSOLUTE): {root}\n"
            "Your working directory is the TARGET project, NOT this skill's repo. Any "
            "skill-relative path your guidance mentions (`resources/...`, `scripts/...`) "
            "lives under that Skill root — read it by its absolute path. A bare relative "
            "path will silently fail to resolve; if a guidance file cannot be read, say so "
            "rather than proceeding as though you had read it."
        )

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
        placeholder = {
            bool: "<true|false>",
            int: "<int>",
            str: "<string>",
            list: "<[...]>",
        }

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
        paused = self._dispatch_pause_directive(
            state=state,
            run_status=STATUS_RUNNING,
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
        )
        if paused is not None:
            # This guard is deliberately before tool execution, fan specification,
            # observability step_start, artifact metadata construction, and every
            # checkpoint write in this method.
            return paused

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
            self._set_state_inputs(new_state, self._state_input_refs(state))
            self.obs.transition(self.ctx, state, new_state, event="tool")
            if new_state in TERMINAL_STATES:
                return self._finish(new_state)
            state = new_state
        else:
            return self._to_error(f"tool-state loop exceeded budget at '{state}'")
        # A deterministic tool may route through unknown into the uniform
        # clarification pause. Handle that control state before primitive lookup;
        # it is never an agent-dispatch state.
        if state == "awaiting_clarification":
            self._save(STATUS_AWAITING_USER, state)
            return self.escalation_directive()
        # A planned gate pauses the run for the user — no agent dispatch.
        if state in self.GATE_STATES:
            return self._enter_gate(state)
        # A parallel state announces step_start for every branch, then fans out.
        try:
            pspec = self.parallel_spec(state, self._ctx)
        except Exception as exc:
            return self._to_error(f"fan-out spec error at '{state}': {exc}")
        if pspec is not None:
            accepted = self._parallel_fan_in(state)
            for branch_id, branch in pspec.branches.items():
                if branch_id not in accepted:
                    self.obs.step_start(self.ctx, branch.name, branch.agent, state)
            directive = self._directive_for_state(state)
            if directive.get("action") in {"error", "paused"}:
                return directive
            self._save(STATUS_RUNNING, state)
            return directive
        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        self.obs.step_start(self.ctx, spec.name, spec.agent, state)
        directive = self._directive_for_state(state)
        if directive.get("action") in {"error", "paused"}:
            return directive
        self._save(STATUS_RUNNING, state)
        return directive

    def _directive_for_state(self, state: str) -> dict:  # noqa: C901
        """Build the exact owner contract for a pending single step or fan branch.

        Parallel recovery omits already accepted branch refs, so restart is keyed
        by ``branch_id`` and independent of result-array order.
        """
        paused = self._dispatch_pause_directive(
            state=state,
            run_status=STATUS_RUNNING,
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
        )
        if paused is not None:
            return paused
        sc = self.skill_context(state, self.ctx)
        model = self.model_for_state(state, self.ctx)
        try:
            pspec = self.parallel_spec(state, self._ctx)
        except Exception as exc:
            return self._to_error(f"fan-out spec error at '{state}': {exc}")
        if pspec is not None:
            try:
                accepted = self._parallel_fan_in(state)
                input_artifacts = self._input_artifacts(state).to_dict()
                tasks = []
                for bid, b in pspec.branches.items():
                    if bid in accepted:
                        continue
                    task = {
                        "branch_id": bid,
                        "agent": b.agent,
                        "task_summary": self._task_summary(state, b, self.ctx)
                        + self._skill_root_line(self.ctx)
                        + self._summary_contract_directive(b),
                        "output_artifact": self._output_metadata(state, b.agent, bid).to_dict(),
                    }
                    if sc:
                        task["skillContext"] = sc
                    if model:
                        task["model"] = model
                    tasks.append(task)
            except ArtifactError as exc:
                return self._to_error(f"artifact directive error at '{state}': {exc}")
            return Directives.invoke_agents_parallel(
                tasks=tasks,
                state_id=state,
                session_id=self.ctx.session_id,
                run_id=self.ctx.run_id,
                project_root=self.ctx.project_root,
                input_artifacts=input_artifacts,
            )
        spec = self.PRIMITIVE_BY_STATE.get(state)
        if spec is None:
            return self._to_error(f"no primitive registered for state '{state}'")
        try:
            output_artifact = self._output_metadata(state, spec.agent, None).to_dict()
            input_artifacts = self._input_artifacts(state).to_dict()
        except ArtifactError as exc:
            return self._to_error(f"artifact directive error at '{state}': {exc}")
        return Directives.invoke_agent(
            agent=spec.agent,
            task_summary=self._task_summary(state, spec, self.ctx)
            + self._skill_root_line(self.ctx)
            + self._uncertainty_retry_line(self.ctx, state)
            + self._summary_contract_directive(spec),
            state_id=state,
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
            skill_context=sc,
            model=model,
            project_root=self.ctx.project_root,
            output_artifact=output_artifact,
            input_artifacts=input_artifacts,
        )

    def _retry_or_fail(self, state: str, reason: str) -> dict:
        self.ctx.step_retries += 1
        if self.ctx.step_retries <= self.max_step_retries:
            return self._advance_to(state)  # re-issue; persists retry count + seq
        return self._to_error(f"step failed after {self.max_step_retries} retries: {reason}")

    def _step_parallel(  # noqa: C901
        self, state: str, pspec: ParallelSpec, agent: str, result: Any
    ) -> dict:
        """Validate and checkpoint branch-safe fan-in keyed only by ``branch_id``."""
        if agent != "__parallel__":
            return self._to_error(
                f"parallel state '{state}' expects the fan-in agent '__parallel__', got '{agent}'"
            )
        if not isinstance(result, list):
            return self._retry_or_fail(
                state, f"parallel state '{state}' received a non-array result"
            )
        entries = result
        owner_fields = {
            "protocol_version",
            "output_artifact_ref",
            "execution_receipt",
            "trusted_invocation",
        }
        if (
            self.allow_programmatic_results
            and entries
            and all(
                isinstance(entry, dict) and not (owner_fields & set(entry)) for entry in entries
            )
        ):
            return self._step_parallel_programmatic(state, pspec, entries)

        accepted = self._parallel_fan_in(state)
        pending_ids = set(pspec.branches) - set(accepted)
        if not entries and pending_ids:
            return self._retry_or_fail(
                state, f"parallel state '{state}' received no pending branch results"
            )

        by_branch: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                return self._retry_or_fail(state, f"parallel '{state}': malformed branch entry")
            branch_id = entry.get("branch_id")
            if not isinstance(branch_id, str) or not branch_id:
                return self._retry_or_fail(
                    state, f"parallel '{state}': branch_id must be a non-empty string"
                )
            if branch_id in by_branch:
                return self._retry_or_fail(
                    state, f"parallel '{state}': duplicate branch_id '{branch_id}'"
                )
            if branch_id not in pspec.branches:
                return self._retry_or_fail(
                    state, f"parallel '{state}': unknown branch_id '{branch_id}'"
                )
            if branch_id not in pending_ids:
                return self._retry_or_fail(
                    state, f"parallel '{state}': stale branch_id '{branch_id}'"
                )
            by_branch[branch_id] = entry

        failures: list[str] = []
        accepted_this_call = False
        for branch_id, branch in pspec.branches.items():
            entry = by_branch.get(branch_id)
            if entry is None:
                continue
            try:
                wrapper = ResultProtocolV2.from_parallel_dict(entry)
                if wrapper.branch_id != branch_id or wrapper.agent != branch.agent:
                    raise ArtifactValidationError(
                        "parallel wrapper branch or agent does not match the directive"
                    )
                expected = self._output_metadata(state, branch.agent, branch_id)
                ref, summary = self._accept_protocol_result(
                    state=state,
                    agent=branch.agent,
                    expected=expected,
                    wrapper=wrapper,
                )
            except ArtifactError as exc:
                if "unsupported" in str(exc) or "stale" in str(exc):
                    return self._artifact_protocol_failure(state, exc)
                failures.append(f"branch '{branch_id}': {exc}")
                continue
            if wrapper.summary_missing:
                failures.append(
                    f"branch '{branch_id}': {wrapper.error or 'no parseable SUMMARY emitted'}"
                )
                continue
            ok, err = validate_summary_contract(branch.name, branch.summary_contract, summary)
            if not ok:
                failures.append(f"branch '{branch_id}': invalid SUMMARY: {err}")
                continue
            accepted[branch_id] = ref.to_dict()
            accepted_this_call = True
            self.obs.step_end(
                self.ctx,
                branch.name,
                {"branch_id": branch_id},
                summary.get("confidence", ""),
            )
            self._save(STATUS_RUNNING, state)

        still_pending = set(pspec.branches) - set(accepted)
        missing = pending_ids - set(by_branch)
        if still_pending:
            if accepted_this_call:
                self.ctx.step_retries = 0
            details = failures
            if missing:
                details.append(f"missing branches {sorted(missing)}")
            return self._retry_or_fail(
                state, f"parallel '{state}' incomplete: {'; '.join(details)}"
            )

        branches: dict[str, dict[str, Any]] = {}
        refs: list[ArtifactRef] = []
        try:
            for branch_id, branch in pspec.branches.items():
                ref = ArtifactRef.from_dict(accepted[branch_id])
                content = self._artifact_store.read_bytes(
                    ref,
                    expected_run_id=self.ctx.run_id,
                    expected_phase=state,
                    expected_branch_id=branch_id,
                    expected_producer=f"agent:{branch.agent}",
                    require_selected=True,
                )
                summary = _extract_artifact_summary(content)
                ok, err = validate_summary_contract(branch.name, branch.summary_contract, summary)
                if not ok:
                    raise ArtifactValidationError(
                        f"recovered branch '{branch_id}' SUMMARY is invalid: {err}"
                    )
                branches[branch_id] = summary
                refs.append(ref)
        except ArtifactError as exc:
            return self._artifact_protocol_failure(state, exc)
        return self._route_parallel_summaries(state, pspec, branches, tuple(refs))

    def _step_parallel_programmatic(
        self, state: str, pspec: ParallelSpec, entries: list[Any]
    ) -> dict:
        """Explicit test-only compatibility for pre-v2 in-process callers."""
        branches: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                return self._retry_or_fail(state, "programmatic parallel entry is malformed")
            branch_id = entry.get("branch_id")
            if not isinstance(branch_id, str) or branch_id in branches:
                return self._retry_or_fail(state, "programmatic parallel branch_id is invalid")
            branch = pspec.branches.get(branch_id)
            if branch is None or entry.get("agent") != branch.agent:
                return self._retry_or_fail(state, "programmatic parallel branch is unknown")
            if entry.get("exitCode") not in (0, None):
                return self._retry_or_fail(state, f"parallel branch '{branch_id}' failed")
            summary = entry.get("summary")
            summary = dict(summary) if isinstance(summary, dict) else {}
            ok, err = validate_summary_contract(branch.name, branch.summary_contract, summary)
            if not ok:
                return self._retry_malformed(
                    state, f"parallel branch '{branch_id}' invalid SUMMARY: {err}"
                )
            branches[branch_id] = summary
        missing = set(pspec.branches) - set(branches)
        if missing:
            return self._retry_or_fail(state, f"parallel missing branches {sorted(missing)}")
        return self._route_parallel_summaries(state, pspec, branches, ())

    def _route_parallel_summaries(  # noqa: C901 - fan-in aggregation and routing
        self,
        state: str,
        pspec: ParallelSpec,
        branches: dict[str, dict[str, Any]],
        refs: tuple[ArtifactRef, ...],
    ) -> dict:
        self.ctx.step_retries = 0
        merged_evidence: list[Any] = []
        for summary in branches.values():
            evidence = summary.get("evidence")
            if isinstance(evidence, str) and evidence.strip():
                merged_evidence.append(evidence)
            elif isinstance(evidence, (list, tuple)):
                merged_evidence.extend(str(item) for item in evidence)
        if merged_evidence:
            self._capture_evidence({"evidence": merged_evidence})
        aggregated = {
            "branches": branches,
            "confidence": weakest_confidence(
                summary.get("confidence", "") for summary in branches.values()
            ),
        }
        if Confidence.is_uncertain(aggregated["confidence"]) and state in self.ESCALATABLE_STATES:
            weak = next(
                branch_id
                for branch_id, summary in branches.items()
                if not Confidence.is_valid(summary.get("confidence"))
                or Confidence.is_uncertain(summary.get("confidence"))
            )
            self._clear_parallel_progress(state)
            return self._escalate(state, pspec.branches[weak], aggregated)

        pre_iteration = self._ctx.iteration
        try:
            self.route_after(state, self._ctx, aggregated)
        except Exception as exc:
            return self._to_error(f"routing error at '{state}': {exc}")
        self._auto_record_iteration(pre_iteration, aggregated)
        new_state = self.sm.current_state_value
        self._clear_parallel_progress(state)
        if refs:
            self._set_state_inputs(new_state, refs)
        self.obs.transition(self.ctx, state, new_state, event="route")
        if new_state in TERMINAL_STATES:
            return self._finish(new_state)
        if self._ctx.iteration > self._ctx.max_iterations:
            return self._force_exhausted(new_state)
        return self._advance_to(new_state)

    def _maybe_retry_uncertain(self, state: str, summary: dict) -> Optional[dict]:
        """One bounded re-attempt of an UNCERTAIN step before spending a human.

        Returns a re-dispatch directive, or ``None`` to escalate as before. Opt-in and
        conservative by construction:

        * OFF unless ``PENNY_UNCERTAINTY_RETRY`` is set;
        * never when the agent asked a question (``needs_clarification``) — that is a
          decision only the user can make, and re-running cannot produce it;
        * at most ONCE per state per run (checkpointed in ``extras``), so a state that
          is genuinely uncertain still reaches the human on its second report;
        * PARALLEL states are excluded (see ``_step_parallel``): re-dispatching a fan
          re-runs every branch to resolve one, and the fan protocol has no
          single-branch re-dispatch. Named limitation, not an oversight.

        The retry must never become pressure to fake confidence — a false CERTAIN is
        far more expensive than an interrupt — so the directive it builds says
        explicitly that reporting UNCERTAIN again is the correct answer when the
        uncertainty is real (see ``_uncertainty_retry_line``).
        """
        if not os.environ.get(_UNCERTAINTY_RETRY_ENV):
            return None
        if summary.get("needs_clarification"):
            return None
        ctx = self._ctx
        tried = ctx.extras.setdefault("uncertainty_retried", [])
        if state in tried:
            return None
        tried.append(state)
        ctx.extras["uncertainty_retry"] = {
            "state": state,
            "reason": str(summary.get("unknown_reason") or ""),
        }
        return self._advance_to(state)

    def _uncertainty_retry_line(self, ctx: RunContext, state: str) -> str:
        """The directive appended when a step is re-issued after reporting UNCERTAIN.

        Appended in ``_directive_for_state`` rather than ``_task_summary`` because
        almost every playbook overrides the latter — a base-class addition there would
        silently reach nobody.
        """
        retry = (ctx.extras.get("uncertainty_retry") or {}) if ctx else {}
        if not retry or retry.get("state") != state:
            return ""
        reason = str(retry.get("reason") or "").strip()
        detail = f"\nWhat you reported: {reason}" if reason else ""
        return (
            "\n\nRETRY AFTER UNCERTAINTY — your previous attempt at this step reported "
            f"UNCERTAIN confidence.{detail}\n"
            "Spend this attempt on the specific thing you were unsure about: gather the "
            "missing evidence, check the source, or narrow the question. You have the "
            "tools; use them on the uncertainty itself rather than redoing what you "
            "already did.\n"
            "If it is still genuinely unresolvable, report UNCERTAIN again — that is the "
            "CORRECT answer and it goes to a human next. Do NOT upgrade your confidence "
            "to end this loop: an unfounded CERTAIN is far more costly than asking."
        )

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

    def _enter_gate(self, state: str, hint: str = "") -> dict:
        """Pause the run at a planned gate: persist AWAITING_USER at the gate
        state id and surface the gate's questions. Distinct from _escalate,
        which is only for UNCERTAIN confidence.

        ``hint`` (F7): when a prior answer was unrecognized, an explanatory hint
        is folded into the directive's ``unknown_reason`` so a re-ask is
        distinguishable from a fresh gate prompt (the obs escalation label is
        left unchanged so it stays a stable ``gate:<state>`` signal).
        """
        self.ctx.previous_state = state
        questions = self.gate_questions(state, self.ctx)
        self.obs.escalation(self.ctx, f"gate:{state}", questions_count=len(questions))
        self._save(STATUS_AWAITING_USER, state)
        unknown_reason = f"gate:{state}" if not hint else f"gate:{state} — {hint}"
        return Directives.escalate_to_user(
            questions=questions,
            previous_state=state,
            unknown_reason=unknown_reason,
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
        # Explicit retry of an errored run re-drives the recorded failed phase
        # instead of forcing a full restart.
        if state == "error":
            return self._retry_errored()
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
            # route_user fired nothing (e.g. an unrecognized answer): re-ask WITH
            # a hint so a programmatic driver can tell this apart from a fresh
            # gate and knows the exact contract (F7). Without this, an
            # unrecognized free-text approval looks like an identical loop.
            return self._enter_gate(
                state,
                hint=(
                    "your previous answer was not recognized — reply with the "
                    "EXACT option value (e.g. 'approve', 'deny', or 'revise'), "
                    "not free text"
                ),
            )
        self._set_state_inputs(new_state, self._state_input_refs(state))
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
        result = self.result_payload(self.ctx)
        self._save(STATUS_COMPLETE, "complete")
        self.obs.run_end(self.ctx, STATUS_COMPLETE, self.ctx.met, self.ctx.iteration)
        exhausted_reason = self._ctx.extras.get("engine_exhausted")
        if exhausted_reason:
            # Honest exhaustion is reported, never dressed as a pass.
            result.setdefault("exhausted", True)
            result.setdefault("exhausted_reason", exhausted_reason)
        return self.terminal_directive(result)

    def _retry_errored(self) -> dict:
        """Re-drive the phase an errored run failed on (F2).

        The failed phase id was captured into ``ctx.extras['failed_state']`` by
        ``_to_error`` before the abort transition. Tool phases are idempotent
        (safe to re-run) and agent phases simply re-dispatch. Returns an
        actionable error only when no recoverable phase was recorded.
        """
        failed_state = str(self.ctx.extras.get("failed_state") or "")
        if not failed_state:
            return self._plain_error(
                self.ctx.session_id,
                self.ctx.run_id,
                "run is in status=error with no recoverable phase recorded; "
                "start a new run for this target",
            )
        try:
            self.sm.current_state_value = failed_state
        except Exception as exc:
            return self._plain_error(
                self.ctx.session_id,
                self.ctx.run_id,
                f"cannot retry errored run at phase '{failed_state}': {exc}",
            )
        # Clear the terminal error markers so the re-driven run is live again.
        self.ctx.errors = []
        self.ctx.complete = False
        self.ctx.met = False
        return self._advance_to(failed_state)

    def _to_error(self, reason: str) -> dict:
        self.ctx.errors.append(reason)
        # F2: record WHERE we failed (captured BEFORE the abort transition) so an
        # explicit resume can retry that phase rather than restart. Additive:
        # status/current_state_id still persist as error/"error".
        failed_state = self.sm.current_state_value
        if failed_state and failed_state != "error":
            self.ctx.extras["failed_state"] = failed_state
        self._safe_send("abort")
        if self.sm.current_state_value != "error":
            try:
                self.sm.current_state_value = "error"
            except Exception:
                pass
        self.ctx.complete = True
        self.ctx.met = False
        self._save(STATUS_ERROR, "error")
        self.obs.run_end(self.ctx, STATUS_ERROR, False, self.ctx.iteration)
        return Directives.error(
            errors=self.ctx.errors,
            session_id=self.ctx.session_id,
            run_id=self.ctx.run_id,
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
