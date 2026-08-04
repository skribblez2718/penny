from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from videogen_artifacts import (  # noqa: E402
    MANIFEST_KEYS,
    ArtifactPathError,
    ManifestValidationError,
    OutputStagingError,
    atomic_write,
    build_tree_ledger,
    canonical_json_bytes,
    compare_staleness,
    ledger_sha256,
    materialize_bundle,
    read_provenance,
    sha256_bytes,
    stage_outputs,
    validate_manifest_exact_keys,
)
from videogen_contracts import (  # noqa: E402
    ConstraintValidationError,
    PathSafetyError,
    ProfileResolutionError,
    resolve_profile,
    validate_and_normalize_constraints,
)

REQUIRED_FIELDS = (
    "section_content",
    "section_identity",
    "content_gate",
    "teaching_canon_paths",
    "analogy_registry",
    "pronunciation_canon",
    "universe_canon_dir",
    "superpose_url",
    "voice_studio_url",
    "voice_id",
    "theme",
    "primitive_schema_source",
    "workspace_dir",
    "output_dir",
    "publish_target_conventions",
)


def _write(path: Path, text: str = "generic evidence\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")
    return path


def _constraints(
    tmp_path: Path, *, section_text: str = "A generic **section**.\n"
) -> dict[str, Any]:
    inputs = tmp_path / "inputs"
    teaching = _write(inputs / "teaching.md")
    analogy = _write(inputs / "analogies.json", "{}\n")
    pronunciation = _write(inputs / "pronunciation.md")
    universe = inputs / "universe"
    universe.mkdir(parents=True)
    _write(universe / "visual-language.md")
    schema = _write(inputs / "primitive-schema.json", '{"version":"1.2.3"}\n')
    return {
        "section_content": {"text": section_text},
        "section_identity": {
            "course_slug": "sample-course",
            "unit_slug": "sample-unit",
            "lesson_slug": "sample-lesson",
            "stable_key": "sample-section",
        },
        "content_gate": {
            "finalized": True,
            "derivation_verdict": "INDEPENDENT",
            "evidence_ref": "evidence:sample",
        },
        "teaching_canon_paths": [str(teaching)],
        "analogy_registry": str(analogy),
        "pronunciation_canon": str(pronunciation),
        "universe_canon_dir": str(universe),
        "superpose_url": "https://renderer.example.test/api/",
        "voice_studio_url": "https://voice.example.test/api/",
        "voice_id": "caller-selected-voice",
        "theme": "caller-selected-theme",
        "primitive_schema_source": {"path": str(schema)},
        "workspace_dir": str(tmp_path / "workspace"),
        "output_dir": str(tmp_path / "output"),
        "publish_target_conventions": {
            "video_id_template": "{stable_key}",
            "base_name_template": "{course_slug}--{unit_slug}--{lesson_slug}--{stable_key}",
            "video_destination_template": "media/{base_name}.mp4",
            "captions_destination_template": "media/{base_name}.vtt",
            "poster_destination_template": "media/{base_name}.jpg",
            "attach_behavior": "consumer-managed",
            "handoff_only": True,
        },
    }


def _normalize(constraints: dict[str, Any]):
    return validate_and_normalize_constraints(resolve_profile(constraints, environ={}))


