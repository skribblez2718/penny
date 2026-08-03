from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any, Literal, TypeAlias, TypedDict, cast

from videogen_contracts import (
    JSONValue,
    PathSafetyError,
    assert_confined_path,
    safe_join,
    validate_safe_component,
    validate_write_root,
)

Pathish: TypeAlias = str | PathLike[str]

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
_RFC3339_Z_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
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
_INPUT_BINDING_KEYS = frozenset(
    {
        "section_snapshot",
        "teaching_canon_snapshots",
        "analogy_registry_snapshot",
        "pronunciation_canon_snapshot",
        "universe_canon_snapshot",
        "primitive_schema_snapshot",
        "publish_convention_snapshot",
    }
)
_RENDERER_BINDING_KEYS = frozenset(
    {
        "bundle_version",
        "primitive_library_version",
        "primitive_schema_sha256",
        "theme",
        "theme_sha256",
    }
)
_VOICE_BINDING_KEYS = frozenset({"voice_id", "voice_id_sha256"})
_REQUIRED_PROVENANCE_CHECKSUM_KEYS = frozenset(
    {
        "input/section",
        "input/teaching-canon/000",
        "input/analogy-registry",
        "input/pronunciation-canon",
        "input/universe-canon-ledger",
        "input/primitive-schema",
        "input/publish-convention",
    }
)
_APPROVAL_KEYS = frozenset(
    {
        "gate",
        "run_id",
        "iteration",
        "action",
        "draft_video_sha256",
        "content_sha256",
        "reviewed_at",
        "response",
    }
)
_HANDOFF_KEYS = frozenset(
    {
        "schema_version",
        "lifecycle_state",
        "run_id",
        "section_identity",
        "content_sha256",
        "profile_provenance",
        "approval_record",
        "checksums",
        "artifacts",
        "publish_destinations",
        "staleness",
        "no_target_side_effects",
        "met",
        "unresolved_issues",
    }
)
_HANDOFF_ARTIFACT_KEYS = frozenset(
    {
        "video",
        "captions",
        "poster",
        "bundle",
        "auto_qa_report",
        "approval_record",
        "publish_instructions",
    }
)
_STAGE_FILE_KEYS = frozenset(
    {
        "video",
        "captions",
        "poster",
        "bundle",
        "auto_qa_report",
        "approval_record",
        "publish_instructions",
    }
)
_HANDOFF_DESTINATION_KEYS = frozenset({"video", "captions", "poster"})
_STALENESS_KEYS = frozenset(
    {"content_status", "compatibility_status", "changed_bindings", "checked_at"}
)
_NO_TARGET_SIDE_EFFECT_KEYS = frozenset(
    {"wrote_target_app", "ran_target_build", "ran_target_import", "committed"}
)
_FILE_REF_KEYS = frozenset({"path", "sha256", "size_bytes"})
_DIRECTORY_REF_KEYS = frozenset({"path", "sha256", "file_count"})
_OMITTED = object()
_DIRECTORY_MODE = 0o755


class ArtifactRef(TypedDict):
    path: str
    sha256: str
    size_bytes: int


class DirectoryRef(TypedDict):
    path: str
    sha256: str
    file_count: int


class VideogenArtifactError(RuntimeError):
    """Base error for immutable videogen artifacts."""


class ArtifactPathError(VideogenArtifactError):
    """A requested artifact path is unsafe or outside its caller root."""


class AtomicWriteError(VideogenArtifactError):
    """An atomic file write could not be completed."""


class ImmutableSnapshotError(VideogenArtifactError):
    """An immutable snapshot destination already has different content."""


class ManifestValidationError(VideogenArtifactError):
    """A Superpose manifest violates the exact four-key contract."""


class ProvenanceValidationError(VideogenArtifactError):
    """Skill-owned provenance is malformed or internally inconsistent."""


class ChecksumMismatchError(VideogenArtifactError):
    """A checksum ledger or optimistic-concurrency digest is invalid."""


class BundleMaterializationError(VideogenArtifactError):
    """A complete render bundle transaction failed."""


class OutputStagingError(VideogenArtifactError):
    """A complete handoff staging transaction failed."""


