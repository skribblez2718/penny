from __future__ import annotations

import copy
import json
import math
import re
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from os import PathLike
from typing import Any, Literal, TypeAlias, TypedDict, cast

JSONScalar: TypeAlias = None | bool | int | float | str
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
QAStatus: TypeAlias = Literal["PASS", "FAIL", "UNCERTAIN", "n/a"]
QAVerdict: TypeAlias = Literal["PASS", "FAIL", "UNCERTAIN"]
Pathish: TypeAlias = str | PathLike[str]

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_KEYS = frozenset({"bundle_version", "video_id", "primitive_library_version", "theme"})
_IDENTITY_KEYS = frozenset({"course_slug", "unit_slug", "lesson_slug", "stable_key"})
_PROVENANCE_KEYS = frozenset(
    {
        "section_identity",
        "content_sha256",
        "profile_provenance",
        "input_bindings",
        "renderer_binding",
        "voice_binding",
        "approval_record",
        "checksums",
    }
)
_EVIDENCE_KEYS = frozenset({"kind", "ref", "sha256", "detail"})
_ROW_KEYS = frozenset({"id", "status", "evidence", "owner", "affected_scene_ids", "fix_route"})
_COUNT_KEYS = ("PASS", "FAIL", "UNCERTAIN", "n/a")
_MEDIA_SUCCESS_STATUSES = frozenset({"success", "succeeded", "completed"})
_MIN_ACCESS_WIDTH = 1920
_MIN_ACCESS_HEIGHT = 1080
_FLOAT_TOLERANCE = 1e-6

MECHANICAL_CHECK_IDS: tuple[str, ...] = (
    "MECH-BUNDLE",
    "MECH-SCENES",
    "MECH-ASSEMBLY",
    "MECH-DRIFT",
    "MECH-CAPTIONS",
    "MECH-CAP",
    "MECH-PROVENANCE",
    "MECH-ACCESS",
)
ALIGNMENT_CHECK_IDS: tuple[str, ...] = (
    "ALIGN-COVERAGE",
    "ALIGN-BOUNDARY",
    "ALIGN-ARC",
    "ALIGN-ANALOGY",
    "ALIGN-PRONUNCIATION",
    "ALIGN-CONVENTIONS",
    "ALIGN-MATH",
    "ALIGN-TONE",
    "ALIGN-ROLES",
    "ALIGN-MNEMONIC",
)
ALL_CHECK_IDS: tuple[str, ...] = MECHANICAL_CHECK_IDS + ALIGNMENT_CHECK_IDS
NA_ALLOWED_CHECK_IDS: frozenset[str] = frozenset({"ALIGN-CONVENTIONS", "ALIGN-MNEMONIC"})

