"""RunContext — the lean, serializable state of a single orchestration run.

Holds metadata + **references, not payloads** (full agent output lives in
MemPalace; the context carries pointers and routing fields only). One explicit
key list drives (de)serialization via ``to_dict``/``from_dict`` — this is a
stable, hand-maintained schema and is NOT the transition-replay state-forcing problem (that was
FSM-position transition-replay; here we only persist plain data). See pack
``06-technical-reference.md`` §5.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Explicit serialization key list. Adding a field means adding it here too — a
# deliberate, reviewable step (fail-loud-by-omission beats silent drift).
_KEYS: tuple[str, ...] = (
    "session_id",
    "run_id",
    "playbook",
    "project_root",
    "goal",
    "constraints",
    # playbook-owned domain state:
    "extras",
    # per-primitive completion + routing fields:
    "success_criteria",
    "plan_steps",
    "verify_verdict",
    "verify_gaps",
    "verify_evidence",
    "iteration",
    "max_iterations",
    "stakes",
    # escalation:
    "last_confidence",
    "clarification_text",
    "previous_state",
    "unknown_reason",
    # bookkeeping:
    "last_seq",
    "step_retries",
    "total_steps",
    "iteration_history",
    "recall_lessons",
    # terminal:
    "met",
    "complete",
    "errors",
)


@dataclass
class RunContext:
    # identity / routing
    session_id: str
    run_id: str
    playbook: str
    project_root: str = ""
    goal: str = ""
    constraints: dict[str, Any] = field(default_factory=dict)

    # per-playbook domain state: round-tripped verbatim through the checkpointer;
    # the playbook owns its schema. This is where domain routing state lives —
    # NOT in constraints (constraints are caller inputs, never mutated by a run).
    extras: dict[str, Any] = field(default_factory=dict)

    # per-primitive completion + routing fields
    success_criteria: list[Any] = field(default_factory=list)
    plan_steps: list[Any] = field(default_factory=list)
    verify_verdict: str = ""
    verify_gaps: list[Any] = field(default_factory=list)
    # Capped digest of the most recent non-empty SUMMARY `evidence` field the
    # engine saw (single or parallel step). Written by the engine, read by the
    # outcome ledger — "Ledger records outcome+evidence" (atomic-loop checklist).
    verify_evidence: list[Any] = field(default_factory=list)
    iteration: int = 0
    max_iterations: int = 3
    stakes: str = ""

    # escalation
    last_confidence: str = ""
    clarification_text: str = ""
    previous_state: str = ""
    unknown_reason: str = ""

    # bookkeeping
    last_seq: int = 0  # monotonic obs seq; survives subprocess boundaries
    step_retries: int = 0
    total_steps: int = 0  # global step counter for the engine's step-cap budget
    # per-iteration digests for the loop-quality guards (strategy-delta between
    # retries; stall / progress-assessment). A playbook appends one entry per
    # completed retry iteration via BasePlaybook.record_iteration; the base's
    # strategy_repeated / is_stalled read it. Entries are small digests, not
    # payloads (gaps summary, the declared strategy_change, confidence).
    iteration_history: list[dict[str, Any]] = field(default_factory=list)

    # Recall (atom F2): distilled lessons retrieved at start() and injected into
    # the FIRST agent directive as advisory context. Never read by routing —
    # a past lesson must not hard-gate a new run (loops.md Rec 3).
    recall_lessons: list[str] = field(default_factory=list)

    # terminal
    met: bool = False
    complete: bool = False
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Serialize using the explicit key list (stable schema)."""
        return {k: getattr(self, k) for k in _KEYS}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RunContext":
        """Reconstruct, tolerating missing keys (defaults) but REJECTING extras.

        ``session_id``, ``run_id`` and ``playbook`` are the only truly required
        keys; every other known key falls back to its dataclass default. Unknown
        top-level keys fail loud rather than being silently dropped — a checkpoint
        written by newer code and read by older code errors visibly instead of
        losing state (add the key to ``_KEYS``; playbook-specific data belongs in
        the ``extras`` dict, which round-trips wholesale).
        """
        if not isinstance(d, dict):
            raise TypeError(f"RunContext.from_dict expects a dict, got {type(d).__name__}")
        unknown = set(d) - set(_KEYS)
        if unknown:
            raise ValueError(
                f"RunContext.from_dict: unknown keys {sorted(unknown)} — checkpoint "
                "schema drift. Add the key to _KEYS, or stash playbook data in extras."
            )
        try:
            kwargs = {
                "session_id": d["session_id"],
                "run_id": d["run_id"],
                "playbook": d["playbook"],
            }
        except KeyError as exc:
            raise ValueError(f"RunContext.from_dict missing required key: {exc}") from exc

        for k in _KEYS:
            if k in kwargs:
                continue
            if k in d:
                kwargs[k] = d[k]
        return cls(**kwargs)
