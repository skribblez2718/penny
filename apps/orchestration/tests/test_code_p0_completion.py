"""End-to-end fail-closed P0 completion predicate tests."""

import hashlib
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest

from orchestration.checkpointer import Checkpointer
from orchestration.code_artifacts import (
    QUALITY_DIMENSION_IDS,
    ArtifactEnvelope,
    ArtifactRegistry,
    ArtifactRef,
    SelectionConflictError,
    new_quality_floor,
    new_quality_floor_status,
    selected_release_input_identity,
    sha256_json,
    sign_trusted_human_event,
    validate_p0_completion,
)
from orchestration.execution_receipts import build_receipt
from orchestration.scope_preservation import capture_preservation_artifact


def _select(
    registry: ArtifactRegistry,
    kind: str,
    payload: dict,
    *,
    upstream: tuple[ArtifactRef, ...] = (),
    authority: str = "test",
) -> ArtifactRef:
    reference = registry.create_and_register(
        kind=kind,
        producer="test",
        authority=authority,
        payload=payload,
        upstream_refs=upstream,
    )
    return reference


def _complete_registry(tmp_path: Path, monkeypatch) -> ArtifactRegistry:
    run_id = "run-complete"
    key = b"completion-owner-key-32-bytes!!!"
    monkeypatch.setenv("PENNY_RECEIPT_HMAC_KEY", key.hex())
    monkeypatch.setenv("PENNY_APPROVAL_HMAC_KEY", key.hex())
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.invalid"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    dirty = tmp_path / "dirty.txt"
    dirty.write_text("before\n")
    (tmp_path / "clean.txt").write_text("clean baseline\n")
    subprocess.run(["git", "add", "dirty.txt", "clean.txt"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=tmp_path, check=True)
    dirty.write_text("pre-existing dirty bytes\n")
    preservation_directory = tmp_path.parent / f"{tmp_path.name}-preservation"
    preservation = capture_preservation_artifact(tmp_path, preservation_directory)
    preservation["artifact_directory"] = str(preservation_directory)

    registry = ArtifactRegistry(Checkpointer(db_path=tmp_path / "orchestration.db"), run_id)

    ideal = _select(
        registry,
        "ideal_state_revision",
        {
            "schema_version": 1,
            "criteria": ["all selected P0 contracts are satisfied"],
        },
    )
    profile = _select(
        registry,
        "target_profile",
        {
            "schema_version": 1,
            "status": "selected",
            "languages": ["custom-language"],
            "framework_runtime": ["custom-runtime"],
            "target_scope": ["src"],
            "tooling": {
                "package": ["native-tool"],
                "build": ["native-build"],
                "test": ["native-test"],
                "lint": ["native-lint"],
                "type": ["native-typecheck"],
            },
            "verification_commands": ["native-test --all"],
            "conventions": [
                {
                    "name": "style",
                    "value": "project-native",
                    "source_evidence": "explicit caller profile",
                }
            ],
            "confidence": "CERTAIN",
            "source_evidence": ["explicit caller profile"],
            "unverified_reasons": [],
        },
    )
    floor_payload = new_quality_floor()
    floor = _select(registry, "quality_floor", floor_payload)
    pre_plan_refs = {
        "quality_floor": floor.to_dict(),
        "target_profile": profile.to_dict(),
        "ideal_state_revision": ideal.to_dict(),
    }
    plan = _select(
        registry,
        "piper_plan",
        {
            "schema_version": 1,
            "content_status": "verified",
            "content": "complete selected plan",
            "selected_refs": pre_plan_refs,
        },
        upstream=(ideal, profile, floor),
    )
    criteria_questions = [{"id": "criteria", "prompt": "approve?"}]
    criteria_transport = _select(
        registry,
        "questionnaire_transport",
        {
            "gate_id": "criteria_gate",
            "challenge": "criteria-challenge-0123456789abcdef",
            "artifact_ref": ideal.to_dict(),
            "questions": criteria_questions,
            "rendered_questions_digest": sha256_json(criteria_questions),
            "transport": "structural-json-terminal-safe",
        },
        upstream=(ideal,),
        authority="trusted-questionnaire-transport",
    )
    criteria_event = {
        "schema_version": 2,
        "origin": "trusted-human-ui",
        "run_id": run_id,
        "gate_id": "criteria_gate",
        "challenge": "criteria-challenge-0123456789abcdef",
        "artifact_ref": ideal.to_dict(),
        "questionnaire_transport_ref": criteria_transport.to_dict(),
        "rendered_questions_digest": sha256_json(criteria_questions),
        "actor": "human:test-reviewer",
        "timestamp": "2026-08-02T00:00:00+00:00",
        "decision": "approve",
        "response": "accept",
        "signature": "",
    }
    criteria_event["signature"] = sign_trusted_human_event(criteria_event, key)
    _select(
        registry,
        "criteria_approval",
        criteria_event,
        upstream=(ideal, criteria_transport),
    )
    plan_questions = [{"id": "plan", "prompt": "approve?"}]
    plan_transport = _select(
        registry,
        "questionnaire_transport",
        {
            "gate_id": "plan_gate",
            "challenge": "plan-challenge-0123456789abcdef012",
            "artifact_ref": plan.to_dict(),
            "questions": plan_questions,
            "rendered_questions_digest": sha256_json(plan_questions),
            "transport": "structural-json-terminal-safe",
        },
        upstream=(plan,),
        authority="trusted-questionnaire-transport",
    )
    plan_event = {
        "schema_version": 2,
        "origin": "trusted-human-ui",
        "run_id": run_id,
        "gate_id": "plan_gate",
        "challenge": "plan-challenge-0123456789abcdef012",
        "artifact_ref": plan.to_dict(),
        "questionnaire_transport_ref": plan_transport.to_dict(),
        "rendered_questions_digest": sha256_json(plan_questions),
        "actor": "human:test-reviewer",
        "timestamp": "2026-08-02T00:00:00+00:00",
        "decision": "approve",
        "response": "approve",
        "signature": "",
    }
    plan_event["signature"] = sign_trusted_human_event(plan_event, key)
    _select(
        registry,
        "plan_approval",
        plan_event,
        upstream=(plan, plan_transport),
    )
    _select(
        registry,
        "echo_exploration",
        {
            "schema_version": 1,
            "content": "evidence",
            "content_status": "verified",
            "selected_refs": pre_plan_refs,
        },
    )
    _select(
        registry,
        "annie_findings",
        {
            "schema_version": 1,
            "content": "complete findings",
            "content_status": "verified",
            "findings": [],
            "selected_refs": pre_plan_refs,
        },
    )
    _select(
        registry,
        "criteria_review",
        {"schema_version": 1, "selected_refs": pre_plan_refs},
    )

    selected_refs = {
        kind: registry.selected(kind).to_dict()
        for kind in (
            "quality_floor",
            "target_profile",
            "ideal_state_revision",
            "piper_plan",
        )
    }
    implementation = _select(
        registry,
        "implementation",
        {"schema_version": 1, "selected_refs": selected_refs},
        upstream=(ideal, profile, floor, plan),
    )

    obligation_ids = [
        "criterion:1",
        *[f"quality:{item}" for item in QUALITY_DIMENSION_IDS],
        "verification:unit",
        "verification:full-evals",
    ]
    coverage_entries = []
    receipt_refs: list[ArtifactRef] = []
    judgment_ids = {
        "quality:harmful_duplication_avoidance",
        "quality:unnecessary_complexity_avoidance",
    }
    for index, obligation_id in enumerate(obligation_ids, start=1):
        if obligation_id in judgment_ids:
            disposition = {
                "schema_version": 1,
                "run_id": run_id,
                "obligation_id": obligation_id,
                "finding_id": None,
                "evidence_refs": [implementation.artifact_id],
                "rationale": "Independent review found no harmful duplication or unnecessary complexity.",
                "final_disposition": "satisfied",
                "reviewer_identity": "agent:carren",
                "reviewer_model": "provider/reviewer",
                "evidence_author_identity": "agent:skribble",
                "evidence_author_model": "provider/author",
                "execution_actor_identity": "agent:vera",
                "execution_actor_model": "provider/executor",
                "timestamp": "2026-08-02T00:00:01+00:00",
                "redaction_state": "redacted",
            }
            artifact_id = f"disposition:{sha256_json(disposition)}"
            envelope = ArtifactEnvelope.create(
                run_id=run_id,
                kind="security_disposition",
                version=len(registry.checkpointer.list_artifacts(run_id, "security_disposition"))
                + 1,
                payload=disposition,
                producer="agent:carren",
                authority="trusted-invocation-provenance",
                artifact_id=artifact_id,
                upstream_refs=(implementation,),
            )
            disposition_ref = registry.register(envelope, select=False)
            coverage_entries.append(
                {
                    "id": obligation_id,
                    "evidence_class": "judgment-only",
                    "status": "satisfied",
                    "evidence_refs": [disposition_ref.artifact_id],
                }
            )
            continue
        receipt = build_receipt(
            receipt_id=f"receipt-{index}",
            run_id=run_id,
            state_id="verifying",
            obligation_id=obligation_id,
            argv=(
                ["native-full-evals", "--json"]
                if obligation_id in {"quality:regression_freedom", "verification:full-evals"}
                else (
                    ["bash", "-lc", "native-test --all"]
                    if obligation_id == "verification:unit"
                    else ["native-test", "--all"]
                )
            ),
            working_directory=str(tmp_path),
            executor_identity="agent:skribble",
            execution_owner_identity="skill-extension-execution-owner",
            started_at="2026-08-02T00:00:00+00:00",
            ended_at="2026-08-02T00:00:01+00:00",
            exit_status=0,
            output_artifact_ref=f"test://receipt-{index}/output",
            output="pass",
            secret_values=[],
            key=key,
        )
        receipt_ref = _select(registry, "execution_receipt", receipt)
        receipt_refs.append(receipt_ref)
        coverage_entries.append(
            {
                "id": obligation_id,
                "evidence_class": "command-verifiable",
                "status": "satisfied",
                "evidence_refs": [receipt_ref.artifact_id],
            }
        )
    verification = _select(
        registry,
        "verification_result",
        {
            "schema_version": 1,
            "passed": True,
            "final_battery": True,
            "selected_refs": selected_refs,
        },
        upstream=(implementation, *receipt_refs),
    )
    _select(
        registry,
        "learning_result",
        {"schema_version": 1, "selected_refs": selected_refs},
        upstream=(verification,),
    )
    coverage_payload = {
        "schema_version": 1,
        "run_id": run_id,
        "obligations": coverage_entries,
        "selected_refs": selected_refs,
    }
    coverage_ref = _select(
        registry,
        "coverage_map",
        coverage_payload,
        upstream=(verification, *receipt_refs),
    )
    _select(
        registry,
        "quality_floor_status",
        new_quality_floor_status(floor, coverage_ref, coverage_payload),
        upstream=(floor, coverage_ref),
    )
    scope_unsigned = {
        "schema_version": 1,
        "manifest_id": "test-scope",
        "version": 1,
        "in_scope_tracked_paths": ["dummy.py"],
        "writable_paths": ["dummy.py"],
        "leak_patterns": [],
        "leak_fixtures": [],
        "allowed_generic_cases": [],
        "ignored_runtime_outputs": ["orchestration.db*"],
        "out_of_scope_reporting_boundary": "tracked files outside selected scope",
    }
    _select(registry, "scope_leak_manifest", scope_unsigned)
    _select(registry, "worktree_preservation", preservation)
    worktree_records = preservation["paths"]
    raw_eval_output = tmp_path.parent / f"{tmp_path.name}-baseline.raw.json"
    raw_eval_output.write_bytes(b'{"exit_status":0,"stderr":"","stdout":"pass"}')
    raw_eval_output.chmod(0o600)
    verification_manifest = {
        "schema_version": 2,
        "manifest_id": "test-verification",
        "version": 1,
        "selected": True,
        "checks": {
            "unit": ["native-test", "--all"],
            "full-evals": ["native-full-evals", "--json"],
        },
        "criterion_map": {"criterion:1": ["unit"]},
        "quality_dimension_map": {
            dimension_id: (["full-evals"] if dimension_id == "regression_freedom" else ["unit"])
            for dimension_id in QUALITY_DIMENSION_IDS
        },
        "evidence_class_map": {
            "criterion:1": "command-verifiable",
            **{
                f"quality:{dimension_id}": (
                    "judgment-only"
                    if dimension_id
                    in {
                        "harmful_duplication_avoidance",
                        "unnecessary_complexity_avoidance",
                    }
                    else "command-verifiable"
                )
                for dimension_id in QUALITY_DIMENSION_IDS
            },
        },
        "annie_obligation_source": "selected:annie_findings",
        "annie_obligation_checks": ["unit"],
    }
    drift_matrix = {
        "schema_version": 1,
        "matrix_id": "test-contract-drift",
        "version": 1,
    }
    baseline_unsigned = {
        "schema_version": 2,
        "immutable": True,
        "captured_at": "2026-08-02T00:00:00+00:00",
        "command_argv": ["native-full-evals", "--json"],
        "working_directory": str(tmp_path),
        "source_identity": {
            "head": preservation["head"],
            "worktree_digest": sha256_json(worktree_records),
            "worktree_records": worktree_records,
        },
        "selected_inputs": {
            "scope_leak_manifest": selected_release_input_identity(
                "scope_leak_manifest", scope_unsigned
            ),
            "verification_manifest": selected_release_input_identity(
                "verification_manifest", verification_manifest
            ),
            "contract_drift_matrix": selected_release_input_identity(
                "contract_drift_matrix", drift_matrix
            ),
        },
        "normalized_outcomes": {"results": [{"name": "baseline-eval", "status": "PASS"}]},
        "comparator": {"id": "p0-full-eval-v1", "frozen": True},
        "raw_output_ref": str(raw_eval_output),
        "raw_output_digest": hashlib.sha256(raw_eval_output.read_bytes()).hexdigest(),
    }
    _select(
        registry,
        "eval_baseline",
        {**baseline_unsigned, "digest": sha256_json(baseline_unsigned)},
    )
    _select(registry, "p0_verification_manifest", verification_manifest)
    _select(registry, "contract_drift_matrix", drift_matrix)
    return registry


def test_complete_registry_passes_single_completion_predicate(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    assert (
        validate_p0_completion(registry=registry, criteria_count=1, project_root=str(tmp_path))
        == []
    )


def test_completion_fails_if_preexisting_dirty_bytes_change(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    (tmp_path / "dirty.txt").write_text("mutated by implementation\n")
    errors = validate_p0_completion(registry=registry, criteria_count=1, project_root=str(tmp_path))
    assert any("dirty.txt: direct byte comparison failed" in error for error in errors)


def test_completion_fails_if_new_out_of_scope_dirty_path_appears(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    (tmp_path / "clean.txt").write_text("new out-of-scope mutation\n")

    errors = validate_p0_completion(registry=registry, criteria_count=1, project_root=str(tmp_path))
    assert any("out-of-scope dirty path set changed" in error for error in errors)


def test_completion_rejects_agent_authored_residual_acceptance_without_trusted_artifact(
    tmp_path, monkeypatch
):
    registry = _complete_registry(tmp_path, monkeypatch)
    prior = registry.get(registry.selected("annie_findings"))
    acceptance = {
        "finding_id": "ANNIE-H1",
        "scope": "receipt owner isolation",
        "rationale": "agent cannot authorize this risk",
        "accepter": "human:claimed",
        "timestamp": "2026-08-02T00:00:00+00:00",
        "run_id": "run-complete",
        "authorization_ref": "missing-trusted-artifact",
    }
    registry.create_and_register(
        kind="annie_findings",
        payload={
            **prior.payload,
            "findings": [
                {
                    "id": "ANNIE-H1",
                    "state": "human_accepted_residual_risk",
                    "evidence_class": "judgment-only",
                    "acceptance": acceptance,
                }
            ],
        },
        producer="agent:skribble",
        authority="finding-state-validator",
        upstream_refs=prior.upstream_refs,
    )
    errors = validate_p0_completion(registry, criteria_count=1, project_root=str(tmp_path))
    assert any("no durable trusted-human authorization" in error for error in errors)


def test_completion_rejects_baseline_command_outside_selected_manifest(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    prior = registry.get(registry.selected("eval_baseline"))
    replacement = deepcopy(prior.payload)
    replacement["command_argv"] = ["unselected-eval-command"]
    unsigned = {key: value for key, value in replacement.items() if key != "digest"}
    replacement["digest"] = sha256_json(unsigned)
    with pytest.raises(SelectionConflictError, match="cannot be reset"):
        registry.create_and_register(
            kind="eval_baseline",
            payload=replacement,
            producer="test",
            authority="test",
            upstream_refs=prior.upstream_refs,
        )


def test_completion_rejects_selected_manifest_same_identity_content_drift(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    prior = registry.get(registry.selected("p0_verification_manifest"))
    registry.create_and_register(
        kind="p0_verification_manifest",
        payload={**prior.payload, "version": prior.payload["version"] + 1},
        producer="test",
        authority="test",
        upstream_refs=prior.upstream_refs,
    )

    errors = validate_p0_completion(registry, criteria_count=1, project_root=str(tmp_path))
    assert "selected verification_manifest identity/version/digest changed" in errors


def test_completion_rejects_model_controlled_questionnaire_transport(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    key = b"completion-owner-key-32-bytes!!!"
    ideal_ref = registry.selected("ideal_state_revision")
    prior = registry.get(registry.selected("criteria_approval"))
    trusted_transport_ref = next(
        reference
        for reference in prior.upstream_refs
        if reference.kind == "questionnaire_transport"
    )
    trusted_transport = registry.get(trusted_transport_ref)
    rogue_transport_ref = _select(
        registry,
        "questionnaire_transport",
        deepcopy(trusted_transport.payload),
        upstream=(ideal_ref,),
        authority="agent-controlled",
    )
    forged = {
        **prior.payload,
        "questionnaire_transport_ref": rogue_transport_ref.to_dict(),
        "signature": "",
    }
    forged["signature"] = sign_trusted_human_event(forged, key)
    registry.create_and_register(
        kind="criteria_approval",
        payload=forged,
        producer="human:test-reviewer",
        authority="trusted-human-ui",
        upstream_refs=(ideal_ref, rogue_transport_ref),
    )

    errors = validate_p0_completion(registry, criteria_count=1, project_root=str(tmp_path))
    assert "criteria_approval questionnaire transport is incomplete or stale" in errors


def test_completion_rejects_signed_deny_as_plan_approval(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    key = b"completion-owner-key-32-bytes!!!"
    prior = registry.get(registry.selected("plan_approval"))
    denied = {**prior.payload, "decision": "deny", "response": "deny", "signature": ""}
    denied["signature"] = sign_trusted_human_event(denied, key)
    registry.create_and_register(
        kind="plan_approval",
        payload=denied,
        producer="trusted-human-ui",
        authority="trusted-human-ui",
        upstream_refs=prior.upstream_refs,
    )

    errors = validate_p0_completion(registry, criteria_count=1, project_root=str(tmp_path))
    assert any("plan_approval does not record an explicit approve" in error for error in errors)


def test_completion_rejects_exit_zero_receipt_for_unmapped_noop_command(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    key = b"completion-owner-key-32-bytes!!!"
    noop = build_receipt(
        receipt_id="receipt-noop",
        run_id="run-complete",
        state_id="verifying",
        obligation_id="criterion:1",
        argv=["echo", "PASS"],
        working_directory=str(tmp_path),
        executor_identity="agent:skribble",
        execution_owner_identity="skill-extension-execution-owner",
        started_at="2026-08-02T00:00:00+00:00",
        ended_at="2026-08-02T00:00:01+00:00",
        exit_status=0,
        output_artifact_ref="test://noop/output",
        output="PASS",
        secret_values=[],
        key=key,
    )
    noop_ref = _select(registry, "execution_receipt", noop)
    prior = registry.get(registry.selected("coverage_map"))
    replacement = deepcopy(prior.payload)
    criterion = next(item for item in replacement["obligations"] if item["id"] == "criterion:1")
    criterion["evidence_refs"] = [noop_ref.artifact_id]
    registry.create_and_register(
        kind="coverage_map",
        payload=replacement,
        producer="test",
        authority="test",
        upstream_refs=prior.upstream_refs,
    )
    errors = validate_p0_completion(registry, criteria_count=1, project_root=str(tmp_path))
    assert any("criterion:1: receipt command is not authorized" in error for error in errors)


def test_completion_fails_if_selected_verification_is_not_final(tmp_path, monkeypatch):
    registry = _complete_registry(tmp_path, monkeypatch)
    prior = registry.get(registry.selected("verification_result"))
    registry.create_and_register(
        kind="verification_result",
        producer="test",
        authority="test",
        payload={**prior.payload, "final_battery": False},
        upstream_refs=prior.upstream_refs,
    )
    errors = validate_p0_completion(registry=registry, criteria_count=1, project_root=str(tmp_path))
    assert "final verification battery has not passed" in errors
