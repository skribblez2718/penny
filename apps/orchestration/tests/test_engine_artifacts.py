"""ART-05/ART-06 orchestration integration and recovery tests."""

from __future__ import annotations

import json

import pytest
from statemachine import State, StateMachine

from artifact_protocol_helpers import TEST_RECEIPT_KEY_HEX, owner_result
from orchestration import playbooks as playbook_module
from orchestration.artifact_cli import put_output_artifact
from orchestration.artifacts import (
    ArtifactRef,
    ArtifactStore,
    ArtifactValidationError,
    InputArtifactBinding,
    InputArtifactsV1,
    OutputArtifactMetadata,
)
from orchestration.checkpointer import STATUS_RUNNING, Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.execution_receipts import sign_receipt
from orchestration.playbooks import ReferenceCycle
from orchestration.primitives.spec import ParallelSpec, PrimitiveSpec
from orchestration.recovery import recover_pending

SID = "artifact-session"
RID = "artifact-run"
OBSERVE = {"observe_complete": True, "confidence": "PROBABLE"}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orchestration.sqlite3")


def _start_reference(cp):
    return ReferenceCycle(cp).start(session_id=SID, run_id=RID, goal="verify artifacts")


def _step_reference(cp, directive, summary=OBSERVE, **kwargs):
    result = owner_result(directive, summary, **kwargs)
    return ReferenceCycle(cp).step(
        session_id=SID,
        run_id=RID,
        agent=str(directive["agent"]),
        result=result,
    )


def test_directives_bind_stable_operation_revision_upstreams_and_consumer(cp):
    first = _start_reference(cp)
    output_v1 = OutputArtifactMetadata.from_dict(first["output_artifact"])
    inputs_v1 = InputArtifactsV1.from_dict(first["input_artifacts"])
    assert output_v1.version == 1 and output_v1.parent_ref is None
    assert output_v1.upstream_refs == () and inputs_v1.artifacts == ()
    assert output_v1.consumer_scope == ("state:framing", "state:observing")

    sentinel = "VALID_OWNER_PAYLOAD_MUST_NOT_ENTER_CHECKPOINT"
    second = _step_reference(
        cp,
        first,
        output=f'{sentinel}\nSUMMARY:{{"observe_complete":true,"confidence":"PROBABLE"}}',
    )
    assert sentinel not in json.dumps(cp.load(RID).context.to_dict(), sort_keys=True)
    selected = ArtifactRef.from_dict(
        cp.load(RID).context.extras["artifact_protocol"]["selected_refs"][0]
    )
    inputs_v2 = InputArtifactsV1.from_dict(second["input_artifacts"])
    output_v2 = OutputArtifactMetadata.from_dict(second["output_artifact"])
    assert inputs_v2.run_id == RID and inputs_v2.consumer == "state:framing"
    assert tuple(binding.ref for binding in inputs_v2.artifacts) == (selected,)
    assert output_v2.upstream_refs == (selected,)
    assert output_v2.consumer_scope == ("state:framing", "state:planning")


def test_pairwise_wrong_legitimate_phase_grants_are_rejected(cp):
    playbook = ReferenceCycle(cp)
    playbook.start(session_id=SID, run_id=RID, goal="scope matrix")
    expected = {
        "observing": {"state:observing", "state:framing"},
        "framing": {"state:framing", "state:planning"},
        "planning": {"state:planning", "state:acting"},
        "acting": {"state:acting", "state:verifying"},
        "verifying": {"state:verifying", "state:acting", "state:learning"},
        "learning": {"state:learning", "state:complete"},
    }
    legitimate_consumers = {f"state:{state}" for state in ReferenceCycle.PRIMITIVE_BY_STATE} | {
        "state:complete"
    }

    for state, spec in ReferenceCycle.PRIMITIVE_BY_STATE.items():
        metadata = playbook._output_metadata(state, spec.agent, None)
        assert set(metadata.consumer_scope) == expected[state]
        ref = put_output_artifact(metadata, f"{state}\nSUMMARY:{{}}".encode())
        for wrong_consumer in legitimate_consumers - expected[state]:
            with pytest.raises(ArtifactValidationError, match="does not grant the consumer"):
                InputArtifactsV1(
                    schema_version=1,
                    run_id=RID,
                    consumer=wrong_consumer,
                    artifacts=(InputArtifactBinding(slot="wrong-phase", ref=ref),),
                )


