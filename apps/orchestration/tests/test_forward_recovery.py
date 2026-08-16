"""Track-A forward-only dispatch pause/unpause drills.

These tests prove the owner kill switch preserves the exact checkpoint/artifact
state and resumes by rebuilding the same pending contracts. No semantic-memory
transport or payload injection participates in recovery.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from statemachine import State, StateMachine

from artifact_protocol_helpers import owner_result
from orchestration import playbooks as playbook_module
from orchestration.artifacts import ArtifactRef, ArtifactStore
from orchestration.checkpointer import STATUS_RUNNING, Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.playbooks import ReferenceCycle
from orchestration.primitives.spec import ParallelSpec, PrimitiveSpec
from orchestration.recovery import recover_pending

SID = "track-a-forward-session"
RID = "track-a-forward-run"
OBSERVE = {"observe_complete": True, "confidence": "PROBABLE"}
FRAME = {
    "frame_complete": True,
    "success_criteria": ["forward recovery"],
    "confidence": "CERTAIN",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _artifact_hashes(store: ArtifactStore) -> dict[str, object]:
    return {
        "manifest": _sha256(store.manifest_path),
        "objects": {
            str(path.relative_to(store.objects_root)): _sha256(path)
            for path in sorted(store.objects_root.rglob("*"))
            if path.is_file()
        },
    }


def _register(monkeypatch, playbook: type[BasePlaybook]) -> None:
    monkeypatch.setitem(playbook_module.PLAYBOOKS, playbook.NAME, playbook)


def test_synthetic_pause_unpause_preserves_hashes_and_reissues_identical_refs(
    tmp_path, monkeypatch
):
    """Synthetic GATE-A drill: selected bytes/refs never move during pause."""
    cp = Checkpointer(db_path=tmp_path / "orchestration.sqlite3")
    first = ReferenceCycle(cp).start(session_id=SID, run_id=RID, goal="forward only")
    pending = ReferenceCycle(cp).step(
        session_id=SID,
        run_id=RID,
        agent="echo",
        result=owner_result(first, OBSERVE),
    )
    assert pending["action"] == "invoke_agent" and pending["state_id"] == "framing"

    before = cp.load(RID)
    assert before is not None and before.status == STATUS_RUNNING
    selected_before = json.loads(
        json.dumps(before.context.extras["artifact_protocol"]["selected_refs"], sort_keys=True)
    )
    selected_ref = ArtifactRef.from_dict(selected_before[0])
    store = ArtifactStore()
    exact_before = store.read_bytes(
        selected_ref,
        expected_run_id=RID,
        expected_phase="observing",
        expected_producer="agent:echo",
        require_selected=True,
    )
    artifact_hashes_before = _artifact_hashes(store)

    memory_sentinel = tmp_path / "memory-sentinel.bin"
    memory_sentinel.write_bytes(b"semantic-memory-must-remain-untouched\x00sentinel")
    memory_hash_before = _sha256(memory_sentinel)

    monkeypatch.setenv("PENNY_ARTIFACT_DISPATCH_MODE", "paused")
    paused = recover_pending(
        Checkpointer(db_path=cp.db_path),
        session_id=SID,
        playbook="reference-cycle",
    )
    assert len(paused) == 1
    assert paused[0]["action"] == "paused"
    assert paused[0]["code"] == "ARTIFACT_DISPATCH_PAUSED"
    assert paused[0]["retryable"] is True
    assert paused[0]["state_id"] == "framing"
    assert paused[0]["recovery"] == {
        "action": "recover",
        "run_id": RID,
        "requires_dispatch_mode": "active",
        "checkpoint_preserved": True,
    }
    assert "agent" not in paused[0] and "tasks" not in paused[0]
    assert "input_artifacts" not in paused[0] and "output_artifact" not in paused[0]

    # A submitted step while paused is ignored before result/artifact selection.
    ignored = ReferenceCycle(Checkpointer(db_path=cp.db_path)).step(
        session_id=SID,
        run_id=RID,
        agent="annie",
        result={"semantic_payload": "must not be processed"},
    )
    assert ignored["action"] == "paused"

    # Read-only control/data-plane operations remain available during the pause.
    status = ReferenceCycle(Checkpointer(db_path=cp.db_path)).status(
        session_id=SID,
        run_id=RID,
    )
    assert status == {
        "action": "status",
        "state": "framing",
        "complete": False,
        "session_id": SID,
        "run_id": RID,
    }
    assert (
        store.read_bytes(
            selected_ref,
            expected_run_id=RID,
            expected_phase="observing",
            expected_producer="agent:echo",
            require_selected=True,
        )
        == exact_before
    )

    after_pause = cp.load(RID)
    assert after_pause is not None
    assert after_pause.status == before.status
    assert after_pause.current_state_id == before.current_state_id
    assert after_pause.updated_at == before.updated_at
    assert after_pause.context.to_dict() == before.context.to_dict()
    assert after_pause.context.extras["artifact_protocol"]["selected_refs"] == selected_before
    assert _artifact_hashes(store) == artifact_hashes_before
    assert _sha256(memory_sentinel) == memory_hash_before

    # A fresh active process reconstructs the exact pending contract, including
    # selected input refs and output revision metadata, then continues normally.
    monkeypatch.setenv("PENNY_ARTIFACT_DISPATCH_MODE", "active")
    resumed = recover_pending(
        Checkpointer(db_path=cp.db_path),
        session_id=SID,
        playbook="reference-cycle",
    )
    assert resumed == [pending]
    serialized = json.dumps(resumed[0], sort_keys=True).lower()
    assert "mempalace" not in serialized
    assert "semantic_payload" not in serialized
    assert "payload injection" not in serialized

    continued = ReferenceCycle(Checkpointer(db_path=cp.db_path)).step(
        session_id=SID,
        run_id=RID,
        agent="annie",
        result=owner_result(resumed[0], FRAME),
    )
    assert continued["action"] == "invoke_agent"
    assert continued["state_id"] == "planning"


def test_unknown_mode_fails_closed_without_error_or_completion(tmp_path, monkeypatch):
    cp = Checkpointer(db_path=tmp_path / "orchestration.sqlite3")
    monkeypatch.setenv("PENNY_ARTIFACT_DISPATCH_MODE", "legacy-semantic")

    directive = ReferenceCycle(cp).start(
        session_id=SID,
        run_id=RID,
        goal="invalid mode must not dispatch",
    )

    assert directive["action"] == "paused"
    assert directive["code"] == "ARTIFACT_DISPATCH_MODE_INVALID"
    assert directive["retryable"] is True
    assert "agent" not in directive and "tasks" not in directive
    record = cp.load(RID)
    assert record is not None
    assert record.status == STATUS_RUNNING
    assert record.current_state_id == "observing"
    assert record.context.complete is False
    assert record.context.errors == []


class _ToolMachine(StateMachine):
    intake = State(initial=True)
    tooling = State()
    working = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(tooling)
    tool_done = tooling.to(working)
    work_done = working.to(complete)
    to_unknown = working.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(working)
    abort = (
        tooling.to(error) | working.to(error) | unknown.to(error) | awaiting_clarification.to(error)
    )


_WORK = PrimitiveSpec(
    "WORK",
    "echo",
    {"required": {"worked": bool}, "optional": {}},
    "work after the tool",
)


class _ToolPlaybook(BasePlaybook):
    NAME = "track-a-tool-pause"
    machine_cls = _ToolMachine
    TOOL_STATES = frozenset({"tooling"})
    PRIMITIVE_BY_STATE = {"working": _WORK}
    dispatch_count = 0

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "tooling"

    def run_tool_state(self, state, ctx):
        type(self).dispatch_count += 1
        self.sm.send("tool_done")

    def route_after(self, state, ctx, summary):
        self.sm.send("work_done")


class _FanMachine(StateMachine):
    intake = State(initial=True)
    fanning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(fanning)
    fan_done = fanning.to(complete)
    to_unknown = fanning.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(fanning)
    abort = fanning.to(error) | unknown.to(error) | awaiting_clarification.to(error)


_BRANCH = {"required": {"passed": bool, "confidence": str}, "optional": {}}


class _FanPlaybook(BasePlaybook):
    NAME = "track-a-fan-pause"
    machine_cls = _FanMachine
    PARALLEL_BY_STATE = {
        "fanning": ParallelSpec(
            branches={
                "one": PrimitiveSpec("ONE", "echo", _BRANCH, "branch one"),
                "two": PrimitiveSpec("TWO", "vera", _BRANCH, "branch two"),
            }
        )
    }

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "fanning"

    def route_after(self, state, ctx, summary):
        self.sm.send("fan_done")


def test_pause_blocks_tool_and_fan_out_then_active_recovery_dispatches(tmp_path, monkeypatch):
    monkeypatch.setenv("PENNY_ARTIFACT_DISPATCH_MODE", "paused")
    _ToolPlaybook.dispatch_count = 0
    tool_cp = Checkpointer(db_path=tmp_path / "tool.sqlite3")
    fan_cp = Checkpointer(db_path=tmp_path / "fan.sqlite3")
    _register(monkeypatch, _ToolPlaybook)
    _register(monkeypatch, _FanPlaybook)

    tool_pause = _ToolPlaybook(tool_cp).start(
        session_id="tool-session", run_id="tool-run", goal="do not execute"
    )
    fan_pause = _FanPlaybook(fan_cp).start(
        session_id="fan-session", run_id="fan-run", goal="do not fan"
    )
    assert tool_pause["action"] == fan_pause["action"] == "paused"
    assert _ToolPlaybook.dispatch_count == 0
    assert "tasks" not in fan_pause
    assert tool_cp.load("tool-run").current_state_id == "tooling"
    assert fan_cp.load("fan-run").current_state_id == "fanning"

    monkeypatch.setenv("PENNY_ARTIFACT_DISPATCH_MODE", "active")
    tool_resumed = recover_pending(
        Checkpointer(db_path=tool_cp.db_path),
        session_id="tool-session",
        playbook=_ToolPlaybook.NAME,
    )
    fan_resumed = recover_pending(
        Checkpointer(db_path=fan_cp.db_path),
        session_id="fan-session",
        playbook=_FanPlaybook.NAME,
    )
    assert _ToolPlaybook.dispatch_count == 1
    assert tool_resumed[0]["action"] == "invoke_agent"
    assert tool_resumed[0]["state_id"] == "working"
    assert fan_resumed[0]["action"] == "invoke_agents_parallel"
    assert {task["branch_id"] for task in fan_resumed[0]["tasks"]} == {"one", "two"}