@pytest.mark.parametrize("field", REQUIRED_FIELDS)
def test_every_required_constraint_reports_field_before_side_effects(
    tmp_path: Path, field: str
) -> None:
    constraints = _constraints(tmp_path)
    constraints.pop(field)

    with pytest.raises(ConstraintValidationError) as captured:
        _normalize(constraints)

    assert any(message.startswith(f"{field}:") for message in captured.value.errors)
    assert captured.value.errors == tuple(sorted(captured.value.errors))
    assert not (tmp_path / "workspace").exists()
    assert not (tmp_path / "output").exists()


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("section_content", {"text": "one", "path": "/two"}),
        (
            "section_identity",
            {
                "course_slug": "../escape",
                "unit_slug": "sample-unit",
                "lesson_slug": "sample-lesson",
                "stable_key": "sample-section",
            },
        ),
        (
            "content_gate",
            {
                "finalized": False,
                "derivation_verdict": "INDEPENDENT",
                "evidence_ref": "evidence:sample",
            },
        ),
        ("teaching_canon_paths", []),
        ("superpose_url", "https://name:secret@renderer.example.test"),
        ("voice_id", "   "),
        (
            "primitive_schema_source",
            {"url": "https://schema.example.test", "path": "/x"},
        ),
        ("workspace_dir", "relative/workspace"),
        (
            "publish_target_conventions",
            {
                "video_id_template": "{stable_key}",
                "base_name_template": "{stable_key}",
                "video_destination_template": "../{base_name}.mp4",
                "captions_destination_template": "media/{base_name}.vtt",
                "poster_destination_template": "media/{base_name}.jpg",
                "attach_behavior": "consumer-managed",
                "handoff_only": True,
            },
        ),
        ("max_scene_tail_seconds", -0.1),
        ("length_cap_seconds", 0),
        ("length_guide_seconds", "soon"),
        ("quality_tier", "preview"),
        ("mode", "continue"),
        ("max_refine_iterations", True),
    ],
)
def test_invalid_constraint_matrix_is_field_specific_and_side_effect_free(
    tmp_path: Path, field: str, invalid: Any
) -> None:
    constraints = _constraints(tmp_path)
    constraints[field] = invalid

    with pytest.raises(ConstraintValidationError) as captured:
        _normalize(constraints)

    assert any(message.startswith(field) for message in captured.value.errors)
    assert not (tmp_path / "workspace").exists()
    assert not (tmp_path / "output").exists()


