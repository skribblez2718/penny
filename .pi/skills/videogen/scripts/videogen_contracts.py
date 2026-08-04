from __future__ import annotations

import copy
import json
import math
import os
import re
import string
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any, Literal, TypeAlias, TypedDict, cast
from urllib.parse import urlsplit

Pathish: TypeAlias = str | PathLike[str]
JSONScalar: TypeAlias = None | bool | int | float | str
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
_MARKDOWN_FRONT_MATTER_TYPE_RE = re.compile(
    r"^(?:section_type|type)\s*:\s*['\"]?([^'\"#\s]+)", re.IGNORECASE
)
_JSON_FENCE_RE = re.compile(r"```json\s*\n(.*?)\n```", re.IGNORECASE | re.DOTALL)

_REQUIRED_CONSTRAINTS = frozenset(
    {
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
    }
)
_OPTIONAL_CONSTRAINTS = frozenset(
    {
        "app_profile",
        "profiles_dir",
        "character_usage_policy",
        "max_scene_tail_seconds",
        "length_cap_seconds",
        "length_guide_seconds",
        "quality_tier",
        "mode",
        "existing_video",
        "feedback_text",
        "max_refine_iterations",
    }
)
_ALLOWED_CONSTRAINTS = _REQUIRED_CONSTRAINTS | _OPTIONAL_CONSTRAINTS
_FORBIDDEN_PROFILE_FIELDS = frozenset(
    {
        "section_content",
        "section_identity",
        "content_gate",
        "mode",
        "existing_video",
        "feedback_text",
        "app_profile",
        "profiles_dir",
    }
)
_PROFILE_ALLOWED_FIELDS = _ALLOWED_CONSTRAINTS - _FORBIDDEN_PROFILE_FIELDS
_IDENTITY_KEYS = frozenset({"course_slug", "unit_slug", "lesson_slug", "stable_key"})
_CONTENT_GATE_KEYS = frozenset({"finalized", "derivation_verdict", "evidence_ref"})
_PUBLISH_REQUIRED_KEYS = frozenset(
    {
        "video_id_template",
        "base_name_template",
        "video_destination_template",
        "captions_destination_template",
        "poster_destination_template",
        "attach_behavior",
        "handoff_only",
    }
)
_PUBLISH_OPTIONAL_KEYS = frozenset(
    {
        "consumer_preference",
        "required_sidecars",
        "requires_word_timings",
        "instructions",
        "metadata",
    }
)
_ALLOWED_TEMPLATE_FIELDS = frozenset(
    {"course_slug", "unit_slug", "lesson_slug", "stable_key", "base_name"}
)
_PROFILE_LIST_PATH_FIELDS = frozenset({"teaching_canon_paths"})
_PROFILE_SINGLE_PATH_FIELDS = frozenset(
    {"analogy_registry", "pronunciation_canon", "universe_canon_dir"}
)


class VideogenContractError(ValueError):
    """Base error for the videogen caller contract."""


class ProfileResolutionError(VideogenContractError):
    """A named profile could not be loaded or did not satisfy its profile schema."""


class ConstraintValidationError(VideogenContractError):
    """One or more independently detectable intake fields are invalid."""

    def __init__(self, errors: Sequence[str]) -> None:
        normalized = tuple(sorted(set(errors)))
        self.errors: tuple[str, ...] = normalized
        super().__init__("; ".join(normalized))


class PathSafetyError(VideogenContractError):
    """A path, path component, or URL violates a confinement rule."""


class PublishConventionError(VideogenContractError):
    """A publish handoff convention is malformed or unsafe."""


class TemplateExpansionError(PublishConventionError):
    """A publish convention template cannot be expanded safely."""


class DirectProfileProvenance(TypedDict):
    mode: Literal["direct"]


class NamedProfileProvenance(TypedDict):
    mode: Literal["profile"]
    name: str
    resolved_path: str
    sha256: str


ProfileProvenance: TypeAlias = DirectProfileProvenance | NamedProfileProvenance


@dataclass(frozen=True, slots=True)
class ProfileResolution:
    merged_constraints: dict[str, JSONValue]
    provenance: ProfileProvenance


class NormalizedPublishConvention(TypedDict):
    video_id_template: str
    base_name_template: str
    destinations: dict[str, str]
    attach_behavior: str
    consumer_preference: str | None
    required_sidecars: list[str]
    requires_word_timings: bool
    instructions: list[str]
    metadata: dict[str, JSONValue]
    handoff_only: Literal[True]


class ExpandedPublishConvention(TypedDict):
    video_id: str
    base_name: str
    destinations: dict[str, str]
    attach_behavior: str
    consumer_preference: str | None
    required_sidecars: list[str]
    requires_word_timings: bool
    instructions: list[str]
    metadata: dict[str, JSONValue]
    handoff_only: Literal[True]


SectionIdentity = dict[str, str]
ContentGate = dict[str, JSONValue]
PrimitiveSchemaSource = dict[str, str]


