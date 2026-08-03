"""P0 artifact envelope/registry integrity and CAS tests."""

import json
import sqlite3

import pytest

from orchestration.checkpointer import Checkpointer
from orchestration.code_artifacts import (
    ARTIFACT_KINDS,
    ArtifactEnvelope,
    ArtifactRegistry,
    ArtifactValidationError,
    SelectionConflictError,
)


def test_registry_round_trips_selected_artifact_in_fresh_process(tmp_path):
    database = tmp_path / "orchestration.db"
    first = Checkpointer(db_path=database)
    registry = ArtifactRegistry(first, "run-1")
    reference = registry.create_and_register(
        kind="quality_floor",
        payload={"schema_version": 1, "dimensions": []},
        producer="test",
        authority="test-owner",
    )

    recovered = ArtifactRegistry(Checkpointer(db_path=database), "run-1")
    assert recovered.selected("quality_floor") == reference
    assert recovered.get(reference).payload == {"schema_version": 1, "dimensions": []}


def test_registry_database_is_owner_only_and_rejects_symlink_alias(tmp_path):
    database = tmp_path / ".penny" / "orchestration.db"
    database.parent.mkdir(mode=0o755)
    Checkpointer(db_path=database)
    assert database.stat().st_mode & 0o077 == 0
    assert database.parent.stat().st_mode & 0o077 == 0

    target = tmp_path / "attacker-selected.db"
    alias = tmp_path / "database-alias.db"
    alias.symlink_to(target)
    with pytest.raises(PermissionError, match="cannot be a symlink"):
        Checkpointer(db_path=alias)
    assert not target.exists()


def test_selected_eval_baseline_is_immutable_within_a_run(tmp_path):
    registry = ArtifactRegistry(Checkpointer(db_path=tmp_path / "orch.db"), "run-1")
    registry.create_and_register(
        kind="eval_baseline",
        payload={"immutable": True, "digest": "first"},
        producer="test",
        authority="execution-owner",
    )
    with pytest.raises(SelectionConflictError, match="cannot be reset"):
        registry.create_and_register(
            kind="eval_baseline",
            payload={"immutable": True, "digest": "attacker-reset"},
            producer="test",
            authority="execution-owner",
        )


def test_registry_rejects_wrong_run_unknown_future_and_tampered_payload(tmp_path):
    registry = ArtifactRegistry(Checkpointer(db_path=tmp_path / "orch.db"), "run-1")
    envelope = ArtifactEnvelope.create(
        run_id="run-1",
        kind="target_profile",
        version=1,
        payload={"status": "unverified"},
        producer="test",
        authority="test-owner",
    )
    wrong_run = envelope.to_dict()
    wrong_run["run_id"] = "run-2"
    with pytest.raises(ArtifactValidationError, match="wrong-run|digest"):
        ArtifactEnvelope.from_dict(wrong_run, expected_run_id="run-1")

    future = envelope.to_dict()
    future["schema_version"] = 99
    with pytest.raises(ArtifactValidationError, match="unsupported"):
        ArtifactEnvelope.from_dict(future)

    tampered = envelope.to_dict()
    tampered["payload"]["status"] = "selected"
    with pytest.raises(ArtifactValidationError, match="payload digest"):
        ArtifactEnvelope.from_dict(tampered)

    registry.register(envelope, select=True)
    assert registry.get(envelope.ref()).payload == {"status": "unverified"}


def test_selection_compare_and_swap_rejects_stale_writer(tmp_path):
    checkpointer = Checkpointer(db_path=tmp_path / "orch.db")
    registry = ArtifactRegistry(checkpointer, "run-1")
    first = registry.create_and_register(
        kind="target_profile", payload={"revision": 1}, producer="a", authority="owner"
    )
    second_envelope = ArtifactEnvelope.create(
        run_id="run-1",
        kind="target_profile",
        version=2,
        payload={"revision": 2},
        producer="b",
        authority="owner",
        parent_ref=first,
    )
    checkpointer.put_artifact(second_envelope.to_dict())
    checkpointer.select_artifact(
        run_id="run-1",
        kind="target_profile",
        artifact_id=second_envelope.artifact_id,
        version=2,
        expected_artifact_id=first.artifact_id,
    )
    with pytest.raises(SelectionConflictError, match="stale"):
        checkpointer.select_artifact(
            run_id="run-1",
            kind="target_profile",
            artifact_id=first.artifact_id,
            version=1,
            expected_artifact_id=first.artifact_id,
        )


def test_additive_migration_preserves_legacy_run_row(tmp_path):
    database = tmp_path / "legacy.db"
    connection = sqlite3.connect(database)
    connection.execute("""
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, playbook TEXT NOT NULL,
          current_state_id TEXT NOT NULL, context_json TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT, updated_at TEXT
        )
        """)
    context = {
        "session_id": "session",
        "run_id": "legacy",
        "playbook": "code",
    }
    connection.execute(
        "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy", "session", "code", "exploring", json.dumps(context), "running", "", ""),
    )
    connection.commit()
    connection.close()

    checkpointer = Checkpointer(db_path=database)
    assert checkpointer.load("legacy").current_state_id == "exploring"
    table_names = {
        row[0]
        for row in sqlite3.connect(database)
        .execute("SELECT name FROM sqlite_master WHERE type='table'")
        .fetchall()
    }
    assert {"runs", "artifacts", "artifact_selections"} <= table_names


def test_canonical_registry_covers_every_named_p0_artifact():
    assert {
        "scope_leak_manifest",
        "worktree_preservation",
        "quality_floor",
        "quality_floor_status",
        "target_profile",
        "echo_exploration",
        "annie_findings",
        "annie_disposition",
        "ideal_state_revision",
        "criteria_review",
        "criteria_approval",
        "piper_plan",
        "plan_approval",
        "questionnaire_transport",
        "execution_receipt",
        "implementation",
        "verification_result",
        "learning_result",
        "coverage_map",
        "security_disposition",
        "human_risk_acceptance",
        "p0_verification_manifest",
        "eval_baseline",
        "contract_drift_matrix",
        "terminal_result",
        "outcome",
    } == ARTIFACT_KINDS