@dataclass(frozen=True, slots=True)
class StalenessComparison:
    content_status: Literal["CURRENT", "STALE", "DIFFERENT_IDENTITY", "UNKNOWN"]
    compatibility_status: Literal["COMPATIBLE", "INCOMPATIBLE", "UNKNOWN"]
    changed_bindings: tuple[str, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class BundleMaterialization:
    bundle: DirectoryRef
    manifest: ArtifactRef
    provenance: ArtifactRef
    storyboard: ArtifactRef
    scene_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class StageResult:
    release_dir: DirectoryRef
    files: dict[str, ArtifactRef | DirectoryRef]


MANIFEST_KEYS: frozenset[str] = frozenset(
    {"bundle_version", "video_id", "primitive_library_version", "theme"}
)
VIDEOGEN_BUNDLE_VERSION: int = 1


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


def canonical_json_bytes(value: JSONValue) -> bytes:
    if not _is_json_value(value):
        raise VideogenArtifactError("canonical JSON value is not finite JSON-safe data")
    try:
        return (
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise VideogenArtifactError(f"canonical JSON encoding failed: {exc}") from exc


def sha256_bytes(data: bytes) -> str:
    if not isinstance(data, bytes):
        raise VideogenArtifactError("sha256_bytes requires bytes")
    return hashlib.sha256(data).hexdigest()


def _read_regular_file(path: Pathish, *, context: str) -> tuple[Path, bytes]:
    try:
        candidate = Path(os.fspath(path))
    except (TypeError, ValueError) as exc:
        raise VideogenArtifactError(f"{context}: expected a filesystem path") from exc
    try:
        resolved = candidate.resolve(strict=True)
        if not resolved.is_file():
            raise VideogenArtifactError(f"{context}: not a regular file: {candidate}")
        return resolved, resolved.read_bytes()
    except VideogenArtifactError:
        raise
    except (OSError, RuntimeError) as exc:
        raise VideogenArtifactError(f"{context}: unreadable file {candidate}: {exc}") from exc


def sha256_file(path: Pathish, *, chunk_size: int = 1024 * 1024) -> str:
    if isinstance(chunk_size, bool) or not isinstance(chunk_size, int) or chunk_size <= 0:
        raise VideogenArtifactError("chunk_size must be a positive integer")
    try:
        candidate = Path(os.fspath(path)).resolve(strict=True)
        if not candidate.is_file():
            raise VideogenArtifactError(f"sha256_file: not a regular file: {candidate}")
        digest = hashlib.sha256()
        with candidate.open("rb") as handle:
            while block := handle.read(chunk_size):
                digest.update(block)
        return digest.hexdigest()
    except VideogenArtifactError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise VideogenArtifactError(f"sha256_file: unreadable input: {exc}") from exc


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _validate_destination(path: Pathish, *, root: Pathish) -> tuple[Path, Path]:
    try:
        root_path = Path(validate_write_root(root, field="root"))
        destination = Path(assert_confined_path(root_path, path))
        if destination == root_path:
            raise ArtifactPathError("artifact destination cannot be the root directory")
        if destination.is_symlink():
            raise ArtifactPathError(f"symlink destination is forbidden: {destination}")
        if destination.exists() and destination.is_dir():
            raise ArtifactPathError(f"file destination is a directory: {destination}")
        return root_path, destination
    except ArtifactPathError:
        raise
    except PathSafetyError as exc:
        raise ArtifactPathError(str(exc)) from exc
    except OSError as exc:
        raise ArtifactPathError(f"cannot inspect artifact destination: {exc}") from exc


def atomic_write(  # noqa: C901
    path: Pathish,
    data: bytes | str,
    *,
    root: Pathish,
    mode: int = 0o644,
) -> ArtifactRef:
    root_path, destination = _validate_destination(path, root=root)
    if isinstance(data, str):
        try:
            payload = data.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise AtomicWriteError(f"cannot UTF-8 encode write data: {exc}") from exc
    elif isinstance(data, bytes):
        payload = data
    else:
        raise AtomicWriteError("atomic_write data must be bytes or str")
    if isinstance(mode, bool) or not isinstance(mode, int) or mode < 0 or mode > 0o777:
        raise AtomicWriteError("mode must be an integer permission mask between 0 and 0o777")

    temporary: Path | None = None
    try:
        root_path.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        _, checked_destination = _validate_destination(destination, root=root_path)
        destination = checked_destination
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.tmp-", dir=destination.parent
        )
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise
        if destination.is_symlink():
            raise ArtifactPathError(f"symlink destination is forbidden: {destination}")
        os.replace(temporary, destination)
        temporary = None
        _fsync_directory(destination.parent)
        return {
            "path": str(destination.resolve(strict=True)),
            "sha256": sha256_bytes(payload),
            "size_bytes": len(payload),
        }
    except ArtifactPathError:
        raise
    except (OSError, RuntimeError) as exc:
        raise AtomicWriteError(f"atomic write failed for {destination}: {exc}") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def atomic_write_json(
    path: Pathish,
    value: JSONValue,
    *,
    root: Pathish,
    mode: int = 0o644,
) -> ArtifactRef:
    return atomic_write(path, canonical_json_bytes(value), root=root, mode=mode)


def _artifact_ref(path: Path) -> ArtifactRef:
    try:
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise VideogenArtifactError(f"not a regular file: {path}")
        size = resolved.stat().st_size
    except (OSError, RuntimeError) as exc:
        raise VideogenArtifactError(f"cannot inspect artifact {path}: {exc}") from exc
    return {"path": str(resolved), "sha256": sha256_file(resolved), "size_bytes": size}


def snapshot_bytes(
    data: bytes,
    destination: Pathish,
    *,
    workspace_root: Pathish,
) -> ArtifactRef:
    if not isinstance(data, bytes):
        raise ImmutableSnapshotError("snapshot_bytes requires bytes")
    try:
        _, target = _validate_destination(destination, root=workspace_root)
        if target.exists():
            existing = target.read_bytes()
            if existing != data:
                raise ImmutableSnapshotError(
                    f"immutable snapshot already exists with different bytes: {target}"
                )
            return _artifact_ref(target)
        return atomic_write(target, data, root=workspace_root)
    except ImmutableSnapshotError:
        raise
    except (ArtifactPathError, AtomicWriteError, OSError, VideogenArtifactError) as exc:
        raise ImmutableSnapshotError(f"snapshot failed: {exc}") from exc


def snapshot_file(
    source: Pathish,
    destination: Pathish,
    *,
    workspace_root: Pathish,
) -> ArtifactRef:
    try:
        _, data = _read_regular_file(source, context="snapshot source")
        return snapshot_bytes(data, destination, workspace_root=workspace_root)
    except ImmutableSnapshotError:
        raise
    except VideogenArtifactError as exc:
        raise ImmutableSnapshotError(str(exc)) from exc


def _validate_logical_key(key: Any, *, context: str) -> str:
    if not isinstance(key, str) or not key or key != key.strip():
        raise ChecksumMismatchError(f"{context}: logical key must be a nonempty string")
    if "\\" in key or any(ord(character) < 32 or ord(character) == 127 for character in key):
        raise ChecksumMismatchError(f"{context}: logical key contains unsafe characters")
    path = PurePosixPath(key)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ChecksumMismatchError(f"{context}: logical key must be a safe relative path")
    return key


def _validate_digest(value: Any, *, context: str, error_type: type[Exception]) -> str:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise error_type(f"{context}: expected lowercase SHA-256")
    return value


def _iter_tree_files(  # noqa: C901
    root: Path, *, error_type: type[Exception]
) -> list[tuple[str, Path]]:
    try:
        if root.is_symlink() or not root.resolve(strict=True).is_dir():
            raise error_type(f"not a real directory: {root}")
        entries: list[tuple[str, Path]] = []
        for current, directory_names, file_names in os.walk(root, followlinks=False):
            current_path = Path(current)
            for directory_name in directory_names:
                directory = current_path / directory_name
                if directory.is_symlink():
                    raise error_type(f"symlink directory is forbidden: {directory}")
            for file_name in file_names:
                file_path = current_path / file_name
                if file_path.is_symlink():
                    raise error_type(f"symlink file is forbidden: {file_path}")
                file_stat = file_path.stat(follow_symlinks=False)
                if not stat.S_ISREG(file_stat.st_mode):
                    raise error_type(f"nonregular tree entry is forbidden: {file_path}")
                relative = file_path.relative_to(root).as_posix()
                _validate_logical_key(relative, context="tree path")
                entries.append((relative, file_path))
        return sorted(entries)
    except ChecksumMismatchError as exc:
        raise error_type(str(exc)) from exc
    except error_type:
        raise
    except (OSError, RuntimeError) as exc:
        raise error_type(f"cannot inspect tree {root}: {exc}") from exc


def build_checksum_ledger(files: Mapping[str, Pathish]) -> dict[str, str]:
    if not isinstance(files, Mapping):
        raise ChecksumMismatchError("files: expected a mapping")
    ledger: dict[str, str] = {}
    for key, path in files.items():
        logical_key = _validate_logical_key(key, context="files")
        try:
            ledger[logical_key] = sha256_file(path)
        except VideogenArtifactError as exc:
            raise ChecksumMismatchError(f"{logical_key}: {exc}") from exc
    return dict(sorted(ledger.items()))


def build_tree_ledger(root_dir: Pathish) -> dict[str, str]:
    try:
        candidate = Path(os.fspath(root_dir))
        if candidate.is_symlink():
            raise ChecksumMismatchError("tree root symlink is forbidden")
        root = candidate.resolve(strict=True)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise ChecksumMismatchError(f"tree root is unreadable: {exc}") from exc
    entries = _iter_tree_files(root, error_type=ChecksumMismatchError)
    return {relative: sha256_file(path) for relative, path in entries}


def ledger_sha256(ledger: Mapping[str, str]) -> str:
    validated = _validate_ledger(ledger, context="ledger")
    return sha256_bytes(canonical_json_bytes(cast(JSONValue, validated)))


def _validate_ledger(ledger: Mapping[str, str], *, context: str) -> dict[str, str]:
    if not isinstance(ledger, Mapping):
        raise ChecksumMismatchError(f"{context}: expected a mapping")
    validated: dict[str, str] = {}
    for key, digest in ledger.items():
        logical_key = _validate_logical_key(key, context=context)
        validated[logical_key] = _validate_digest(
            digest, context=f"{context}.{logical_key}", error_type=ChecksumMismatchError
        )
    return dict(sorted(validated.items()))


def verify_checksum_ledger(
    ledger: Mapping[str, str],
    files: Mapping[str, Pathish],
) -> list[str]:
    expected = _validate_ledger(ledger, context="ledger")
    if not isinstance(files, Mapping):
        raise ChecksumMismatchError("files: expected a mapping")
    normalized_files: dict[str, Pathish] = {}
    for key, path in files.items():
        normalized_files[_validate_logical_key(key, context="files")] = path
    mismatches: list[str] = []
    for key in sorted(set(expected) - set(normalized_files)):
        mismatches.append(f"{key}: missing file mapping")
    for key in sorted(set(normalized_files) - set(expected)):
        mismatches.append(f"{key}: unexpected file mapping")
    for key in sorted(set(expected) & set(normalized_files)):
        try:
            actual = sha256_file(normalized_files[key])
        except VideogenArtifactError as exc:
            mismatches.append(f"{key}: unreadable file: {exc}")
            continue
        if actual != expected[key]:
            mismatches.append(f"{key}: checksum mismatch expected {expected[key]} got {actual}")
    return sorted(mismatches)


def _directory_ref(path: Path) -> DirectoryRef:
    ledger = build_tree_ledger(path)
    return {
        "path": str(path.resolve(strict=True)),
        "sha256": ledger_sha256(ledger),
        "file_count": len(ledger),
    }


def _remove_owned_tree(path: Path, *, error_type: type[Exception]) -> None:
    if not path.exists():
        return
    if path.is_symlink() or not path.is_dir():
        raise error_type(f"transaction path is not a real directory: {path}")
    _iter_tree_files(path, error_type=error_type)
    try:
        shutil.rmtree(path)
    except OSError as exc:
        raise error_type(f"cannot remove transaction directory {path}: {exc}") from exc


def snapshot_tree(  # noqa: C901
    source_dir: Pathish,
    destination_dir: Pathish,
    *,
    workspace_root: Pathish,
) -> DirectoryRef:
    temporary: Path | None = None
    try:
        source_candidate = Path(os.fspath(source_dir))
        if source_candidate.is_symlink():
            raise ImmutableSnapshotError("tree snapshot source symlink is forbidden")
        source = source_candidate.resolve(strict=True)
        source_entries = _iter_tree_files(source, error_type=ImmutableSnapshotError)
        root = Path(validate_write_root(workspace_root, field="workspace_root"))
        destination = Path(assert_confined_path(root, destination_dir))
        if destination == root or destination.is_symlink():
            raise ImmutableSnapshotError("snapshot tree destination is unsafe")
        source_ledger = {relative: sha256_file(path) for relative, path in source_entries}
        if destination.exists():
            if not destination.is_dir():
                raise ImmutableSnapshotError("snapshot tree destination is not a directory")
            if build_tree_ledger(destination) != source_ledger:
                raise ImmutableSnapshotError(
                    f"immutable tree snapshot differs from existing destination: {destination}"
                )
            return _directory_ref(destination)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{destination.name}.tmp-", dir=destination.parent)
        )
        for relative, source_path in source_entries:
            target = temporary / PurePosixPath(relative)
            target.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
            data = source_path.read_bytes()
            with target.open("wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        if build_tree_ledger(temporary) != source_ledger:
            raise ImmutableSnapshotError("tree snapshot verification failed")
        os.replace(temporary, destination)
        temporary = None
        _fsync_directory(destination.parent)
        return _directory_ref(destination)
    except ImmutableSnapshotError:
        raise
    except (OSError, RuntimeError, PathSafetyError, VideogenArtifactError) as exc:
        raise ImmutableSnapshotError(f"tree snapshot failed: {exc}") from exc
    finally:
        if temporary is not None:
            try:
                _remove_owned_tree(temporary, error_type=ImmutableSnapshotError)
            except ImmutableSnapshotError:
                pass


def _read_json_object(
    path: Pathish, *, error_type: type[Exception], context: str
) -> dict[str, Any]:
    try:
        _, data = _read_regular_file(path, context=context)
        text = data.decode("utf-8")

        def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, item in pairs:
                if key in result:
                    raise ValueError(f"duplicate key {key!r}")
                result[key] = item
            return result

        value = json.loads(text, object_pairs_hook=reject_duplicates)
        if not isinstance(value, dict):
            raise error_type(f"{context}: JSON must be an object")
        return cast(dict[str, Any], value)
    except error_type:
        raise
    except (VideogenArtifactError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise error_type(f"{context}: invalid UTF-8 JSON: {exc}") from exc


def validate_manifest_exact_keys(
    manifest: Mapping[str, Any] | Pathish,
) -> dict[str, JSONValue]:
    if isinstance(manifest, Mapping):
        value = dict(manifest)
    else:
        value = _read_json_object(manifest, error_type=ManifestValidationError, context="manifest")
    if set(value) != MANIFEST_KEYS:
        raise ManifestValidationError(
            f"manifest keys must equal {sorted(MANIFEST_KEYS)}; got {sorted(value)}"
        )
    bundle_version = value.get("bundle_version")
    if (
        isinstance(bundle_version, bool)
        or not isinstance(bundle_version, int)
        or bundle_version <= 0
    ):
        raise ManifestValidationError("bundle_version must be a positive integer")
    try:
        video_id = validate_safe_component(cast(str, value.get("video_id")), field="video_id")
    except PathSafetyError as exc:
        raise ManifestValidationError(str(exc)) from exc
    library_version = value.get("primitive_library_version")
    if not isinstance(library_version, str) or not _SEMVER_RE.fullmatch(library_version):
        raise ManifestValidationError("primitive_library_version must be semantic version text")
    theme = value.get("theme")
    if not isinstance(theme, str) or not theme.strip():
        raise ManifestValidationError("theme must be a nonempty string")
    return {
        "bundle_version": bundle_version,
        "video_id": video_id,
        "primitive_library_version": library_version,
        "theme": theme,
    }


def _validate_profile_provenance(value: Any) -> dict[str, JSONValue]:
    if not isinstance(value, Mapping):
        raise ProvenanceValidationError("profile_provenance must be an object")
    if value.get("mode") == "direct":
        if set(value) != {"mode"}:
            raise ProvenanceValidationError("direct profile provenance must contain exactly mode")
        return {"mode": "direct"}
    if value.get("mode") != "profile" or set(value) != {
        "mode",
        "name",
        "resolved_path",
        "sha256",
    }:
        raise ProvenanceValidationError("named profile provenance has invalid keys or mode")
    try:
        name = validate_safe_component(
            cast(str, value.get("name")), field="profile_provenance.name"
        )
    except PathSafetyError as exc:
        raise ProvenanceValidationError(str(exc)) from exc
    resolved_path = value.get("resolved_path")
    if not isinstance(resolved_path, str) or not Path(resolved_path).is_absolute():
        raise ProvenanceValidationError("profile_provenance.resolved_path must be absolute")
    digest = _validate_digest(
        value.get("sha256"),
        context="profile_provenance.sha256",
        error_type=ProvenanceValidationError,
    )
    return {"mode": "profile", "name": name, "resolved_path": resolved_path, "sha256": digest}


def _validate_relative_binding(value: Any, *, field: str) -> str:
    try:
        return _validate_logical_key(value, context=field)
    except ChecksumMismatchError as exc:
        raise ProvenanceValidationError(str(exc)) from exc


def _validate_approval(value: Any, *, content_sha256: str) -> dict[str, JSONValue] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != _APPROVAL_KEYS:
        raise ProvenanceValidationError("approval_record has invalid keys")
    if value.get("gate") != "operator_review" or value.get("action") != "approve":
        raise ProvenanceValidationError("approval_record gate/action is invalid")
    run_id = value.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise ProvenanceValidationError("approval_record.run_id must be nonempty")
    iteration = value.get("iteration")
    if isinstance(iteration, bool) or not isinstance(iteration, int) or iteration < 0:
        raise ProvenanceValidationError("approval_record.iteration must be a nonnegative integer")
    draft_digest = _validate_digest(
        value.get("draft_video_sha256"),
        context="approval_record.draft_video_sha256",
        error_type=ProvenanceValidationError,
    )
    approval_content = _validate_digest(
        value.get("content_sha256"),
        context="approval_record.content_sha256",
        error_type=ProvenanceValidationError,
    )
    if approval_content != content_sha256:
        raise ProvenanceValidationError("approval_record content hash disagrees with provenance")
    reviewed_at = value.get("reviewed_at")
    if not isinstance(reviewed_at, str) or not _RFC3339_Z_RE.fullmatch(reviewed_at):
        raise ProvenanceValidationError("approval_record.reviewed_at must be UTC RFC3339 Z")
    response = value.get("response")
    if not isinstance(response, Mapping) or dict(response) != {"action": "approve"}:
        raise ProvenanceValidationError("approval_record.response must be exact approve response")
    return {
        "gate": "operator_review",
        "run_id": run_id,
        "iteration": iteration,
        "action": "approve",
        "draft_video_sha256": draft_digest,
        "content_sha256": approval_content,
        "reviewed_at": reviewed_at,
        "response": {"action": "approve"},
    }


def _validate_provenance(value: Mapping[str, Any]) -> dict[str, JSONValue]:  # noqa: C901
    if set(value) != _PROVENANCE_KEYS:
        raise ProvenanceValidationError(
            f"provenance keys must equal {sorted(_PROVENANCE_KEYS)}; got {sorted(value)}"
        )
    identity_value = value.get("section_identity")
    if not isinstance(identity_value, Mapping) or set(identity_value) != _IDENTITY_KEYS:
        raise ProvenanceValidationError("section_identity has invalid keys")
    identity: dict[str, str] = {}
    for key in sorted(_IDENTITY_KEYS):
        try:
            identity[key] = validate_safe_component(
                cast(str, identity_value.get(key)), field=f"section_identity.{key}"
            )
        except PathSafetyError as exc:
            raise ProvenanceValidationError(str(exc)) from exc
    content_digest = _validate_digest(
        value.get("content_sha256"),
        context="content_sha256",
        error_type=ProvenanceValidationError,
    )
    profile = _validate_profile_provenance(value.get("profile_provenance"))

    input_value = value.get("input_bindings")
    if not isinstance(input_value, Mapping) or set(input_value) != _INPUT_BINDING_KEYS:
        raise ProvenanceValidationError("input_bindings has invalid keys")
    teaching = input_value.get("teaching_canon_snapshots")
    if not isinstance(teaching, list) or not teaching:
        raise ProvenanceValidationError("teaching_canon_snapshots must be a nonempty list")
    input_bindings: dict[str, JSONValue] = {
        "section_snapshot": _validate_relative_binding(
            input_value.get("section_snapshot"), field="input_bindings.section_snapshot"
        ),
        "teaching_canon_snapshots": [
            _validate_relative_binding(
                item, field=f"input_bindings.teaching_canon_snapshots[{index}]"
            )
            for index, item in enumerate(teaching)
        ],
        "analogy_registry_snapshot": _validate_relative_binding(
            input_value.get("analogy_registry_snapshot"),
            field="input_bindings.analogy_registry_snapshot",
        ),
        "pronunciation_canon_snapshot": _validate_relative_binding(
            input_value.get("pronunciation_canon_snapshot"),
            field="input_bindings.pronunciation_canon_snapshot",
        ),
        "universe_canon_snapshot": _validate_relative_binding(
            input_value.get("universe_canon_snapshot"),
            field="input_bindings.universe_canon_snapshot",
        ),
        "primitive_schema_snapshot": _validate_relative_binding(
            input_value.get("primitive_schema_snapshot"),
            field="input_bindings.primitive_schema_snapshot",
        ),
        "publish_convention_snapshot": _validate_relative_binding(
            input_value.get("publish_convention_snapshot"),
            field="input_bindings.publish_convention_snapshot",
        ),
    }

    renderer_value = value.get("renderer_binding")
    if not isinstance(renderer_value, Mapping) or set(renderer_value) != _RENDERER_BINDING_KEYS:
        raise ProvenanceValidationError("renderer_binding has invalid keys")
    bundle_version = renderer_value.get("bundle_version")
    if (
        isinstance(bundle_version, bool)
        or not isinstance(bundle_version, int)
        or bundle_version <= 0
    ):
        raise ProvenanceValidationError("renderer_binding.bundle_version must be positive")
    library_version = renderer_value.get("primitive_library_version")
    if not isinstance(library_version, str) or not _SEMVER_RE.fullmatch(library_version):
        raise ProvenanceValidationError("renderer_binding.primitive_library_version is invalid")
    primitive_digest = _validate_digest(
        renderer_value.get("primitive_schema_sha256"),
        context="renderer_binding.primitive_schema_sha256",
        error_type=ProvenanceValidationError,
    )
    theme = renderer_value.get("theme")
    if not isinstance(theme, str) or not theme.strip():
        raise ProvenanceValidationError("renderer_binding.theme must be nonempty")
    theme_digest = _validate_digest(
        renderer_value.get("theme_sha256"),
        context="renderer_binding.theme_sha256",
        error_type=ProvenanceValidationError,
    )
    renderer_binding: dict[str, JSONValue] = {
        "bundle_version": bundle_version,
        "primitive_library_version": library_version,
        "primitive_schema_sha256": primitive_digest,
        "theme": theme,
        "theme_sha256": theme_digest,
    }

    voice_value = value.get("voice_binding")
    if not isinstance(voice_value, Mapping) or set(voice_value) != _VOICE_BINDING_KEYS:
        raise ProvenanceValidationError("voice_binding has invalid keys")
    voice_id = voice_value.get("voice_id")
    if not isinstance(voice_id, str) or not voice_id.strip():
        raise ProvenanceValidationError("voice_binding.voice_id must be nonempty")
    voice_digest = _validate_digest(
        voice_value.get("voice_id_sha256"),
        context="voice_binding.voice_id_sha256",
        error_type=ProvenanceValidationError,
    )
    try:
        expected_voice_digest = sha256_bytes(voice_id.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ProvenanceValidationError(f"voice_binding.voice_id is not UTF-8: {exc}") from exc
    if voice_digest != expected_voice_digest:
        raise ProvenanceValidationError(
            "voice_binding.voice_id_sha256 disagrees with voice_id bytes"
        )
    voice_binding: dict[str, JSONValue] = {
        "voice_id": voice_id,
        "voice_id_sha256": voice_digest,
    }

    approval = _validate_approval(value.get("approval_record"), content_sha256=content_digest)
    checksums_value = value.get("checksums")
    try:
        checksums = _validate_ledger(cast(Mapping[str, str], checksums_value), context="checksums")
    except (ChecksumMismatchError, TypeError) as exc:
        raise ProvenanceValidationError(str(exc)) from exc
    missing_checksums = _REQUIRED_PROVENANCE_CHECKSUM_KEYS - set(checksums)
    teaching_checksums = {f"input/teaching-canon/{index:03d}" for index in range(len(teaching))}
    missing_checksums |= teaching_checksums - set(checksums)
    if missing_checksums:
        raise ProvenanceValidationError(
            f"checksums missing required input bindings: {sorted(missing_checksums)}"
        )
    if checksums.get("input/section") != content_digest:
        raise ProvenanceValidationError("checksums.input/section must equal content_sha256")
    return cast(
        dict[str, JSONValue],
        {
            "section_identity": identity,
            "content_sha256": content_digest,
            "profile_provenance": profile,
            "input_bindings": input_bindings,
            "renderer_binding": renderer_binding,
            "voice_binding": voice_binding,
            "approval_record": approval,
            "checksums": checksums,
        },
    )


def read_provenance(path: Pathish) -> dict[str, JSONValue]:
    value = _read_json_object(path, error_type=ProvenanceValidationError, context="provenance")
    return _validate_provenance(value)


def update_provenance(  # noqa: C901
    path: Pathish,
    *,
    workspace_root: Pathish,
    expected_file_sha256: str,
    approval_record: Mapping[str, Any] | None | object = _OMITTED,
    checksum_updates: Mapping[str, str] | None = None,
) -> ArtifactRef:
    expected = _validate_digest(
        expected_file_sha256,
        context="expected_file_sha256",
        error_type=ChecksumMismatchError,
    )
    try:
        actual = sha256_file(path)
    except VideogenArtifactError as exc:
        raise ProvenanceValidationError(str(exc)) from exc
    if actual != expected:
        raise ChecksumMismatchError(
            f"provenance file changed: expected {expected_file_sha256}, got {actual}"
        )
    current = read_provenance(path)
    updated = copy.deepcopy(current)
    if approval_record is not _OMITTED:
        updated["approval_record"] = copy.deepcopy(cast(JSONValue, approval_record))
    if checksum_updates is not None:
        try:
            additions = _validate_ledger(checksum_updates, context="checksum_updates")
        except ChecksumMismatchError:
            raise
        current_checksums = cast(dict[str, str], current["checksums"])
        updated_checksums = cast(dict[str, str], updated["checksums"])
        for key, digest in additions.items():
            if (
                current["approval_record"] is not None
                and key in current_checksums
                and current_checksums[key] != digest
            ):
                raise ProvenanceValidationError(
                    f"checksums.{key}: approved checksum cannot be replaced until approval is reset"
                )
            updated_checksums[key] = digest
    validated = _validate_provenance(cast(Mapping[str, Any], updated))
    try:
        return atomic_write_json(path, validated, root=workspace_root)
    except (AtomicWriteError, ArtifactPathError) as exc:
        raise ProvenanceValidationError(f"provenance update failed: {exc}") from exc


def _storyboard_scene_ids(storyboard: Mapping[str, Any]) -> tuple[tuple[str, ...], frozenset[str]]:
    scenes = storyboard.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise BundleMaterializationError("storyboard.scenes must be a nonempty array")
    ordered: list[str] = []
    narration_ids: set[str] = set()
    for index, scene in enumerate(scenes):
        if not isinstance(scene, Mapping):
            raise BundleMaterializationError(f"storyboard.scenes[{index}] must be an object")
        try:
            scene_id = validate_safe_component(
                cast(str, scene.get("scene_id")),
                field=f"storyboard.scenes[{index}].scene_id",
            )
        except PathSafetyError as exc:
            raise BundleMaterializationError(str(exc)) from exc
        if scene_id in ordered:
            raise BundleMaterializationError(f"duplicate storyboard scene_id {scene_id}")
        ordered.append(scene_id)
        narration = scene.get("narration")
        if isinstance(narration, str) and narration.strip():
            narration_ids.add(scene_id)
    return tuple(ordered), frozenset(narration_ids)


def _normalize_scene_source_mapping(
    value: Mapping[str, Pathish], *, field: str
) -> dict[str, Pathish]:
    if not isinstance(value, Mapping):
        raise BundleMaterializationError(f"{field}: expected a mapping")
    result: dict[str, Pathish] = {}
    for key, path in value.items():
        try:
            scene_id = validate_safe_component(key, field=f"{field}.scene_id")
        except PathSafetyError as exc:
            raise BundleMaterializationError(str(exc)) from exc
        result[scene_id] = path
    return result


def _write_transaction_file(path: Path, data: bytes, *, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
    with path.open("xb") as handle:
        os.fchmod(handle.fileno(), mode)
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def _copy_transaction_file(source: Pathish, destination: Path, *, context: str) -> str:
    try:
        _, data = _read_regular_file(source, context=context)
        _write_transaction_file(destination, data)
        return sha256_bytes(data)
    except (VideogenArtifactError, OSError) as exc:
        raise BundleMaterializationError(f"{context}: {exc}") from exc


def _recover_directory_transaction(
    target: Path, backup: Path, *, error_type: type[Exception]
) -> None:
    if target.is_symlink() or backup.is_symlink():
        raise error_type("transaction target/backup symlink is forbidden")
    for stale_temporary in target.parent.glob(f".{target.name}.videogen-tmp-*"):
        _remove_owned_tree(stale_temporary, error_type=error_type)
    if backup.exists() and not target.exists():
        try:
            os.replace(backup, target)
            _fsync_directory(target.parent)
        except OSError as exc:
            raise error_type(f"could not restore transaction backup: {exc}") from exc
    elif backup.exists() and target.exists():
        _remove_owned_tree(backup, error_type=error_type)


def _swap_directory(  # noqa: C901
    temporary: Path,
    target: Path,
    backup: Path,
    *,
    error_type: type[Exception],
) -> None:
    moved_old = False
    try:
        if target.exists():
            if target.is_symlink() or not target.is_dir():
                raise error_type(f"transaction target is not a real directory: {target}")
            os.replace(target, backup)
            moved_old = True
        os.replace(temporary, target)
        _fsync_directory(target.parent)
        if moved_old:
            _remove_owned_tree(backup, error_type=error_type)
    except error_type:
        if moved_old and not target.exists() and backup.exists():
            os.replace(backup, target)
        raise
    except OSError as exc:
        if moved_old and not target.exists() and backup.exists():
            try:
                os.replace(backup, target)
            except OSError:
                pass
        raise error_type(f"directory swap failed: {exc}") from exc


def materialize_bundle(  # noqa: C901
    *,
    workspace_root: Pathish,
    bundle_dir: Pathish,
    manifest: Mapping[str, Any],
    provenance: Mapping[str, Any],
    storyboard: Mapping[str, Any],
    scene_files: Mapping[str, Pathish],
    audio_files: Mapping[str, Pathish],
    caption_files: Mapping[str, Pathish] | None = None,
) -> BundleMaterialization:
    temporary: Path | None = None
    try:
        root = Path(validate_write_root(workspace_root, field="workspace_root"))
        target = Path(assert_confined_path(root, bundle_dir))
        if target == root or target.is_symlink():
            raise BundleMaterializationError(
                "bundle_dir must be a nonsymlink child of workspace_root"
            )
        target.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        backup = target.parent / f".{target.name}.videogen-backup"
        _recover_directory_transaction(target, backup, error_type=BundleMaterializationError)

        valid_manifest = validate_manifest_exact_keys(manifest)
        if valid_manifest["bundle_version"] != VIDEOGEN_BUNDLE_VERSION:
            raise BundleMaterializationError(
                f"bundle_version must be {VIDEOGEN_BUNDLE_VERSION} for M1"
            )
        valid_provenance = _validate_provenance(provenance)
        renderer = cast(dict[str, JSONValue], valid_provenance["renderer_binding"])
        if (
            renderer["bundle_version"] != valid_manifest["bundle_version"]
            or renderer["primitive_library_version"] != valid_manifest["primitive_library_version"]
            or renderer["theme"] != valid_manifest["theme"]
        ):
            raise BundleMaterializationError("manifest and renderer provenance bindings disagree")
        if not isinstance(storyboard, Mapping) or not _is_json_value(dict(storyboard)):
            raise BundleMaterializationError("storyboard must be a JSON object")
        ordered_scene_ids, narration_ids = _storyboard_scene_ids(storyboard)
        normalized_scenes = _normalize_scene_source_mapping(scene_files, field="scene_files")
        normalized_audio = _normalize_scene_source_mapping(audio_files, field="audio_files")
        if set(normalized_scenes) != set(ordered_scene_ids):
            raise BundleMaterializationError(
                "scene_files IDs must equal storyboard scene IDs exactly"
            )
        if set(normalized_audio) != set(narration_ids):
            raise BundleMaterializationError(
                "audio_files IDs must equal narration-bearing storyboard scene IDs exactly"
            )
        normalized_captions: dict[str, Pathish] | None = None
        if caption_files is not None:
            normalized_captions = _normalize_scene_source_mapping(
                caption_files, field="caption_files"
            )
            if not set(normalized_captions).issubset(set(ordered_scene_ids)):
                raise BundleMaterializationError("caption_files contains an unknown scene ID")

        temporary = Path(
            tempfile.mkdtemp(prefix=f".{target.name}.videogen-tmp-", dir=target.parent)
        )
        manifest_bytes = canonical_json_bytes(cast(JSONValue, valid_manifest))
        storyboard_bytes = canonical_json_bytes(cast(JSONValue, dict(storyboard)))
        _write_transaction_file(temporary / "manifest.json", manifest_bytes)
        _write_transaction_file(temporary / "storyboard.json", storyboard_bytes)

        generated_checksums: dict[str, str] = {"design/storyboard": sha256_bytes(storyboard_bytes)}
        for scene_id in ordered_scene_ids:
            generated_checksums[f"bundle/scene/{scene_id}"] = _copy_transaction_file(
                normalized_scenes[scene_id],
                temporary / "scenes" / f"{scene_id}.py",
                context=f"scene_files.{scene_id}",
            )
        for scene_id in sorted(narration_ids):
            generated_checksums[f"bundle/audio/{scene_id}"] = _copy_transaction_file(
                normalized_audio[scene_id],
                temporary / "audio" / f"{scene_id}.wav",
                context=f"audio_files.{scene_id}",
            )
        if normalized_captions is not None:
            for scene_id in sorted(normalized_captions):
                generated_checksums[f"bundle/caption/{scene_id}"] = _copy_transaction_file(
                    normalized_captions[scene_id],
                    temporary / "captions" / f"{scene_id}.json",
                    context=f"caption_files.{scene_id}",
                )

        provenance_checksums = cast(dict[str, str], valid_provenance["checksums"])
        for key, digest in generated_checksums.items():
            prior = provenance_checksums.get(key)
            if prior is not None and prior != digest:
                raise BundleMaterializationError(
                    f"provenance checksum {key} disagrees with materialized bytes"
                )
            provenance_checksums[key] = digest
        valid_provenance = _validate_provenance(valid_provenance)
        provenance_bytes = canonical_json_bytes(cast(JSONValue, valid_provenance))
        _write_transaction_file(temporary / "provenance.json", provenance_bytes)

        expected_ledger = build_tree_ledger(temporary)
        if not expected_ledger:
            raise BundleMaterializationError("materialized bundle is empty")
        _swap_directory(
            temporary,
            target,
            backup,
            error_type=BundleMaterializationError,
        )
        temporary = None
        bundle_ref = _directory_ref(target)
        return BundleMaterialization(
            bundle=bundle_ref,
            manifest=_artifact_ref(target / "manifest.json"),
            provenance=_artifact_ref(target / "provenance.json"),
            storyboard=_artifact_ref(target / "storyboard.json"),
            scene_ids=ordered_scene_ids,
        )
    except BundleMaterializationError:
        raise
    except (
        ArtifactPathError,
        ManifestValidationError,
        ProvenanceValidationError,
        ChecksumMismatchError,
        VideogenArtifactError,
        PathSafetyError,
        OSError,
        RuntimeError,
    ) as exc:
        raise BundleMaterializationError(str(exc)) from exc
    finally:
        if temporary is not None:
            try:
                _remove_owned_tree(temporary, error_type=BundleMaterializationError)
            except BundleMaterializationError:
                pass


def compare_staleness(  # noqa: C901
    *,
    current_section_identity: Mapping[str, str],
    current_content_sha256: str,
    prior_provenance: Mapping[str, Any] | None,
    current_bindings: Mapping[str, str],
) -> StalenessComparison:
    if (
        not isinstance(current_section_identity, Mapping)
        or set(current_section_identity) != _IDENTITY_KEYS
    ):
        raise ProvenanceValidationError("current_section_identity has invalid keys")
    current_identity: dict[str, str] = {}
    for key in sorted(_IDENTITY_KEYS):
        try:
            current_identity[key] = validate_safe_component(
                cast(str, current_section_identity.get(key)),
                field=f"current_section_identity.{key}",
            )
        except PathSafetyError as exc:
            raise ProvenanceValidationError(str(exc)) from exc
    _validate_digest(
        current_content_sha256,
        context="current_content_sha256",
        error_type=ProvenanceValidationError,
    )
    try:
        bindings = _validate_ledger(current_bindings, context="current_bindings")
    except ChecksumMismatchError as exc:
        raise ProvenanceValidationError(str(exc)) from exc
    if not bindings:
        raise ProvenanceValidationError("current_bindings must be nonempty")

    reasons: list[str] = []
    content_status: Literal["CURRENT", "STALE", "DIFFERENT_IDENTITY", "UNKNOWN"]
    prior = prior_provenance if isinstance(prior_provenance, Mapping) else None
    prior_identity: Any = None if prior is None else prior.get("section_identity")
    prior_content: Any = None if prior is None else prior.get("content_sha256")
    identity_valid = (
        isinstance(prior_identity, Mapping)
        and set(prior_identity) == _IDENTITY_KEYS
        and all(isinstance(prior_identity.get(key), str) for key in _IDENTITY_KEYS)
    )
    if identity_valid:
        try:
            for key in _IDENTITY_KEYS:
                validate_safe_component(
                    cast(str, prior_identity.get(key)),
                    field=f"prior.section_identity.{key}",
                )
        except PathSafetyError:
            identity_valid = False
    content_valid = isinstance(prior_content, str) and bool(_SHA256_RE.fullmatch(prior_content))
    if not identity_valid or not content_valid:
        content_status = "UNKNOWN"
        reasons.append("prior identity or content hash is absent/malformed")
    elif dict(prior_identity) != current_identity:
        content_status = "DIFFERENT_IDENTITY"
        reasons.append("prior section identity differs")
    elif prior_content != current_content_sha256:
        content_status = "STALE"
        reasons.append("same section identity has different exact content bytes")
    else:
        content_status = "CURRENT"

    prior_checksums: Any = None if prior is None else prior.get("checksums")
    changed: list[str] = []
    missing: list[str] = []
    prior_bindings_valid = isinstance(prior_checksums, Mapping)
    if prior_bindings_valid:
        for key, digest in bindings.items():
            prior_digest = prior_checksums.get(key)
            if not isinstance(prior_digest, str) or not _SHA256_RE.fullmatch(prior_digest):
                missing.append(key)
            elif prior_digest != digest:
                changed.append(key)
    else:
        missing.extend(bindings)
    compatibility_status: Literal["COMPATIBLE", "INCOMPATIBLE", "UNKNOWN"]
    if changed:
        compatibility_status = "INCOMPATIBLE"
        reasons.append("one or more protected bindings changed")
    elif missing:
        compatibility_status = "UNKNOWN"
        reasons.append("one or more prior protected bindings are absent/malformed")
    else:
        compatibility_status = "COMPATIBLE"
    return StalenessComparison(
        content_status=content_status,
        compatibility_status=compatibility_status,
        changed_bindings=tuple(sorted(set(changed + missing))),
        reasons=tuple(sorted(set(reasons))),
    )


def _validate_file_ref(value: Any, *, field: str) -> dict[str, JSONValue]:
    if not isinstance(value, Mapping) or set(value) != _FILE_REF_KEYS:
        raise OutputStagingError(f"{field}: invalid artifact reference keys")
    path = value.get("path")
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise OutputStagingError(f"{field}.path must be absolute")
    digest = _validate_digest(
        value.get("sha256"), context=f"{field}.sha256", error_type=OutputStagingError
    )
    size = value.get("size_bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise OutputStagingError(f"{field}.size_bytes must be nonnegative")
    return {"path": path, "sha256": digest, "size_bytes": size}


def _validate_directory_ref(value: Any, *, field: str) -> dict[str, JSONValue]:
    if not isinstance(value, Mapping) or set(value) != _DIRECTORY_REF_KEYS:
        raise OutputStagingError(f"{field}: invalid directory reference keys")
    path = value.get("path")
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise OutputStagingError(f"{field}.path must be absolute")
    digest = _validate_digest(
        value.get("sha256"), context=f"{field}.sha256", error_type=OutputStagingError
    )
    count = value.get("file_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise OutputStagingError(f"{field}.file_count must be nonnegative")
    return {"path": path, "sha256": digest, "file_count": count}


def _validate_handoff_receipt(receipt: Mapping[str, Any]) -> dict[str, JSONValue]:  # noqa: C901
    if not isinstance(receipt, Mapping) or set(receipt) != _HANDOFF_KEYS:
        raise OutputStagingError("handoff receipt has invalid top-level keys")
    if receipt.get("schema_version") != 1 or receipt.get("lifecycle_state") != "HANDOFF_READY":
        raise OutputStagingError("handoff receipt schema/lifecycle is invalid")
    run_id = receipt.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise OutputStagingError("handoff receipt run_id must be nonempty")
    pseudo_provenance: dict[str, Any] = {
        "section_identity": receipt.get("section_identity"),
        "content_sha256": receipt.get("content_sha256"),
        "profile_provenance": receipt.get("profile_provenance"),
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
            "primitive_library_version": "0.0.0",
            "primitive_schema_sha256": "0" * 64,
            "theme": "receipt-validation",
            "theme_sha256": "0" * 64,
        },
        "voice_binding": {
            "voice_id": "receipt-validation",
            "voice_id_sha256": sha256_bytes(b"receipt-validation"),
        },
        "approval_record": receipt.get("approval_record"),
        "checksums": receipt.get("checksums"),
    }
    try:
        repeated = _validate_provenance(pseudo_provenance)
    except ProvenanceValidationError as exc:
        raise OutputStagingError(f"handoff repeated provenance is invalid: {exc}") from exc
    approval = repeated["approval_record"]
    if not isinstance(approval, dict) or approval.get("run_id") != run_id:
        raise OutputStagingError("handoff approval must be non-null and use the receipt run_id")

    artifacts_value = receipt.get("artifacts")
    if not isinstance(artifacts_value, Mapping) or set(artifacts_value) != _HANDOFF_ARTIFACT_KEYS:
        raise OutputStagingError("handoff artifacts has invalid keys")
    artifacts: dict[str, JSONValue] = {}
    for key in sorted(_HANDOFF_ARTIFACT_KEYS):
        artifacts[key] = (
            _validate_directory_ref(artifacts_value.get(key), field=f"artifacts.{key}")
            if key == "bundle"
            else _validate_file_ref(artifacts_value.get(key), field=f"artifacts.{key}")
        )

    destinations = receipt.get("publish_destinations")
    if not isinstance(destinations, Mapping) or set(destinations) != _HANDOFF_DESTINATION_KEYS:
        raise OutputStagingError("publish_destinations has invalid keys")
    if not all(
        isinstance(destinations.get(key), str) and destinations.get(key) for key in destinations
    ):
        raise OutputStagingError("publish_destinations values must be nonempty strings")

    staleness = receipt.get("staleness")
    if not isinstance(staleness, Mapping) or set(staleness) != _STALENESS_KEYS:
        raise OutputStagingError("staleness has invalid keys")
    if (
        staleness.get("content_status") != "CURRENT"
        or staleness.get("compatibility_status") != "COMPATIBLE"
    ):
        raise OutputStagingError("handoff requires CURRENT and COMPATIBLE staleness")
    if staleness.get("changed_bindings") != []:
        raise OutputStagingError("handoff staleness changed_bindings must be empty")
    checked_at = staleness.get("checked_at")
    if not isinstance(checked_at, str) or not _RFC3339_Z_RE.fullmatch(checked_at):
        raise OutputStagingError("staleness.checked_at must be UTC RFC3339 Z")

    side_effects = receipt.get("no_target_side_effects")
    if not isinstance(side_effects, Mapping) or set(side_effects) != _NO_TARGET_SIDE_EFFECT_KEYS:
        raise OutputStagingError("no_target_side_effects has invalid keys")
    if any(side_effects.get(key) is not False for key in _NO_TARGET_SIDE_EFFECT_KEYS):
        raise OutputStagingError("all no_target_side_effects values must be false")
    if receipt.get("met") is not True:
        raise OutputStagingError("handoff receipt met must be true")
    unresolved = receipt.get("unresolved_issues")
    if not isinstance(unresolved, list) or not _is_json_value(unresolved):
        raise OutputStagingError("unresolved_issues must be a JSON array")
    if unresolved:
        raise OutputStagingError("HANDOFF_READY requires no unresolved issues")

    checksums = cast(dict[str, str], repeated["checksums"])
    for logical_key, artifact_key in (
        ("final/video", "video"),
        ("final/captions", "captions"),
        ("final/poster", "poster"),
    ):
        artifact = cast(dict[str, JSONValue], artifacts[artifact_key])
        if checksums.get(logical_key) != artifact["sha256"]:
            raise OutputStagingError(
                f"checksums.{logical_key} must equal artifacts.{artifact_key}.sha256"
            )
    return cast(dict[str, JSONValue], copy.deepcopy(dict(receipt)))


def _stage_relative_destination(release: Path, expected_path: str, *, field: str) -> PurePosixPath:
    try:
        confined = Path(assert_confined_path(release, expected_path))
        relative = confined.relative_to(release).as_posix()
        logical = _validate_logical_key(relative, context=field)
    except (PathSafetyError, ValueError, ChecksumMismatchError) as exc:
        raise OutputStagingError(
            f"{field}: artifact path must be inside release_dir: {exc}"
        ) from exc
    return PurePosixPath(logical)


def _copy_tree_into(source: Pathish, destination: Path) -> DirectoryRef:
    try:
        source_candidate = Path(os.fspath(source))
        if source_candidate.is_symlink():
            raise OutputStagingError("bundle source symlink is forbidden")
        source_path = source_candidate.resolve(strict=True)
        entries = _iter_tree_files(source_path, error_type=OutputStagingError)
        destination.mkdir(parents=True, exist_ok=False, mode=_DIRECTORY_MODE)
        for relative, source_file in entries:
            target = destination / PurePosixPath(relative)
            target.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
            _write_transaction_file(target, source_file.read_bytes())
        return _directory_ref(destination)
    except OutputStagingError:
        raise
    except (OSError, RuntimeError, VideogenArtifactError) as exc:
        raise OutputStagingError(f"bundle copy failed: {exc}") from exc


def stage_outputs(  # noqa: C901
    *,
    output_root: Pathish,
    release_name: str,
    files: Mapping[str, Pathish],
    receipt: Mapping[str, Any],
) -> StageResult:
    temporary: Path | None = None
    try:
        if not isinstance(files, Mapping) or set(files) != _STAGE_FILE_KEYS:
            raise OutputStagingError(f"files keys must equal {sorted(_STAGE_FILE_KEYS)}")
        try:
            safe_release_name = validate_safe_component(release_name, field="release_name")
            root = Path(validate_write_root(output_root, field="output_root"))
            release = Path(safe_join(root, safe_release_name))
        except PathSafetyError as exc:
            raise OutputStagingError(str(exc)) from exc
        root.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        release.parent.mkdir(parents=True, exist_ok=True, mode=_DIRECTORY_MODE)
        backup = release.parent / f".{release.name}.videogen-backup"
        _recover_directory_transaction(release, backup, error_type=OutputStagingError)
        valid_receipt = _validate_handoff_receipt(receipt)
        artifact_specs = cast(dict[str, dict[str, JSONValue]], valid_receipt["artifacts"])

        temporary = Path(
            tempfile.mkdtemp(prefix=f".{release.name}.videogen-tmp-", dir=release.parent)
        )
        staged_refs: dict[str, ArtifactRef | DirectoryRef] = {}
        for key in sorted(_STAGE_FILE_KEYS):
            expected = artifact_specs[key]
            relative = _stage_relative_destination(
                release, cast(str, expected["path"]), field=f"artifacts.{key}.path"
            )
            temporary_destination = temporary / relative
            final_ref: ArtifactRef | DirectoryRef
            if key == "bundle":
                ref = _copy_tree_into(files[key], temporary_destination)
                final_ref = DirectoryRef(
                    path=str(release / relative),
                    sha256=ref["sha256"],
                    file_count=ref["file_count"],
                )
            else:
                _, data = _read_regular_file(files[key], context=f"files.{key}")
                _write_transaction_file(temporary_destination, data)
                final_ref = ArtifactRef(
                    path=str(release / relative),
                    sha256=sha256_bytes(data),
                    size_bytes=len(data),
                )
            if final_ref != expected:
                raise OutputStagingError(
                    f"artifacts.{key} reference disagrees with staged source bytes/tree"
                )
            staged_refs[key] = final_ref

        staged_bundle = cast(DirectoryRef, staged_refs["bundle"])
        bundle_relative = Path(staged_bundle["path"]).relative_to(release)
        temporary_bundle = temporary / bundle_relative
        bundle_provenance = read_provenance(temporary_bundle / "provenance.json")
        for key in (
            "section_identity",
            "content_sha256",
            "profile_provenance",
            "approval_record",
            "checksums",
        ):
            if valid_receipt[key] != bundle_provenance[key]:
                raise OutputStagingError(f"handoff receipt {key} disagrees with bundle provenance")

        approval_relative = Path(
            cast(ArtifactRef, staged_refs["approval_record"])["path"]
        ).relative_to(release)
        approval_value = _read_json_object(
            temporary / approval_relative,
            error_type=OutputStagingError,
            context="approval record artifact",
        )
        if approval_value != valid_receipt["approval_record"]:
            raise OutputStagingError(
                "approval record artifact disagrees with receipt/provenance approval"
            )
        _write_transaction_file(
            temporary / "handoff-receipt.json",
            canonical_json_bytes(cast(JSONValue, valid_receipt)),
        )
        _directory_ref(temporary)
        _swap_directory(temporary, release, backup, error_type=OutputStagingError)
        temporary = None
        return StageResult(release_dir=_directory_ref(release), files=staged_refs)
    except OutputStagingError:
        raise
    except (
        ProvenanceValidationError,
        VideogenArtifactError,
        ChecksumMismatchError,
        OSError,
        RuntimeError,
    ) as exc:
        raise OutputStagingError(str(exc)) from exc
    finally:
        if temporary is not None:
            try:
                _remove_owned_tree(temporary, error_type=OutputStagingError)
            except OutputStagingError:
                pass