_OWNER: dict[str, str] = {
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
_ALLOWED_ROUTES: dict[str, frozenset[str]] = {
    "MECH-BUNDLE": frozenset({"INGEST", "CODEGEN", "VALIDATE"}),
    "MECH-SCENES": frozenset({"CODEGEN", "DRAFT_RENDER"}),
    "MECH-ASSEMBLY": frozenset({"DRAFT_RENDER"}),
    "MECH-DRIFT": frozenset({"NARRATION_SCRIPT", "VOICE_SYNTH", "CODEGEN"}),
    "MECH-CAPTIONS": frozenset({"NARRATION_SCRIPT", "DRAFT_RENDER", "FINALIZE"}),
    "MECH-CAP": frozenset({"STORYBOARD", "NARRATION_SCRIPT"}),
    "MECH-PROVENANCE": frozenset({"INGEST", "VALIDATE"}),
    "MECH-ACCESS": frozenset({"STORYBOARD", "CODEGEN", "DRAFT_RENDER"}),
    "ALIGN-COVERAGE": frozenset({"STORYBOARD"}),
    "ALIGN-BOUNDARY": frozenset({"STORYBOARD", "NARRATION_SCRIPT", "CODEGEN"}),
    "ALIGN-ARC": frozenset({"STORYBOARD", "NARRATION_SCRIPT"}),
    "ALIGN-ANALOGY": frozenset({"STORYBOARD", "NARRATION_SCRIPT", "CODEGEN"}),
    "ALIGN-PRONUNCIATION": frozenset({"NARRATION_SCRIPT", "VOICE_SYNTH"}),
    "ALIGN-CONVENTIONS": frozenset({"STORYBOARD", "NARRATION_SCRIPT", "CODEGEN"}),
    "ALIGN-MATH": frozenset({"STORYBOARD", "NARRATION_SCRIPT", "CODEGEN"}),
    "ALIGN-TONE": frozenset({"NARRATION_SCRIPT"}),
    "ALIGN-ROLES": frozenset({"STORYBOARD", "NARRATION_SCRIPT", "CODEGEN"}),
    "ALIGN-MNEMONIC": frozenset({"NARRATION_SCRIPT"}),
}

BundleProbe: TypeAlias = Callable[[str], Mapping[str, Any]]
MediaProbe: TypeAlias = Callable[[str], Mapping[str, Any]]
CaptionProbe: TypeAlias = Callable[..., Mapping[str, Any]]
ChecksumProbe: TypeAlias = Callable[[Mapping[str, str], Mapping[str, str]], Sequence[str]]
AccessibilityProbe: TypeAlias = Callable[[str, str, str], Mapping[str, Any]]


class EvidenceRef(TypedDict):
    kind: str
    ref: str
    sha256: str | None
    detail: str


class QAResult(TypedDict):
    id: str
    status: QAStatus
    evidence: list[EvidenceRef]
    owner: str
    affected_scene_ids: list[str]
    fix_route: str


class QAReport(TypedDict):
    schema_version: int
    verdict: QAVerdict
    checks: list[QAResult]
    counts: dict[str, int]
    blocking_ids: list[str]
    uncertain_ids: list[str]
    review_flags: list[dict[str, JSONValue]]


class QAContractError(ValueError):
    """Malformed caller data or QA report schema."""


def _json_safe(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_json_safe(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _json_safe(item) for key, item in value.items())
    return False


def _compact(value: Any) -> str:
    if not _json_safe(value):
        value = str(value)
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError, UnicodeError):
        return str(value)


def _evidence(
    *,
    ref: str,
    detail: Any,
    kind: str = "probe",
    sha256: Any = None,
) -> EvidenceRef:
    digest = sha256 if isinstance(sha256, str) and _SHA256_RE.fullmatch(sha256) else None
    return {
        "kind": kind,
        "ref": ref,
        "sha256": digest,
        "detail": _compact(detail),
    }


def _row(
    check_id: str,
    status: QAStatus,
    evidence: Sequence[EvidenceRef],
    *,
    affected: Sequence[str] = (),
    route: str = "NONE",
) -> QAResult:
    value: dict[str, Any] = {
        "id": check_id,
        "status": status,
        "evidence": [copy.deepcopy(item) for item in evidence],
        "owner": _OWNER[check_id],
        "affected_scene_ids": sorted(set(affected)),
        "fix_route": "NONE" if status in {"PASS", "n/a"} else route,
    }
    return validate_qa_result(value)


def _require_mapping(value: Any, *, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise QAContractError(f"{field}: expected an object")
    return value


def _require_string(value: Any, *, field: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise QAContractError(f"{field}: expected a nonempty string")
    return value


def _finite_number(value: Any, *, field: str, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QAContractError(f"{field}: expected a finite number")
    result = float(value)
    if not math.isfinite(result) or (minimum is not None and result < minimum):
        raise QAContractError(f"{field}: expected a finite number >= {minimum}")
    return result


def _observation_status(observation: Mapping[str, Any]) -> Literal["PASS", "FAIL", "UNKNOWN"]:
    if observation.get("ok") is False or observation.get("valid") is False:
        return "FAIL"
    for key in ("errors", "violations", "mismatches"):
        value = observation.get(key)
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) > 0:
            return "FAIL"
    if observation.get("ok") is True or observation.get("valid") is True:
        return "PASS"
    return "UNKNOWN"


def check_mech_bundle(
    *,
    bundle_dir: str,
    local_probe: BundleProbe,
    service_probe: BundleProbe,
) -> QAResult:
    _require_string(bundle_dir, field="bundle_dir")
    evidence: list[EvidenceRef] = []
    statuses: list[Literal["PASS", "FAIL", "UNKNOWN"]] = []
    for name, probe in (("local", local_probe), ("service", service_probe)):
        if not callable(probe):
            raise QAContractError(f"{name}_probe: expected a callable")
        try:
            observation = probe(bundle_dir)
            if not isinstance(observation, Mapping):
                raise TypeError("probe did not return an object")
            status = _observation_status(observation)
            statuses.append(status)
            evidence.append(
                _evidence(
                    ref=f"bundle:{name}",
                    detail=dict(observation),
                    sha256=observation.get("sha256") or observation.get("bundle_sha256"),
                )
            )
        except Exception as exc:
            statuses.append("UNKNOWN")
            evidence.append(
                _evidence(
                    ref=f"bundle:{name}",
                    detail={"observation": "unavailable", "error": str(exc)},
                )
            )
    if "FAIL" in statuses:
        return _row("MECH-BUNDLE", "FAIL", evidence, route="VALIDATE")
    if "UNKNOWN" in statuses:
        return _row("MECH-BUNDLE", "UNCERTAIN", evidence, route="VALIDATE")
    return _row("MECH-BUNDLE", "PASS", evidence)


def _scene_ids(values: Sequence[str], *, field: str, allow_empty: bool = False) -> list[str]:
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence):
        raise QAContractError(f"{field}: expected an array of scene IDs")
    result: list[str] = []
    for index, value in enumerate(values):
        result.append(_require_string(value, field=f"{field}[{index}]"))
    if not allow_empty and not result:
        raise QAContractError(f"{field}: must be nonempty")
    if len(result) != len(set(result)):
        raise QAContractError(f"{field}: duplicate scene IDs are malformed caller data")
    return result


def _job_succeeded(job: Mapping[str, Any]) -> bool:
    if job.get("ok") is True:
        return True
    status = job.get("status")
    return isinstance(status, str) and status.lower() in _MEDIA_SUCCESS_STATUSES


def check_mech_scenes(  # noqa: C901
    *,
    storyboard_scene_ids: Sequence[str],
    jobs: Sequence[Mapping[str, Any]],
    outputs: Mapping[str, Mapping[str, Any]],
) -> QAResult:
    expected = _scene_ids(storyboard_scene_ids, field="storyboard_scene_ids")
    if isinstance(jobs, (str, bytes)) or not isinstance(jobs, Sequence):
        raise QAContractError("jobs: expected an array")
    if not isinstance(outputs, Mapping):
        raise QAContractError("outputs: expected an object")
    jobs_by_scene: dict[str, list[Mapping[str, Any]]] = {scene_id: [] for scene_id in expected}
    unexpected: set[str] = set()
    for index, job in enumerate(jobs):
        job_mapping = _require_mapping(job, field=f"jobs[{index}]")
        scene_id = job_mapping.get("scene_id")
        if not isinstance(scene_id, str) or not scene_id:
            unexpected.add(f"job-{index}")
            continue
        if scene_id not in jobs_by_scene:
            unexpected.add(scene_id)
            continue
        jobs_by_scene[scene_id].append(job_mapping)
    failed: set[str] = set(unexpected)
    details: dict[str, Any] = {"expected_scene_ids": expected, "scenes": {}}
    for scene_id in expected:
        scene_jobs = jobs_by_scene[scene_id]
        output = outputs.get(scene_id)
        output_valid = (
            isinstance(output, Mapping)
            and isinstance(output.get("path"), str)
            and bool(output.get("path"))
        )
        exactly_one_success = len(scene_jobs) == 1 and _job_succeeded(scene_jobs[0])
        if not exactly_one_success or not output_valid:
            failed.add(scene_id)
        details["scenes"][scene_id] = {
            "job_count": len(scene_jobs),
            "job_statuses": [job.get("status") for job in scene_jobs],
            "output_present": output_valid,
        }
    for output_id in outputs:
        if not isinstance(output_id, str) or output_id not in set(expected):
            failed.add(str(output_id))
    evidence = [_evidence(ref="scene-render-join", detail=details)]
    if failed:
        return _row(
            "MECH-SCENES",
            "FAIL",
            evidence,
            affected=sorted(failed),
            route="DRAFT_RENDER",
        )
    return _row("MECH-SCENES", "PASS", evidence)


def _probe_streams(observation: Mapping[str, Any], name: str) -> list[Any] | None:
    value = observation.get(name)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return list(value)
    return None


def check_mech_assembly(
    *,
    assembled_video_path: str,
    ordered_scene_ids: Sequence[str],
    scene_outputs: Mapping[str, Mapping[str, Any]],
    media_probe: MediaProbe,
) -> QAResult:
    path = _require_string(assembled_video_path, field="assembled_video_path")
    expected = _scene_ids(ordered_scene_ids, field="ordered_scene_ids")
    if not isinstance(scene_outputs, Mapping):
        raise QAContractError("scene_outputs: expected an object")
    if not callable(media_probe):
        raise QAContractError("media_probe: expected a callable")
    output_order = list(scene_outputs)
    output_shape_ok = output_order == expected and all(
        isinstance(scene_outputs.get(scene_id), Mapping)
        and isinstance(scene_outputs[scene_id].get("path"), str)
        and bool(scene_outputs[scene_id].get("path"))
        for scene_id in expected
    )
    try:
        observation = media_probe(path)
        if not isinstance(observation, Mapping):
            raise TypeError("media probe did not return an object")
    except Exception as exc:
        evidence = [
            _evidence(
                ref="assembled-media",
                detail={"observation": "unavailable", "error": str(exc)},
            )
        ]
        return _row("MECH-ASSEMBLY", "UNCERTAIN", evidence, affected=expected, route="DRAFT_RENDER")
    evidence = [
        _evidence(
            ref="assembled-media",
            detail={"probe": dict(observation), "scene_order": output_order},
            sha256=observation.get("sha256"),
        )
    ]
    duration = observation.get("duration_seconds")
    size = observation.get("size_bytes")
    videos = _probe_streams(observation, "video_streams")
    audios = _probe_streams(observation, "audio_streams")
    required_available = (
        isinstance(duration, (int, float))
        and not isinstance(duration, bool)
        and math.isfinite(float(duration))
        and isinstance(size, int)
        and not isinstance(size, bool)
        and videos is not None
        and audios is not None
    )
    if not required_available:
        return _row(
            "MECH-ASSEMBLY",
            "UNCERTAIN",
            evidence,
            affected=expected,
            route="DRAFT_RENDER",
        )
    probe_order = observation.get("assembly_order")
    order_ok = (
        probe_order is None or list(probe_order) == expected
        if isinstance(probe_order, Sequence) and not isinstance(probe_order, (str, bytes))
        else probe_order is None
    )
    duration_value = float(cast(float, duration))
    size_value = cast(int, size)
    defects = (
        observation.get("ok") is False
        or observation.get("decodable") is False
        or duration_value <= 0
        or size_value <= 0
        or not videos
        or not audios
        or not output_shape_ok
        or not order_ok
    )
    if defects:
        return _row("MECH-ASSEMBLY", "FAIL", evidence, affected=expected, route="DRAFT_RENDER")
    return _row("MECH-ASSEMBLY", "PASS", evidence)


def check_mech_drift(  # noqa: C901
    *,
    scene_timings: Sequence[Mapping[str, Any]],
    max_scene_tail_seconds: float,
) -> QAResult:
    bound = _finite_number(max_scene_tail_seconds, field="max_scene_tail_seconds", minimum=0.0)
    if isinstance(scene_timings, (str, bytes)) or not isinstance(scene_timings, Sequence):
        raise QAContractError("scene_timings: expected an array")
    if not scene_timings:
        raise QAContractError("scene_timings: must be nonempty")
    calculations: list[dict[str, JSONValue]] = []
    failed: list[str] = []
    unavailable: list[str] = []
    seen: set[str] = set()
    for index, timing in enumerate(scene_timings):
        row = _require_mapping(timing, field=f"scene_timings[{index}]")
        scene_id = _require_string(row.get("scene_id"), field=f"scene_timings[{index}].scene_id")
        if scene_id in seen:
            raise QAContractError("scene_timings: duplicate scene IDs")
        seen.add(scene_id)
        video = row.get("video_duration_seconds")
        narration = row.get("narration_duration_seconds")
        if (
            isinstance(video, bool)
            or not isinstance(video, (int, float))
            or not math.isfinite(float(video))
            or isinstance(narration, bool)
            or not isinstance(narration, (int, float))
            or not math.isfinite(float(narration))
        ):
            unavailable.append(scene_id)
            calculations.append({"scene_id": scene_id, "observation": "unavailable"})
            continue
        video_value = float(video)
        narration_value = float(narration)
        tail = video_value - narration_value
        measured = row.get("measured_duration", row.get("storyboard_measured_duration"))
        measured_match: bool | None = None
        if measured is not None:
            if isinstance(measured, bool) or not isinstance(measured, (int, float)):
                unavailable.append(scene_id)
            else:
                measured_match = math.isclose(
                    float(measured), video_value, rel_tol=0.0, abs_tol=_FLOAT_TOLERANCE
                )
                if not measured_match:
                    failed.append(scene_id)
        if video_value < 0 or narration_value < 0 or tail < 0 or tail > bound:
            failed.append(scene_id)
        calculations.append(
            {
                "scene_id": scene_id,
                "video_duration_seconds": video_value,
                "narration_duration_seconds": narration_value,
                "signed_tail_seconds": tail,
                "max_scene_tail_seconds": bound,
                "storyboard_measured_match": measured_match,
            }
        )
    evidence = [_evidence(ref="scene-timing-ledger", detail=calculations)]
    if failed:
        return _row(
            "MECH-DRIFT",
            "FAIL",
            evidence,
            affected=sorted(set(failed)),
            route="CODEGEN",
        )
    if unavailable:
        return _row(
            "MECH-DRIFT",
            "UNCERTAIN",
            evidence,
            affected=sorted(set(unavailable)),
            route="CODEGEN",
        )
    return _row("MECH-DRIFT", "PASS", evidence)


def _collapse_whitespace(value: str) -> str:
    return " ".join(value.split())


def check_mech_captions(  # noqa: C901
    *,
    captions_path: str,
    narration_by_scene: Mapping[str, str],
    scene_windows: Mapping[str, tuple[float, float]],
    video_duration_seconds: float,
    caption_probe: CaptionProbe,
) -> QAResult:
    path = _require_string(captions_path, field="captions_path")
    duration = _finite_number(video_duration_seconds, field="video_duration_seconds", minimum=0.0)
    if duration <= 0:
        raise QAContractError("video_duration_seconds must be positive")
    if not isinstance(narration_by_scene, Mapping) or not narration_by_scene:
        raise QAContractError("narration_by_scene: expected a nonempty object")
    if not isinstance(scene_windows, Mapping) or set(scene_windows) != set(narration_by_scene):
        raise QAContractError("scene_windows keys must equal narration_by_scene keys")
    normalized_narration: dict[str, str] = {}
    normalized_windows: dict[str, tuple[float, float]] = {}
    for scene_id, narration in narration_by_scene.items():
        normalized_narration[_require_string(scene_id, field="narration_by_scene key")] = (
            _require_string(narration, field=f"narration_by_scene.{scene_id}")
        )
        window = scene_windows.get(scene_id)
        if not isinstance(window, tuple) or len(window) != 2:
            raise QAContractError(f"scene_windows.{scene_id}: expected a (start, end) tuple")
        start = _finite_number(window[0], field=f"scene_windows.{scene_id}[0]", minimum=0.0)
        end = _finite_number(window[1], field=f"scene_windows.{scene_id}[1]", minimum=0.0)
        if end <= start or end > duration:
            raise QAContractError(f"scene_windows.{scene_id}: invalid or out-of-range window")
        normalized_windows[scene_id] = (start, end)
    if not callable(caption_probe):
        raise QAContractError("caption_probe: expected a callable")
    try:
        observation = caption_probe(
            path,
            narration_by_scene=normalized_narration,
            scene_windows=normalized_windows,
            video_duration_seconds=duration,
        )
        if not isinstance(observation, Mapping):
            raise TypeError("caption probe did not return an object")
    except Exception as exc:
        evidence = [
            _evidence(
                ref="caption-coverage",
                detail={"observation": "unavailable", "error": str(exc)},
            )
        ]
        return _row(
            "MECH-CAPTIONS",
            "UNCERTAIN",
            evidence,
            affected=sorted(normalized_narration),
            route="DRAFT_RENDER",
        )

    missing = set(observation.get("missing_scene_ids", []))
    mismatch = set(observation.get("text_mismatch_scene_ids", []))
    out_of_range = observation.get("out_of_range_cue_indices", [])
    errors = observation.get("errors", [])
    cue_count = observation.get("cue_count")
    cue_text = observation.get("cue_text_by_scene")
    if isinstance(cue_text, Mapping):
        for scene_id, narration in normalized_narration.items():
            candidate = cue_text.get(scene_id)
            if not isinstance(candidate, str):
                missing.add(scene_id)
            elif _collapse_whitespace(candidate) != _collapse_whitespace(narration):
                mismatch.add(scene_id)
    evidence = [
        _evidence(
            ref="caption-coverage",
            detail={
                "probe": dict(observation),
                "whitespace_only_comparison": True,
                "missing_scene_ids": sorted(str(item) for item in missing),
                "text_mismatch_scene_ids": sorted(str(item) for item in mismatch),
            },
            sha256=observation.get("sha256"),
        )
    ]
    if not isinstance(cue_count, int) or isinstance(cue_count, bool):
        return _row(
            "MECH-CAPTIONS",
            "UNCERTAIN",
            evidence,
            affected=sorted(normalized_narration),
            route="DRAFT_RENDER",
        )
    failed = (
        observation.get("ok") is False
        or observation.get("exists") is False
        or cue_count <= 0
        or bool(missing)
        or bool(mismatch)
        or (isinstance(out_of_range, Sequence) and len(out_of_range) > 0)
        or (isinstance(errors, Sequence) and len(errors) > 0)
    )
    affected = sorted({str(item) for item in missing | mismatch if isinstance(item, str)})
    if failed:
        return _row(
            "MECH-CAPTIONS",
            "FAIL",
            evidence,
            affected=affected,
            route="DRAFT_RENDER",
        )
    return _row("MECH-CAPTIONS", "PASS", evidence)


def check_mech_cap(
    *,
    duration_seconds: float,
    length_cap_seconds: float | None,
    length_guide_seconds: float | None,
) -> QAResult:
    duration = _finite_number(duration_seconds, field="duration_seconds", minimum=0.0)
    cap = None
    guide = None
    if length_cap_seconds is not None:
        cap = _finite_number(length_cap_seconds, field="length_cap_seconds", minimum=0.0)
        if cap <= 0:
            raise QAContractError("length_cap_seconds must be positive")
    if length_guide_seconds is not None:
        guide = _finite_number(length_guide_seconds, field="length_guide_seconds", minimum=0.0)
        if guide <= 0:
            raise QAContractError("length_guide_seconds must be positive")
    over_cap = cap is not None and duration > cap
    over_guide = guide is not None and duration > guide
    evidence = [
        _evidence(
            ref="length-guide" if over_guide else "length-constraints",
            detail={
                "duration_seconds": duration,
                "length_cap_seconds": cap,
                "length_guide_seconds": guide,
                "over_cap": over_cap,
                "over_guide": over_guide,
                "no_cap_enforced": cap is None,
            },
        )
    ]
    if over_cap:
        return _row("MECH-CAP", "FAIL", evidence, route="NARRATION_SCRIPT")
    return _row("MECH-CAP", "PASS", evidence)


def check_mech_provenance(  # noqa: C901
    *,
    manifest: Mapping[str, Any],
    provenance: Mapping[str, Any],
    expected_section_identity: Mapping[str, str],
    expected_content_sha256: str,
    checksum_files: Mapping[str, str],
    checksum_probe: ChecksumProbe,
) -> QAResult:
    if (
        not isinstance(expected_section_identity, Mapping)
        or set(expected_section_identity) != _IDENTITY_KEYS
    ):
        raise QAContractError("expected_section_identity has invalid keys")
    for key, value in expected_section_identity.items():
        _require_string(key, field="expected_section_identity key")
        _require_string(value, field=f"expected_section_identity.{key}")
    if not isinstance(expected_content_sha256, str) or not _SHA256_RE.fullmatch(
        expected_content_sha256
    ):
        raise QAContractError("expected_content_sha256 must be lowercase SHA-256")
    if not isinstance(checksum_files, Mapping) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in checksum_files.items()
    ):
        raise QAContractError("checksum_files must map logical strings to path strings")
    if not callable(checksum_probe):
        raise QAContractError("checksum_probe: expected a callable")

    defects: list[str] = []
    if not isinstance(manifest, Mapping) or set(manifest) != _MANIFEST_KEYS:
        defects.append("manifest key set is not exact")
    else:
        if (
            isinstance(manifest.get("bundle_version"), bool)
            or not isinstance(manifest.get("bundle_version"), int)
            or manifest.get("bundle_version", 0) <= 0
        ):
            defects.append("manifest bundle_version is invalid")
        for key in ("video_id", "primitive_library_version", "theme"):
            if not isinstance(manifest.get(key), str) or not manifest.get(key):
                defects.append(f"manifest {key} is invalid")
    if not isinstance(provenance, Mapping) or set(provenance) != _PROVENANCE_KEYS:
        defects.append("provenance key set is not exact")
        checksums: Mapping[str, str] | None = None
    else:
        if provenance.get("section_identity") != dict(expected_section_identity):
            defects.append("provenance section identity disagrees with intake")
        if provenance.get("content_sha256") != expected_content_sha256:
            defects.append("provenance content hash disagrees with intake")
        checksums_value = provenance.get("checksums")
        if not isinstance(checksums_value, Mapping) or not checksums_value:
            defects.append("provenance checksums are absent")
            checksums = None
        elif not all(
            isinstance(key, str) and isinstance(value, str) and bool(_SHA256_RE.fullmatch(value))
            for key, value in checksums_value.items()
        ):
            defects.append("provenance checksums are malformed")
            checksums = None
        else:
            checksums = cast(Mapping[str, str], checksums_value)
            if checksums.get("input/section") != expected_content_sha256:
                defects.append("provenance input/section checksum disagrees")
    evidence: list[EvidenceRef] = [
        _evidence(
            ref="manifest-provenance-structure",
            detail={"defects": defects, "manifest_keys": sorted(manifest)},
        )
    ]
    if checksums is not None:
        try:
            mismatches_value = checksum_probe(checksums, checksum_files)
            if isinstance(mismatches_value, (str, bytes)) or not isinstance(
                mismatches_value, Sequence
            ):
                raise TypeError("checksum probe did not return a sequence")
            mismatches = [str(item) for item in mismatches_value]
            evidence.append(_evidence(ref="provenance-checksums", detail=mismatches))
            defects.extend(mismatches)
        except Exception as exc:
            evidence.append(
                _evidence(
                    ref="provenance-checksums",
                    detail={"observation": "unavailable", "error": str(exc)},
                )
            )
            if defects:
                return _row("MECH-PROVENANCE", "FAIL", evidence, route="VALIDATE")
            return _row("MECH-PROVENANCE", "UNCERTAIN", evidence, route="VALIDATE")
    if defects:
        route = "INGEST" if any("intake" in defect for defect in defects) else "VALIDATE"
        return _row("MECH-PROVENANCE", "FAIL", evidence, route=route)
    return _row("MECH-PROVENANCE", "PASS", evidence)


def _media_dimensions(observation: Mapping[str, Any]) -> tuple[int, int] | None:
    width = observation.get("width")
    height = observation.get("height")
    if (
        isinstance(width, int)
        and not isinstance(width, bool)
        and isinstance(height, int)
        and not isinstance(height, bool)
    ):
        return width, height
    streams = observation.get("video_streams")
    if isinstance(streams, Sequence) and not isinstance(streams, (str, bytes)) and streams:
        first = streams[0]
        if isinstance(first, Mapping):
            width = first.get("width")
            height = first.get("height")
            if (
                isinstance(width, int)
                and not isinstance(width, bool)
                and isinstance(height, int)
                and not isinstance(height, bool)
            ):
                return width, height
    return None


def check_mech_access(  # noqa: C901
    *,
    video_path: str,
    storyboard_path: str,
    captions_path: str,
    media_probe: MediaProbe,
    accessibility_probe: AccessibilityProbe,
) -> QAResult:
    video = _require_string(video_path, field="video_path")
    storyboard = _require_string(storyboard_path, field="storyboard_path")
    captions = _require_string(captions_path, field="captions_path")
    if not callable(media_probe) or not callable(accessibility_probe):
        raise QAContractError("media_probe and accessibility_probe must be callable")
    evidence: list[EvidenceRef] = []
    media: Mapping[str, Any] | None = None
    access: Mapping[str, Any] | None = None
    unavailable = False
    for name, call in (
        ("media", lambda: media_probe(video)),
        ("visual", lambda: accessibility_probe(video, storyboard, captions)),
    ):
        try:
            observation = call()
            if not isinstance(observation, Mapping):
                raise TypeError("probe did not return an object")
            if name == "media":
                media = observation
            else:
                access = observation
            evidence.append(_evidence(ref=f"access:{name}", detail=dict(observation)))
        except Exception as exc:
            unavailable = True
            evidence.append(
                _evidence(
                    ref=f"access:{name}",
                    detail={"observation": "unavailable", "error": str(exc)},
                )
            )
    failed = False
    if media is not None:
        dimensions = _media_dimensions(media)
        if dimensions is None:
            unavailable = True
        elif dimensions[0] < _MIN_ACCESS_WIDTH or dimensions[1] < _MIN_ACCESS_HEIGHT:
            failed = True
    if access is not None:
        required = {
            "text_readable": access.get("text_readable"),
            "non_color_meaning": access.get("non_color_meaning"),
            "captions_available": access.get("captions_available"),
        }
        if any(value is False for value in required.values()):
            failed = True
        if any(value is not True for value in required.values()):
            unavailable = True
    if failed:
        return _row("MECH-ACCESS", "FAIL", evidence, route="CODEGEN")
    if unavailable or access is None or media is None:
        return _row("MECH-ACCESS", "UNCERTAIN", evidence, route="CODEGEN")
    return _row("MECH-ACCESS", "PASS", evidence)


def validate_qa_result(row: Mapping[str, Any]) -> QAResult:  # noqa: C901
    if not isinstance(row, Mapping) or set(row) != _ROW_KEYS:
        raise QAContractError(f"QA row must have exactly {sorted(_ROW_KEYS)}")
    check_id = row.get("id")
    if check_id not in ALL_CHECK_IDS:
        raise QAContractError(f"unknown QA check ID: {check_id!r}")
    status = row.get("status")
    if status not in {"PASS", "FAIL", "UNCERTAIN", "n/a"}:
        raise QAContractError(f"{check_id}: invalid status")
    if status == "n/a" and check_id not in NA_ALLOWED_CHECK_IDS:
        raise QAContractError(f"{check_id}: n/a is not authorized")
    owner = row.get("owner")
    if not isinstance(owner, str) or not owner or owner != _OWNER[check_id]:
        raise QAContractError(f"{check_id}: owner must be {_OWNER[check_id]}")
    route = row.get("fix_route")
    if status in {"PASS", "n/a"}:
        if route != "NONE":
            raise QAContractError(f"{check_id}: passing/n/a rows require fix_route NONE")
    elif route not in _ALLOWED_ROUTES[check_id]:
        raise QAContractError(f"{check_id}: invalid fix_route {route!r}")

    evidence_value = row.get("evidence")
    if (
        isinstance(evidence_value, (str, bytes))
        or not isinstance(evidence_value, Sequence)
        or not evidence_value
    ):
        raise QAContractError(f"{check_id}: evidence must be nonempty")
    evidence: list[EvidenceRef] = []
    for index, item in enumerate(evidence_value):
        if not isinstance(item, Mapping) or set(item) != _EVIDENCE_KEYS:
            raise QAContractError(f"{check_id}.evidence[{index}]: invalid keys")
        kind = item.get("kind")
        ref = item.get("ref")
        detail = item.get("detail")
        digest = item.get("sha256")
        if not isinstance(kind, str) or not kind:
            raise QAContractError(f"{check_id}.evidence[{index}].kind must be nonempty")
        if not isinstance(ref, str) or not ref:
            raise QAContractError(f"{check_id}.evidence[{index}].ref must be nonempty")
        if not isinstance(detail, str) or not detail:
            raise QAContractError(f"{check_id}.evidence[{index}].detail must be nonempty")
        if digest is not None and (not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest)):
            raise QAContractError(f"{check_id}.evidence[{index}].sha256 is invalid")
        evidence.append({"kind": kind, "ref": ref, "sha256": digest, "detail": detail})

    affected_value = row.get("affected_scene_ids")
    if isinstance(affected_value, (str, bytes)) or not isinstance(affected_value, Sequence):
        raise QAContractError(f"{check_id}: affected_scene_ids must be an array")
    affected = [
        _require_string(value, field=f"{check_id}.affected_scene_ids[{index}]")
        for index, value in enumerate(affected_value)
    ]
    if affected != sorted(set(affected)):
        raise QAContractError(f"{check_id}: affected_scene_ids must be sorted and unique")
    return {
        "id": check_id,
        "status": status,
        "evidence": evidence,
        "owner": owner,
        "affected_scene_ids": affected,
        "fix_route": route,
    }