def test_unknown_constraint_is_rejected(tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    constraints["unrecognized_setting"] = "value"
    with pytest.raises(ConstraintValidationError) as captured:
        _normalize(constraints)
    assert "unrecognized_setting: unknown constraint" in captured.value.errors


def test_exact_utf8_hash_is_whitespace_and_newline_sensitive(tmp_path: Path) -> None:
    hashes = {
        _normalize(
            _constraints(tmp_path / f"case-{index}", section_text=text)
        ).content_sha256
        for index, text in enumerate(("same", "same ", "same\n", "same\r\n"))
    }
    assert len(hashes) == 4

    file_constraints = _constraints(tmp_path / "file-case")
    source = _write(tmp_path / "file-case" / "section.md", "same\r\n")
    file_constraints["section_content"] = {"path": str(source)}
    intake = _normalize(file_constraints)
    assert intake.section_bytes == b"same\r\n"
    assert intake.content_sha256 == sha256_bytes(b"same\r\n")
    assert intake.section_source_path == str(source.resolve())


def test_defaults_and_exact_to_dict_shape(tmp_path: Path) -> None:
    intake = _normalize(_constraints(tmp_path))
    value = intake.to_dict()
    assert value["max_scene_tail_seconds"] == 2.0
    assert value["max_refine_iterations"] == 3
    assert value["length_cap_seconds"] is None
    assert value["length_guide_seconds"] is None
    assert value["character_usage_policy"] is None
    assert value["profile_provenance"] == {"mode": "direct"}
    assert value["content_gate"]["verification_status"] == "caller_attested"
    assert "text" not in value["section_content"]


def test_explicit_non_markdown_front_matter_is_rejected(tmp_path: Path) -> None:
    constraints = _constraints(
        tmp_path,
        section_text="---\nsection_type: simulation\n---\nNot eligible.\n",
    )
    with pytest.raises(ConstraintValidationError) as captured:
        _normalize(constraints)
    assert any("non-markdown" in error for error in captured.value.errors)


def test_word_timing_requirement_fails_closed(tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    constraints["publish_target_conventions"]["requires_word_timings"] = True
    with pytest.raises(ConstraintValidationError) as captured:
        _normalize(constraints)
    assert any("unsupported in v1" in error for error in captured.value.errors)


def test_two_generic_profiles_use_one_normalization_path(tmp_path: Path) -> None:
    profiles_root = tmp_path / "profiles"
    generic_profile = {
        "character_usage_policy": {"mode": "canon-authorized-only"},
        "max_refine_iterations": 3,
        "max_scene_tail_seconds": 2.0,
    }
    for name in ("profile-one", "profile-two"):
        _write(
            profiles_root / name / "profile.json",
            json.dumps(generic_profile, sort_keys=True, separators=(",", ":")) + "\n",
        )
    normalized: list[dict[str, Any]] = []
    provenances: list[dict[str, Any]] = []
    shared_constraints = _constraints(tmp_path / "shared-inputs")
    for name in ("profile-one", "profile-two"):
        constraints = copy.deepcopy(shared_constraints)
        constraints.update({"app_profile": name, "profiles_dir": str(profiles_root)})
        resolution = resolve_profile(
            constraints,
            environ={"VIDEOGEN_PROFILES_DIR": str(tmp_path / "ignored")},
        )
        intake = validate_and_normalize_constraints(resolution)
        value = intake.to_dict()
        provenances.append(value.pop("profile_provenance"))
        normalized.append(value)

    assert normalized[0] == normalized[1]
    assert {item["name"] for item in provenances} == {"profile-one", "profile-two"}
    assert all(
        set(item) == {"mode", "name", "resolved_path", "sha256"} for item in provenances
    )


def test_profile_annotation_keys_are_ignored_not_rejected(tmp_path: Path) -> None:
    """$-prefixed JSON-convention annotation keys are documentation, not contract data."""
    profiles_root = tmp_path / "profiles"
    profile = {
        "$schema_note": "human documentation string — must be ignored",
        "$comment": "also ignored",
        "max_refine_iterations": 3,
        "max_scene_tail_seconds": 2.0,
    }
    _write(
        profiles_root / "annotated" / "profile.json",
        json.dumps(profile, sort_keys=True, separators=(",", ":")) + "\n",
    )
    constraints = _constraints(tmp_path / "inputs")
    constraints.update({"app_profile": "annotated", "profiles_dir": str(profiles_root)})
    resolution = resolve_profile(constraints, environ={})
    assert not any(key.startswith("$") for key in resolution.merged_constraints)
    intake = validate_and_normalize_constraints(resolution)
    assert intake.to_dict()["profile_provenance"]["name"] == "annotated"

    # A non-annotation unknown key still fails closed.
    bad = dict(profile)
    bad["surprise_field"] = True
    _write(
        profiles_root / "bad" / "profile.json",
        json.dumps(bad, sort_keys=True, separators=(",", ":")) + "\n",
    )
    bad_constraints = _constraints(tmp_path / "inputs-bad")
    bad_constraints.update({"app_profile": "bad", "profiles_dir": str(profiles_root)})
    with pytest.raises(ProfileResolutionError, match="surprise_field: unknown profile field"):
        resolve_profile(bad_constraints, environ={})


@pytest.mark.parametrize(
    "failure", ["unknown", "unreadable", "invalid-json", "schema-invalid", "forbidden"]
)
def test_profile_resolution_failures_have_no_workspace_or_output_effect(
    tmp_path: Path, failure: str
) -> None:
    profiles_root = tmp_path / "profiles"
    profile_path = profiles_root / "sample-profile" / "profile.json"
    profile_path.parent.mkdir(parents=True)
    if failure == "unreadable":
        profile_path.mkdir()
    elif failure == "invalid-json":
        profile_path.write_text("{not-json", encoding="utf-8")
    elif failure == "schema-invalid":
        profile_path.write_text(
            '{"max_refine_iterations":"unbounded"}\n', encoding="utf-8"
        )
    elif failure == "forbidden":
        profile_path.write_text(
            '{"section_content":{"text":"forbidden"}}\n', encoding="utf-8"
        )
    elif failure == "unknown":
        profile_path.parent.rmdir()
    constraints = _constraints(tmp_path)
    constraints.update(
        {"app_profile": "sample-profile", "profiles_dir": str(profiles_root)}
    )

    with pytest.raises(ProfileResolutionError):
        resolve_profile(constraints, environ={})

    assert not (tmp_path / "workspace").exists()
    assert not (tmp_path / "output").exists()


def test_profile_name_and_symlink_escape_are_rejected(tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    constraints.update({"app_profile": "../outside", "profiles_dir": str(tmp_path)})
    with pytest.raises(PathSafetyError):
        resolve_profile(constraints, environ={})

    profiles = tmp_path / "profiles"
    profiles.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    _write(outside / "profile.json", "{}\n")
    (profiles / "linked").symlink_to(outside, target_is_directory=True)
    constraints.update({"app_profile": "linked", "profiles_dir": str(profiles)})
    with pytest.raises(PathSafetyError):
        resolve_profile(constraints, environ={})


def test_direct_mode_does_not_read_profile_environment(tmp_path: Path) -> None:
    class ExplodingEnvironment(dict[str, str]):
        def get(self, key: str, default: str | None = None) -> str | None:
            raise AssertionError(f"unexpected environment lookup: {key}")

    resolution = resolve_profile(_constraints(tmp_path), environ=ExplodingEnvironment())
    assert resolution.provenance == {"mode": "direct"}


def test_atomic_write_rejects_traversal_and_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "linked").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ArtifactPathError):
        atomic_write(root / "linked" / "escaped.txt", b"no", root=root)
    with pytest.raises(ArtifactPathError):
        atomic_write(root / ".." / "escaped.txt", b"no", root=root)

    assert not (outside / "escaped.txt").exists()
    assert not (tmp_path / "escaped.txt").exists()


def _digest(label: str) -> str:
    return sha256_bytes(label.encode("utf-8"))


def _approval(content_sha256: str) -> dict[str, Any]:
    return {
        "gate": "operator_review",
        "run_id": "run-sample",
        "iteration": 0,
        "action": "approve",
        "draft_video_sha256": _digest("draft-video"),
        "content_sha256": content_sha256,
        "reviewed_at": "2030-01-02T03:04:05Z",
        "response": {"action": "approve"},
    }


def _provenance(content_sha256: str, *, approved: bool = True) -> dict[str, Any]:
    voice_id = "caller-selected-voice"
    return {
        "section_identity": {
            "course_slug": "sample-course",
            "unit_slug": "sample-unit",
            "lesson_slug": "sample-lesson",
            "stable_key": "sample-section",
        },
        "content_sha256": content_sha256,
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
            "primitive_schema_sha256": _digest("schema"),
            "theme": "caller-selected-theme",
            "theme_sha256": _digest("theme-definition"),
        },
        "voice_binding": {
            "voice_id": voice_id,
            "voice_id_sha256": sha256_bytes(voice_id.encode("utf-8")),
        },
        "approval_record": _approval(content_sha256) if approved else None,
        "checksums": {
            "input/section": content_sha256,
            "input/teaching-canon/000": _digest("teaching"),
            "input/analogy-registry": _digest("analogy"),
            "input/pronunciation-canon": _digest("pronunciation"),
            "input/universe-canon-ledger": _digest("universe"),
            "input/primitive-schema": _digest("schema"),
            "input/publish-convention": _digest("publish"),
        },
    }


