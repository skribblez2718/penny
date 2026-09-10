"""Descriptor-bound filesystem safety for copied-palace recovery.

A recovery source is opened component-by-component with ``openat`` and
``O_NOFOLLOW`` before the existing receipt gate runs.  The resulting source,
parent, and receipt descriptors are then identity-checked against the gate and
retained for the complete operation.  All later source reads, staging writes,
events, and renames are relative to those held descriptors.

Recovery attempts are private unique sibling directories.  This module never
removes an attempt: staged data, parked originals, failed swaps, and event
records remain until a separate operator-authorized cleanup.  Returned paths
are advisory only; actionable backup evidence includes the exact parked object
and its held-parent identity so a later operator can reacquire it fail-closed.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import secrets
import stat
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from scripts.system.memory.common import ValidationError, canonical_json_bytes
from scripts.system.memory.offline_access import (
    OfflineAuthorization,
    PathIdentity,
    authorize_offline_target,
)

_HASH_CHUNK_BYTES = 1024 * 1024
_COPY_CHUNK_BYTES = 1024 * 1024
_RENAME_NOREPLACE = 1
_MAX_UNIQUE_NAME_ATTEMPTS = 128


class RecoveryRefusalCode(str, Enum):
    """Stable reason codes for bounded recovery refusal."""

    INPUT_BYTES = "recovery-input-bytes-limit"
    STAGING_BYTES = "recovery-staging-bytes-limit"
    FILE_COUNT = "recovery-file-count-limit"
    DEPTH = "recovery-depth-limit"
    DEADLINE = "recovery-deadline-exceeded"
    CANCELLED = "recovery-cancelled"


class RecoveryRefusal(ValidationError):
    """A typed, fail-closed resource or cancellation refusal."""

    def __init__(self, code: RecoveryRefusalCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class RecoveryLimits:
    """Finite limits for one complete authorization-to-swap operation."""

    max_input_bytes: int = 16 * 1024 * 1024 * 1024
    max_staging_bytes: int = 32 * 1024 * 1024 * 1024
    max_files: int = 200_000
    max_depth: int = 64
    deadline_seconds: float = 60 * 60

    def __post_init__(self) -> None:
        values = (
            self.max_input_bytes,
            self.max_staging_bytes,
            self.max_files,
            self.max_depth,
        )
        if any(value <= 0 for value in values) or self.deadline_seconds <= 0:
            raise ValueError("recovery limits must all be positive")


@dataclass
class RecoveryBudget:
    """Monotonic total-operation budget shared by every recovery phase."""

    limits: RecoveryLimits = field(default_factory=RecoveryLimits)
    cancelled: Callable[[], bool] | None = None
    clock: Callable[[], float] = time.monotonic
    _started: float = field(init=False)
    _input_members: dict[str, int] = field(default_factory=dict, init=False)
    _staging_members: dict[str, int] = field(default_factory=dict, init=False)
    _input_bytes: int = field(default=0, init=False)
    _staging_bytes: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self._started = self.clock()

    @property
    def remaining_seconds(self) -> float:
        """Return positive wall time remaining, or raise a typed refusal."""

        self.checkpoint()
        return max(0.001, self.limits.deadline_seconds - (self.clock() - self._started))

    def checkpoint(self, *, depth: int | None = None) -> None:
        """Fail before more work when cancelled, expired, or too deeply nested."""

        if self.cancelled is not None and self.cancelled():
            raise RecoveryRefusal(RecoveryRefusalCode.CANCELLED, "operation was cancelled")
        if self.clock() - self._started >= self.limits.deadline_seconds:
            raise RecoveryRefusal(RecoveryRefusalCode.DEADLINE, "total operation deadline elapsed")
        if depth is not None and depth > self.limits.max_depth:
            raise RecoveryRefusal(
                RecoveryRefusalCode.DEPTH,
                f"tree depth {depth} exceeds {self.limits.max_depth}",
            )

    def account_input_member(self, key: str, size: int, *, depth: int) -> None:
        """Account one logical source-tree member exactly once."""

        self.checkpoint(depth=depth)
        previous = self._input_members.get(key)
        if previous is None:
            self._require_file_capacity()
            self._input_members[key] = size
            self._input_bytes += size
        elif size > previous:
            self._input_members[key] = size
            self._input_bytes += size - previous
        if self._input_bytes > self.limits.max_input_bytes:
            raise RecoveryRefusal(
                RecoveryRefusalCode.INPUT_BYTES,
                f"input bytes exceed {self.limits.max_input_bytes}",
            )

    def account_staging_member(self, key: str, size: int, *, depth: int) -> None:
        """Account a created/output member and its greatest observed size."""

        self.checkpoint(depth=depth)
        previous = self._staging_members.get(key)
        if previous is None:
            self._require_file_capacity()
            self._staging_members[key] = size
            self._staging_bytes += size
        elif size > previous:
            self._staging_members[key] = size
            self._staging_bytes += size - previous
        if self._staging_bytes > self.limits.max_staging_bytes:
            raise RecoveryRefusal(
                RecoveryRefusalCode.STAGING_BYTES,
                f"staging bytes exceed {self.limits.max_staging_bytes}",
            )

    @property
    def staging_write_capacity(self) -> int:
        """Bytes that may still be written without crossing the total staging cap."""

        self.checkpoint()
        return max(0, self.limits.max_staging_bytes - self._staging_bytes)

    def charge_staging_write(self, key: str, count: int, *, depth: int) -> None:
        """Charge bytes as they are written rather than only after completion."""

        if count < 0:
            raise ValueError("staging write count cannot be negative")
        self.checkpoint(depth=depth)
        previous = self._staging_members.get(key)
        if previous is None:
            self._require_file_capacity()
            previous = 0
        self._staging_members[key] = previous + count
        self._staging_bytes += count
        if self._staging_bytes > self.limits.max_staging_bytes:
            raise RecoveryRefusal(
                RecoveryRefusalCode.STAGING_BYTES,
                f"staging bytes exceed {self.limits.max_staging_bytes}",
            )

    def _require_file_capacity(self) -> None:
        if len(self._input_members) + len(self._staging_members) >= self.limits.max_files:
            raise RecoveryRefusal(
                RecoveryRefusalCode.FILE_COUNT,
                f"member count exceeds {self.limits.max_files}",
            )


@dataclass(frozen=True)
class FileIdentity:
    """Exact stat identity retained across a security-critical operation."""

    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int
    changed_ns: int

    @classmethod
    def from_stat(cls, value: os.stat_result) -> FileIdentity:
        return cls(
            device=value.st_dev,
            inode=value.st_ino,
            mode=value.st_mode,
            size=value.st_size,
            modified_ns=value.st_mtime_ns,
            changed_ns=value.st_ctime_ns,
        )

    def to_dict(self) -> dict[str, int]:
        """Return stable, content-free identity evidence."""

        return {
            "device": self.device,
            "inode": self.inode,
            "mode": self.mode,
            "size": self.size,
            "modified_ns": self.modified_ns,
            "changed_ns": self.changed_ns,
        }


@dataclass(frozen=True)
class HeldDirectory:
    """A directory addressed by a retained descriptor, never by an untrusted path."""

    descriptor: int
    identity: FileIdentity
    display_path: Path
    budget: RecoveryBudget
    namespace: str

    @property
    def access_path(self) -> Path:
        """Stable Linux path for libraries that cannot consume a directory fd."""

        proc_path = Path("/proc/self/fd") / str(self.descriptor)
        if not proc_path.exists():
            raise ValidationError("descriptor-backed library access requires /proc/self/fd")
        return proc_path


@dataclass
class RecoverySource:
    """Receipt-authorized source and receipt identities held for one operation."""

    authorization: OfflineAuthorization
    parent: HeldDirectory
    root: HeldDirectory
    source_name: str
    receipt_descriptor: int
    receipt_identity: FileIdentity
    receipt_sha256: str
    ancestor_chain: _DirectoryChain
    _closed: bool = False

    @property
    def target(self) -> Path:
        return self.authorization.target

    @property
    def budget(self) -> RecoveryBudget:
        return self.root.budget

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        os.close(self.receipt_descriptor)
        os.close(self.root.descriptor)
        self.ancestor_chain.close()

    def __enter__(self) -> RecoverySource:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


@dataclass(frozen=True)
class SourceMember:
    """One no-follow member identity in a copied source tree."""

    relative_path: str
    kind: str
    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int
    changed_ns: int
    sha256: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "relative_path": self.relative_path,
            "kind": self.kind,
            "device": self.device,
            "inode": self.inode,
            "mode": self.mode,
            "size": self.size,
            "modified_ns": self.modified_ns,
            "changed_ns": self.changed_ns,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class SourceSnapshot:
    """Exact no-follow identity and bytes for one held authorized source."""

    target: Path
    root_identity: FileIdentity
    members: tuple[SourceMember, ...]
    manifest_sha256: str


@dataclass(frozen=True)
class RecoveryAttemptBinding:
    """Content-free source/receipt identity persisted with an apply attempt."""

    source_id: str
    source_manifest_sha256: str
    receipt_sha256: str


@dataclass
class RecoveryAttempt:
    """Held private directories and reserved names for one authorized attempt."""

    root: Path
    staging: Path
    backup: Path
    failed_swap: Path
    binding: RecoveryAttemptBinding
    root_handle: HeldDirectory
    staging_handle: HeldDirectory
    _closed: bool = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        os.close(self.staging_handle.descriptor)
        os.close(self.root_handle.descriptor)

    def __enter__(self) -> RecoveryAttempt:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


@dataclass(frozen=True)
class VerificationResult:
    """Content-free verification result used by the swap state machine."""

    ok: bool
    detail: str


@dataclass(frozen=True)
class BackupEvidence:
    """Advisory path plus exact identities for reacquiring the parked original."""

    advisory_path: Path
    name: str
    parent_identity: FileIdentity
    original_identity: FileIdentity
    parked_identity: FileIdentity

    def to_dict(self) -> dict[str, object]:
        """Return content-free evidence; the path must never be trusted alone."""

        return {
            "advisory_path": str(self.advisory_path),
            "name": self.name,
            "parent_identity": self.parent_identity.to_dict(),
            "original_identity": self.original_identity.to_dict(),
            "parked_identity": self.parked_identity.to_dict(),
        }


@dataclass(frozen=True)
class SwapResult:
    """Successful swap result with identity-bound evidence for the original."""

    backup: BackupEvidence
    verification: VerificationResult


class RecoverySwapError(RuntimeError):
    """A swap failed; only identity-validated backup evidence is exposed."""

    def __init__(
        self,
        message: str,
        *,
        rollback_succeeded: bool,
        backup: BackupEvidence | None,
        failed_swap_advisory: Path,
        event_errors: tuple[str, ...] = (),
    ) -> None:
        super().__init__(message)
        self.rollback_succeeded = rollback_succeeded
        self.backup = backup
        self.failed_swap_advisory = failed_swap_advisory
        self.event_errors = event_errors


@dataclass
class ScratchDirectory:
    """Private descriptor-bound scratch directory with safe best-effort cleanup."""

    parent_descriptor: int
    name: str
    handle: HeldDirectory
    _closed: bool = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            _remove_directory_contents(self.handle.descriptor)
            current = _stat_member_at_optional(self.parent_descriptor, self.name)
            if current is not None and _same_file_object(current, self.handle.identity):
                os.rmdir(self.name, dir_fd=self.parent_descriptor)
        finally:
            os.close(self.handle.descriptor)
            os.close(self.parent_descriptor)

    def __enter__(self) -> ScratchDirectory:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


def _descriptor_filesystem_flags() -> tuple[int, int]:
    """Return safe open flags or reject platforms without required primitives."""

    no_follow = getattr(os, "O_NOFOLLOW", None)
    directory = getattr(os, "O_DIRECTORY", None)
    nonblock = getattr(os, "O_NONBLOCK", None)
    if (
        not isinstance(no_follow, int)
        or not isinstance(directory, int)
        or not isinstance(nonblock, int)
    ):
        raise ValidationError(
            "race-safe recovery requires O_DIRECTORY, O_NOFOLLOW, and O_NONBLOCK support"
        )
    required_dir_fd = (os.open, os.stat, os.mkdir, os.unlink, os.rmdir)
    if not all(function in os.supports_dir_fd for function in required_dir_fd):
        raise ValidationError("race-safe recovery requires descriptor-relative filesystem support")
    if os.scandir not in os.supports_fd or os.utime not in os.supports_fd:
        raise ValidationError("race-safe recovery requires descriptor scandir/utime support")
    if not hasattr(os, "fchmod"):
        raise ValidationError("race-safe recovery requires descriptor chmod support")
    close_on_exec = getattr(os, "O_CLOEXEC", 0)
    if not isinstance(close_on_exec, int):
        raise ValidationError("race-safe recovery requires valid close-on-exec flags")
    directory_flags = os.O_RDONLY | directory | no_follow | close_on_exec
    regular_flags = os.O_RDONLY | nonblock | no_follow | close_on_exec
    return directory_flags, regular_flags


def _require_same_identity(
    actual: os.stat_result,
    expected: os.stat_result | FileIdentity,
    message: str,
) -> None:
    expected_identity = (
        expected if isinstance(expected, FileIdentity) else FileIdentity.from_stat(expected)
    )
    if FileIdentity.from_stat(actual) != expected_identity:
        raise ValidationError(message)


def _same_file_object(
    actual: os.stat_result | FileIdentity,
    expected: os.stat_result | FileIdentity,
) -> bool:
    actual_identity = actual if isinstance(actual, FileIdentity) else FileIdentity.from_stat(actual)
    expected_identity = (
        expected if isinstance(expected, FileIdentity) else FileIdentity.from_stat(expected)
    )
    return (
        actual_identity.device == expected_identity.device
        and actual_identity.inode == expected_identity.inode
        and stat.S_IFMT(actual_identity.mode) == stat.S_IFMT(expected_identity.mode)
    )


def _require_same_file_object(
    actual: os.stat_result | FileIdentity,
    expected: os.stat_result | FileIdentity,
    message: str,
) -> None:
    if not _same_file_object(actual, expected):
        raise ValidationError(message)


def _same_directory_after_rename(
    actual: os.stat_result | FileIdentity,
    expected: os.stat_result | FileIdentity,
) -> bool:
    actual_identity = actual if isinstance(actual, FileIdentity) else FileIdentity.from_stat(actual)
    expected_identity = (
        expected if isinstance(expected, FileIdentity) else FileIdentity.from_stat(expected)
    )
    return (
        _same_file_object(actual_identity, expected_identity)
        and actual_identity.mode == expected_identity.mode
        and actual_identity.size == expected_identity.size
        and actual_identity.modified_ns == expected_identity.modified_ns
    )


def _require_same_directory_after_rename(
    actual: os.stat_result | FileIdentity,
    expected: os.stat_result | FileIdentity,
    message: str,
) -> None:
    if not _same_directory_after_rename(actual, expected):
        raise ValidationError(message)


def _validate_member_name(name: str) -> None:
    if (
        not name
        or name in {".", ".."}
        or os.sep in name
        or (os.altsep is not None and os.altsep in name)
    ):
        raise ValidationError("recovery directory returned an invalid member name")


def _stat_member_at(parent_descriptor: int, name: str, field: str) -> os.stat_result:
    _validate_member_name(name)
    try:
        return os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except OSError as exc:
        raise ValidationError(f"cannot inspect {field}") from exc


def _stat_member_at_optional(parent_descriptor: int, name: str) -> os.stat_result | None:
    _validate_member_name(name)
    try:
        return os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _open_directory_at(
    parent_descriptor: int,
    name: str,
    expected: os.stat_result | FileIdentity,
    field: str,
    directory_flags: int,
) -> tuple[int, os.stat_result]:
    try:
        descriptor = os.open(name, directory_flags, dir_fd=parent_descriptor)
    except OSError as exc:
        raise ValidationError(f"{field} changed before descriptor open") from exc
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            raise ValidationError(f"{field} is not a directory")
        _require_same_identity(opened, expected, f"{field} changed before descriptor open")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, opened


def _open_directory_object_at(
    parent_descriptor: int,
    name: str,
    expected: os.stat_result,
    field: str,
    directory_flags: int,
) -> tuple[int, os.stat_result]:
    """Open an ancestor whose ordinary metadata may change concurrently."""

    try:
        descriptor = os.open(name, directory_flags, dir_fd=parent_descriptor)
    except OSError as exc:
        raise ValidationError(f"{field} changed before descriptor open") from exc
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            raise ValidationError(f"{field} is not a directory")
        _require_same_file_object(opened, expected, f"{field} changed before descriptor open")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, opened


def _open_regular_file_at(
    parent_descriptor: int,
    name: str,
    expected: os.stat_result | FileIdentity,
    field: str,
    regular_flags: int,
) -> tuple[int, os.stat_result]:
    try:
        descriptor = os.open(name, regular_flags, dir_fd=parent_descriptor)
    except OSError as exc:
        raise ValidationError(f"{field} changed before descriptor open") from exc
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise ValidationError(f"{field} is not a regular file")
        _require_same_identity(opened, expected, f"{field} changed before descriptor open")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, opened


def _list_directory_names(descriptor: int, field: str) -> tuple[str, ...]:
    try:
        with os.scandir(descriptor) as entries:
            names = tuple(sorted(entry.name for entry in entries))
    except OSError as exc:
        raise ValidationError(f"cannot enumerate {field}") from exc
    for name in names:
        _validate_member_name(name)
    return names


@dataclass
class _DirectoryChain:
    path: Path
    descriptors: list[int]
    stats: list[os.stat_result]
    names: tuple[str, ...]

    def validate(self, field: str) -> None:
        for index, name in enumerate(self.names):
            rebound = _stat_member_at(self.descriptors[index], name, field)
            _require_same_file_object(
                rebound,
                self.stats[index + 1],
                f"{field} ancestor changed during authorization",
            )

    def retain_last(self) -> int:
        retained = self.descriptors[-1]
        for descriptor in self.descriptors[:-1]:
            os.close(descriptor)
        self.descriptors = [retained]
        return retained

    def close(self) -> None:
        for descriptor in reversed(self.descriptors):
            os.close(descriptor)
        self.descriptors = []


def _absolute_names(
    path: Path,
    field: str,
    *,
    allow_root: bool = False,
) -> tuple[str, ...]:
    if not path.is_absolute():
        raise ValidationError(f"{field} must be an explicit absolute path")
    names = tuple(part for part in path.parts if part != os.sep)
    if (not names and not allow_root) or any(part in {".", ".."} for part in names):
        raise ValidationError(f"{field} must be a normalized named path")
    for name in names:
        _validate_member_name(name)
    return names


def _open_absolute_directory_chain(path: Path, field: str) -> _DirectoryChain:
    directory_flags, _ = _descriptor_filesystem_flags()
    names = _absolute_names(path, field, allow_root=True)
    root_descriptor = os.open(os.sep, directory_flags)
    descriptors = [root_descriptor]
    stats = [os.fstat(root_descriptor)]
    try:
        for index, name in enumerate(names):
            child_stat = _stat_member_at(descriptors[-1], name, field)
            if stat.S_ISLNK(child_stat.st_mode) or not stat.S_ISDIR(child_stat.st_mode):
                raise ValidationError(f"{field} must contain only non-symlink directories")
            descriptor, opened = _open_directory_object_at(
                descriptors[-1],
                name,
                child_stat,
                field,
                directory_flags,
            )
            descriptors.append(descriptor)
            stats.append(opened)
            if index % 16 == 0:
                pass
    except Exception:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise
    return _DirectoryChain(path, descriptors, stats, names)


def directory_member_names(directory: HeldDirectory) -> tuple[str, ...]:
    """Enumerate one held directory without resolving its display path."""

    directory.budget.checkpoint()
    _require_same_file_object(
        os.fstat(directory.descriptor),
        directory.identity,
        "held directory identity changed",
    )
    return _list_directory_names(directory.descriptor, "held recovery directory")


def directory_member_identity(directory: HeldDirectory, name: str) -> FileIdentity | None:
    """Return one no-follow member identity under a held directory."""

    directory.budget.checkpoint()
    value = _stat_member_at_optional(directory.descriptor, name)
    return FileIdentity.from_stat(value) if value is not None else None


@contextmanager
def hold_child_directory(
    parent: HeldDirectory,
    name: str,
    expected: FileIdentity,
    *,
    namespace: str,
) -> Iterator[HeldDirectory]:
    """Hold one exact child directory for a bounded descriptor-relative use."""

    directory_flags, _ = _descriptor_filesystem_flags()
    current = _stat_member_at(parent.descriptor, name, "held child directory")
    _require_same_identity(current, expected, "held child directory changed before use")
    descriptor, opened = _open_directory_at(
        parent.descriptor,
        name,
        expected,
        "held child directory",
        directory_flags,
    )
    handle = HeldDirectory(
        descriptor,
        FileIdentity.from_stat(opened),
        parent.display_path / name,
        parent.budget,
        namespace,
    )
    try:
        yield handle
        _require_same_identity(
            os.fstat(descriptor),
            expected,
            "held child directory changed during use",
        )
        rebound = _stat_member_at(parent.descriptor, name, "held child directory")
        _require_same_identity(rebound, expected, "held child directory name changed during use")
    finally:
        os.close(descriptor)


@contextmanager
def hold_private_regular_file(parent: HeldDirectory, name: str) -> Iterator[int]:
    """Hold a private output file while allowing expected SQLite mutations."""

    _, regular_flags = _descriptor_filesystem_flags()
    current = _stat_member_at(parent.descriptor, name, "private recovery file")
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
        raise ValidationError("private recovery file is not a regular file")
    descriptor, opened = _open_regular_file_at(
        parent.descriptor,
        name,
        current,
        "private recovery file",
        regular_flags,
    )
    try:
        yield descriptor
        _require_same_file_object(
            os.fstat(descriptor),
            opened,
            "private recovery file identity changed during use",
        )
        rebound = _stat_member_at(parent.descriptor, name, "private recovery file")
        _require_same_file_object(
            rebound,
            opened,
            "private recovery file name changed during use",
        )
    finally:
        os.close(descriptor)


@contextmanager
def hold_regular_file(
    parent: HeldDirectory,
    name: str,
    expected: FileIdentity,
) -> Iterator[int]:
    """Hold one exact regular file and recheck its name after consumption."""

    _, regular_flags = _descriptor_filesystem_flags()
    current = _stat_member_at(parent.descriptor, name, "held recovery file")
    _require_same_identity(current, expected, "held recovery file changed before use")
    descriptor, opened = _open_regular_file_at(
        parent.descriptor,
        name,
        expected,
        "held recovery file",
        regular_flags,
    )
    try:
        yield descriptor
        _require_same_identity(
            os.fstat(descriptor),
            opened,
            "held recovery file changed during use",
        )
        rebound = _stat_member_at(parent.descriptor, name, "held recovery file")
        _require_same_identity(rebound, opened, "held recovery file name changed during use")
    finally:
        os.close(descriptor)


def _hash_descriptor(descriptor: int, budget: RecoveryBudget) -> str:
    digest = hashlib.sha256()
    offset = 0
    while True:
        budget.checkpoint()
        chunk = os.pread(descriptor, _HASH_CHUNK_BYTES, offset)
        if not chunk:
            break
        digest.update(chunk)
        offset += len(chunk)
    return digest.hexdigest()


def _path_identity_matches(
    actual_stat: os.stat_result,
    expected: PathIdentity,
    *,
    digest: str | None,
) -> bool:
    return (
        actual_stat.st_dev == expected.device
        and actual_stat.st_ino == expected.inode
        and actual_stat.st_mode == expected.mode
        and actual_stat.st_size == expected.size
        and actual_stat.st_mtime_ns == expected.modified_ns
        and digest == expected.sha256
    )


def open_authorized_recovery(
    target_path: Path,
    receipt_path: Path,
    *,
    budget: RecoveryBudget | None = None,
    environment: Mapping[str, str] | None = None,
) -> RecoverySource:
    """Authorize and bind source/receipt descriptors for one whole operation."""

    operation_budget = budget if budget is not None else RecoveryBudget()
    operation_budget.checkpoint()
    target_names = _absolute_names(target_path, "offline target")
    target_parent_path = target_path.parent
    target_parent_chain = _open_absolute_directory_chain(
        target_parent_path,
        "offline target parent",
    )
    source_descriptor = -1
    receipt_descriptor = -1
    receipt_parent_chain: _DirectoryChain | None = None
    try:
        directory_flags, regular_flags = _descriptor_filesystem_flags()
        source_stat = _stat_member_at(
            target_parent_chain.descriptors[-1], target_names[-1], "offline target"
        )
        if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISDIR(source_stat.st_mode):
            raise ValidationError("offline target must be a non-symlink directory")
        source_descriptor, opened_source = _open_directory_at(
            target_parent_chain.descriptors[-1],
            target_names[-1],
            source_stat,
            "offline target",
            directory_flags,
        )

        receipt_names = _absolute_names(receipt_path, "offline receipt")
        receipt_parent_chain = _open_absolute_directory_chain(
            receipt_path.parent,
            "offline receipt parent",
        )
        receipt_stat = _stat_member_at(
            receipt_parent_chain.descriptors[-1], receipt_names[-1], "offline receipt"
        )
        if stat.S_ISLNK(receipt_stat.st_mode) or not stat.S_ISREG(receipt_stat.st_mode):
            raise ValidationError("offline receipt must be a regular non-symlink file")
        operation_budget.account_input_member(
            "authorization-receipt",
            receipt_stat.st_size,
            depth=0,
        )
        receipt_descriptor, opened_receipt = _open_regular_file_at(
            receipt_parent_chain.descriptors[-1],
            receipt_names[-1],
            receipt_stat,
            "offline receipt",
            regular_flags,
        )
        receipt_sha256 = _hash_descriptor(receipt_descriptor, operation_budget)

        authorization = authorize_offline_target(
            target_path,
            receipt_path,
            environment=environment,
        )
        target_parent_chain.validate("offline target")
        receipt_parent_chain.validate("offline receipt")
        _require_same_identity(
            _stat_member_at(
                target_parent_chain.descriptors[-1], target_names[-1], "offline target"
            ),
            opened_source,
            "offline target changed during authorization",
        )
        _require_same_identity(
            _stat_member_at(
                receipt_parent_chain.descriptors[-1], receipt_names[-1], "offline receipt"
            ),
            opened_receipt,
            "offline receipt changed during authorization",
        )
        if not _path_identity_matches(
            opened_source,
            authorization.target_identity,
            digest=None,
        ):
            raise ValidationError("held offline target does not match authorized identity")
        if not _path_identity_matches(
            opened_receipt,
            authorization.receipt_identity,
            digest=receipt_sha256,
        ):
            raise ValidationError("held offline receipt does not match authorized identity")

        parent_descriptor = target_parent_chain.descriptors[-1]
        receipt_parent_chain.close()
        receipt_parent_chain = None
        parent_stat = os.fstat(parent_descriptor)
        return RecoverySource(
            authorization=authorization,
            parent=HeldDirectory(
                parent_descriptor,
                FileIdentity.from_stat(parent_stat),
                authorization.target.parent,
                operation_budget,
                "source-parent",
            ),
            root=HeldDirectory(
                source_descriptor,
                FileIdentity.from_stat(opened_source),
                authorization.target,
                operation_budget,
                "source",
            ),
            source_name=target_names[-1],
            receipt_descriptor=receipt_descriptor,
            receipt_identity=FileIdentity.from_stat(opened_receipt),
            receipt_sha256=receipt_sha256,
            ancestor_chain=target_parent_chain,
        )
    except Exception:
        if receipt_descriptor >= 0:
            os.close(receipt_descriptor)
        if source_descriptor >= 0:
            os.close(source_descriptor)
        if receipt_parent_chain is not None:
            receipt_parent_chain.close()
        target_parent_chain.close()
        raise


def assert_authorization_held(source: RecoverySource, *, require_source_name: bool = True) -> None:
    """Validate held descriptor identities without reopening any supplied path."""

    source.budget.checkpoint()
    source.ancestor_chain.validate("held recovery source")
    _require_same_file_object(
        os.fstat(source.parent.descriptor),
        source.parent.identity,
        "held recovery source parent identity changed",
    )
    _require_same_identity(
        os.fstat(source.root.descriptor),
        source.root.identity,
        "held recovery source identity changed",
    )
    if require_source_name:
        rebound = _stat_member_at(source.parent.descriptor, source.source_name, "recovery source")
        _require_same_identity(rebound, source.root.identity, "recovery source name changed")
    receipt_stat = os.fstat(source.receipt_descriptor)
    _require_same_identity(
        receipt_stat,
        source.receipt_identity,
        "held offline receipt identity changed",
    )
    if _hash_descriptor(source.receipt_descriptor, source.budget) != source.receipt_sha256:
        raise ValidationError("held offline receipt bytes changed")


def _source_member(
    relative_path: str,
    kind: str,
    source_stat: os.stat_result,
    sha256: str | None,
) -> SourceMember:
    return SourceMember(
        relative_path=relative_path,
        kind=kind,
        device=source_stat.st_dev,
        inode=source_stat.st_ino,
        mode=source_stat.st_mode,
        size=source_stat.st_size,
        modified_ns=source_stat.st_mtime_ns,
        changed_ns=source_stat.st_ctime_ns,
        sha256=sha256,
    )


def _hash_regular_file_at(
    parent_descriptor: int,
    name: str,
    expected: os.stat_result,
    relative_path: Path,
    regular_flags: int,
    budget: RecoveryBudget,
) -> str:
    field = f"recovery source member {relative_path.as_posix()}"
    descriptor, opened = _open_regular_file_at(
        parent_descriptor,
        name,
        expected,
        field,
        regular_flags,
    )
    try:
        digest = _hash_descriptor(descriptor, budget)
        _require_same_identity(os.fstat(descriptor), opened, f"{field} changed while hashing")
        rebound = _stat_member_at(parent_descriptor, name, field)
        _require_same_identity(rebound, opened, f"{field} changed while hashing")
        return digest
    finally:
        os.close(descriptor)


def _snapshot_members(
    source: RecoverySource,
    *,
    allow_root_rename: bool = False,
) -> tuple[SourceMember, ...]:
    directory_flags, regular_flags = _descriptor_filesystem_flags()
    members: list[SourceMember] = []

    def visit(
        directory_descriptor: int,
        directory_stat: os.stat_result,
        relative_directory: Path,
        depth: int,
    ) -> None:
        source.budget.checkpoint(depth=depth)
        relative_name = "." if relative_directory == Path(".") else relative_directory.as_posix()
        source.budget.account_input_member(f"source:{relative_name}", 0, depth=depth)
        members.append(_source_member(relative_name, "directory", directory_stat, None))
        for name in _list_directory_names(directory_descriptor, "recovery source directory"):
            relative_child = (
                Path(name) if relative_directory == Path(".") else relative_directory / name
            )
            child_depth = depth + 1
            source.budget.checkpoint(depth=child_depth)
            field = f"recovery source member {relative_child.as_posix()}"
            child_stat = _stat_member_at(directory_descriptor, name, field)
            if stat.S_ISLNK(child_stat.st_mode):
                raise ValidationError(
                    f"recovery source must not contain symlinks: {relative_child.as_posix()}"
                )
            if stat.S_ISDIR(child_stat.st_mode):
                child_descriptor, opened = _open_directory_at(
                    directory_descriptor,
                    name,
                    child_stat,
                    field,
                    directory_flags,
                )
                try:
                    visit(child_descriptor, opened, relative_child, child_depth)
                finally:
                    os.close(child_descriptor)
                rebound = _stat_member_at(directory_descriptor, name, field)
                _require_same_identity(rebound, opened, f"{field} changed during snapshot")
                continue
            if not stat.S_ISREG(child_stat.st_mode):
                raise ValidationError(
                    "recovery source contains an unsupported special file: "
                    f"{relative_child.as_posix()}"
                )
            source.budget.account_input_member(
                f"source:{relative_child.as_posix()}",
                child_stat.st_size,
                depth=child_depth,
            )
            digest = _hash_regular_file_at(
                directory_descriptor,
                name,
                child_stat,
                relative_child,
                regular_flags,
                source.budget,
            )
            members.append(_source_member(relative_child.as_posix(), "file", child_stat, digest))
        _require_same_identity(
            os.fstat(directory_descriptor),
            directory_stat,
            f"recovery source directory {relative_name} changed during snapshot",
        )

    root_stat = os.fstat(source.root.descriptor)
    if allow_root_rename:
        _require_same_directory_after_rename(
            root_stat,
            source.root.identity,
            "held recovery source changed",
        )
    else:
        _require_same_identity(root_stat, source.root.identity, "held recovery source changed")
    visit(source.root.descriptor, root_stat, Path("."), 0)
    rebound_root = _stat_member_at(source.parent.descriptor, source.source_name, "recovery source")
    _require_same_identity(rebound_root, root_stat, "recovery source changed during snapshot")
    return tuple(members)


def snapshot_source_tree(source: RecoverySource) -> SourceSnapshot:
    """Hash one held authorized source without following any link member."""

    assert_authorization_held(source)
    members = _snapshot_members(source)
    manifest = canonical_json_bytes([member.to_dict() for member in members])
    return SourceSnapshot(
        target=source.target,
        root_identity=source.root.identity,
        members=members,
        manifest_sha256=hashlib.sha256(manifest).hexdigest(),
    )


def assert_source_unchanged(
    source: RecoverySource,
    expected: SourceSnapshot,
    *,
    allow_root_rename: bool = False,
) -> None:
    """Reject source identity, metadata, membership, or byte drift."""

    if source.target != expected.target or source.root.identity != expected.root_identity:
        raise ValidationError("source snapshot is not bound to this recovery source")
    if not allow_root_rename:
        assert_authorization_held(source)
        current_members = _snapshot_members(source)
    else:
        _assert_restored_source_binding(source, expected)
        current_members = _snapshot_members(source, allow_root_rename=True)
    normalized = _normalize_root_rename(current_members, expected.members)
    manifest = canonical_json_bytes([member.to_dict() for member in normalized])
    current_digest = hashlib.sha256(manifest).hexdigest()
    if normalized != expected.members or current_digest != expected.manifest_sha256:
        raise ValidationError("copied recovery source changed after authorization/inspection")


def _assert_restored_source_binding(source: RecoverySource, expected: SourceSnapshot) -> None:
    source.ancestor_chain.validate("held recovery source")
    _require_same_file_object(
        os.fstat(source.parent.descriptor),
        source.parent.identity,
        "held recovery source parent changed",
    )
    root_stat = os.fstat(source.root.descriptor)
    _require_same_directory_after_rename(
        root_stat,
        expected.root_identity,
        "renamed recovery source identity changed",
    )
    rebound = _stat_member_at(source.parent.descriptor, source.source_name, "recovery source")
    _require_same_directory_after_rename(
        rebound,
        expected.root_identity,
        "restored recovery source name changed",
    )
    receipt_stat = os.fstat(source.receipt_descriptor)
    _require_same_identity(
        receipt_stat,
        source.receipt_identity,
        "held offline receipt identity changed",
    )
    if _hash_descriptor(source.receipt_descriptor, source.budget) != source.receipt_sha256:
        raise ValidationError("held offline receipt bytes changed")


def _normalize_root_rename(
    current: tuple[SourceMember, ...],
    expected: tuple[SourceMember, ...],
) -> tuple[SourceMember, ...]:
    if not current or not expected or current[0].relative_path != ".":
        return current
    root = current[0]
    expected_root = expected[0]
    current_identity = FileIdentity(
        root.device,
        root.inode,
        root.mode,
        root.size,
        root.modified_ns,
        root.changed_ns,
    )
    expected_identity = FileIdentity(
        expected_root.device,
        expected_root.inode,
        expected_root.mode,
        expected_root.size,
        expected_root.modified_ns,
        expected_root.changed_ns,
    )
    if not _same_directory_after_rename(current_identity, expected_identity):
        return current
    normalized_root = SourceMember(
        root.relative_path,
        root.kind,
        root.device,
        root.inode,
        root.mode,
        root.size,
        root.modified_ns,
        expected_root.changed_ns,
        root.sha256,
    )
    return (normalized_root,) + current[1:]


def revalidate_source_binding(
    source: RecoverySource,
    snapshot: SourceSnapshot,
) -> RecoverySource:
    """Revalidate exact held receipt/source identities before mutation."""

    assert_source_unchanged(source, snapshot)
    return source


def recovery_attempt_binding(
    source: RecoverySource,
    snapshot: SourceSnapshot,
) -> RecoveryAttemptBinding:
    """Bind a future attempt to the exact held receipt and source manifest."""

    if source.target != snapshot.target or source.receipt_sha256 == "":
        raise ValidationError("recovery attempt binding does not match authorization")
    return RecoveryAttemptBinding(
        source_id=source.authorization.source_id,
        source_manifest_sha256=snapshot.manifest_sha256,
        receipt_sha256=source.receipt_sha256,
    )


def _create_unique_directory_at(
    parent_descriptor: int,
    prefix: str,
    field: str,
    budget: RecoveryBudget,
    namespace_prefix: str,
) -> tuple[str, HeldDirectory]:
    directory_flags, _ = _descriptor_filesystem_flags()
    for _ in range(_MAX_UNIQUE_NAME_ATTEMPTS):
        budget.checkpoint()
        name = f"{prefix}{secrets.token_hex(12)}"
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_descriptor)
        except FileExistsError:
            continue
        except OSError as exc:
            raise ValidationError(f"cannot allocate {field}") from exc
        created = _stat_member_at(parent_descriptor, name, field)
        if stat.S_ISLNK(created.st_mode) or not stat.S_ISDIR(created.st_mode):
            raise ValidationError(f"{field} is not a newly created directory")
        descriptor, opened = _open_directory_at(
            parent_descriptor,
            name,
            created,
            field,
            directory_flags,
        )
        os.fchmod(descriptor, 0o700)
        identity = FileIdentity.from_stat(opened)
        budget.account_staging_member(f"{namespace_prefix}:.", 0, depth=0)
        return name, HeldDirectory(
            descriptor,
            identity,
            Path(name),
            budget,
            f"{namespace_prefix}:{identity.device}:{identity.inode}",
        )
    raise ValidationError(f"cannot allocate a unique {field}")


def allocate_recovery_attempt(
    source: RecoverySource,
    operation: str,
    snapshot: SourceSnapshot,
    binding: RecoveryAttemptBinding,
) -> RecoveryAttempt:
    """Reserve a private unique sibling attempt using the held source parent."""

    if not operation or not operation.replace("-", "").isalnum():
        raise ValidationError("recovery operation must be a simple identifier")
    assert_source_unchanged(source, snapshot)
    expected_binding = recovery_attempt_binding(source, snapshot)
    if expected_binding != binding:
        raise ValidationError("recovery attempt binding does not match held authorization")
    root_name, root_handle = _create_unique_directory_at(
        source.parent.descriptor,
        f".penny-{operation}-",
        "recovery attempt root",
        source.budget,
        f"attempt-{operation}",
    )
    try:
        staging_name, staging_handle = _create_unique_directory_at(
            root_handle.descriptor,
            "staged-",
            "recovery staging",
            source.budget,
            f"{root_handle.namespace}:staging",
        )
    except Exception:
        os.close(root_handle.descriptor)
        raise
    root_path = source.target.parent / root_name
    staging_path = root_path / staging_name
    attempt = RecoveryAttempt(
        root=root_path,
        staging=staging_path,
        backup=root_path / "original",
        failed_swap=root_path / "failed-swapped",
        binding=binding,
        root_handle=HeldDirectory(
            root_handle.descriptor,
            root_handle.identity,
            root_path,
            source.budget,
            root_handle.namespace,
        ),
        staging_handle=HeldDirectory(
            staging_handle.descriptor,
            staging_handle.identity,
            staging_path,
            source.budget,
            staging_handle.namespace,
        ),
    )
    try:
        _record_attempt_event(
            attempt,
            "allocated",
            {
                "operation": operation,
                "source_id": binding.source_id,
                "source_manifest_sha256": binding.source_manifest_sha256,
                "receipt_sha256": binding.receipt_sha256,
            },
        )
    except Exception:
        attempt.close()
        raise
    return attempt


def _open_unique_event_file(attempt: RecoveryAttempt, event: str) -> tuple[int, str]:
    _, regular_flags = _descriptor_filesystem_flags()
    write_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | (regular_flags & ~(os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)))
    )
    for _ in range(_MAX_UNIQUE_NAME_ATTEMPTS):
        attempt.root_handle.budget.checkpoint()
        name = f"event-{event}-{secrets.token_hex(12)}.json"
        try:
            descriptor = os.open(
                name,
                write_flags,
                0o600,
                dir_fd=attempt.root_handle.descriptor,
            )
        except FileExistsError:
            continue
        except OSError as exc:
            raise ValidationError("cannot create recovery event") from exc
        return descriptor, name
    raise ValidationError("cannot allocate a unique recovery event")


def _write_all(
    descriptor: int,
    chunk: bytes,
    *,
    budget: RecoveryBudget,
    staging_key: str,
    depth: int,
) -> None:
    view = memoryview(chunk)
    while view:
        budget.checkpoint(depth=depth)
        capacity = budget.staging_write_capacity
        if capacity <= 0:
            raise RecoveryRefusal(
                RecoveryRefusalCode.STAGING_BYTES,
                f"staging bytes exceed {budget.limits.max_staging_bytes}",
            )
        written = os.write(descriptor, view[:capacity])
        if written <= 0:
            raise OSError("recovery staging write made no progress")
        budget.charge_staging_write(staging_key, written, depth=depth)
        view = view[written:]


def _record_attempt_event(
    attempt: RecoveryAttempt,
    event: str,
    fields: Mapping[str, object] | None = None,
) -> Path:
    """Create one immutable event relative to the held attempt root."""

    if not event or not event.replace("-", "").isalnum():
        raise ValidationError("recovery event must be a simple identifier")
    _require_same_file_object(
        os.fstat(attempt.root_handle.descriptor),
        attempt.root_handle.identity,
        "held recovery attempt root changed",
    )
    descriptor, name = _open_unique_event_file(attempt, event)
    payload: dict[str, object] = {"event": event}
    if fields:
        payload.update(fields)
    data = canonical_json_bytes(payload)
    key = f"{attempt.root_handle.namespace}:{name}"
    try:
        _write_all(
            descriptor,
            data,
            budget=attempt.root_handle.budget,
            staging_key=key,
            depth=1,
        )
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o600)
        opened = os.fstat(descriptor)
        rebound = _stat_member_at(
            attempt.root_handle.descriptor,
            name,
            "recovery event",
        )
        _require_same_identity(rebound, opened, "recovery event changed while writing")
    finally:
        os.close(descriptor)
    return attempt.root / name


def _safe_record_attempt_event(
    attempt: RecoveryAttempt,
    event: str,
    fields: Mapping[str, object] | None = None,
) -> str | None:
    try:
        _record_attempt_event(attempt, event, fields)
    except Exception as exc:  # event evidence must never replace the primary failure
        return f"{event}:{type(exc).__name__}"
    return None


def _copy_regular_file_at(
    source_parent: int,
    destination_parent: int,
    source_name: str,
    destination_name: str,
    source_stat: os.stat_result,
    relative_path: Path,
    regular_flags: int,
    destination: HeldDirectory,
    depth: int,
) -> None:
    field = f"recovery source member {relative_path.as_posix()}"
    source_descriptor, opened = _open_regular_file_at(
        source_parent,
        source_name,
        source_stat,
        field,
        regular_flags,
    )
    no_follow_flags = regular_flags & ~(os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    staging_key = f"{destination.namespace}:{relative_path.as_posix()}"
    destination.budget.account_staging_member(staging_key, 0, depth=depth)
    try:
        try:
            destination_descriptor = os.open(
                destination_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | no_follow_flags,
                0o600,
                dir_fd=destination_parent,
            )
        except OSError as exc:
            raise ValidationError(
                f"cannot create recovery staging member {relative_path.as_posix()}"
            ) from exc
        try:
            while True:
                destination.budget.checkpoint(depth=depth)
                chunk = os.read(source_descriptor, _COPY_CHUNK_BYTES)
                if not chunk:
                    break
                _write_all(
                    destination_descriptor,
                    chunk,
                    budget=destination.budget,
                    staging_key=staging_key,
                    depth=depth,
                )
            os.fchmod(destination_descriptor, stat.S_IMODE(source_stat.st_mode))
            os.utime(
                destination_descriptor,
                ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns),
            )
            os.fsync(destination_descriptor)
            destination_finished = os.fstat(destination_descriptor)
            destination_bound = _stat_member_at(
                destination_parent,
                destination_name,
                f"recovery staging member {relative_path.as_posix()}",
            )
            _require_same_identity(
                destination_bound,
                destination_finished,
                f"recovery staging member {relative_path.as_posix()} changed during copy",
            )
        finally:
            os.close(destination_descriptor)
        _require_same_identity(
            os.fstat(source_descriptor), opened, f"{field} changed while copying"
        )
        source_bound = _stat_member_at(source_parent, source_name, field)
        _require_same_identity(source_bound, opened, f"{field} changed while copying")
    finally:
        os.close(source_descriptor)


def _create_directory_at(
    parent_descriptor: int,
    name: str,
    field: str,
    directory_flags: int,
    destination: HeldDirectory,
    relative_path: Path,
    depth: int,
) -> tuple[int, os.stat_result]:
    destination.budget.account_staging_member(
        f"{destination.namespace}:{relative_path.as_posix()}",
        0,
        depth=depth,
    )
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent_descriptor)
    except OSError as exc:
        raise ValidationError(f"cannot create {field}") from exc
    created = _stat_member_at(parent_descriptor, name, field)
    if stat.S_ISLNK(created.st_mode) or not stat.S_ISDIR(created.st_mode):
        raise ValidationError(f"{field} is not a newly created directory")
    return _open_directory_at(parent_descriptor, name, created, field, directory_flags)


def _copy_members_at(
    source_descriptor: int,
    destination_descriptor: int,
    source_stat: os.stat_result,
    relative_directory: Path,
    excluded_names: frozenset[str],
    directory_flags: int,
    regular_flags: int,
    destination: HeldDirectory,
    depth: int,
) -> None:
    destination.budget.checkpoint(depth=depth)
    for name in _list_directory_names(source_descriptor, "recovery source directory"):
        if relative_directory == Path(".") and name in excluded_names:
            continue
        relative_child = (
            Path(name) if relative_directory == Path(".") else relative_directory / name
        )
        source_child_stat = _stat_member_at(
            source_descriptor,
            name,
            f"recovery source member {relative_child.as_posix()}",
        )
        _copy_member_at(
            source_descriptor,
            destination_descriptor,
            name,
            name,
            source_child_stat,
            relative_child,
            directory_flags,
            regular_flags,
            destination,
            depth + 1,
        )
    relative_name = "." if relative_directory == Path(".") else relative_directory.as_posix()
    _require_same_identity(
        os.fstat(source_descriptor),
        source_stat,
        f"recovery source directory {relative_name} changed during copy",
    )


def _copy_directory_at(
    source_parent: int,
    destination_parent: int,
    source_name: str,
    destination_name: str,
    source_stat: os.stat_result,
    relative_path: Path,
    directory_flags: int,
    regular_flags: int,
    destination: HeldDirectory,
    depth: int,
) -> None:
    field = f"recovery source member {relative_path.as_posix()}"
    source_descriptor, opened = _open_directory_at(
        source_parent,
        source_name,
        source_stat,
        field,
        directory_flags,
    )
    try:
        destination_field = f"recovery staging member {relative_path.as_posix()}"
        destination_descriptor, _ = _create_directory_at(
            destination_parent,
            destination_name,
            destination_field,
            directory_flags,
            destination,
            relative_path,
            depth,
        )
        try:
            _copy_members_at(
                source_descriptor,
                destination_descriptor,
                opened,
                relative_path,
                frozenset(),
                directory_flags,
                regular_flags,
                destination,
                depth,
            )
            os.fchmod(destination_descriptor, stat.S_IMODE(source_stat.st_mode))
            os.utime(
                destination_descriptor,
                ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns),
            )
            destination_finished = os.fstat(destination_descriptor)
            destination_bound = _stat_member_at(
                destination_parent,
                destination_name,
                destination_field,
            )
            _require_same_identity(
                destination_bound,
                destination_finished,
                f"{destination_field} changed during copy",
            )
        finally:
            os.close(destination_descriptor)
        source_bound = _stat_member_at(source_parent, source_name, field)
        _require_same_identity(source_bound, opened, f"{field} changed during copy")
    finally:
        os.close(source_descriptor)


def _copy_member_at(
    source_parent: int,
    destination_parent: int,
    source_name: str,
    destination_name: str,
    source_stat: os.stat_result,
    relative_path: Path,
    directory_flags: int,
    regular_flags: int,
    destination: HeldDirectory,
    depth: int,
) -> None:
    destination.budget.checkpoint(depth=depth)
    if stat.S_ISLNK(source_stat.st_mode):
        raise ValidationError(
            f"refusing to copy a symlink into recovery staging: {relative_path.as_posix()}"
        )
    if stat.S_ISREG(source_stat.st_mode):
        _copy_regular_file_at(
            source_parent,
            destination_parent,
            source_name,
            destination_name,
            source_stat,
            relative_path,
            regular_flags,
            destination,
            depth,
        )
        return
    if stat.S_ISDIR(source_stat.st_mode):
        _copy_directory_at(
            source_parent,
            destination_parent,
            source_name,
            destination_name,
            source_stat,
            relative_path,
            directory_flags,
            regular_flags,
            destination,
            depth,
        )
        return
    raise ValidationError(
        f"refusing to copy a special file into recovery staging: {relative_path.as_posix()}"
    )


def copy_preserved_entries(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    snapshot: SourceSnapshot,
    *,
    excluded_names: frozenset[str],
) -> None:
    """Copy source entries through held source and staging descriptors."""

    assert_source_unchanged(source, snapshot)
    directory_flags, regular_flags = _descriptor_filesystem_flags()
    source_stat = os.fstat(source.root.descriptor)
    _copy_members_at(
        source.root.descriptor,
        attempt.staging_handle.descriptor,
        source_stat,
        Path("."),
        excluded_names,
        directory_flags,
        regular_flags,
        attempt.staging_handle,
        0,
    )
    assert_source_unchanged(source, snapshot)
    _require_same_file_object(
        os.fstat(attempt.staging_handle.descriptor),
        attempt.staging_handle.identity,
        "held recovery staging changed during copy",
    )


OpenedRegularFile = tuple[str, int, os.stat_result]


def _validate_named_regular_candidate(
    name: str,
    candidate: os.stat_result | None,
    expected: Mapping[str, FileIdentity] | None,
) -> os.stat_result | None:
    expected_identity = expected.get(name) if expected is not None else None
    if candidate is None:
        if expected_identity is not None:
            raise ValidationError(f"recovery source member {name} disappeared")
        return None
    if expected is not None and expected_identity is None:
        raise ValidationError(f"recovery source member {name} appeared after inspection")
    if expected_identity is not None:
        _require_same_identity(
            candidate,
            expected_identity,
            f"recovery source member {name} changed before copying",
        )
    if stat.S_ISLNK(candidate.st_mode) or not stat.S_ISREG(candidate.st_mode):
        raise ValidationError(f"recovery source member {name} is not a regular file")
    return candidate


def _open_named_regular_files(
    source: HeldDirectory,
    names: tuple[str, ...],
    expected: Mapping[str, FileIdentity] | None,
    *,
    account_as_input: bool,
    regular_flags: int,
) -> list[OpenedRegularFile]:
    opened_files: list[OpenedRegularFile] = []
    try:
        for name in names:
            source.budget.checkpoint(depth=1)
            candidate = _validate_named_regular_candidate(
                name,
                _stat_member_at_optional(source.descriptor, name),
                expected,
            )
            if candidate is None:
                continue
            if account_as_input:
                source.budget.account_input_member(f"source:{name}", candidate.st_size, depth=1)
            descriptor, opened = _open_regular_file_at(
                source.descriptor,
                name,
                candidate,
                f"recovery source member {name}",
                regular_flags,
            )
            opened_files.append((name, descriptor, opened))
        return opened_files
    except Exception:
        for _name, descriptor, _opened in opened_files:
            os.close(descriptor)
        raise


def _copy_open_regular_file(
    source: HeldDirectory,
    destination: HeldDirectory,
    opened_file: OpenedRegularFile,
    output_flags: int,
) -> None:
    name, source_descriptor, opened = opened_file
    key = f"{destination.namespace}:{name}"
    destination.budget.account_staging_member(key, 0, depth=1)
    try:
        output_descriptor = os.open(
            name,
            output_flags,
            0o600,
            dir_fd=destination.descriptor,
        )
    except OSError as exc:
        raise ValidationError(f"cannot create diagnostic copy member {name}") from exc
    try:
        while True:
            source.budget.checkpoint(depth=1)
            chunk = os.read(source_descriptor, _COPY_CHUNK_BYTES)
            if not chunk:
                break
            _write_all(
                output_descriptor,
                chunk,
                budget=destination.budget,
                staging_key=key,
                depth=1,
            )
        os.fchmod(output_descriptor, 0o600)
        os.fsync(output_descriptor)
        output_stat = os.fstat(output_descriptor)
        output_bound = _stat_member_at(destination.descriptor, name, "diagnostic copy member")
        _require_same_identity(
            output_bound,
            output_stat,
            "diagnostic copy member changed while writing",
        )
    finally:
        os.close(output_descriptor)
    _require_same_identity(
        os.fstat(source_descriptor),
        opened,
        f"recovery source member {name} changed while copying",
    )
    rebound = _stat_member_at(source.descriptor, name, f"recovery source member {name}")
    _require_same_identity(rebound, opened, f"recovery source member {name} changed while copying")


def copy_named_regular_files(
    source: HeldDirectory,
    destination: HeldDirectory,
    names: tuple[str, ...],
    *,
    account_as_input: bool,
    expected: Mapping[str, FileIdentity] | None = None,
) -> tuple[str, ...]:
    """Copy selected regular files between held directories without path lookup."""

    _, regular_flags = _descriptor_filesystem_flags()
    opened_files = _open_named_regular_files(
        source,
        names,
        expected,
        account_as_input=account_as_input,
        regular_flags=regular_flags,
    )
    output_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | (regular_flags & ~(os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)))
    )
    try:
        for opened_file in opened_files:
            _copy_open_regular_file(source, destination, opened_file, output_flags)
        return tuple(name for name, _descriptor, _opened in opened_files)
    finally:
        for _name, descriptor, _opened in opened_files:
            os.close(descriptor)


def account_staging_tree(directory: HeldDirectory) -> None:
    """Measure generated staging after each bounded external-library step."""

    directory_flags, _ = _descriptor_filesystem_flags()

    def visit(fd: int, opened: os.stat_result, relative: Path, depth: int) -> None:
        directory.budget.checkpoint(depth=depth)
        for name in _list_directory_names(fd, "recovery staging"):
            child = Path(name) if relative == Path(".") else relative / name
            child_stat = _stat_member_at(fd, name, "recovery staging member")
            key = f"{directory.namespace}:{child.as_posix()}"
            if stat.S_ISREG(child_stat.st_mode) and not stat.S_ISLNK(child_stat.st_mode):
                directory.budget.account_staging_member(key, child_stat.st_size, depth=depth + 1)
                continue
            if stat.S_ISDIR(child_stat.st_mode) and not stat.S_ISLNK(child_stat.st_mode):
                directory.budget.account_staging_member(key, 0, depth=depth + 1)
                child_fd, child_opened = _open_directory_at(
                    fd, name, child_stat, "recovery staging member", directory_flags
                )
                try:
                    visit(child_fd, child_opened, child, depth + 1)
                finally:
                    os.close(child_fd)
                continue
            raise ValidationError("recovery staging contains a symlink or special file")
        _require_same_identity(os.fstat(fd), opened, "recovery staging changed while measuring")

    root_stat = os.fstat(directory.descriptor)
    _require_same_file_object(root_stat, directory.identity, "held recovery staging changed")
    visit(directory.descriptor, root_stat, Path("."), 0)


def _rename_no_replace_at(
    source_parent: int,
    source_name: str,
    destination_parent: int,
    destination_name: str,
) -> None:
    """Atomically rename names under held descriptors without replacement."""

    _validate_member_name(source_name)
    _validate_member_name(destination_name)
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise ValidationError("race-safe recovery swap requires renameat2 support")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        source_parent,
        os.fsencode(source_name),
        destination_parent,
        os.fsencode(destination_name),
        _RENAME_NOREPLACE,
    )
    error_number = ctypes.get_errno()
    if result == 0:
        return
    if error_number == errno.EEXIST:
        raise ValidationError(f"refusing to replace recovery name: {destination_name}")
    raise OSError(error_number, os.strerror(error_number), destination_name)


RenameAt = Callable[[int, str, int, str], None]


def _name_has_identity(parent: int, name: str, expected: FileIdentity) -> bool:
    actual = _stat_member_at_optional(parent, name)
    return actual is not None and _same_file_object(actual, expected)


def _held_original_identity(
    source: RecoverySource,
    source_snapshot: SourceSnapshot,
) -> FileIdentity:
    if source.target != source_snapshot.target:
        raise ValidationError("source snapshot is not bound to this recovery source")
    held_original = FileIdentity.from_stat(os.fstat(source.root.descriptor))
    _require_same_directory_after_rename(
        held_original,
        source_snapshot.root_identity,
        "held original source identity changed after parking",
    )
    return held_original


def _validate_backup_evidence(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    source_snapshot: SourceSnapshot,
) -> BackupEvidence:
    """Validate and capture the exact parked original under the held attempt fd."""

    parent_stat = os.fstat(attempt.root_handle.descriptor)
    _require_same_file_object(
        parent_stat,
        attempt.root_handle.identity,
        "held recovery attempt root changed",
    )
    held_original = _held_original_identity(source, source_snapshot)
    parked = _stat_member_at(
        attempt.root_handle.descriptor,
        attempt.backup.name,
        "parked recovery source",
    )
    _require_same_identity(
        parked,
        held_original,
        "parked original name changed after verification",
    )
    return BackupEvidence(
        advisory_path=attempt.backup,
        name=attempt.backup.name,
        parent_identity=FileIdentity.from_stat(parent_stat),
        original_identity=source_snapshot.root_identity,
        parked_identity=FileIdentity.from_stat(parked),
    )


def _safe_backup_evidence(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    source_snapshot: SourceSnapshot,
) -> BackupEvidence | None:
    try:
        return _validate_backup_evidence(source, attempt, source_snapshot)
    except Exception:
        return None


def _undo_moved_candidate(
    source_parent: int,
    source_name: str,
    destination_parent: int,
    destination_name: str,
    moved_identity: FileIdentity,
    rename_at: RenameAt,
) -> bool:
    """Undo our rename only while its exact candidate and empty source remain."""

    if _stat_member_at_optional(source_parent, source_name) is not None:
        return False
    destination = _stat_member_at_optional(destination_parent, destination_name)
    if destination is None or FileIdentity.from_stat(destination) != moved_identity:
        return False
    try:
        rename_at(
            destination_parent,
            destination_name,
            source_parent,
            source_name,
        )
    except Exception:
        return False
    restored = _stat_member_at_optional(source_parent, source_name)
    return restored is not None and _same_directory_after_rename(restored, moved_identity)


def _move_directory_identity_bound(
    source_parent: int,
    source_name: str,
    destination_parent: int,
    destination_name: str,
    expected: FileIdentity,
    field: str,
    rename_at: RenameAt,
) -> FileIdentity:
    """Move one exact directory without replacement and check the rename cliff."""

    candidate = _stat_member_at(source_parent, source_name, field)
    _require_same_identity(candidate, expected, f"{field} identity changed before rollback")
    rename_at(source_parent, source_name, destination_parent, destination_name)
    moved = _stat_member_at(destination_parent, destination_name, field)
    moved_identity = FileIdentity.from_stat(moved)
    if not _same_directory_after_rename(moved_identity, expected):
        _undo_moved_candidate(
            source_parent,
            source_name,
            destination_parent,
            destination_name,
            moved_identity,
            rename_at,
        )
        raise ValidationError(f"{field} identity changed at rollback rename cliff")
    return moved_identity


def _restore_original(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    source_snapshot: SourceSnapshot,
    rename_at: RenameAt,
) -> None:
    """Restore only exact descriptor-bound names; never move a raced replacement."""

    source.budget.checkpoint()
    _require_same_file_object(
        os.fstat(source.parent.descriptor),
        source.parent.identity,
        "held recovery source parent changed before rollback",
    )
    _validate_backup_evidence(source, attempt, source_snapshot)
    current = _stat_member_at_optional(source.parent.descriptor, source.source_name)
    if current is None:
        held_original = _held_original_identity(source, source_snapshot)
        _move_directory_identity_bound(
            attempt.root_handle.descriptor,
            attempt.backup.name,
            source.parent.descriptor,
            source.source_name,
            held_original,
            "parked original",
            rename_at,
        )
    else:
        held_stage = FileIdentity.from_stat(os.fstat(attempt.staging_handle.descriptor))
        _require_same_file_object(
            held_stage,
            attempt.staging_handle.identity,
            "held recovery staging identity changed before rollback",
        )
        _require_same_identity(
            current,
            held_stage,
            "installed stage identity changed before rollback",
        )
        if (
            _stat_member_at_optional(
                attempt.root_handle.descriptor,
                attempt.failed_swap.name,
            )
            is not None
        ):
            raise ValidationError("failed-swap evidence name is already occupied")
        parked_stage = _move_directory_identity_bound(
            source.parent.descriptor,
            source.source_name,
            attempt.root_handle.descriptor,
            attempt.failed_swap.name,
            held_stage,
            "installed stage",
            rename_at,
        )
        try:
            _validate_backup_evidence(source, attempt, source_snapshot)
            held_original = _held_original_identity(source, source_snapshot)
            _move_directory_identity_bound(
                attempt.root_handle.descriptor,
                attempt.backup.name,
                source.parent.descriptor,
                source.source_name,
                held_original,
                "parked original",
                rename_at,
            )
        except Exception as restore_error:
            try:
                _move_directory_identity_bound(
                    attempt.root_handle.descriptor,
                    attempt.failed_swap.name,
                    source.parent.descriptor,
                    source.source_name,
                    parked_stage,
                    "parked failed stage",
                    rename_at,
                )
            except Exception as stage_error:
                raise ValidationError(
                    "original restore failed and exact installed stage could not be recovered"
                ) from stage_error
            raise restore_error

    rebound = _stat_member_at(source.parent.descriptor, source.source_name, "restored source")
    held_original = FileIdentity.from_stat(os.fstat(source.root.descriptor))
    _require_same_identity(rebound, held_original, "rollback restored the wrong source")
    _require_same_directory_after_rename(
        held_original,
        source_snapshot.root_identity,
        "rollback restored a changed original source",
    )


def _rollback_after_failure(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    snapshot: SourceSnapshot,
    rename_at: RenameAt,
    *,
    phase: str,
    cause: Exception,
    event_errors: list[str],
) -> RecoverySwapError:
    try:
        _restore_original(source, attempt, snapshot, rename_at)
        assert_source_unchanged(source, snapshot, allow_root_rename=True)
    except Exception as rollback_error:
        event_error = _safe_record_attempt_event(attempt, "rollback-failed", {"phase": phase})
        if event_error is not None:
            event_errors.append(event_error)
        return RecoverySwapError(
            f"{phase} failed and rollback failed: {type(rollback_error).__name__}",
            rollback_succeeded=False,
            backup=_safe_backup_evidence(source, attempt, snapshot),
            failed_swap_advisory=attempt.failed_swap,
            event_errors=tuple(event_errors),
        )
    event_error = _safe_record_attempt_event(attempt, "rollback-complete", {"phase": phase})
    if event_error is not None:
        event_errors.append(event_error)
    return RecoverySwapError(
        f"{phase} failed; original restored: {type(cause).__name__}",
        rollback_succeeded=True,
        backup=_safe_backup_evidence(source, attempt, snapshot),
        failed_swap_advisory=attempt.failed_swap,
        event_errors=tuple(event_errors),
    )


def _restore_wrong_cliff_candidate(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    rename_at: RenameAt,
    moved_identity: FileIdentity,
) -> bool:
    """Restore the pre-cliff name only when both names remain unambiguous."""

    if _stat_member_at_optional(source.parent.descriptor, source.source_name) is not None:
        return False
    if not _name_has_identity(
        attempt.root_handle.descriptor,
        attempt.backup.name,
        moved_identity,
    ):
        return False
    try:
        rename_at(
            attempt.root_handle.descriptor,
            attempt.backup.name,
            source.parent.descriptor,
            source.source_name,
        )
    except Exception:
        return False
    return _name_has_identity(source.parent.descriptor, source.source_name, moved_identity)


def _validate_parked_source_cliff(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    source_snapshot: SourceSnapshot,
    rename_at: RenameAt,
) -> None:
    moved_stat = _stat_member_at(
        attempt.root_handle.descriptor,
        attempt.backup.name,
        "parked recovery source",
    )
    moved_identity = FileIdentity.from_stat(moved_stat)
    if not _same_directory_after_rename(moved_identity, source_snapshot.root_identity):
        restored = _restore_wrong_cliff_candidate(
            source,
            attempt,
            rename_at,
            moved_identity,
        )
        event_errors: list[str] = []
        event_error = _safe_record_attempt_event(
            attempt,
            "source-cliff-mismatch",
            {"candidate_restored": restored},
        )
        if event_error is not None:
            event_errors.append(event_error)
        raise RecoverySwapError(
            "source identity changed at atomic rename cliff",
            rollback_succeeded=restored,
            backup=_safe_backup_evidence(source, attempt, source_snapshot),
            failed_swap_advisory=attempt.failed_swap,
            event_errors=tuple(event_errors),
        )
    _require_same_directory_after_rename(
        os.fstat(source.root.descriptor),
        source_snapshot.root_identity,
        "held source changed after parking",
    )


def _validate_swap_success_boundary(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    source_snapshot: SourceSnapshot,
) -> BackupEvidence:
    """Bind both installed names to held identities immediately before success."""

    source.budget.checkpoint()
    _require_same_file_object(
        os.fstat(source.parent.descriptor),
        source.parent.identity,
        "held recovery source parent changed after verification",
    )
    held_stage = FileIdentity.from_stat(os.fstat(attempt.staging_handle.descriptor))
    _require_same_file_object(
        held_stage,
        attempt.staging_handle.identity,
        "held recovery staging identity changed after verification",
    )
    installed = _stat_member_at(
        source.parent.descriptor,
        source.source_name,
        "installed recovery source",
    )
    _require_same_identity(
        installed,
        held_stage,
        "installed recovery source name changed after verification",
    )
    return _validate_backup_evidence(source, attempt, source_snapshot)


def swap_staged_palace(
    source: RecoverySource,
    attempt: RecoveryAttempt,
    source_snapshot: SourceSnapshot,
    verify_swapped: Callable[[HeldDirectory], VerificationResult],
    *,
    rename: RenameAt | None = None,
) -> SwapResult:
    """Park, install, verify, and on failure restore using held descriptors.

    The first no-replace rename is followed immediately by an inode postcondition.
    Only when the name moved at that atomic rename cliff is the exact inspected
    source inode may staging be installed.  A mismatch is moved back when safe and
    the operation fails closed without reading or copying the raced entry.
    """

    rename_at = rename if rename is not None else _rename_no_replace_at
    revalidate_source_binding(source, source_snapshot)
    account_staging_tree(attempt.staging_handle)
    _require_same_file_object(
        os.fstat(attempt.root_handle.descriptor),
        attempt.root_handle.identity,
        "held recovery attempt root changed",
    )
    staging_name = attempt.staging.name
    if not _name_has_identity(
        attempt.root_handle.descriptor,
        staging_name,
        attempt.staging_handle.identity,
    ):
        raise ValidationError("recovery staging name changed before swap")
    if (
        _stat_member_at_optional(attempt.root_handle.descriptor, attempt.backup.name) is not None
        or _stat_member_at_optional(attempt.root_handle.descriptor, attempt.failed_swap.name)
        is not None
    ):
        raise ValidationError("recovery attempt backup identities must be unused")
    _record_attempt_event(attempt, "swap-started")

    rename_at(
        source.parent.descriptor,
        source.source_name,
        attempt.root_handle.descriptor,
        attempt.backup.name,
    )
    event_errors: list[str] = []
    try:
        _validate_parked_source_cliff(source, attempt, source_snapshot, rename_at)
    except RecoverySwapError:
        raise
    except Exception as park_error:
        raise _rollback_after_failure(
            source,
            attempt,
            source_snapshot,
            rename_at,
            phase="source park postcondition",
            cause=park_error,
            event_errors=event_errors,
        ) from park_error

    try:
        _record_attempt_event(attempt, "source-parked")
        rename_at(
            attempt.root_handle.descriptor,
            staging_name,
            source.parent.descriptor,
            source.source_name,
        )
        installed = _stat_member_at(
            source.parent.descriptor,
            source.source_name,
            "installed recovery stage",
        )
        _require_same_file_object(
            installed,
            attempt.staging_handle.identity,
            "wrong staging identity installed at rename cliff",
        )
        _record_attempt_event(attempt, "stage-installed")
        source.budget.checkpoint()
        verification = verify_swapped(attempt.staging_handle)
        source.budget.checkpoint()
        if not verification.ok:
            raise RuntimeError(verification.detail)
        backup = _validate_swap_success_boundary(source, attempt, source_snapshot)
        _record_attempt_event(attempt, "swap-verified", {"detail": verification.detail})
        backup = _validate_swap_success_boundary(source, attempt, source_snapshot)
    except Exception as swap_error:
        raise _rollback_after_failure(
            source,
            attempt,
            source_snapshot,
            rename_at,
            phase="post-park swap/verification",
            cause=swap_error,
            event_errors=event_errors,
        ) from swap_error

    return SwapResult(backup=backup, verification=verification)


def _remove_directory_contents(descriptor: int) -> None:
    directory_flags, _ = _descriptor_filesystem_flags()
    for name in _list_directory_names(descriptor, "private recovery scratch"):
        child_stat = _stat_member_at(descriptor, name, "private recovery scratch member")
        if stat.S_ISDIR(child_stat.st_mode) and not stat.S_ISLNK(child_stat.st_mode):
            child_descriptor, opened = _open_directory_at(
                descriptor,
                name,
                child_stat,
                "private recovery scratch member",
                directory_flags,
            )
            try:
                _remove_directory_contents(child_descriptor)
            finally:
                os.close(child_descriptor)
            rebound = _stat_member_at_optional(descriptor, name)
            if rebound is not None and FileIdentity.from_stat(rebound) == FileIdentity.from_stat(
                opened
            ):
                os.rmdir(name, dir_fd=descriptor)
            continue
        os.unlink(name, dir_fd=descriptor)


@contextmanager
def private_scratch_directory(
    budget: RecoveryBudget,
    *,
    prefix: str,
) -> Iterator[ScratchDirectory]:
    """Yield a private scratch directory held independently of its pathname."""

    if not prefix or not prefix.replace("-", "").isalnum():
        raise ValidationError("scratch prefix must be a simple identifier")
    temporary_root = Path(tempfile.gettempdir())
    temporary_chain = _open_absolute_directory_chain(temporary_root, "temporary root")
    parent_descriptor = temporary_chain.retain_last()
    try:
        name, handle = _create_unique_directory_at(
            parent_descriptor,
            f"penny-{prefix}-",
            "private recovery scratch",
            budget,
            f"scratch-{prefix}",
        )
    except Exception:
        os.close(parent_descriptor)
        raise
    scratch = ScratchDirectory(parent_descriptor, name, handle)
    try:
        yield scratch
    finally:
        scratch.close()