def test_selected_ref_is_checkpointed_before_malformed_summary_retry_without_payload(cp):
    directive = _start_reference(cp)
    sentinel = "OWNER_PAYLOAD_MUST_NOT_ENTER_CHECKPOINT"
    retry = _step_reference(
        cp,
        directive,
        {},
        output=f"{sentinel}\nSUMMARY:{{}}",
    )
    assert retry["action"] == "invoke_agent" and retry["state_id"] == "observing"
    first = OutputArtifactMetadata.from_dict(directive["output_artifact"])
    revision = OutputArtifactMetadata.from_dict(retry["output_artifact"])
    assert revision.operation_id == first.operation_id
    assert revision.version == 2
    assert revision.parent_ref is not None and revision.parent_ref.version == 1
    assert revision.consumer_scope == first.consumer_scope
    assert "state:observing" in revision.consumer_scope

    context_json = json.dumps(cp.load(RID).context.to_dict(), sort_keys=True)
    assert sentinel not in context_json
    artifact_state = cp.load(RID).context.extras["artifact_protocol"]
    assert artifact_state["schema_version"] == 2
    assert len(artifact_state["selected_refs"]) == 1


def test_fresh_process_recovers_exact_selected_input_ref(cp):
    first = _start_reference(cp)
    second = _step_reference(cp, first)
    expected = second["input_artifacts"]

    fresh = Checkpointer(db_path=cp.db_path)
    directives = recover_pending(fresh, session_id=SID, playbook="reference-cycle")
    assert len(directives) == 1
    assert directives[0]["state_id"] == "framing"
    assert directives[0]["input_artifacts"] == expected


def test_restart_rejects_stale_checkpoint_with_wrong_legitimate_phase_ref(cp):
    observing = _start_reference(cp)
    _step_reference(cp, observing)
    record = cp.load(RID)
    selected = record.context.extras["artifact_protocol"]["selected_refs"][0]
    record.context.extras["artifact_protocol"]["state_inputs"]["acting"] = [selected]
    cp.save(
        run_id=RID,
        session_id=SID,
        playbook=record.playbook,
        current_state_id="acting",
        context=record.context,
        status=STATUS_RUNNING,
    )

    recovered = recover_pending(
        Checkpointer(db_path=cp.db_path),
        session_id=SID,
        playbook="reference-cycle",
    )
    assert len(recovered) == 1 and recovered[0]["action"] == "error"
    assert "does not grant the producer state" in recovered[0]["errors"][0]


def test_canonical_receipt_ref_binding_rejects_reserialized_substitute(cp):
    directive = _start_reference(cp)
    result = owner_result(directive, OBSERVE)
    receipt = result["execution_receipt"]
    receipt["output_artifact_ref"] = json.dumps(
        result["output_artifact_ref"], sort_keys=True, indent=2
    )
    receipt["signature"] = sign_receipt(receipt, bytes.fromhex(TEST_RECEIPT_KEY_HEX))
    result["receipts"][0] = receipt

    retry = ReferenceCycle(cp).step(session_id=SID, run_id=RID, agent="echo", result=result)
    assert retry["action"] == "invoke_agent" and retry["state_id"] == "observing"
    assert cp.load(RID).context.extras["artifact_protocol"]["selected_refs"] == []


