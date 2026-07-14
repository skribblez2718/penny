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


# JSON-safe type names for contracts that arrive as DATA (a model-emitted
# ``dynamic_branches`` payload serialized through the checkpointer). Fail-loud
# on unknown names: a typo'd contract must not silently skip validation.
_TYPE_BY_NAME: dict[str, type] = {"bool": bool, "int": int, "str": str, "list": list}


def contract_from_json(contract: dict) -> dict:
    """Convert a JSON-safe SUMMARY contract (type NAMES) into a runtime contract.

    ``{"required": {"k": "bool"}, "optional": {...}, "evidence": [...]}`` →
    the ``{"required": {"k": bool}, ...}`` shape ``validate_summary_contract``
    consumes. Raises ``ValueError`` on an unknown type name.
    """
    out: dict = {}
    for section in ("required", "optional"):
        fields = contract.get(section, {}) or {}
        converted: dict[str, type] = {}
        for key, tname in fields.items():
            if tname not in _TYPE_BY_NAME:
                raise ValueError(
                    f"unknown contract type name {tname!r} for field '{key}' "
                    f"(expected one of {sorted(_TYPE_BY_NAME)})"
                )
            converted[str(key)] = _TYPE_BY_NAME[tname]
        out[section] = converted
    if contract.get("evidence"):
        out["evidence"] = [str(f) for f in contract["evidence"]]
    return out


def parallel_spec_from_dict(branches: dict) -> "ParallelSpec":
    """Build a ParallelSpec from JSON-safe branch data — fan topology as DATA.

    This is what lets a run's fan-out be the model's runtime output (arrangement
    4, orchestrator-workers) instead of a topology frozen at author time: a
    playbook stashes ``{branch_id: {agent, name?, task_hint?, summary_contract?}}``
    (from a Decide/PLAN SUMMARY) in ``ctx.extras["dynamic_branches"][state]``,
    and ``BasePlaybook.parallel_spec`` rebuilds the spec from it on every
    process — so dynamic topology survives checkpoint/resume for free.
    Raises ``ValueError``/``KeyError`` on malformed branch data (fail loud).
    """
    specs: dict[str, PrimitiveSpec] = {}
    for bid, branch in branches.items():
        if not isinstance(branch, dict):
            raise ValueError(f"dynamic branch '{bid}' must be a dict")
        agent = branch.get("agent")
        if not agent or not isinstance(agent, str):
            raise ValueError(f"dynamic branch '{bid}' missing required 'agent'")
        specs[str(bid)] = PrimitiveSpec(
            name=str(branch.get("name") or str(bid).upper()),
            agent=agent,
            summary_contract=contract_from_json(branch.get("summary_contract") or {}),
            task_hint=str(branch.get("task_hint") or ""),
        )
    return ParallelSpec(branches=specs)


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
