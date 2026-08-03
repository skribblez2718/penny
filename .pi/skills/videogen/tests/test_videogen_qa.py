from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from videogen_qa import (  # noqa: E402
    ALL_CHECK_IDS,
    NA_ALLOWED_CHECK_IDS,
    QAContractError,
    check_mech_access,
    check_mech_assembly,
    check_mech_bundle,
    check_mech_cap,
    check_mech_captions,
    check_mech_drift,
    check_mech_provenance,
    check_mech_scenes,
    roll_up_report,
    validate_qa_result,
)

OWNERS = {
    "MECH-BUNDLE": "VALIDATE",
    "MECH-SCENES": "DRAFT_RENDER",
    "MECH-ASSEMBLY": "DRAFT_RENDER",
    "MECH-DRIFT": "AUTO_QA",
    "MECH-CAPTIONS": "AUTO_QA",
    "MECH-CAP": "AUTO_QA",
    "MECH-PROVENANCE": "VALIDATE",
    "MECH-ACCESS": "AUTO_QA",
    "ALIGN-COVERAGE": "STORYBOARD",
    "ALIGN-BOUNDARY": "STORYBOARD",
    "ALIGN-ARC": "STORYBOARD",
    "ALIGN-ANALOGY": "STORYBOARD",
    "ALIGN-PRONUNCIATION": "NARRATION_SCRIPT",
    "ALIGN-CONVENTIONS": "STORYBOARD",
    "ALIGN-MATH": "STORYBOARD",
    "ALIGN-TONE": "NARRATION_SCRIPT",
    "ALIGN-ROLES": "STORYBOARD",
    "ALIGN-MNEMONIC": "NARRATION_SCRIPT",
}
FAIL_ROUTES = {
    "MECH-BUNDLE": "VALIDATE",
    "MECH-SCENES": "DRAFT_RENDER",
    "MECH-ASSEMBLY": "DRAFT_RENDER",
    "MECH-DRIFT": "CODEGEN",
    "MECH-CAPTIONS": "DRAFT_RENDER",
    "MECH-CAP": "NARRATION_SCRIPT",
    "MECH-PROVENANCE": "VALIDATE",
    "MECH-ACCESS": "CODEGEN",
    "ALIGN-COVERAGE": "STORYBOARD",
    "ALIGN-BOUNDARY": "STORYBOARD",
    "ALIGN-ARC": "STORYBOARD",
    "ALIGN-ANALOGY": "STORYBOARD",
    "ALIGN-PRONUNCIATION": "NARRATION_SCRIPT",
    "ALIGN-CONVENTIONS": "STORYBOARD",
    "ALIGN-MATH": "STORYBOARD",
    "ALIGN-TONE": "NARRATION_SCRIPT",
    "ALIGN-ROLES": "STORYBOARD",
    "ALIGN-MNEMONIC": "NARRATION_SCRIPT",
}


def _evidence(detail: str = "verified generic evidence") -> list[dict[str, Any]]:
    return [{"kind": "probe", "ref": "evidence:sample", "sha256": None, "detail": detail}]


def _row(check_id: str, status: str = "PASS") -> dict[str, Any]:
    return {
        "id": check_id,
        "status": status,
        "evidence": _evidence(),
        "owner": OWNERS[check_id],
        "affected_scene_ids": [] if status == "PASS" else ["scene-one"],
        "fix_route": "NONE" if status in {"PASS", "n/a"} else FAIL_ROUTES[check_id],
    }


def _digest(character: str) -> str:
    return character * 64


