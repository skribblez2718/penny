"""PrimitiveSpec — the frozen descriptor of one operation (= one agent).

A PrimitiveSpec tells the engine only *which agent to invoke* and *what SUMMARY
to expect* for a given operation. The real work (LEARN's ledger write, VERIFY's
cross-model check, etc.) happens inside the spawned agent subprocess — the engine
imports no agent-side capability. See pack 06-technical-reference.md §10.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class PrimitiveSpec:
    name: str  # canonical uppercase name, e.g. "FRAME"
    agent: str  # default driver agent, e.g. "annie"
    summary_contract: dict  # {"required": {...}, "optional": {...}}
    task_hint: str  # generic instruction appended to the task message


@dataclass(frozen=True)
class ParallelSpec:
    """Descriptor of a fan-out state: every branch's agent is dispatched
    concurrently (one ``invoke_agents_parallel`` directive). The driver spawns one
    agent per branch and feeds ALL branch results back in a single ``step`` (agent
    ``"__parallel__"``); the engine validates each branch against its own contract,
    aggregates them by weakest confidence, and routes ONCE on fan-in. Nothing is
    buffered on the context. Each branch reuses a PrimitiveSpec so it gets its own
    agent, contract, and task hint."""

    branches: dict[str, PrimitiveSpec] = field(default_factory=dict)  # branch_id -> spec
