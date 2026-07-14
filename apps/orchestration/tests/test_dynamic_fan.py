"""Dynamic fan topology (PRD R7 — arrangement 4, orchestrator-workers): the
fan-out of a parallel state is DATA emitted at runtime (a model's PLAN output
stashed in ``ctx.extras["dynamic_branches"]``), rebuilt from the checkpoint on
every process, validated per-branch, bounded by the ``max_fan_width`` budget,
and fail-loud on malformed branch data.
"""

import pytest
from statemachine import State, StateMachine

from orchestration.checkpointer import Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import (
    PrimitiveSpec,
    contract_from_json,
    parallel_spec_from_dict,
)

SID, RID = "sess-fan", "run-fan"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


# ---------------------------------------------------------------------------
# spec-from-data helpers
# ---------------------------------------------------------------------------


def test_contract_from_json_converts_type_names():
    c = contract_from_json(
        {"required": {"done": "bool", "n": "int"}, "optional": {"notes": "str", "items": "list"}}
    )
    assert c["required"] == {"done": bool, "n": int}
    assert c["optional"] == {"notes": str, "items": list}


def test_contract_from_json_preserves_evidence_fields():
    c = contract_from_json({"required": {"evidence": "list"}, "evidence": ["evidence"]})
    assert c["evidence"] == ["evidence"]


def test_contract_from_json_rejects_unknown_type_name():
    with pytest.raises(ValueError, match="unknown contract type name"):
        contract_from_json({"required": {"x": "float"}})


def test_parallel_spec_from_dict_builds_branches():
    spec = parallel_spec_from_dict(
        {
            "b1": {"agent": "skribble", "task_hint": "do part 1"},
            "b2": {
                "agent": "vera",
                "name": "CHECK",
                "summary_contract": {"required": {"ok": "bool"}},
            },
        }
    )
    assert spec.branches["b1"].agent == "skribble"
    assert spec.branches["b2"].name == "CHECK"
    assert spec.branches["b2"].summary_contract["required"] == {"ok": bool}


def test_parallel_spec_from_dict_requires_agent():
    with pytest.raises(ValueError, match="missing required 'agent'"):
        parallel_spec_from_dict({"b1": {"task_hint": "no agent"}})


# ---------------------------------------------------------------------------
# End-to-end: PLAN emits subtasks -> engine fans out -> fan-in -> complete
# ---------------------------------------------------------------------------