def _provenance() -> tuple[dict[str, Any], dict[str, str], str]:
    content = _digest("a")
    identity = {
        "course_slug": "sample-course",
        "unit_slug": "sample-unit",
        "lesson_slug": "sample-lesson",
        "stable_key": "sample-section",
    }
    checksums = {
        "input/section": content,
        "input/teaching-canon/000": _digest("b"),
        "input/analogy-registry": _digest("c"),
        "input/pronunciation-canon": _digest("d"),
        "input/universe-canon-ledger": _digest("e"),
        "input/primitive-schema": _digest("f"),
        "input/publish-convention": _digest("0"),
        "design/storyboard": _digest("1"),
    }
    provenance = {
        "section_identity": identity,
        "content_sha256": content,
        "profile_provenance": {"mode": "direct"},
        "input_bindings": {
            "section_snapshot": "source/section.md",
            "teaching_canon_snapshots": ["source/canon/teaching/000"],
            "analogy_registry_snapshot": "source/canon/analogy",
            "pronunciation_canon_snapshot": "source/canon/pronunciation",
            "universe_canon_snapshot": "source/canon/universe",
            "primitive_schema_snapshot": "source/schema/primitive-schema.json",
            "publish_convention_snapshot": "source/publish/convention.json",
        },
        "renderer_binding": {
            "bundle_version": 1,
            "primitive_library_version": "1.2.3",
            "primitive_schema_sha256": _digest("d"),
            "theme": "caller-theme",
            "theme_sha256": _digest("e"),
        },
        "voice_binding": {
            "voice_id": "caller-voice",
            "voice_id_sha256": _digest("f"),
        },
        "approval_record": None,
        "checksums": checksums,
    }
    return provenance, identity, content


def test_mech_bundle_pass_fail_and_probe_uncertainty() -> None:
    passed = check_mech_bundle(
        bundle_dir="/generic/bundle",
        local_probe=lambda _: {"ok": True, "violations": []},
        service_probe=lambda _: {
            "import_result": {"ok": True},
            "validation_result": {"ok": True},
            "violations": [],
        },
    )
    failed = check_mech_bundle(
        bundle_dir="/generic/bundle",
        local_probe=lambda _: {"ok": False, "errors": ["schema mismatch"]},
        service_probe=lambda _: {"ok": True, "violations": []},
    )

    def unavailable(_: str) -> dict[str, Any]:
        raise RuntimeError("probe unavailable")

    uncertain = check_mech_bundle(
        bundle_dir="/generic/bundle",
        local_probe=unavailable,
        service_probe=lambda _: {"ok": True},
    )
    assert (passed["status"], failed["status"], uncertain["status"]) == (
        "PASS",
        "FAIL",
        "UNCERTAIN",
    )
    assert all(row["evidence"] for row in (passed, failed, uncertain))


def test_mech_scenes_unknown_missing_duplicate_and_failed_jobs_fail() -> None:
    passed = check_mech_scenes(
        storyboard_scene_ids=["scene-one", "scene-two"],
        jobs=[
            {"scene_id": "scene-one", "status": "succeeded"},
            {"scene_id": "scene-two", "status": "completed"},
        ],
        outputs={
            "scene-one": {"path": "/generic/one.mp4"},
            "scene-two": {"path": "/generic/two.mp4"},
        },
    )
    failed = check_mech_scenes(
        storyboard_scene_ids=["scene-one", "scene-two"],
        jobs=[
            {"scene_id": "scene-one", "status": "succeeded"},
            {"scene_id": "scene-one", "status": "succeeded"},
            {"scene_id": "scene-two"},
        ],
        outputs={"scene-one": {"path": "/generic/one.mp4"}},
    )
    assert passed["status"] == "PASS"
    assert failed["status"] == "FAIL"
    assert failed["affected_scene_ids"] == ["scene-one", "scene-two"]