@dataclass(frozen=True, slots=True)
class NormalizedIntake:
    section_bytes: bytes
    section_source_mode: Literal["inline", "file"]
    section_source_path: str | None
    section_identity: SectionIdentity
    content_sha256: str
    content_gate: ContentGate
    teaching_canon_paths: tuple[str, ...]
    analogy_registry: str
    pronunciation_canon: str
    universe_canon_dir: str
    superpose_url: str
    voice_studio_url: str
    voice_id: str
    theme: str
    primitive_schema_source: PrimitiveSchemaSource
    workspace_dir: str
    output_dir: str
    publish_target_conventions: NormalizedPublishConvention
    profile_provenance: ProfileProvenance
    character_usage_policy: str | dict[str, JSONValue] | None
    max_scene_tail_seconds: float
    length_cap_seconds: float | None
    length_guide_seconds: float | None
    quality_tier: Literal["final", "4k"]
    mode: Literal["create", "refine_existing"]
    existing_video: dict[str, JSONValue] | None
    feedback_bytes: bytes | None
    feedback_source_mode: Literal["inline", "file"] | None
    feedback_source_path: str | None
    max_refine_iterations: int

    def to_dict(self) -> dict[str, JSONValue]:
        feedback: dict[str, JSONValue] | None = None
        if self.feedback_bytes is not None and self.feedback_source_mode is not None:
            feedback = {
                "source_mode": self.feedback_source_mode,
                "source_path": self.feedback_source_path,
                "feedback_sha256": _sha256_bytes(self.feedback_bytes),
            }
        return cast(
            dict[str, JSONValue],
            {
                "section_content": {
                    "source_mode": self.section_source_mode,
                    "source_path": self.section_source_path,
                    "content_sha256": self.content_sha256,
                },
                "section_identity": copy.deepcopy(self.section_identity),
                "content_gate": copy.deepcopy(self.content_gate),
                "teaching_canon_paths": list(self.teaching_canon_paths),
                "analogy_registry": self.analogy_registry,
                "pronunciation_canon": self.pronunciation_canon,
                "universe_canon_dir": self.universe_canon_dir,
                "superpose_url": self.superpose_url,
                "voice_studio_url": self.voice_studio_url,
                "voice_id": self.voice_id,
                "theme": self.theme,
                "primitive_schema_source": copy.deepcopy(self.primitive_schema_source),
                "workspace_dir": self.workspace_dir,
                "output_dir": self.output_dir,
                "publish_target_conventions": copy.deepcopy(self.publish_target_conventions),
                "profile_provenance": copy.deepcopy(self.profile_provenance),
                "character_usage_policy": copy.deepcopy(self.character_usage_policy),
                "max_scene_tail_seconds": self.max_scene_tail_seconds,
                "length_cap_seconds": self.length_cap_seconds,
                "length_guide_seconds": self.length_guide_seconds,
                "quality_tier": self.quality_tier,
                "mode": self.mode,
                "existing_video": copy.deepcopy(self.existing_video),
                "feedback_text": feedback,
                "max_refine_iterations": self.max_refine_iterations,
            },
        )


def _sha256_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def _coerce_path(path: Pathish, *, field: str) -> Path:
    try:
        value = os.fspath(path)
    except (TypeError, ValueError) as exc:
        raise PathSafetyError(f"{field}: expected a filesystem path") from exc
    if not isinstance(value, str) or not value:
        raise PathSafetyError(f"{field}: expected a nonempty filesystem path")
    if _CONTROL_RE.search(value):
        raise PathSafetyError(f"{field}: control characters are forbidden")
    return Path(value)


def _absolute_lexical(path: Path) -> Path:
    return Path(os.path.abspath(os.path.normpath(str(path))))


def _reject_symlink_components(path: Path, *, field: str) -> None:
    absolute = _absolute_lexical(path)
    current = Path(absolute.anchor)
    try:
        for component in absolute.parts[1:]:
            current = current / component
            if current.is_symlink():
                raise PathSafetyError(f"{field}: symlink traversal is forbidden: {current}")
    except OSError as exc:
        raise PathSafetyError(f"{field}: could not inspect path components: {exc}") from exc


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def validate_safe_component(value: str, *, field: str) -> str:
    if not isinstance(value, str):
        raise PathSafetyError(f"{field}: expected a string")
    if not value or not value.strip():
        raise PathSafetyError(f"{field}: must be nonempty")
    if value != value.strip():
        raise PathSafetyError(f"{field}: surrounding whitespace is forbidden")
    if value in {".", ".."}:
        raise PathSafetyError(f"{field}: dot components are forbidden")
    if _CONTROL_RE.search(value):
        raise PathSafetyError(f"{field}: control characters are forbidden")
    if "/" in value or "\\" in value:
        raise PathSafetyError(f"{field}: path separators are forbidden")
    path = Path(value)
    if path.is_absolute() or len(path.parts) != 1:
        raise PathSafetyError(f"{field}: must be one relative path component")
    return value


def validate_absolute_file(path: Pathish, *, field: str) -> str:
    candidate = _coerce_path(path, field=field)
    if not candidate.is_absolute():
        raise PathSafetyError(f"{field}: must be an absolute file path")
    try:
        resolved = candidate.resolve(strict=True)
        if not resolved.is_file():
            raise PathSafetyError(f"{field}: is not a regular file: {candidate}")
        with resolved.open("rb") as handle:
            handle.read(1)
    except PathSafetyError:
        raise
    except (OSError, RuntimeError) as exc:
        raise PathSafetyError(f"{field}: unreadable file {candidate}: {exc}") from exc
    return str(resolved)


def validate_absolute_directory(path: Pathish, *, field: str) -> str:
    candidate = _coerce_path(path, field=field)
    if not candidate.is_absolute():
        raise PathSafetyError(f"{field}: must be an absolute directory path")
    try:
        resolved = candidate.resolve(strict=True)
        if not resolved.is_dir():
            raise PathSafetyError(f"{field}: is not a directory: {candidate}")
        next(resolved.iterdir(), None)
    except PathSafetyError:
        raise
    except (OSError, RuntimeError) as exc:
        raise PathSafetyError(f"{field}: unreadable directory {candidate}: {exc}") from exc
    return str(resolved)


