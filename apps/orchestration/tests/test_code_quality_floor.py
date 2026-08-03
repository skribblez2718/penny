"""The global code quality floor is exact, canonical, and non-waivable."""

from copy import deepcopy

from orchestration.code_artifacts import (
    QUALITY_DIMENSION_IDS,
    ArtifactRef,
    new_quality_floor,
    new_quality_floor_status,
    validate_quality_floor,
    validate_quality_floor_status,
)


def test_new_floor_has_exactly_six_stable_unresolved_dimensions():
    floor = new_quality_floor()
    assert tuple(item["id"] for item in floor["dimensions"]) == QUALITY_DIMENSION_IDS
    assert len(floor["dimensions"]) == 6
    assert {item["status"] for item in floor["dimensions"]} == {"unresolved"}
    assert validate_quality_floor(floor) == []


def test_accept_or_skip_cannot_waive_any_of_exactly_six_dimensions():
    floor = new_quality_floor()
    for forbidden in ("waived", "disabled", "not_applicable", "skipped"):
        candidate = deepcopy(floor)
        candidate["dimensions"][0]["status"] = forbidden
        assert any("cannot be waived" in error for error in validate_quality_floor(candidate))

    deleted = deepcopy(floor)
    deleted["dimensions"].pop()
    assert any("exactly" in error for error in validate_quality_floor(deleted))


def test_status_overlay_reconciles_all_six_dimensions_with_exact_coverage_classes():
    floor_ref = ArtifactRef("floor-1", "quality_floor", 1, "a" * 64)
    coverage_ref = ArtifactRef("coverage-1", "coverage_map", 1, "b" * 64)
    obligations = []
    for dimension_id in QUALITY_DIMENSION_IDS:
        evidence_class = (
            "judgment-only"
            if dimension_id in {"harmful_duplication_avoidance", "unnecessary_complexity_avoidance"}
            else "command-verifiable"
        )
        obligations.append(
            {
                "id": f"quality:{dimension_id}",
                "status": "satisfied",
                "evidence_class": evidence_class,
                "evidence_refs": [f"evidence:{dimension_id}"],
            }
        )
    coverage = {"obligations": obligations}
    status = new_quality_floor_status(floor_ref, coverage_ref, coverage)
    assert (
        validate_quality_floor_status(
            status, floor_ref=floor_ref, coverage_ref=coverage_ref, coverage=coverage
        )
        == []
    )

    tampered = deepcopy(status)
    tampered["dimensions"][0]["evidence_refs"] = ["agent says pass"]
    assert any(
        "do not reconcile" in error
        for error in validate_quality_floor_status(
            tampered, floor_ref=floor_ref, coverage_ref=coverage_ref, coverage=coverage
        )
    )


def test_floor_rejects_definition_reinterpretation_and_stale_fields():
    changed = new_quality_floor()
    changed["dimensions"][1]["definition"] = "ship quickly"
    assert any("reinterprets" in error for error in validate_quality_floor(changed))

    stale = new_quality_floor()
    stale["dimensions"][0]["optional"] = True
    assert any("stale" in error for error in validate_quality_floor(stale))