def test_mech_assembly_requires_decodable_complete_ordered_av_media() -> None:
    outputs = {
        "scene-one": {"path": "/generic/one.mp4"},
        "scene-two": {"path": "/generic/two.mp4"},
    }
    passed = check_mech_assembly(
        assembled_video_path="/generic/draft.mp4",
        ordered_scene_ids=["scene-one", "scene-two"],
        scene_outputs=outputs,
        media_probe=lambda _: {
            "ok": True,
            "decodable": True,
            "duration_seconds": 4.0,
            "size_bytes": 400,
            "video_streams": [{"codec": "generic"}],
            "audio_streams": [{"codec": "generic"}],
            "assembly_order": ["scene-one", "scene-two"],
        },
    )
    failed = check_mech_assembly(
        assembled_video_path="/generic/draft.mp4",
        ordered_scene_ids=["scene-one", "scene-two"],
        scene_outputs=outputs,
        media_probe=lambda _: {
            "ok": True,
            "duration_seconds": 4.0,
            "size_bytes": 400,
            "video_streams": [{"codec": "generic"}],
            "audio_streams": [],
            "assembly_order": ["scene-two", "scene-one"],
        },
    )
    assert passed["status"] == "PASS"
    assert failed["status"] == "FAIL"


def test_mech_assembly_probe_exception_is_uncertain() -> None:
    def unavailable(_: str) -> dict[str, Any]:
        raise RuntimeError("media observation unavailable")

    result = check_mech_assembly(
        assembled_video_path="/generic/draft.mp4",
        ordered_scene_ids=["scene-one"],
        scene_outputs={"scene-one": {"path": "/generic/one.mp4"}},
        media_probe=unavailable,
    )
    assert result["status"] == "UNCERTAIN"


@pytest.mark.parametrize(
    ("video_duration", "narration_duration", "expected"),
    [(5.0, 4.0, "PASS"), (3.9, 4.0, "FAIL"), (6.1, 4.0, "FAIL")],
)
def test_mech_drift_uses_signed_tail(
    video_duration: float, narration_duration: float, expected: str
) -> None:
    result = check_mech_drift(
        scene_timings=[
            {
                "scene_id": "scene-one",
                "video_duration_seconds": video_duration,
                "narration_duration_seconds": narration_duration,
                "measured_duration": video_duration,
            }
        ],
        max_scene_tail_seconds=2.0,
    )
    assert result["status"] == expected
    assert "signed_tail_seconds" in result["evidence"][0]["detail"]


def test_mech_captions_preserves_case_and_punctuation_in_exact_collapsed_comparison() -> None:
    kwargs = {
        "captions_path": "/generic/captions.vtt",
        "narration_by_scene": {"scene-one": "Exact, narration."},
        "scene_windows": {"scene-one": (0.0, 2.0)},
        "video_duration_seconds": 2.0,
    }
    passed = check_mech_captions(
        **kwargs,
        caption_probe=lambda *_args, **_kwargs: {
            "ok": True,
            "cue_count": 1,
            "missing_scene_ids": [],
            "text_mismatch_scene_ids": [],
            "out_of_range_cue_indices": [],
            "errors": [],
            "cue_text_by_scene": {"scene-one": "Exact,   narration."},
        },
    )
    punctuation_changed = check_mech_captions(
        **kwargs,
        caption_probe=lambda *_args, **_kwargs: {
            "ok": True,
            "cue_count": 1,
            "missing_scene_ids": [],
            "text_mismatch_scene_ids": [],
            "out_of_range_cue_indices": [],
            "errors": [],
            "cue_text_by_scene": {"scene-one": "Exact narration."},
        },
    )
    case_changed = check_mech_captions(
        **kwargs,
        caption_probe=lambda *_args, **_kwargs: {
            "ok": True,
            "cue_count": 1,
            "missing_scene_ids": [],
            "text_mismatch_scene_ids": [],
            "out_of_range_cue_indices": [],
            "errors": [],
            "cue_text_by_scene": {"scene-one": "exact, narration."},
        },
    )
    assert passed["status"] == "PASS"
    assert punctuation_changed["status"] == "FAIL"
    assert case_changed["status"] == "FAIL"