class FanMachine(StateMachine):
    intake = State(initial=True)
    planning = State()
    fanning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(planning)
    plan_done = planning.to(fanning)
    fan_done = fanning.to(complete)
    to_unknown = planning.to(unknown) | fanning.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(planning)
    abort = (
        planning.to(error)
        | fanning.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


PLAN_C = {"required": {"subtasks": dict, "confidence": str}, "optional": {}}


class FanPlaybook(BasePlaybook):
    """The fan topology is the PLAN agent's runtime output — nothing is declared
    in PARALLEL_BY_STATE for 'fanning'."""

    NAME = "fan-test"
    machine_cls = FanMachine
    PRIMITIVE_BY_STATE = {"planning": PrimitiveSpec("F_PLAN", "piper", PLAN_C, "plan the fan")}
    ESCALATABLE_STATES = frozenset({"planning", "fanning"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "planning"

    def route_after(self, state, ctx, summary):
        if state == "planning":
            # Decide's runtime output becomes the topology (JSON-safe -> extras).
            ctx.extras.setdefault("dynamic_branches", {})["fanning"] = summary["subtasks"]
            self.sm.send("plan_done")
        else:
            ctx.extras["fan_results"] = sorted(summary["branches"])
            self.sm.send("fan_done")

    def done_predicate(self, ctx):
        return bool(ctx.extras.get("fan_results"))


SUBTASKS = {
    "part1": {
        "agent": "skribble",
        "task_hint": "do part 1",
        "summary_contract": {"required": {"done": "bool", "confidence": "str"}},
    },
    "part2": {
        "agent": "skribble",
        "task_hint": "do part 2",
        "summary_contract": {"required": {"done": "bool", "confidence": "str"}},
    },
}


def _plan(cp, subtasks=SUBTASKS, constraints=None):
    FanPlaybook(cp).start(session_id=SID, run_id=RID, goal="fan", constraints=constraints or {})
    return FanPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="piper",
        result={"subtasks": subtasks, "confidence": "CERTAIN"},
    )


def test_runtime_branches_dispatch_as_parallel_directive(cp):
    d = _plan(cp)
    assert d["action"] == "invoke_agents_parallel"
    assert d["state_id"] == "fanning"
    assert {t["branch_id"] for t in d["tasks"]} == {"part1", "part2"}
    assert any("do part 1" in t["task_summary"] for t in d["tasks"])


def test_fan_in_validates_and_completes_across_processes(cp):
    _plan(cp)
    # Fresh playbook instance = new process; the dynamic spec must be rebuilt
    # from the checkpointed extras (topology survives kill-and-resume).
    results = [
        {
            "branch_id": "part1",
            "agent": "skribble",
            "exitCode": 0,
            "summary": {"done": True, "confidence": "CERTAIN"},
        },
        {
            "branch_id": "part2",
            "agent": "skribble",
            "exitCode": 0,
            "summary": {"done": True, "confidence": "PROBABLE"},
        },
    ]
    d = FanPlaybook(cp).step(session_id=SID, run_id=RID, agent="__parallel__", result=results)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True


def test_dynamic_branch_contract_is_enforced_on_fan_in(cp):
    _plan(cp)
    results = [
        {
            "branch_id": "part1",
            "agent": "skribble",
            "exitCode": 0,
            "summary": {"done": "yes", "confidence": "CERTAIN"},
        },  # mistyped
        {
            "branch_id": "part2",
            "agent": "skribble",
            "exitCode": 0,
            "summary": {"done": True, "confidence": "CERTAIN"},
        },
    ]
    d = FanPlaybook(cp).step(session_id=SID, run_id=RID, agent="__parallel__", result=results)
    # Malformed branch SUMMARY -> bounded format-repair re-issue of the fan-out.
    assert d["action"] == "invoke_agents_parallel"


def test_fan_width_budget_default(cp):
    wide = {
        f"b{i}": {"agent": "skribble", "summary_contract": {"required": {"confidence": "str"}}}
        for i in range(9)  # default cap is 8
    }
    d = _plan(cp, subtasks=wide)
    assert d["action"] == "error"
    assert "max_fan_width" in d["errors"][0]


def test_fan_width_budget_constraint_override(cp):
    d = _plan(cp, constraints={"max_fan_width": 1})
    assert d["action"] == "error"
    assert "max_fan_width budget (1)" in d["errors"][0]


def test_malformed_dynamic_branch_fails_loud(cp):
    bad = {"b1": {"agent": "skribble", "summary_contract": {"required": {"x": "float"}}}}
    d = _plan(cp, subtasks=bad)
    assert d["action"] == "error"
    assert "unknown contract type name" in d["errors"][0]


def test_static_parallel_by_state_still_works_via_seam(cp):
    """Class-declared topology is the fallback when no dynamic branches exist."""

    class StaticFanPlaybook(FanPlaybook):
        NAME = "fan-static"
        PARALLEL_BY_STATE = {
            "fanning": __import__("orchestration").ParallelSpec(
                branches={
                    "s1": PrimitiveSpec(
                        "S1",
                        "skribble",
                        {"required": {"done": bool, "confidence": str}},
                        "static 1",
                    )
                }
            )
        }

        def route_after(self, state, ctx, summary):
            if state == "planning":
                self.sm.send("plan_done")  # no dynamic stash
            else:
                ctx.extras["fan_results"] = sorted(summary["branches"])
                self.sm.send("fan_done")

    StaticFanPlaybook(cp).start(session_id=SID, run_id=RID, goal="fan")
    d = StaticFanPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="piper",
        result={"subtasks": {}, "confidence": "CERTAIN"},
    )
    assert d["action"] == "invoke_agents_parallel"
    assert {t["branch_id"] for t in d["tasks"]} == {"s1"}
