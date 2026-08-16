"""Manifest-bound mutation policy and dirty-worktree preservation artifacts."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

PRESERVATION_SCHEMA_VERSION = 1
SCOPE_MANIFEST_SCHEMA_VERSION = 1


class ScopeViolation(PermissionError):
    """A requested path or operation is outside the selected writable scope."""


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_scope_manifest(value: Any) -> list[str]:  # noqa: C901
    if not isinstance(value, dict):
        return ["scope/leak manifest must be an object"]
    required = {
        "schema_version",
        "manifest_id",
        "version",
        "in_scope_tracked_paths",
        "writable_paths",
        "leak_patterns",
        "leak_fixtures",
        "allowed_generic_cases",
        "ignored_runtime_outputs",
        "out_of_scope_reporting_boundary",
    }
    errors: list[str] = []
    if set(value) != required:
        errors.append(f"scope/leak manifest must contain exactly {sorted(required)}")
    if value.get("schema_version") != SCOPE_MANIFEST_SCHEMA_VERSION:
        errors.append("unsupported scope/leak manifest schema version")
    if type(value.get("version")) is not int or value.get("version", 0) < 1:
        errors.append("scope/leak manifest version must be a positive integer")
    if not isinstance(value.get("manifest_id"), str) or not value.get("manifest_id"):
        errors.append("scope/leak manifest id must be non-empty")
    for key in (
        "in_scope_tracked_paths",
        "writable_paths",
        "leak_patterns",
        "leak_fixtures",
        "allowed_generic_cases",
        "ignored_runtime_outputs",
    ):
        if not isinstance(value.get(key), list):
            errors.append(f"scope/leak manifest {key} must be a list")
    if not isinstance(value.get("out_of_scope_reporting_boundary"), str) or not value.get(
        "out_of_scope_reporting_boundary"
    ):
        errors.append("scope/leak manifest out-of-scope boundary must be non-empty")
    for key in ("in_scope_tracked_paths", "writable_paths", "ignored_runtime_outputs"):
        entries = value.get(key)
        if not isinstance(entries, list):
            continue
        if key != "ignored_runtime_outputs" and not entries:
            errors.append(f"scope/leak manifest {key} must not be empty")
        if len(entries) != len(set(entries)):
            errors.append(f"scope/leak manifest {key} has duplicate entries")
        for entry in entries:
            if (
                not isinstance(entry, str)
                or not entry
                or "\x00" in entry
                or "\\" in entry
                or Path(entry).is_absolute()
                or ".." in Path(entry).parts
            ):
                errors.append(f"scope/leak manifest {key} has an unsafe path pattern")
    in_scope_entries = value.get("in_scope_tracked_paths", [])
    writable_entries = value.get("writable_paths", [])
    if isinstance(in_scope_entries, list) and isinstance(writable_entries, list):
        for writable in writable_entries:
            if isinstance(writable, str) and writable not in in_scope_entries:
                errors.append(f"writable path {writable!r} is not an exact in-scope entry")
    pattern_ids: list[str] = []
    for index, pattern in enumerate(value.get("leak_patterns", [])):
        if not isinstance(pattern, dict) or set(pattern) != {"id", "pattern_parts", "reason"}:
            errors.append(f"leak pattern {index} must contain id, pattern_parts, and reason")
            continue
        pattern_id = pattern.get("id")
        parts = pattern.get("pattern_parts")
        if not isinstance(pattern_id, str) or not pattern_id:
            errors.append(f"leak pattern {index} has no stable id")
        else:
            pattern_ids.append(pattern_id)
        if (
            not isinstance(parts, list)
            or not parts
            or any(not isinstance(part, str) or not part for part in parts)
        ):
            errors.append(f"leak pattern {index} has invalid pattern parts")
        if not isinstance(pattern.get("reason"), str) or not pattern["reason"]:
            errors.append(f"leak pattern {index} has no reason")
    if len(pattern_ids) != len(set(pattern_ids)):
        errors.append("scope/leak manifest has duplicate pattern IDs")
    for index, fixture in enumerate(value.get("leak_fixtures", [])):
        if not isinstance(fixture, dict) or not isinstance(fixture.get("id"), str):
            errors.append(f"leak fixture {index} has no stable id")
            continue
        if not set(fixture).issubset({"id", "expected", "pattern_id", "text", "text_parts"}):
            errors.append(f"leak fixture {index} has unknown fields")
        expected = fixture.get("expected")
        if expected not in {"allowed-generic", "unresolved-unless-authorized"}:
            errors.append(f"leak fixture {index} has an unknown expected outcome")
        if "pattern_id" in fixture and fixture.get("pattern_id") not in pattern_ids:
            errors.append(f"leak fixture {index} references an unknown pattern")
        text_parts = fixture.get("text_parts")
        if text_parts is not None and (
            not isinstance(text_parts, list)
            or not text_parts
            or any(not isinstance(part, str) or not part for part in text_parts)
        ):
            errors.append(f"leak fixture {index} has invalid text parts")
        if "text" not in fixture and "text_parts" not in fixture and "pattern_id" not in fixture:
            errors.append(f"leak fixture {index} has no text or pattern reference")
    for index, allowed in enumerate(value.get("allowed_generic_cases", [])):
        if not isinstance(allowed, dict) or set(allowed) != {
            "path",
            "pattern_id",
            "source_evidence",
        }:
            errors.append(
                f"allowed generic case {index} must record path, pattern_id, and source_evidence"
            )
        elif (
            allowed.get("pattern_id") not in {"*", *pattern_ids}
            or not isinstance(allowed.get("path"), str)
            or not allowed["path"]
            or not isinstance(allowed.get("source_evidence"), str)
            or not allowed["source_evidence"].strip()
        ):
            errors.append(f"allowed generic case {index} is not evidence-authorized")
    return errors


@dataclass(frozen=True)
class ScopePolicy:
    """Canonical path policy used before any product-managed write."""

    project_root: Path
    writable_patterns: tuple[str, ...]
    runtime_patterns: tuple[str, ...] = ()

    @classmethod
    def from_manifest(cls, project_root: str | Path, manifest: Mapping[str, Any]) -> "ScopePolicy":
        errors = validate_scope_manifest(manifest)
        if errors:
            raise ScopeViolation("; ".join(errors))
        return cls(
            project_root=Path(project_root).resolve(),
            writable_patterns=tuple(str(item) for item in manifest["writable_paths"]),
            runtime_patterns=tuple(str(item) for item in manifest["ignored_runtime_outputs"]),
        )

    def authorize(self, candidate: str | Path) -> Path:
        raw = Path(candidate)
        absolute = raw if raw.is_absolute() else self.project_root / raw
        resolved = absolute.resolve(strict=False)
        try:
            relative = resolved.relative_to(self.project_root).as_posix()
        except ValueError as exc:
            raise ScopeViolation(f"path escapes selected project root: {candidate}") from exc
        if not any(
            fnmatch(relative, pattern) or fnmatch(relative + "/", pattern)
            for pattern in self.writable_patterns + self.runtime_patterns
        ):
            raise ScopeViolation(f"path is outside selected writable scope: {relative}")
        # Existing symlinks are resolved above. For a not-yet-existing child, reject
        # if any existing parent resolves outside the project.
        parent = absolute.parent
        while parent != self.project_root and not parent.exists():
            parent = parent.parent
        if parent.exists():
            try:
                parent.resolve().relative_to(self.project_root)
            except ValueError as exc:
                raise ScopeViolation(f"path parent escapes through a symlink: {candidate}") from exc
        return resolved

    @staticmethod
    def authorize_argv(argv: Sequence[str]) -> None:
        """Reject destructive VCS/filesystem commands at the managed execution seam."""
        normalized = tuple(str(item).strip().lower() for item in argv)
        destructive = {
            ("git", "reset"),
            ("git", "checkout"),
            ("git", "clean"),
            ("git", "restore"),
            ("git", "add"),
            ("git", "commit"),
            ("rm", "-rf"),
        }
        if any(normalized[: len(prefix)] == prefix for prefix in destructive):
            raise ScopeViolation(
                f"destructive command is outside the authorized mutation scope: {argv}"
            )


def _git(
    root: Path, argv: Sequence[str], *, check: bool = True
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *argv], cwd=root, check=check, capture_output=True, shell=False)


def dirty_paths(root: str | Path) -> list[tuple[str, str]]:
    """Return every dirty path and exact two-column index/worktree status."""
    project = Path(root).resolve()
    raw = _git(
        project,
        ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
    ).stdout
    paths: list[tuple[str, str]] = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        paths.append(
            (
                item[3:].decode("utf-8", "surrogateescape"),
                item[:2].decode("ascii"),
            )
        )
    return sorted(paths)


def out_of_scope_dirty_paths(root: str | Path, manifest: Mapping[str, Any]) -> list[str]:
    """Return every pre-existing dirty path outside the selected tracked corpus."""
    errors = validate_scope_manifest(manifest)
    if errors:
        raise ScopeViolation("; ".join(errors))
    patterns = tuple(str(item) for item in manifest["in_scope_tracked_paths"])
    runtime_patterns = tuple(str(item) for item in manifest["ignored_runtime_outputs"])
    return [
        relative
        for relative, _status in dirty_paths(root)
        if not any(fnmatch(relative, pattern) for pattern in patterns)
        and not any(fnmatch(relative, pattern) for pattern in runtime_patterns)
    ]


def _path_record(root: Path, relative: str, status: str, snapshot_root: Path) -> dict[str, Any]:
    path = root / relative
    tracked = (
        _git(root, ["ls-files", "--error-unmatch", "--", relative], check=False).returncode == 0
    )
    exists = path.exists() or path.is_symlink()
    record: dict[str, Any] = {
        "path": relative,
        "tracked": tracked,
        "state": "deleted" if not exists else ("tracked" if tracked else "untracked"),
        "index_status": status[0],
        "worktree_status": status[1],
        "exists": exists,
        "mode": None,
        "sha256": None,
        "snapshot": None,
        "index_blob": None,
    }
    if tracked:
        index = _git(root, ["rev-parse", f":{relative}"], check=False)
        record["index_blob"] = index.stdout.decode().strip() if index.returncode == 0 else None
    if not exists:
        return record
    file_stat = path.lstat()
    record["mode"] = format(stat.S_IMODE(file_stat.st_mode), "04o")
    destination = snapshot_root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if stat.S_ISREG(file_stat.st_mode):
        record["sha256"] = _sha256_file(path)
        shutil.copy2(path, destination, follow_symlinks=False)
        record["snapshot"] = relative
    elif stat.S_ISLNK(file_stat.st_mode):
        target = os.readlink(path)
        record["sha256"] = hashlib.sha256(os.fsencode(target)).hexdigest()
        destination.symlink_to(target)
        record["snapshot"] = relative
        record["symlink_target"] = target
    else:
        record["special_file"] = True
    return record


def capture_preservation_artifact(
    project_root: str | Path,
    output_directory: str | Path,
    *,
    include_paths: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Atomically capture path/Git/mode/bytes for dirty paths into an artifact dir."""
    root = Path(project_root).resolve()
    destination = Path(output_directory).resolve()
    if destination == root or root in destination.parents:
        raise ScopeViolation("preservation artifacts must be written outside the project tree")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent))
    selected = set(include_paths) if include_paths is not None else None
    try:
        records = [
            _path_record(root, path, status, temporary / "content")
            for path, status in dirty_paths(root)
            if selected is None or path in selected
        ]
        payload: dict[str, Any] = {
            "schema_version": PRESERVATION_SCHEMA_VERSION,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "project_root": str(root),
            "head": _git(root, ["rev-parse", "HEAD"]).stdout.decode().strip(),
            "paths": records,
        }
        identity = {key: value for key, value in payload.items() if key != "captured_at"}
        payload["digest"] = hashlib.sha256(_canonical_json(identity)).hexdigest()
        (temporary / "artifact.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        if destination.exists():
            raise FileExistsError(f"preservation artifact already exists: {destination}")
        temporary.replace(destination)
        return payload
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def compare_preservation_artifact(  # noqa: C901 - direct Git/byte comparison
    project_root: str | Path, artifact_directory: str | Path
) -> list[str]:
    """Directly compare every snapshotted path plus Git state, mode, and digest."""
    root = Path(project_root).resolve()
    artifact_root = Path(artifact_directory).resolve()
    artifact = json.loads((artifact_root / "artifact.json").read_text(encoding="utf-8"))
    errors: list[str] = []
    if artifact.get("schema_version") != PRESERVATION_SCHEMA_VERSION:
        errors.append("preservation artifact schema version is unsupported")
    if artifact.get("project_root") != str(root):
        errors.append("preservation artifact is bound to a different project root")
    if artifact.get("head") != _git(root, ["rev-parse", "HEAD"]).stdout.decode().strip():
        errors.append("preservation artifact revision changed")
    unsigned = {
        key: value for key, value in artifact.items() if key not in {"captured_at", "digest"}
    }
    if artifact.get("digest") != hashlib.sha256(_canonical_json(unsigned)).hexdigest():
        errors.append("preservation artifact digest is invalid or tampered")
    current_status = dict(dirty_paths(root))
    for record in artifact.get("paths", []):
        relative = record["path"]
        path = root / relative
        current = current_status.get(relative, "  ")
        if current[0] != record["index_status"] or current[1] != record["worktree_status"]:
            errors.append(f"{relative}: index/worktree status changed")
        tracked = (
            _git(root, ["ls-files", "--error-unmatch", "--", relative], check=False).returncode == 0
        )
        if tracked != record["tracked"]:
            errors.append(f"{relative}: tracked/untracked state changed")
        exists = path.exists() or path.is_symlink()
        if exists != record["exists"]:
            errors.append(f"{relative}: deleted/content state changed")
            continue
        if not exists:
            continue
        mode = format(stat.S_IMODE(path.lstat().st_mode), "04o")
        if mode != record["mode"]:
            errors.append(f"{relative}: file mode changed")
        snapshot_name = record.get("snapshot")
        if snapshot_name:
            snapshot = artifact_root / "content" / snapshot_name
            if path.is_symlink() or snapshot.is_symlink():
                if not (
                    path.is_symlink()
                    and snapshot.is_symlink()
                    and os.readlink(path) == os.readlink(snapshot)
                ):
                    errors.append(f"{relative}: symlink bytes/target changed")
            else:
                # Direct byte comparison is the primary oracle; digest is an
                # independent integrity/corruption check and reporting aid.
                if path.read_bytes() != snapshot.read_bytes():
                    errors.append(f"{relative}: direct byte comparison failed")
                if _sha256_file(path) != record["sha256"]:
                    errors.append(f"{relative}: SHA-256 changed")
    return errors