def validate_write_root(path: Pathish, *, field: str) -> str:
    candidate = _coerce_path(path, field=field)
    if not candidate.is_absolute():
        raise PathSafetyError(f"{field}: must be an absolute directory path")
    lexical = _absolute_lexical(candidate)
    _reject_symlink_components(lexical, field=field)
    current = lexical
    try:
        while not current.exists():
            if current == current.parent:
                break
            current = current.parent
        if not current.exists() or not current.is_dir():
            raise PathSafetyError(f"{field}: nearest existing ancestor is not a directory")
        if lexical.exists() and not lexical.is_dir():
            raise PathSafetyError(f"{field}: write root is not a directory")
        resolved = lexical.resolve(strict=False)
    except PathSafetyError:
        raise
    except (OSError, RuntimeError) as exc:
        raise PathSafetyError(f"{field}: cannot validate write root: {exc}") from exc
    return str(resolved)


def assert_confined_path(root: Pathish, candidate: Pathish) -> str:
    root_path = _coerce_path(root, field="root")
    if not root_path.is_absolute():
        raise PathSafetyError("root: must be absolute")
    candidate_path = _coerce_path(candidate, field="candidate")
    if not candidate_path.is_absolute():
        candidate_path = root_path / candidate_path
    root_lexical = _absolute_lexical(root_path)
    candidate_lexical = _absolute_lexical(candidate_path)
    if not _is_within(root_lexical, candidate_lexical):
        raise PathSafetyError(f"candidate: path escapes root {root_lexical}")
    _reject_symlink_components(root_lexical, field="root")
    _reject_symlink_components(candidate_lexical, field="candidate")
    try:
        root_resolved = root_lexical.resolve(strict=False)
        candidate_resolved = candidate_lexical.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise PathSafetyError(f"candidate: cannot resolve path: {exc}") from exc
    if not _is_within(root_resolved, candidate_resolved):
        raise PathSafetyError(f"candidate: resolved path escapes root {root_resolved}")
    return str(candidate_resolved)


def safe_join(root: Pathish, *components: str) -> str:
    root_path = _coerce_path(root, field="root")
    if not root_path.is_absolute():
        raise PathSafetyError("root: must be absolute")
    validated = [
        validate_safe_component(component, field=f"components[{index}]")
        for index, component in enumerate(components)
    ]
    return assert_confined_path(root_path, root_path.joinpath(*validated))


