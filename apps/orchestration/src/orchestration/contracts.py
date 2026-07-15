"""Contracts — the typed seam between the engine and the agent subprocesses.

Single source of truth for:
  * the Confidence taxonomy (``CERTAIN | PROBABLE | POSSIBLE | UNCERTAIN``);
  * the canonical per-primitive SUMMARY contracts + ``validate_summary`` (the
    engine's fail-loud gatekeeper);
  * the stdout directive builders (``invoke_agent`` / ``invoke_agents_parallel``
    / ``escalate_to_user`` / ``complete`` / ``error`` / ``status``).

Every directive carries ``session_id`` + ``run_id``. There is deliberately NO
``orchestrator_state`` field — the durable checkpointer owns all state (this is
what retires the legacy state-on-argv transport). See
``docs/agents/orchestration/overview.md`` and the unified-overhaul pack
``06-technical-reference.md`` §2–4.
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Confidence taxonomy (§2). Canonical, reused from Penny. UNCERTAIN triggers the
# engine's escalation path; every escalating primitive SUMMARY must include one.
# ---------------------------------------------------------------------------


class Confidence:
    CERTAIN = "CERTAIN"
    PROBABLE = "PROBABLE"
    POSSIBLE = "POSSIBLE"
    UNCERTAIN = "UNCERTAIN"

    ALL: frozenset[str] = frozenset({CERTAIN, PROBABLE, POSSIBLE, UNCERTAIN})

    @classmethod
    def is_valid(cls, value: Any) -> bool:
        return isinstance(value, str) and value in cls.ALL

    @classmethod
    def is_uncertain(cls, value: Any) -> bool:
        return value == cls.UNCERTAIN


_CONFIDENCE_RANK: dict[str, int] = {
    Confidence.CERTAIN: 0,
    Confidence.PROBABLE: 1,
    Confidence.POSSIBLE: 2,
    Confidence.UNCERTAIN: 3,
}


def weakest_confidence(values: Any) -> str:
    """Fan-in aggregation for a parallel state: the weakest branch confidence
    wins. Unknown or missing values rank as UNCERTAIN so a silent branch cannot
    fake certainty. Empty input -> "" (no branches reported)."""
    vals = list(values)
    if not vals:
        return ""
    return max(vals, key=lambda v: _CONFIDENCE_RANK.get(v, 3))


# ---------------------------------------------------------------------------
# Primitive names (the six operations). Uppercase canonical form.
# ---------------------------------------------------------------------------

OBSERVE = "OBSERVE"
FRAME = "FRAME"
PLAN = "PLAN"
ACT = "ACT"
VERIFY = "VERIFY"
LEARN = "LEARN"

# Verdict vocabulary for VERIFY (legacy APPROVE/NEEDS_REVISION/BLOCKED map to
# PASS/FAIL at migration — see pack C10).
VERDICT_PASS = "PASS"
VERDICT_FAIL = "FAIL"
VERDICTS: frozenset[str] = frozenset(
    {VERDICT_PASS, VERDICT_FAIL}
)  # used by route_after (P3) to reject unknown verdicts


# ---------------------------------------------------------------------------
# Canonical primitive SUMMARY contracts (§4). The single source of truth for the
# engine's gatekeeper: required fields fail loud if missing/mis-typed.
#
# NOTE on ``confidence``: the §4 canonical table REQUIRES it on OBSERVE / FRAME /
# PLAN / ACT / VERIFY and OMITS it for LEARN — that table is the single source of
# truth here, and it (correctly) overrides §2's looser "every primitive" wording.
# Separately, the escalation FSM (§9) acts only on framing/planning/acting/
# verifying; note that `observing` has no UNCERTAIN->unknown edge yet OBSERVE
# still carries `confidence` per the table. LEARN is terminal-adjacent and omits
# it. (Unknown/extra fields in a SUMMARY are ignored by validate_summary, so an
# agent that emits confidence on LEARN anyway is never rejected.)
# ---------------------------------------------------------------------------

CONTRACTS: dict[str, dict[str, dict[str, type]]] = {
    OBSERVE: {
        "required": {"observe_complete": bool, "confidence": str},
        "optional": {"findings_count": int, "sources": list, "unknowns_count": int},
    },
    FRAME: {
        "required": {"frame_complete": bool, "success_criteria": list, "confidence": str},
        "optional": {
            "problem": str,
            "anti_criteria": list,
            "constraints": list,
            "assumptions": list,
        },
    },
    PLAN: {
        "required": {"plan_steps": list, "plan_complete": bool, "confidence": str},
        "optional": {"stakes": str, "dependencies": list},
    },
    ACT: {
        "required": {"act_complete": bool, "confidence": str},
        "optional": {"artifacts": list, "changed": list},
    },
    VERIFY: {
        "required": {"verdict": str, "gaps": list, "confidence": str},
        "optional": {"evidence": list},
    },
    LEARN: {
        "required": {"learn_complete": bool},
        "optional": {"ledger_id": str, "amendments": list},
    },
}


def _type_ok(value: Any, expected: type) -> bool:
    """isinstance check with one hardening: reject ``bool`` where ``int`` is
    expected (``bool`` is a subclass of ``int`` in Python, so ``True`` would
    otherwise satisfy an ``int`` field like ``findings_count``)."""
    if expected is int and isinstance(value, bool):
        return False
    return isinstance(value, expected)


def _is_nonempty(value: Any) -> bool:
    """Truthiness with a non-empty-container guarantee, for evidence fields:
    ``[]`` / ``""`` / ``{}`` / ``0`` / ``False`` / ``None`` all fail. A VERIFY
    that must be *externally grounded* declares its evidence field(s) so a bare
    ``verdict: PASS`` with no captured test/scan output fails loud."""
    if isinstance(value, (list, str, dict, tuple, set)):
        return len(value) > 0
    return bool(value)


def validate_summary_contract(name: str, contract: dict, summary: Any) -> tuple[bool, str]:  # noqa: C901
    """Validate a SUMMARY against an explicit contract dict.

    ``contract`` is a ``{"required": {...}, "optional": {...}}`` mapping —
    normally a ``PrimitiveSpec.summary_contract``. This is the engine's real
    gatekeeper: it validates against the contract the state actually carries, so
    a domain skill can bring its own custom-named operations (e.g. ``CODE_VERIFY``)
    without registering anything in the global CONTRACTS table below.

    An optional ``contract["evidence"]`` list names required fields that must
    additionally be **non-empty** — the externally-grounded-evidence guarantee
    (research/loop-research Rec 4): a verifier gate cannot PASS on a bare
    assertion; it must carry the artifact (captured test output, scan results,
    an executed-PoC transcript). Evidence fields must also appear in
    ``required`` (so their type is checked); the evidence pass then enforces
    non-emptiness on top.
    """
    if not isinstance(summary, dict):
        return False, f"{name}: summary must be a dict, got {type(summary).__name__}"

    for field, typ in contract.get("required", {}).items():
        if field not in summary:
            return False, f"{name}: missing required '{field}'"
        if not _type_ok(summary[field], typ):
            return False, f"{name}: '{field}' must be {typ.__name__}"

    for field, typ in contract.get("optional", {}).items():
        if field in summary and not _type_ok(summary[field], typ):
            return False, f"{name}: optional '{field}' must be {typ.__name__}"

    for field in contract.get("evidence", ()):  # externally-grounded evidence
        if not _is_nonempty(summary.get(field)):
            return False, (
                f"{name}: evidence field '{field}' must be present and non-empty "
                "(externally-grounded VERIFY: attach the artifact, not a bare claim)"
            )

    # Conditional evidence: each (evidence_field, condition_field) requires
    # ``evidence_field`` non-empty ONLY when ``condition_field`` is positive/non-empty.
    # This lets a security verifier stay pressure-free on a clean target (the condition,
    # e.g. verified_count, is 0 -> nothing enforced) while refusing a self-claimed
    # positive that carries no artifact (verified_count > 0 -> evidence must be present).
    for evidence_field, condition_field in contract.get("conditional_evidence", ()):
        if _is_nonempty(summary.get(condition_field)) and not _is_nonempty(summary.get(evidence_field)):
            return False, (
                f"{name}: '{evidence_field}' must be non-empty when '{condition_field}' is "
                "positive (a claimed positive must carry its artifact, not a bare count)"
            )

    return True, ""


def validate_summary(primitive: str, summary: Any) -> tuple[bool, str]:
    """Validate an agent SUMMARY against one of the six canonical CONTRACTS.

    Thin public wrapper over :func:`validate_summary_contract` that looks the
    contract up by canonical primitive name. Convenience for callers validating
    against the six standard operations; the engine itself validates against each
    state's own ``spec.summary_contract`` directly (custom-named operations never
    touch this table).
    """
    contract = CONTRACTS.get(primitive)
    if contract is None:
        return False, f"unknown primitive '{primitive}'"
    return validate_summary_contract(primitive, contract, summary)


# ---------------------------------------------------------------------------
# Directive builders (§3). One JSON object per invocation, printed to stdout by
# the CLI. Every directive carries session_id + run_id; none carries state.
# ---------------------------------------------------------------------------


class Directives:
    """Builders for the stdout directive contract the TS driver consumes."""

    @staticmethod
    def invoke_agent(
        *,
        agent: str,
        task_summary: str,
        state_id: str,
        session_id: str,
        run_id: str,
        logical_step: bool = True,
        skill_context: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        # By default the TS skill driver injects domain guidance from
        # assets/prompts/{agent}.md against skill.path. A playbook whose states map
        # to per-state prompt files (sca/jsa) may set `skill_context` (a
        # skill-relative path); the driver resolves + injects it (index.ts ~1158,
        # `resolveSkillContextPath`). `model` is an optional per-state model
        # override the driver honors (index.ts ~1243). Both are omitted unless set,
        # so single-prompt skills' directives are unchanged.
        directive: dict[str, Any] = {
            "action": "invoke_agent",
            "agent": agent,
            "task_summary": task_summary,
            "state_id": state_id,
            "logical_step": logical_step,
            "session_id": session_id,
            "run_id": run_id,
        }
        if skill_context:
            directive["skillContext"] = skill_context
        if model:
            directive["model"] = model
        return directive

    @staticmethod
    def invoke_agents_parallel(
        *,
        tasks: list[dict[str, Any]],
        state_id: str,
        session_id: str,
        run_id: str,
    ) -> dict[str, Any]:
        return {
            "action": "invoke_agents_parallel",
            "tasks": tasks,
            "state_id": state_id,
            "session_id": session_id,
            "run_id": run_id,
        }

    @staticmethod
    def escalate_to_user(
        *,
        questions: list[dict[str, Any]],
        previous_state: str,
        unknown_reason: str,
        session_id: str,
        run_id: str,
    ) -> dict[str, Any]:
        return {
            "action": "escalate_to_user",
            "questions": questions,
            "previous_state": previous_state,
            "unknown_reason": unknown_reason,
            "session_id": session_id,
            "run_id": run_id,
        }

    @staticmethod
    def complete(*, result: dict[str, Any], session_id: str, run_id: str) -> dict[str, Any]:
        return {
            "action": "complete",
            "result": result,
            "session_id": session_id,
            "run_id": run_id,
        }

    @staticmethod
    def error(*, errors: list[str], session_id: str, run_id: str) -> dict[str, Any]:
        return {
            "action": "error",
            "errors": errors,
            "session_id": session_id,
            "run_id": run_id,
        }

    @staticmethod
    def status(*, state: str, complete: bool, session_id: str, run_id: str) -> dict[str, Any]:
        return {
            "action": "status",
            "state": state,
            "complete": complete,
            "session_id": session_id,
            "run_id": run_id,
        }