def test_manifest_has_set_equality_and_types() -> None:
    manifest = {
        "bundle_version": 1,
        "video_id": "sample-video",
        "primitive_library_version": "1.2.3",
        "theme": "caller-selected-theme",
    }
    assert set(validate_manifest_exact_keys(manifest)) == MANIFEST_KEYS
    with pytest.raises(ManifestValidationError):
        validate_manifest_exact_keys({**manifest, "extra": "forbidden"})
    with pytest.raises(ManifestValidationError):
        validate_manifest_exact_keys({**manifest, "bundle_version": True})


def test_bundle_provenance_receipt_are_byte_consistent(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    output = tmp_path / "output"
    source = tmp_path / "source"
    scene = _write(source / "scene.py", "class GenericScene:\n    pass\n")
    audio = source / "audio.wav"
    audio.write_bytes(b"generic-audio-bytes")
    video = source / "final.mp4"
    video.write_bytes(b"generic-video-bytes")
    captions = _write(
        source / "final.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nGeneric.\n"
    )
    poster = source / "final.jpg"
    poster.write_bytes(b"generic-poster-bytes")
    qa_report = _write(source / "auto-qa.json", '{"verdict":"PASS"}\n')
    publish_instructions = _write(source / "publish.txt", "Consumer-managed handoff.\n")
    content_sha = _digest("exact source bytes")
    provenance = _provenance(content_sha)
    provenance["checksums"].update(
        {
            "final/video": sha256_bytes(video.read_bytes()),
            "final/captions": sha256_bytes(captions.read_bytes()),
            "final/poster": sha256_bytes(poster.read_bytes()),
        }
    )
    manifest = {
        "bundle_version": 1,
        "video_id": "sample-video",
        "primitive_library_version": "1.2.3",
        "theme": "caller-selected-theme",
    }
    storyboard = {
        "scenes": [
            {
                "scene_id": "scene-one",
                "title": "Generic concept",
                "narration": "Generic narration.",
                "visuals": [],
            }
        ]
    }
    bundle = materialize_bundle(
        workspace_root=workspace,
        bundle_dir=workspace / "bundle",
        manifest=manifest,
        provenance=provenance,
        storyboard=storyboard,
        scene_files={"scene-one": scene},
        audio_files={"scene-one": audio},
    )
    persisted_provenance = read_provenance(bundle.provenance["path"])
    approval_file = source / "approval.json"
    approval_file.write_bytes(
        canonical_json_bytes(persisted_provenance["approval_record"])
    )

    release = output / "release-sample"
    artifacts = {
        "video": {
            "path": str(release / "video.mp4"),
            "sha256": sha256_bytes(video.read_bytes()),
            "size_bytes": video.stat().st_size,
        },
        "captions": {
            "path": str(release / "captions.vtt"),
            "sha256": sha256_bytes(captions.read_bytes()),
            "size_bytes": captions.stat().st_size,
        },
        "poster": {
            "path": str(release / "poster.jpg"),
            "sha256": sha256_bytes(poster.read_bytes()),
            "size_bytes": poster.stat().st_size,
        },
        "bundle": {
            "path": str(release / "bundle"),
            "sha256": bundle.bundle["sha256"],
            "file_count": bundle.bundle["file_count"],
        },
        "auto_qa_report": {
            "path": str(release / "evidence" / "auto-qa.json"),
            "sha256": sha256_bytes(qa_report.read_bytes()),
            "size_bytes": qa_report.stat().st_size,
        },
        "approval_record": {
            "path": str(release / "evidence" / "approval.json"),
            "sha256": sha256_bytes(approval_file.read_bytes()),
            "size_bytes": approval_file.stat().st_size,
        },
        "publish_instructions": {
            "path": str(release / "publish-instructions.txt"),
            "sha256": sha256_bytes(publish_instructions.read_bytes()),
            "size_bytes": publish_instructions.stat().st_size,
        },
    }
    receipt = {
        "schema_version": 1,
        "lifecycle_state": "HANDOFF_READY",
        "run_id": "run-sample",
        "section_identity": persisted_provenance["section_identity"],
        "content_sha256": persisted_provenance["content_sha256"],
        "profile_provenance": persisted_provenance["profile_provenance"],
        "approval_record": persisted_provenance["approval_record"],
        "checksums": persisted_provenance["checksums"],
        "artifacts": artifacts,
        "publish_destinations": {
            "video": "media/sample.mp4",
            "captions": "media/sample.vtt",
            "poster": "media/sample.jpg",
        },
        "staleness": {
            "content_status": "CURRENT",
            "compatibility_status": "COMPATIBLE",
            "changed_bindings": [],
            "checked_at": "2030-01-02T03:04:06Z",
        },
        "no_target_side_effects": {
            "wrote_target_app": False,
            "ran_target_build": False,
            "ran_target_import": False,
            "committed": False,
        },
        "met": True,
        "unresolved_issues": [],
    }
    for key in (
        "section_identity",
        "content_sha256",
        "profile_provenance",
        "approval_record",
        "checksums",
    ):
        assert canonical_json_bytes(receipt[key]) == canonical_json_bytes(
            persisted_provenance[key]
        )

    result = stage_outputs(
        output_root=output,
        release_name="release-sample",
        files={
            "video": video,
            "captions": captions,
            "poster": poster,
            "bundle": Path(bundle.bundle["path"]),
            "auto_qa_report": qa_report,
            "approval_record": approval_file,
            "publish_instructions": publish_instructions,
        },
        receipt=receipt,
    )
    assert result.release_dir["path"] == str(release.resolve())
    staged_receipt = json.loads(
        (release / "handoff-receipt.json").read_text(encoding="utf-8")
    )
    assert staged_receipt == receipt
    assert (
        read_provenance(release / "bundle" / "provenance.json")["checksums"]
        == receipt["checksums"]
    )
    assert ledger_sha256(build_tree_ledger(release)) == result.release_dir["sha256"]

    stale_receipt = copy.deepcopy(receipt)
    stale_receipt["staleness"]["content_status"] = "STALE"
    with pytest.raises(OutputStagingError):
        stage_outputs(
            output_root=output,
            release_name="release-stale",
            files={
                "video": video,
                "captions": captions,
                "poster": poster,
                "bundle": Path(bundle.bundle["path"]),
                "auto_qa_report": qa_report,
                "approval_record": approval_file,
                "publish_instructions": publish_instructions,
            },
            receipt=stale_receipt,
        )


@pytest.mark.parametrize(
    ("prior_change", "expected_content", "expected_compatibility"),
    [
        ("same", "CURRENT", "COMPATIBLE"),
        ("content", "STALE", "COMPATIBLE"),
        ("identity", "DIFFERENT_IDENTITY", "COMPATIBLE"),
        ("malformed", "UNKNOWN", "UNKNOWN"),
        ("binding", "CURRENT", "INCOMPATIBLE"),
    ],
)
def test_staleness_matrix(
    prior_change: str, expected_content: str, expected_compatibility: str
) -> None:
    identity = {
        "course_slug": "sample-course",
        "unit_slug": "sample-unit",
        "lesson_slug": "sample-lesson",
        "stable_key": "sample-section",
    }
    content = _digest("content")
    binding = _digest("binding")
    prior: dict[str, Any] = {
        "section_identity": copy.deepcopy(identity),
        "content_sha256": content,
        "checksums": {"binding/current": binding},
    }
    if prior_change == "content":
        prior["content_sha256"] = _digest("changed-content")
    elif prior_change == "identity":
        prior["section_identity"]["stable_key"] = "different-section"
    elif prior_change == "malformed":
        prior = {
            "section_identity": {"stable_key": "sample-section"},
            "content_sha256": "bad",
        }
    elif prior_change == "binding":
        prior["checksums"]["binding/current"] = _digest("changed-binding")

    comparison = compare_staleness(
        current_section_identity=identity,
        current_content_sha256=content,
        prior_provenance=prior,
        current_bindings={"binding/current": binding},
    )
    assert comparison.content_status == expected_content
    assert comparison.compatibility_status == expected_compatibility
    if expected_content == "UNKNOWN":
        assert comparison.content_status != "CURRENT"