def normalize_base_url(value: str, *, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise PathSafetyError(f"{field}: expected a nonempty URL without surrounding whitespace")
    if any(character.isspace() for character in value) or _CONTROL_RE.search(value):
        raise PathSafetyError(f"{field}: whitespace/control characters are forbidden")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise PathSafetyError(f"{field}: invalid URL: {exc}") from exc
    del port
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise PathSafetyError(f"{field}: must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise PathSafetyError(f"{field}: credentials are forbidden")
    if parsed.query or parsed.fragment:
        raise PathSafetyError(f"{field}: query strings and fragments are forbidden")
    return value.rstrip("/")


def _json_object_no_duplicates(text: str, *, context: str) -> dict[str, Any]:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key {key!r}")
            result[key] = value
        return result

    try:
        parsed = json.loads(text, object_pairs_hook=object_pairs)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{context}: invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{context}: JSON must be an object")
    return cast(dict[str, Any], parsed)


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _validate_profile_schema(profile: Mapping[str, Any]) -> None:  # noqa: C901
    errors: list[str] = []
    # JSON-convention annotation keys ($schema, $comment, $schema_note, ...) are
    # documentation, not contract values: ignored for validation and resolution.
    annotation_keys = {key for key in profile if key.startswith("$")}
    forbidden = sorted(set(profile) & _FORBIDDEN_PROFILE_FIELDS)
    errors.extend(f"{field}: forbidden per-work-item profile field" for field in forbidden)
    unknown = sorted(
        set(profile) - _PROFILE_ALLOWED_FIELDS - _FORBIDDEN_PROFILE_FIELDS - annotation_keys
    )
    errors.extend(f"{field}: unknown profile field" for field in unknown)
    for field, value in profile.items():
        if field in annotation_keys:
            continue
        if field in _PROFILE_LIST_PATH_FIELDS:
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                errors.append(f"{field}: expected an array of path strings")
        elif field in _PROFILE_SINGLE_PATH_FIELDS | {
            "superpose_url",
            "voice_studio_url",
            "voice_id",
            "theme",
            "workspace_dir",
            "output_dir",
        }:
            if not isinstance(value, str):
                errors.append(f"{field}: expected a string")
        elif field == "primitive_schema_source":
            if not isinstance(value, dict) or set(value) not in ({"url"}, {"path"}):
                errors.append(f"{field}: expected exactly one of url or path")
            elif not all(isinstance(item, str) for item in value.values()):
                errors.append(f"{field}: source value must be a string")
        elif field == "publish_target_conventions":
            if not isinstance(value, (str, dict)):
                errors.append(f"{field}: expected an object or path string")
        elif field == "character_usage_policy":
            if not isinstance(value, (str, dict)) or not _is_json_value(value):
                errors.append(f"{field}: expected a JSON string or object")
        elif field in {"max_scene_tail_seconds", "length_cap_seconds", "length_guide_seconds"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                errors.append(f"{field}: expected a number")
        elif field == "quality_tier":
            if not isinstance(value, str):
                errors.append(f"{field}: expected a string")
        elif field == "max_refine_iterations":
            if isinstance(value, bool) or not isinstance(value, int):
                errors.append(f"{field}: expected an integer")
        elif not _is_json_value(value):
            errors.append(f"{field}: value is not JSON-safe")
    if errors:
        raise ProfileResolutionError("; ".join(sorted(set(errors))))


def _resolve_profile_relative_path(profile_dir: Path, value: str, *, field: str) -> str:
    if not isinstance(value, str):
        raise ProfileResolutionError(f"{field}: expected a path string")
    candidate = Path(value)
    if candidate.is_absolute():
        return value
    if any(part in {".", ".."} for part in candidate.parts) or _CONTROL_RE.search(value):
        raise PathSafetyError(f"{field}: unsafe relative profile path")
    return assert_confined_path(profile_dir, profile_dir / candidate)


def _resolve_profile_owned_paths(profile: dict[str, Any], profile_dir: Path) -> dict[str, Any]:
    resolved = copy.deepcopy(profile)
    for field in _PROFILE_LIST_PATH_FIELDS:
        value = resolved.get(field)
        if isinstance(value, list):
            resolved[field] = [
                _resolve_profile_relative_path(profile_dir, item, field=f"{field}[{index}]")
                for index, item in enumerate(value)
            ]
    for field in _PROFILE_SINGLE_PATH_FIELDS:
        value = resolved.get(field)
        if isinstance(value, str):
            resolved[field] = _resolve_profile_relative_path(profile_dir, value, field=field)
    primitive = resolved.get("primitive_schema_source")
    if isinstance(primitive, dict) and isinstance(primitive.get("path"), str):
        primitive = copy.deepcopy(primitive)
        primitive["path"] = _resolve_profile_relative_path(
            profile_dir, primitive["path"], field="primitive_schema_source.path"
        )
        resolved["primitive_schema_source"] = primitive
    publish = resolved.get("publish_target_conventions")
    if isinstance(publish, str):
        resolved["publish_target_conventions"] = _resolve_profile_relative_path(
            profile_dir, publish, field="publish_target_conventions"
        )
    return resolved


def resolve_profile(  # noqa: C901
    constraints: Mapping[str, Any],
    *,
    environ: Mapping[str, str] | None = None,
) -> ProfileResolution:
    if not isinstance(constraints, Mapping):
        raise ProfileResolutionError("constraints: expected an object")
    if "app_profile" not in constraints:
        return ProfileResolution(
            merged_constraints=cast(dict[str, JSONValue], dict(constraints)),
            provenance={"mode": "direct"},
        )

    name_value = constraints.get("app_profile")
    if not isinstance(name_value, str):
        raise PathSafetyError("app_profile: expected a string")
    name = validate_safe_component(name_value, field="app_profile")
    explicit_root = constraints.get("profiles_dir")
    root_value: Any = None if explicit_root is None or explicit_root == "" else explicit_root
    if root_value is None:
        environment = os.environ if environ is None else environ
        env_root = environment.get("VIDEOGEN_PROFILES_DIR", "")
        root_value = env_root if env_root else None
    if root_value is None:
        raise ProfileResolutionError(
            "app_profile: set an absolute profiles_dir constraint or VIDEOGEN_PROFILES_DIR"
        )
    if not isinstance(root_value, (str, os.PathLike)):
        raise ProfileResolutionError("profiles_dir: expected a filesystem path")
    root = Path(validate_absolute_directory(root_value, field="profiles_dir"))
    profile_path = Path(safe_join(root, name, "profile.json"))
    try:
        raw = profile_path.read_bytes()
    except OSError as exc:
        raise ProfileResolutionError(
            f"app_profile: unreadable profile {profile_path}: {exc}"
        ) from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ProfileResolutionError(f"app_profile: profile is not UTF-8: {exc}") from exc
    try:
        profile = _json_object_no_duplicates(text, context="app_profile")
    except ValueError as exc:
        raise ProfileResolutionError(str(exc)) from exc
    _validate_profile_schema(profile)
    # Strip JSON-convention annotation keys before resolution/merge so they never
    # surface as contract constraints downstream.
    profile = {key: value for key, value in profile.items() if not key.startswith("$")}
    resolved_profile = _resolve_profile_owned_paths(profile, profile_path.parent)
    merged: dict[str, Any] = dict(resolved_profile)
    merged.update(dict(constraints))
    provenance: NamedProfileProvenance = {
        "mode": "profile",
        "name": name,
        "resolved_path": str(profile_path.resolve(strict=True)),
        "sha256": _sha256_bytes(raw),
    }
    return ProfileResolution(
        merged_constraints=cast(dict[str, JSONValue], merged), provenance=provenance
    )


def _validate_template(
    value: Any,
    *,
    field: str,
    allow_base_name: bool,
    destination: bool = False,
) -> str:
    if not isinstance(value, str) or not value or not value.strip():
        raise PublishConventionError(f"{field}: expected a nonempty template string")
    if value != value.strip() or _CONTROL_RE.search(value):
        raise PublishConventionError(f"{field}: whitespace/control characters are unsafe")
    allowed = (
        _ALLOWED_TEMPLATE_FIELDS if allow_base_name else _ALLOWED_TEMPLATE_FIELDS - {"base_name"}
    )
    try:
        parsed = list(string.Formatter().parse(value))
    except ValueError as exc:
        raise PublishConventionError(f"{field}: malformed template: {exc}") from exc
    for _, placeholder, format_spec, conversion in parsed:
        if placeholder is None:
            continue
        if placeholder not in allowed or "." in placeholder or "[" in placeholder:
            raise PublishConventionError(f"{field}: unknown or unsafe placeholder {placeholder!r}")
        if format_spec or conversion:
            raise PublishConventionError(f"{field}: format specs and conversions are forbidden")
    if destination:
        _validate_destination_text(value, field=field, template=True)
    return value


def _validate_destination_text(value: str, *, field: str, template: bool = False) -> str:
    del template
    if not value or value != value.strip() or _CONTROL_RE.search(value):
        raise PublishConventionError(f"{field}: destination must be nonempty and free of controls")
    if "\\" in value:
        raise PublishConventionError(f"{field}: backslash separators are forbidden")
    parsed = urlsplit(value)
    path = PurePosixPath(value)
    if parsed.scheme or parsed.netloc or path.is_absolute():
        raise PublishConventionError(f"{field}: destination must be a relative handoff path")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise PublishConventionError(f"{field}: destination contains an unsafe path component")
    return value


def _load_publish_source(value: Mapping[str, Any] | Pathish) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    try:
        path = Path(validate_absolute_file(value, field="publish_target_conventions"))
        raw = path.read_bytes()
        text = raw.decode("utf-8")
    except (PathSafetyError, OSError, UnicodeError) as exc:
        raise PublishConventionError(f"publish_target_conventions: {exc}") from exc
    if path.suffix.lower() == ".json":
        try:
            return _json_object_no_duplicates(text, context="publish_target_conventions")
        except ValueError as exc:
            raise PublishConventionError(str(exc)) from exc
    matches = _JSON_FENCE_RE.findall(text)
    if len(matches) != 1:
        raise PublishConventionError(
            "publish_target_conventions: Markdown must contain exactly one fenced json object"
        )
    try:
        return _json_object_no_duplicates(matches[0], context="publish_target_conventions")
    except ValueError as exc:
        raise PublishConventionError(str(exc)) from exc


def validate_publish_convention(
    value: Mapping[str, Any] | Pathish,
) -> NormalizedPublishConvention:
    source = _load_publish_source(value)
    keys = set(source)
    missing = sorted(_PUBLISH_REQUIRED_KEYS - keys)
    unknown = sorted(keys - _PUBLISH_REQUIRED_KEYS - _PUBLISH_OPTIONAL_KEYS)
    errors = [f"missing {field}" for field in missing] + [f"unknown {field}" for field in unknown]
    if errors:
        raise PublishConventionError("publish_target_conventions: " + "; ".join(errors))

    base_template = _validate_template(
        source.get("base_name_template"), field="base_name_template", allow_base_name=False
    )
    video_id_template = _validate_template(
        source.get("video_id_template"), field="video_id_template", allow_base_name=True
    )
    destinations = {
        "video": _validate_template(
            source.get("video_destination_template"),
            field="video_destination_template",
            allow_base_name=True,
            destination=True,
        ),
        "captions": _validate_template(
            source.get("captions_destination_template"),
            field="captions_destination_template",
            allow_base_name=True,
            destination=True,
        ),
        "poster": _validate_template(
            source.get("poster_destination_template"),
            field="poster_destination_template",
            allow_base_name=True,
            destination=True,
        ),
    }
    attach_behavior = source.get("attach_behavior")
    if not isinstance(attach_behavior, str) or not attach_behavior.strip():
        raise PublishConventionError("attach_behavior: expected a nonempty string")
    consumer_preference = source.get("consumer_preference")
    if consumer_preference is not None and (
        not isinstance(consumer_preference, str) or not consumer_preference.strip()
    ):
        raise PublishConventionError("consumer_preference: expected null or a nonempty string")
    required_sidecars = source.get("required_sidecars", ["vtt", "jpg"])
    if required_sidecars != ["vtt", "jpg"]:
        raise PublishConventionError('required_sidecars: v1 requires exactly ["vtt", "jpg"]')
    requires_word_timings = source.get("requires_word_timings", False)
    if not isinstance(requires_word_timings, bool):
        raise PublishConventionError("requires_word_timings: expected a boolean")
    instructions = source.get("instructions", [])
    if not isinstance(instructions, list) or not all(
        isinstance(item, str) for item in instructions
    ):
        raise PublishConventionError("instructions: expected an array of strings")
    metadata = source.get("metadata", {})
    if not isinstance(metadata, dict) or not _is_json_value(metadata):
        raise PublishConventionError("metadata: expected a JSON object")
    if source.get("handoff_only") is not True:
        raise PublishConventionError("handoff_only: must be boolean true")
    return {
        "video_id_template": video_id_template,
        "base_name_template": base_template,
        "destinations": destinations,
        "attach_behavior": attach_behavior,
        "consumer_preference": consumer_preference,
        "required_sidecars": ["vtt", "jpg"],
        "requires_word_timings": requires_word_timings,
        "instructions": list(instructions),
        "metadata": copy.deepcopy(cast(dict[str, JSONValue], metadata)),
        "handoff_only": True,
    }


def _expand_template(template: str, values: Mapping[str, str], *, field: str) -> str:
    chunks: list[str] = []
    try:
        for literal, placeholder, format_spec, conversion in string.Formatter().parse(template):
            chunks.append(literal)
            if placeholder is None:
                continue
            if placeholder not in values or format_spec or conversion:
                raise TemplateExpansionError(f"{field}: unsafe or unresolved placeholder")
            chunks.append(values[placeholder])
    except ValueError as exc:
        raise TemplateExpansionError(f"{field}: malformed template: {exc}") from exc
    result = "".join(chunks)
    if not result:
        raise TemplateExpansionError(f"{field}: expansion is empty")
    return result


def expand_publish_convention(
    convention: NormalizedPublishConvention,
    section_identity: Mapping[str, str],
) -> ExpandedPublishConvention:
    try:
        if set(section_identity) != _IDENTITY_KEYS:
            raise TemplateExpansionError("section_identity: exact identity keys are required")
        identity = {
            key: validate_safe_component(section_identity[key], field=f"section_identity.{key}")
            for key in sorted(_IDENTITY_KEYS)
        }
        base_name = _expand_template(
            convention["base_name_template"], identity, field="base_name_template"
        )
        validate_safe_component(base_name, field="base_name")
        values = {**identity, "base_name": base_name}
        video_id = _expand_template(
            convention["video_id_template"], values, field="video_id_template"
        )
        validate_safe_component(video_id, field="video_id")
        destinations: dict[str, str] = {}
        if set(convention["destinations"]) != {"video", "captions", "poster"}:
            raise TemplateExpansionError("destinations: exact video/captions/poster keys required")
        for key in ("video", "captions", "poster"):
            expanded = _expand_template(
                convention["destinations"][key], values, field=f"destinations.{key}"
            )
            try:
                destinations[key] = _validate_destination_text(
                    expanded, field=f"destinations.{key}"
                )
            except PublishConventionError as exc:
                raise TemplateExpansionError(str(exc)) from exc
    except TemplateExpansionError:
        raise
    except (KeyError, TypeError, PathSafetyError, PublishConventionError) as exc:
        raise TemplateExpansionError(f"publish convention expansion failed: {exc}") from exc
    return {
        "video_id": video_id,
        "base_name": base_name,
        "destinations": destinations,
        "attach_behavior": convention["attach_behavior"],
        "consumer_preference": convention["consumer_preference"],
        "required_sidecars": list(convention["required_sidecars"]),
        "requires_word_timings": convention["requires_word_timings"],
        "instructions": list(convention["instructions"]),
        "metadata": copy.deepcopy(convention["metadata"]),
        "handoff_only": True,
    }


def _read_locator(
    value: Any,
    *,
    field: str,
) -> tuple[bytes | None, Literal["inline", "file"] | None, str | None, list[str]]:
    errors: list[str] = []
    if not isinstance(value, Mapping):
        return None, None, None, [f"{field}: expected exactly one of text or path"]
    if set(value) not in ({"text"}, {"path"}):
        return None, None, None, [f"{field}: expected exactly one of text or path"]
    if "text" in value:
        text = value.get("text")
        if not isinstance(text, str) or not text.strip():
            return None, None, None, [f"{field}.text: must be a nonempty string"]
        try:
            return text.encode("utf-8"), "inline", None, errors
        except UnicodeEncodeError as exc:
            return None, None, None, [f"{field}.text: is not valid UTF-8: {exc}"]
    try:
        path = validate_absolute_file(cast(Pathish, value.get("path")), field=f"{field}.path")
        data = Path(path).read_bytes()
        data.decode("utf-8")
        if not data.decode("utf-8").strip():
            errors.append(f"{field}.path: file content is empty")
        return data, "file", path, errors
    except (PathSafetyError, OSError, UnicodeError) as exc:
        return None, None, None, [f"{field}.path: {exc}"]


def _explicit_non_markdown(section_bytes: bytes) -> str | None:
    try:
        text = section_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return "content is not UTF-8"
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    end = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), None)
    if end is None:
        return None
    for line in lines[1:end]:
        match = _MARKDOWN_FRONT_MATTER_TYPE_RE.match(line.strip())
        if match and match.group(1).lower() not in {"markdown", "md"}:
            return f"front matter declares non-markdown section type {match.group(1)!r}"
    return None


def _field_error(errors: list[str], field: str, exc: Exception) -> None:
    message = str(exc)
    prefix = f"{field}:"
    errors.append(message if message.startswith(prefix) else f"{field}: {message}")


def _validate_nonempty_string(value: Any, *, field: str, errors: list[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{field}: must be a nonempty string")
        return ""
    return value


def _validate_number(
    value: Any,
    *,
    field: str,
    default: float | None,
    minimum: float,
    strict: bool,
    errors: list[str],
) -> float | None:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        errors.append(f"{field}: must be a number")
        return default
    number = float(value)
    if not math.isfinite(number) or (number <= minimum if strict else number < minimum):
        relation = "greater than" if strict else "at least"
        errors.append(f"{field}: must be finite and {relation} {minimum}")
        return default
    return number


def validate_and_normalize_constraints(  # noqa: C901
    resolution: ProfileResolution,
) -> NormalizedIntake:
    if not isinstance(resolution, ProfileResolution):
        raise ConstraintValidationError(["constraints: expected a ProfileResolution"])
    constraints: Mapping[str, Any] = resolution.merged_constraints
    errors: list[str] = []
    for field in sorted(_REQUIRED_CONSTRAINTS - set(constraints)):
        errors.append(f"{field}: required constraint is missing")
    for field in sorted(set(constraints) - _ALLOWED_CONSTRAINTS):
        errors.append(f"{field}: unknown constraint")

    section_bytes, section_mode, section_path, locator_errors = _read_locator(
        constraints.get("section_content"), field="section_content"
    )
    errors.extend(locator_errors)
    if section_bytes is not None:
        declaration_error = _explicit_non_markdown(section_bytes)
        if declaration_error:
            errors.append(f"section_content: {declaration_error}")

    identity: dict[str, str] = {}
    identity_value = constraints.get("section_identity")
    if not isinstance(identity_value, Mapping):
        errors.append("section_identity: expected an object")
    else:
        if set(identity_value) != _IDENTITY_KEYS:
            missing = sorted(_IDENTITY_KEYS - set(identity_value))
            unknown = sorted(set(identity_value) - _IDENTITY_KEYS)
            if missing:
                errors.append(f"section_identity: missing keys {missing}")
            if unknown:
                errors.append(f"section_identity: unknown keys {unknown}")
        for key in sorted(_IDENTITY_KEYS):
            try:
                identity[key] = validate_safe_component(
                    cast(str, identity_value.get(key)), field=f"section_identity.{key}"
                )
            except PathSafetyError as exc:
                _field_error(errors, f"section_identity.{key}", exc)

    gate: dict[str, JSONValue] = {}
    gate_value = constraints.get("content_gate")
    if not isinstance(gate_value, Mapping):
        errors.append("content_gate: expected an object")
    else:
        if set(gate_value) != _CONTENT_GATE_KEYS:
            missing = sorted(_CONTENT_GATE_KEYS - set(gate_value))
            unknown = sorted(set(gate_value) - _CONTENT_GATE_KEYS)
            if missing:
                errors.append(f"content_gate: missing keys {missing}")
            if unknown:
                errors.append(f"content_gate: unknown keys {unknown}")
        if gate_value.get("finalized") is not True:
            errors.append("content_gate.finalized: must be boolean true")
        if gate_value.get("derivation_verdict") != "INDEPENDENT":
            errors.append("content_gate.derivation_verdict: must be INDEPENDENT")
        evidence_ref = gate_value.get("evidence_ref")
        if not isinstance(evidence_ref, str) or not evidence_ref.strip():
            errors.append("content_gate.evidence_ref: must be a nonempty reference")
        gate = {
            "finalized": True,
            "derivation_verdict": "INDEPENDENT",
            "evidence_ref": evidence_ref if isinstance(evidence_ref, str) else "",
            "verification_status": "caller_attested",
        }

    teaching_paths: list[str] = []
    teaching_value = constraints.get("teaching_canon_paths")
    if not isinstance(teaching_value, list) or not teaching_value:
        errors.append("teaching_canon_paths: must be a nonempty array of absolute files")
    else:
        for index, item in enumerate(teaching_value):
            try:
                teaching_paths.append(
                    validate_absolute_file(item, field=f"teaching_canon_paths[{index}]")
                )
            except PathSafetyError as exc:
                _field_error(errors, f"teaching_canon_paths[{index}]", exc)

    def file_field(field: str) -> str:
        try:
            return validate_absolute_file(cast(Pathish, constraints.get(field)), field=field)
        except PathSafetyError as exc:
            _field_error(errors, field, exc)
            return ""

    analogy_registry = file_field("analogy_registry")
    pronunciation_canon = file_field("pronunciation_canon")
    try:
        universe_canon_dir = validate_absolute_directory(
            cast(Pathish, constraints.get("universe_canon_dir")),
            field="universe_canon_dir",
        )
    except PathSafetyError as exc:
        _field_error(errors, "universe_canon_dir", exc)
        universe_canon_dir = ""

    try:
        superpose_url = normalize_base_url(
            cast(str, constraints.get("superpose_url")), field="superpose_url"
        )
    except PathSafetyError as exc:
        _field_error(errors, "superpose_url", exc)
        superpose_url = ""
    try:
        voice_studio_url = normalize_base_url(
            cast(str, constraints.get("voice_studio_url")), field="voice_studio_url"
        )
    except PathSafetyError as exc:
        _field_error(errors, "voice_studio_url", exc)
        voice_studio_url = ""
    voice_id = _validate_nonempty_string(
        constraints.get("voice_id"), field="voice_id", errors=errors
    )
    theme = _validate_nonempty_string(constraints.get("theme"), field="theme", errors=errors)

    primitive_source: dict[str, str] = {}
    primitive_value = constraints.get("primitive_schema_source")
    if not isinstance(primitive_value, Mapping) or set(primitive_value) not in ({"url"}, {"path"}):
        errors.append("primitive_schema_source: expected exactly one of url or path")
    elif "url" in primitive_value:
        try:
            primitive_source = {
                "url": normalize_base_url(
                    cast(str, primitive_value.get("url")),
                    field="primitive_schema_source.url",
                )
            }
        except PathSafetyError as exc:
            _field_error(errors, "primitive_schema_source.url", exc)
    else:
        try:
            primitive_source = {
                "path": validate_absolute_file(
                    cast(Pathish, primitive_value.get("path")),
                    field="primitive_schema_source.path",
                )
            }
        except PathSafetyError as exc:
            _field_error(errors, "primitive_schema_source.path", exc)

    try:
        workspace_dir = validate_write_root(
            cast(Pathish, constraints.get("workspace_dir")), field="workspace_dir"
        )
    except PathSafetyError as exc:
        _field_error(errors, "workspace_dir", exc)
        workspace_dir = ""
    try:
        output_dir = validate_write_root(
            cast(Pathish, constraints.get("output_dir")), field="output_dir"
        )
    except PathSafetyError as exc:
        _field_error(errors, "output_dir", exc)
        output_dir = ""

    publish: NormalizedPublishConvention | None = None
    publish_value = constraints.get("publish_target_conventions")
    try:
        if not isinstance(publish_value, (Mapping, str, os.PathLike)):
            raise PublishConventionError("expected an inline object or absolute contract path")
        publish = validate_publish_convention(publish_value)
        if publish["requires_word_timings"]:
            errors.append(
                "publish_target_conventions.requires_word_timings: unsupported in v1; no producer/schema is pinned"
            )
    except (PublishConventionError, TypeError) as exc:
        _field_error(errors, "publish_target_conventions", exc)

    policy_value = constraints.get("character_usage_policy")
    policy: str | dict[str, JSONValue] | None
    if policy_value is None:
        policy = None
    elif isinstance(policy_value, str) and policy_value.strip():
        policy = policy_value
    elif isinstance(policy_value, dict) and _is_json_value(policy_value):
        policy = copy.deepcopy(cast(dict[str, JSONValue], policy_value))
    else:
        errors.append("character_usage_policy: expected a nonempty string or JSON object")
        policy = None

    max_tail = _validate_number(
        constraints.get("max_scene_tail_seconds"),
        field="max_scene_tail_seconds",
        default=2.0,
        minimum=0.0,
        strict=False,
        errors=errors,
    )
    length_cap = _validate_number(
        constraints.get("length_cap_seconds"),
        field="length_cap_seconds",
        default=None,
        minimum=0.0,
        strict=True,
        errors=errors,
    )
    length_guide = _validate_number(
        constraints.get("length_guide_seconds"),
        field="length_guide_seconds",
        default=None,
        minimum=0.0,
        strict=True,
        errors=errors,
    )

    quality_value = constraints.get("quality_tier", "final")
    if quality_value not in {"final", "4k"}:
        errors.append("quality_tier: must be final or 4k")
        quality: Literal["final", "4k"] = "final"
    else:
        quality = cast(Literal["final", "4k"], quality_value)
    mode_value = constraints.get("mode", "create")
    if mode_value not in {"create", "refine_existing"}:
        errors.append("mode: must be create or refine_existing")
        mode: Literal["create", "refine_existing"] = "create"
    else:
        mode = cast(Literal["create", "refine_existing"], mode_value)

    existing: dict[str, JSONValue] | None = None
    existing_value = constraints.get("existing_video")
    if existing_value is not None:
        if not isinstance(existing_value, Mapping) or not _is_json_value(dict(existing_value)):
            errors.append("existing_video: expected a JSON object")
        else:
            missing_existing = {"video_path", "bundle_dir"} - set(existing_value)
            if missing_existing:
                errors.append(f"existing_video: missing keys {sorted(missing_existing)}")
            normalized_existing = copy.deepcopy(dict(existing_value))
            try:
                normalized_existing["video_path"] = validate_absolute_file(
                    cast(Pathish, existing_value.get("video_path")),
                    field="existing_video.video_path",
                )
            except PathSafetyError as exc:
                _field_error(errors, "existing_video.video_path", exc)
            try:
                normalized_existing["bundle_dir"] = validate_absolute_directory(
                    cast(Pathish, existing_value.get("bundle_dir")),
                    field="existing_video.bundle_dir",
                )
            except PathSafetyError as exc:
                _field_error(errors, "existing_video.bundle_dir", exc)
            existing = cast(dict[str, JSONValue], normalized_existing)

    feedback_bytes: bytes | None = None
    feedback_mode: Literal["inline", "file"] | None = None
    feedback_path: str | None = None
    feedback_value = constraints.get("feedback_text")
    if feedback_value is not None:
        feedback_bytes, feedback_mode, feedback_path, feedback_errors = _read_locator(
            feedback_value, field="feedback_text"
        )
        errors.extend(feedback_errors)

    if mode == "create":
        if existing_value is not None:
            errors.append("existing_video: forbidden in create mode")
        if feedback_value is not None:
            errors.append("feedback_text: forbidden in create mode")
    elif mode == "refine_existing":
        if existing_value is None:
            errors.append("existing_video: required in refine_existing mode")
        if feedback_value is None:
            errors.append("feedback_text: required in refine_existing mode")

    refine_value = constraints.get("max_refine_iterations", 3)
    if isinstance(refine_value, bool) or not isinstance(refine_value, int) or refine_value <= 0:
        errors.append("max_refine_iterations: must be a positive integer")
        max_refine_iterations = 3
    else:
        max_refine_iterations = refine_value

    provenance = resolution.provenance
    if provenance.get("mode") == "direct":
        if set(provenance) != {"mode"}:
            errors.append("profile_provenance: direct mode must contain exactly mode")
    elif provenance.get("mode") == "profile":
        if set(provenance) != {"mode", "name", "resolved_path", "sha256"}:
            errors.append("profile_provenance: profile mode has invalid keys")
        elif not _SHA256_RE.fullmatch(str(provenance.get("sha256", ""))):
            errors.append("profile_provenance.sha256: invalid SHA-256")
    else:
        errors.append("profile_provenance.mode: invalid mode")

    if errors:
        raise ConstraintValidationError(errors)
    assert section_bytes is not None and section_mode is not None and publish is not None
    assert max_tail is not None
    return NormalizedIntake(
        section_bytes=section_bytes,
        section_source_mode=section_mode,
        section_source_path=section_path,
        section_identity=identity,
        content_sha256=_sha256_bytes(section_bytes),
        content_gate=gate,
        teaching_canon_paths=tuple(teaching_paths),
        analogy_registry=analogy_registry,
        pronunciation_canon=pronunciation_canon,
        universe_canon_dir=universe_canon_dir,
        superpose_url=superpose_url,
        voice_studio_url=voice_studio_url,
        voice_id=voice_id,
        theme=theme,
        primitive_schema_source=primitive_source,
        workspace_dir=workspace_dir,
        output_dir=output_dir,
        publish_target_conventions=publish,
        profile_provenance=copy.deepcopy(provenance),
        character_usage_policy=policy,
        max_scene_tail_seconds=max_tail,
        length_cap_seconds=length_cap,
        length_guide_seconds=length_guide,
        quality_tier=quality,
        mode=mode,
        existing_video=existing,
        feedback_bytes=feedback_bytes,
        feedback_source_mode=feedback_mode,
        feedback_source_path=feedback_path,
        max_refine_iterations=max_refine_iterations,
    )