def _guide_review_flag(row: QAResult) -> dict[str, JSONValue] | None:
    if row["id"] != "MECH-CAP" or row["status"] != "PASS":
        return None
    for evidence in row["evidence"]:
        if evidence["ref"] != "length-guide":
            continue
        try:
            detail = json.loads(evidence["detail"])
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(detail, dict) and detail.get("over_guide") is True:
            return {
                "id": "LENGTH-GUIDE",
                "over_guide": True,
                "duration_seconds": cast(JSONValue, detail.get("duration_seconds")),
                "length_guide_seconds": cast(JSONValue, detail.get("length_guide_seconds")),
            }
    return None


def roll_up_report(
    rows: Sequence[Mapping[str, Any]],
    *,
    review_flags: Sequence[Mapping[str, Any]] = (),
) -> QAReport:
    if isinstance(rows, (str, bytes)) or not isinstance(rows, Sequence):
        raise QAContractError("rows: expected an array")
    validated = [validate_qa_result(row) for row in rows]
    identifiers = [row["id"] for row in validated]
    duplicates = sorted(
        identifier for identifier, count in Counter(identifiers).items() if count > 1
    )
    missing = sorted(set(ALL_CHECK_IDS) - set(identifiers))
    if duplicates or missing or set(identifiers) != set(ALL_CHECK_IDS):
        raise QAContractError(
            f"QA rows require every ID exactly once; duplicates={duplicates}, missing={missing}"
        )
    by_id = {row["id"]: row for row in validated}
    ordered = [by_id[check_id] for check_id in ALL_CHECK_IDS]
    counts = {status: sum(row["status"] == status for row in ordered) for status in _COUNT_KEYS}
    blocking_ids = [row["id"] for row in ordered if row["status"] == "FAIL"]
    uncertain_ids = [row["id"] for row in ordered if row["status"] == "UNCERTAIN"]
    verdict: QAVerdict
    if blocking_ids:
        verdict = "FAIL"
    elif uncertain_ids:
        verdict = "UNCERTAIN"
    else:
        verdict = "PASS"

    if isinstance(review_flags, (str, bytes)) or not isinstance(review_flags, Sequence):
        raise QAContractError("review_flags: expected an array")
    normalized_flags: list[dict[str, JSONValue]] = []
    for index, flag in enumerate(review_flags):
        if not isinstance(flag, Mapping) or not _json_safe(dict(flag)):
            raise QAContractError(f"review_flags[{index}]: expected a JSON object")
        normalized_flags.append(copy.deepcopy(cast(dict[str, JSONValue], dict(flag))))
    cap_flag = _guide_review_flag(by_id["MECH-CAP"])
    if cap_flag is not None and cap_flag not in normalized_flags:
        normalized_flags.append(cap_flag)
    return {
        "schema_version": 1,
        "verdict": verdict,
        "checks": ordered,
        "counts": counts,
        "blocking_ids": blocking_ids,
        "uncertain_ids": uncertain_ids,
        "review_flags": normalized_flags,
    }
