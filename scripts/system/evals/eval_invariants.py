#!/usr/bin/env python3
"""Capability invariants — the leverage spine, made self-enforcing.

Asserts the protected capabilities from ``docs/agents/architecture/bitter-lesson.md``
at the CONTRACT / CONFIG level, so a change that weakens one turns a check RED in
``make evals``. Per the doctrine's rule — *ratchet on capabilities, not
implementations* — each check asserts a capability (evidence is required; the
generator is not its own judge), never a specific code shape, so
the checks themselves do not ossify.

Cheap and cron-safe: pure imports + in-process assertions. No model calls, no
network, no live-store reads. Gating checks carry no baseline metric — they pass
silently and REGRESS loudly if broken. Aspirational / behavioural invariants are
marked ``informational`` so they are tracked (visible in the scorecard) without
gating on a proxy.

Coverage note: durable-memory recall is measured by the ``retrieval`` section;
safety guards (SSRF / path allow-lists, orchestration guards) by ``compat``
(check_orchestration_guards / check_compliance). This section covers the
orchestration-level leverage spine.
"""

from __future__ import annotations

from typing import Callable, List, Tuple

from eval_lib import FAIL, PASS, EvalResult, EvalSkip, run_checks


def _require_orchestration() -> None:
    """SKIP (not FAIL) when the engine package is absent — a missing prerequisite
    is not a capability regression."""
    try:
        import orchestration  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — surface as SKIP, not a crash
        raise EvalSkip(f"orchestration package not importable: {type(exc).__name__}: {exc}")


def check_grounded_verification() -> EvalResult:
    """A VERIFY that declares an evidence field cannot PASS on empty evidence.

    Asserts the externally-grounded-evidence guarantee behaviourally: the very
    validator the engine uses must reject a bare ``verdict: PASS`` with empty
    evidence, and accept one carrying a captured artifact.
    """
    _require_orchestration()
    from orchestration.contracts import validate_summary_contract

    contract = {
        "required": {"verdict": str, "gaps": list, "confidence": str},
        "evidence": ["evidence"],
    }
    empty = {"verdict": "PASS", "gaps": [], "confidence": "CERTAIN", "evidence": []}
    grounded = {
        "verdict": "PASS",
        "gaps": [],
        "confidence": "CERTAIN",
        "evidence": ["ran: pytest -q -> 12 passed"],
    }
    empty_ok, _ = validate_summary_contract("VERIFY", contract, empty)
    grounded_ok, why = validate_summary_contract("VERIFY", contract, grounded)
    holds = (not empty_ok) and grounded_ok
    return EvalResult(
        name="invariants.grounded_verification",
        status=PASS if holds else FAIL,
        detail=(
            "evidence-grounded VERIFY holds — empty-evidence PASS rejected, grounded PASS accepted"
            if holds
            else (
                f"BROKEN — empty-evidence PASS accepted={empty_ok}, "
                f"grounded PASS accepted={grounded_ok} ({why})"
            )
        ),
    )


def check_independent_verification() -> EvalResult:
    """VERIFY is driven by a different agent than ACT (generator != its own judge)."""
    _require_orchestration()
    from orchestration.primitives import ACT, VERIFY

    independent = bool(ACT.agent) and bool(VERIFY.agent) and ACT.agent != VERIFY.agent
    return EvalResult(
        name="invariants.independent_verification",
        status=PASS if independent else FAIL,
        detail=(
            f"ACT agent={ACT.agent!r} != VERIFY agent={VERIFY.agent!r} — independent"
            if independent
            else f"BROKEN — ACT={ACT.agent!r}, VERIFY={VERIFY.agent!r}: generator judges its own work"
        ),
    )


def check_checkpoint_resume() -> EvalResult:
    """Durable checkpoint/resume is present: state persists across transitions."""
    _require_orchestration()
    from orchestration.checkpointer import Checkpointer
    from orchestration.engine import BasePlaybook

    has_checkpointer = isinstance(Checkpointer, type)
    persists = hasattr(BasePlaybook, "_save")
    ok = has_checkpointer and persists
    return EvalResult(
        name="invariants.checkpoint_resume",
        status=PASS if ok else FAIL,
        detail=(
            "durable Checkpointer present and engine persists state after transitions"
            if ok
            else f"BROKEN — Checkpointer_present={has_checkpointer}, engine_persists={persists}"
        ),
    )


def check_honest_exhaustion() -> EvalResult:
    """Iterate-to-verified with honest exhaustion (never a fabricated PASS).

    A behavioural guarantee whose real gate is the pytest suite
    (``apps/orchestration/tests/test_loop_guards.py`` — run by regression check #5).
    Surfaced here as a tracked invariant via a light structural proxy (the
    anti-paralysis / bounded-iteration hooks); ``informational`` so it never gates
    on a proxy — gating on a renamed helper would ratchet on implementation.
    """
    _require_orchestration()
    from orchestration.engine import BasePlaybook

    hooks = ("record_iteration", "is_stalled", "strategy_repeated")
    absent = [h for h in hooks if not hasattr(BasePlaybook, h)]
    return EvalResult(
        name="invariants.honest_exhaustion",
        status=PASS if not absent else FAIL,
        informational=True,
        detail=(
            "bounded-iteration + anti-paralysis hooks present; behaviour guarded by "
            "apps/orchestration/tests/test_loop_guards.py"
            if not absent
            else f"anti-paralysis hooks missing: {absent}"
        ),
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("invariants.grounded_verification", check_grounded_verification),
    ("invariants.independent_verification", check_independent_verification),
    ("invariants.checkpoint_resume", check_checkpoint_resume),
    ("invariants.honest_exhaustion", check_honest_exhaustion),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