def test_malformed_caption_probe_observation_is_uncertain() -> None:
    result = check_mech_captions(
        captions_path="/generic/captions.vtt",
        narration_by_scene={"scene-one": "Narration."},
        scene_windows={"scene-one": (0.0, 1.0)},
        video_duration_seconds=1.0,
        caption_probe=lambda *_args, **_kwargs: {
            "ok": True,
            "cue_count": 1,
            "missing_scene_ids": None,
        },
    )
    assert result["status"] == "UNCERTAIN"


def test_mech_caption_probe_exception_is_uncertain() -> None:
    def unavailable(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("caption observation unavailable")

    result = check_mech_captions(
        captions_path="/generic/captions.vtt",
        narration_by_scene={"scene-one": "Narration."},
        scene_windows={"scene-one": (0.0, 1.0)},
        video_duration_seconds=1.0,
        caption_probe=unavailable,
    )
    assert result["status"] == "UNCERTAIN"


def test_mech_cap_has_no_implicit_cap_and_soft_guide_only_flags() -> None:
    no_constraints = check_mech_cap(
        duration_seconds=120.0,
        length_cap_seconds=None,
        length_guide_seconds=None,
    )
    over_guide = check_mech_cap(
        duration_seconds=121.0,
        length_cap_seconds=None,
        length_guide_seconds=120.0,
    )
    over_cap = check_mech_cap(
        duration_seconds=121.0,
        length_cap_seconds=120.0,
        length_guide_seconds=None,
    )
    assert no_constraints["status"] == "PASS"
    assert over_guide["status"] == "PASS"
    assert over_cap["status"] == "FAIL"
    rows = [_row(check_id) for check_id in ALL_CHECK_IDS]
    rows[ALL_CHECK_IDS.index("MECH-CAP")] = over_guide
    report = roll_up_report(rows)
    assert report["verdict"] == "PASS"
    assert report["review_flags"] == [
        {
            "id": "LENGTH-GUIDE",
            "over_guide": True,
            "duration_seconds": 121.0,
            "length_guide_seconds": 120.0,
        }
    ]


def test_mech_provenance_checks_exact_manifest_identity_hash_and_files() -> None:
    provenance, identity, content = _provenance()
    manifest = {
        "bundle_version": 1,
        "video_id": "sample-video",
        "primitive_library_version": "1.2.3",
        "theme": "caller-theme",
    }
    passed = check_mech_provenance(
        manifest=manifest,
        provenance=provenance,
        expected_section_identity=identity,
        expected_content_sha256=content,
        checksum_files={"input/section": "/generic/section.md"},
        checksum_probe=lambda _ledger, _files: [],
    )
    failed = check_mech_provenance(
        manifest={**manifest, "extra": "forbidden"},
        provenance={**provenance, "content_sha256": _digest("c")},
        expected_section_identity=identity,
        expected_content_sha256=content,
        checksum_files={"input/section": "/generic/section.md"},
        checksum_probe=lambda _ledger, _files: ["input/section: mismatch"],
    )
    assert passed["status"] == "PASS"
    assert failed["status"] == "FAIL"


def test_mech_provenance_probe_exception_is_uncertain_when_structure_is_valid() -> None:
    provenance, identity, content = _provenance()

    def unavailable(_ledger: Any, _files: Any) -> list[str]:
        raise RuntimeError("checksum observation unavailable")

    result = check_mech_provenance(
        manifest={
            "bundle_version": 1,
            "video_id": "sample-video",
            "primitive_library_version": "1.2.3",
            "theme": "caller-theme",
        },
        provenance=provenance,
        expected_section_identity=identity,
        expected_content_sha256=content,
        checksum_files={"input/section": "/generic/section.md"},
        checksum_probe=unavailable,
    )
    assert result["status"] == "UNCERTAIN"


def test_mech_access_requires_visual_evidence_not_resolution_alone() -> None:
    media = lambda _path: {  # noqa: E731
        "width": 1920,
        "height": 1080,
        "video_streams": [{"width": 1920, "height": 1080}],
    }
    passed = check_mech_access(
        video_path="/generic/final.mp4",
        storyboard_path="/generic/storyboard.json",
        captions_path="/generic/captions.vtt",
        media_probe=media,
        accessibility_probe=lambda *_: {
            "text_readable": True,
            "non_color_meaning": True,
            "captions_available": True,
        },
    )
    failed = check_mech_access(
        video_path="/generic/final.mp4",
        storyboard_path="/generic/storyboard.json",
        captions_path="/generic/captions.vtt",
        media_probe=media,
        accessibility_probe=lambda *_: {
            "text_readable": False,
            "non_color_meaning": True,
            "captions_available": True,
        },
    )
    uncertain = check_mech_access(
        video_path="/generic/final.mp4",
        storyboard_path="/generic/storyboard.json",
        captions_path="/generic/captions.vtt",
        media_probe=media,
        accessibility_probe=lambda *_: {"ok": True},
    )
    assert (passed["status"], failed["status"], uncertain["status"]) == (
        "PASS",
        "FAIL",
        "UNCERTAIN",
    )


def test_every_check_id_validates_and_clean_rollup_passes() -> None:
    rows = [_row(check_id) for check_id in ALL_CHECK_IDS]
    report = roll_up_report(rows)
    assert [row["id"] for row in report["checks"]] == list(ALL_CHECK_IDS)
    assert report["counts"] == {"PASS": 18, "FAIL": 0, "UNCERTAIN": 0, "n/a": 0}
    assert report["verdict"] == "PASS"


@pytest.mark.parametrize("blocking_id", ALL_CHECK_IDS)
def test_weighted_aggregate_cannot_hide_any_single_failure(blocking_id: str) -> None:
    rows = [_row(check_id) for check_id in ALL_CHECK_IDS]
    rows[ALL_CHECK_IDS.index(blocking_id)] = _row(blocking_id, "FAIL")
    report = roll_up_report(rows)
    assert report["verdict"] == "FAIL"
    assert report["blocking_ids"] == [blocking_id]
    assert report["counts"]["FAIL"] == 1
    assert report["counts"]["PASS"] == 17


def test_uncertain_blocks_and_never_rolls_up_to_pass() -> None:
    rows = [_row(check_id) for check_id in ALL_CHECK_IDS]
    rows[0] = _row("MECH-BUNDLE", "UNCERTAIN")
    report = roll_up_report(rows)
    assert report["verdict"] == "UNCERTAIN"
    assert report["uncertain_ids"] == ["MECH-BUNDLE"]


def test_only_frozen_alignment_checks_allow_na_and_still_require_evidence() -> None:
    for check_id in NA_ALLOWED_CHECK_IDS:
        row = _row(check_id, "n/a")
        row["affected_scene_ids"] = []
        assert validate_qa_result(row)["status"] == "n/a"
    unauthorized = _row("MECH-CAP")
    unauthorized["status"] = "n/a"
    with pytest.raises(QAContractError):
        validate_qa_result(unauthorized)
    empty_evidence = _row("ALIGN-MNEMONIC", "n/a")
    empty_evidence["affected_scene_ids"] = []
    empty_evidence["evidence"] = []
    with pytest.raises(QAContractError):
        validate_qa_result(empty_evidence)


def test_rollup_rejects_unknown_duplicate_and_missing_ids() -> None:
    rows = [_row(check_id) for check_id in ALL_CHECK_IDS]
    with pytest.raises(QAContractError):
        roll_up_report(rows[:-1])
    duplicate = copy.deepcopy(rows)
    duplicate[-1] = copy.deepcopy(duplicate[0])
    with pytest.raises(QAContractError):
        roll_up_report(duplicate)
    unknown = _row("MECH-BUNDLE")
    unknown["id"] = "MECH-UNKNOWN"
    with pytest.raises(QAContractError):
        validate_qa_result(unknown)