def test_unsupported_result_and_checkpoint_versions_fail_loud(cp):
    directive = _start_reference(cp)
    result = owner_result(directive, OBSERVE)
    result["protocol_version"] = 3
    failed = ReferenceCycle(cp).step(session_id=SID, run_id=RID, agent="echo", result=result)
    assert failed["action"] == "error"
    assert any("unsupported result protocol" in error for error in failed["errors"])

    other_run = "checkpoint-version-run"
    first = ReferenceCycle(cp).start(session_id=SID, run_id=other_run, goal="x")
    record = cp.load(other_run)
    record.context.extras["artifact_protocol"]["schema_version"] = 99
    cp.save(
        run_id=other_run,
        session_id=SID,
        playbook=record.playbook,
        current_state_id=record.current_state_id,
        context=record.context,
        status=STATUS_RUNNING,
    )
    recovered = recover_pending(cp, session_id=SID, playbook="reference-cycle")
    assert any(
        directive["action"] == "error"
        and "unsupported artifact checkpoint" in directive["errors"][0]
        for directive in recovered
    )
    failed = ReferenceCycle(cp).step(
        session_id=SID,
        run_id=other_run,
        agent="echo",
        result=owner_result(first, OBSERVE),
    )
    assert failed["action"] == "error"
    assert any("unsupported artifact checkpoint" in error for error in failed["errors"])


def test_summary_artifact_claim_cannot_replace_outer_owner_wrapper(cp, monkeypatch):
    monkeypatch.delenv("PENNY_ORCH_TEST_ALLOW_PROGRAMMATIC_RESULTS", raising=False)
    directive = _start_reference(cp)
    fake_ref = directive["output_artifact"]
    result = {**OBSERVE, "output_artifact_ref": fake_ref}
    retry = ReferenceCycle(cp).step(session_id=SID, run_id=RID, agent="echo", result=result)
    assert retry["action"] == "invoke_agent" and retry["state_id"] == "observing"
    assert cp.load(RID).context.extras["artifact_protocol"]["selected_refs"] == []


def test_cas_conflict_fails_without_overwriting_selected_ref(cp):
    directive = _start_reference(cp)
    expected = OutputArtifactMetadata.from_dict(directive["output_artifact"])
    conflict_value = expected.to_dict()
    conflict_value["operation_id"] = "conflicting-owner-operation"
    conflict = OutputArtifactMetadata.from_dict(conflict_value)
    conflict_ref = put_output_artifact(conflict, b"conflict\nSUMMARY:{}")
    ArtifactStore().select(conflict_ref, expected=None)

    result = owner_result(directive, OBSERVE)
    failed = ReferenceCycle(cp).step(session_id=SID, run_id=RID, agent="echo", result=result)
    assert failed["action"] == "error"
    selected = ArtifactStore().get_selected(
        run_id=RID,
        phase="observing",
        branch_id=None,
        kind="agent-output",
    )
    assert selected == conflict_ref


class FanMachine(StateMachine):
    intake = State(initial=True)
    scanning = State()
    complete = State(final=True)
    error = State(final=True)
    start_scan = intake.to(scanning)
    finish_scan = scanning.to(complete)
    abort = scanning.to(error)


BRANCH_CONTRACT = {
    "required": {"passed": bool, "confidence": str},
    "optional": {},
}
ALPHA = PrimitiveSpec("ALPHA", "echo", BRANCH_CONTRACT, "alpha scan")
BETA = PrimitiveSpec("BETA", "vera", BRANCH_CONTRACT, "beta scan")


class ArtifactFanPlaybook(BasePlaybook):
    NAME = "artifact-fan-test"
    machine_cls = FanMachine
    PARALLEL_BY_STATE = {"scanning": ParallelSpec(branches={"alpha": ALPHA, "beta": BETA})}

    def initial_transition(self, ctx):
        self.sm.send("start_scan")
        return "scanning"

    def route_after(self, state, ctx, summary):
        ctx.extras["fan_result"] = summary
        self.sm.send("finish_scan")

    def done_predicate(self, ctx):
        return True


class InvalidArtifactScopePlaybook(ArtifactFanPlaybook):
    NAME = "invalid-artifact-scope-test"

    def artifact_input_phases(self, ctx):
        return {"scanning": ("legitimate-looking-but-unknown",)}


class UnreachableArtifactScopePlaybook(ReferenceCycle):
    NAME = "unreachable-artifact-scope-test"

    def artifact_input_phases(self, ctx):
        return {"observing": ("learning",)}


def _fan_start(cp):
    return ArtifactFanPlaybook(cp).start(session_id=SID, run_id=RID, goal="fan")


def _fan_step(cp, entries):
    return ArtifactFanPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="__parallel__", result=entries
    )


