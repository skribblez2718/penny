"""Protocol conformance tests for generic workflow artifacts."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from orchestration.artifacts import (
    ArtifactEnvelope,
    ArtifactRef,
    ArtifactValidationError,
    InputArtifactsV1,
    ResultProtocolV2,
    artifact_id_for,
    canonical_json,
    sha256_digest,
)

PACKAGE_ROOT = Path(__file__).parents[1]
SCHEMA_ROOT = PACKAGE_ROOT / "schemas" / "artifacts"
FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "artifacts"


def _json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _schemas_and_registry():
    paths = sorted(SCHEMA_ROOT.glob("v*/*.schema.json"))
    schemas = [_json(path) for path in paths]
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    return list(zip(paths, schemas, strict=True)), registry


def test_versioned_json_schemas_are_valid_and_strict():
    schemas, _registry = _schemas_and_registry()
    assert [path.relative_to(SCHEMA_ROOT).as_posix() for path, _ in schemas] == [
        "v1/artifact-envelope.schema.json",
        "v1/artifact-ref.schema.json",
        "v1/input-artifacts.schema.json",
        "v2/result-protocol.schema.json",
    ]
    for _path, schema in schemas:
        Draft202012Validator.check_schema(schema)
        assert schema["additionalProperties"] is False


def test_valid_protocol_fixtures_validate_and_round_trip_exactly():
    schemas, registry = _schemas_and_registry()
    by_title = {schema["title"]: schema for _path, schema in schemas}
    cases = [
        (
            by_title["ArtifactRef v1"],
            FIXTURE_ROOT / "v1" / "artifact-ref.valid.json",
            ArtifactRef,
        ),
        (
            by_title["ArtifactEnvelope v1"],
            FIXTURE_ROOT / "v1" / "artifact-envelope.valid.json",
            ArtifactEnvelope,
        ),
        (
            by_title["Directive input_artifacts v1"],
            FIXTURE_ROOT / "v1" / "input-artifacts.valid.json",
            InputArtifactsV1,
        ),
        (
            by_title["Trusted result protocol v2"],
            FIXTURE_ROOT / "v2" / "result-protocol.valid.json",
            ResultProtocolV2,
        ),
    ]
    for schema, fixture_path, parser in cases:
        fixture = _json(fixture_path)
        Draft202012Validator(schema, registry=registry).validate(fixture)
        parsed = parser.from_dict(fixture)
        assert parsed.to_dict() == fixture
        assert json.loads(canonical_json(parsed.to_dict())) == fixture


def test_unknown_fields_and_unsupported_versions_fail_closed():
    schemas, registry = _schemas_and_registry()
    by_title = {schema["title"]: schema for _path, schema in schemas}
    cases = [
        (
            by_title["ArtifactEnvelope v1"],
            FIXTURE_ROOT / "v1" / "artifact-envelope.unknown-field.invalid.json",
            ArtifactEnvelope,
        ),
        (
            by_title["ArtifactRef v1"],
            FIXTURE_ROOT / "v1" / "artifact-ref.future-version.invalid.json",
            ArtifactRef,
        ),
    ]
    for schema, fixture_path, parser in cases:
        fixture = _json(fixture_path)
        assert list(Draft202012Validator(schema, registry=registry).iter_errors(fixture))
        with pytest.raises(ArtifactValidationError):
            parser.from_dict(fixture)


def test_canonical_sha256_and_owner_generated_identity_are_stable():
    content = b"# Findings\nExact output.\n"
    assert sha256_digest(content) == (
        "ffa37b1d5689c333201d810e76707c38fbabbe8f1a616a5e16e94ae78db50c14"
    )
    assert (
        artifact_id_for(
            run_id="run-1",
            phase="observing",
            branch_id=None,
            kind="agent-output",
            operation_id="observe-1",
            version=1,
        )
        == "art_aecc9e8a5d7e711c58ae2dda9d5b7a8673ba77bc93414d65f48ad17c8d85e927"
    )


def test_result_wrapper_matches_driver_shape_and_rejects_drift():
    fixture = _json(FIXTURE_ROOT / "v2" / "result-protocol.valid.json")
    parsed = ResultProtocolV2.from_dict(fixture)
    assert parsed.exit_code == 0
    assert parsed.summary_missing is False
    assert parsed.agent is None
    assert parsed.error is None

    unknown = {**fixture, "future_owner_field": True}
    with pytest.raises(ArtifactValidationError, match="unknown fields"):
        ResultProtocolV2.from_dict(unknown)

    missing_receipts = dict(fixture)
    missing_receipts.pop("receipts")
    with pytest.raises(ArtifactValidationError, match="missing required fields"):
        ResultProtocolV2.from_dict(missing_receipts)

    future = {**fixture, "protocol_version": 3}
    with pytest.raises(ArtifactValidationError, match="unsupported result protocol"):
        ResultProtocolV2.from_dict(future)


def test_result_optional_error_and_parallel_agent_are_shape_specific():
    fixture = _json(FIXTURE_ROOT / "v2" / "result-protocol.valid.json")
    missing = json.loads(json.dumps(fixture))
    missing["summary"] = {}
    missing["summary_missing"] = True
    missing["error"] = "no parseable SUMMARY"
    assert ResultProtocolV2.from_dict(missing).error == "no parseable SUMMARY"

    parallel = json.loads(json.dumps(fixture))
    parallel["branch_id"] = "branch-a"
    parallel["agent"] = "echo"
    parallel["output_artifact_ref"]["branch_id"] = "branch-a"
    parallel["output_artifact_ref"]["artifact_id"] = artifact_id_for(
        run_id="run-1",
        phase="observing",
        branch_id="branch-a",
        kind="agent-output",
        operation_id="observe-1",
        version=1,
    )
    assert ResultProtocolV2.from_parallel_dict(parallel).agent == "echo"
    with pytest.raises(ArtifactValidationError, match="unknown fields"):
        ResultProtocolV2.from_dict(parallel)
    without_agent = dict(parallel)
    without_agent.pop("agent")
    with pytest.raises(ArtifactValidationError, match="missing required fields"):
        ResultProtocolV2.from_parallel_dict(without_agent)


def test_result_requires_trusted_outer_ref_and_binds_its_identity():
    fixture = _json(FIXTURE_ROOT / "v2" / "result-protocol.valid.json")
    model_claim = dict(fixture)
    model_claim.pop("output_artifact_ref")
    model_claim["summary"] = {
        **model_claim["summary"],
        "output_artifact_ref": fixture["output_artifact_ref"],
    }
    with pytest.raises(ArtifactValidationError, match="missing required fields"):
        ResultProtocolV2.from_dict(model_claim)

    wrong_phase = json.loads(json.dumps(fixture))
    wrong_phase["output_artifact_ref"]["phase"] = "planning"
    with pytest.raises(ArtifactValidationError):
        ResultProtocolV2.from_dict(wrong_phase)


def test_input_artifacts_enforce_run_consumer_and_unique_slots():
    fixture = _json(FIXTURE_ROOT / "v1" / "input-artifacts.valid.json")
    wrong_run = json.loads(json.dumps(fixture))
    wrong_run["run_id"] = "run-2"
    with pytest.raises(ArtifactValidationError, match="directive run"):
        InputArtifactsV1.from_dict(wrong_run)

    unauthorized = json.loads(json.dumps(fixture))
    unauthorized["consumer"] = "state:publishing"
    with pytest.raises(ArtifactValidationError, match="does not grant"):
        InputArtifactsV1.from_dict(unauthorized)

    duplicate = json.loads(json.dumps(fixture))
    duplicate["artifacts"].append(duplicate["artifacts"][0])
    with pytest.raises(ArtifactValidationError, match="slots must be unique"):
        InputArtifactsV1.from_dict(duplicate)