def _branch(directive, branch_id, confidence="CERTAIN"):
    return owner_result(
        directive,
        {"passed": True, "confidence": confidence},
        branch_id=branch_id,
    )


def test_explicit_artifact_input_seam_fails_closed_on_unknown_phase(cp):
    failed = InvalidArtifactScopePlaybook(cp).start(
        session_id=SID, run_id=RID, goal="invalid scope"
    )
    assert failed["action"] == "error"
    assert "unknown producer state" in failed["errors"][0]


def test_explicit_artifact_input_seam_fails_closed_on_unreachable_pair(cp):
    failed = UnreachableArtifactScopePlaybook(cp).start(
        session_id=SID, run_id=RID, goal="invalid reachability"
    )
    assert failed["action"] == "error"
    assert "cannot legally reach consumer" in failed["errors"][0]


def test_parallel_fan_in_is_order_independent_and_checkpoints_exact_branch_refs(cp):
    directive = _fan_start(cp)
    scopes = {
        tuple(OutputArtifactMetadata.from_dict(task["output_artifact"]).consumer_scope)
        for task in directive["tasks"]
    }
    assert scopes == {("state:complete", "state:scanning")}
    complete = _fan_step(
        cp,
        [_branch(directive, "beta"), _branch(directive, "alpha")],
    )
    assert complete["action"] == "complete"
    result = cp.load(RID).context.extras["fan_result"]
    assert list(result["branches"]) == ["alpha", "beta"]
    selected = cp.load(RID).context.extras["artifact_protocol"]["selected_refs"]
    assert {value["branch_id"] for value in selected} == {"alpha", "beta"}


def test_parallel_partial_restart_reissues_only_missing_branch_in_fresh_process(cp):
    directive = _fan_start(cp)
    retry = _fan_step(cp, [_branch(directive, "alpha")])
    assert [task["branch_id"] for task in retry["tasks"]] == ["beta"]

    original = dict(playbook_module.PLAYBOOKS)
    playbook_module.PLAYBOOKS[ArtifactFanPlaybook.NAME] = ArtifactFanPlaybook
    try:
        fresh = Checkpointer(db_path=cp.db_path)
        recovered = recover_pending(fresh, session_id=SID, playbook=ArtifactFanPlaybook.NAME)
    finally:
        playbook_module.PLAYBOOKS.clear()
        playbook_module.PLAYBOOKS.update(original)
    assert len(recovered) == 1
    assert [task["branch_id"] for task in recovered[0]["tasks"]] == ["beta"]

    complete = _fan_step(cp, [_branch(recovered[0], "beta")])
    assert complete["action"] == "complete"


def test_parallel_rejects_duplicate_and_stale_branch_ids_without_order_coupling(cp):
    directive = _fan_start(cp)
    alpha = _branch(directive, "alpha")
    retry = _fan_step(cp, [alpha, alpha])
    assert {task["branch_id"] for task in retry["tasks"]} == {"alpha", "beta"}
    assert cp.load(RID).context.extras["artifact_protocol"]["selected_refs"] == []

    # A valid partial fan-in commits alpha; replaying that old branch is stale and
    # cannot displace or masquerade as the still-pending beta branch.
    retry = _fan_step(cp, [_branch(retry, "alpha")])
    assert [task["branch_id"] for task in retry["tasks"]] == ["beta"]
    stale = _fan_step(cp, [alpha])
    assert [task["branch_id"] for task in stale["tasks"]] == ["beta"]
    selected = cp.load(RID).context.extras["artifact_protocol"]["selected_refs"]
    assert [value["branch_id"] for value in selected] == ["alpha"]


def test_parallel_failed_sibling_preserves_successful_branch_for_restart(cp):
    directive = _fan_start(cp)
    beta = _branch(directive, "beta")
    beta["trusted_invocation"]["signature"] = "0" * 64
    retry = _fan_step(cp, [_branch(directive, "alpha"), beta])
    assert [task["branch_id"] for task in retry["tasks"]] == ["beta"]
    selected = cp.load(RID).context.extras["artifact_protocol"]["selected_refs"]
    assert [value["branch_id"] for value in selected] == ["alpha"]
