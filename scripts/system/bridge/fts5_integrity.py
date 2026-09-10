"""Receipt-gated SQLite/FTS5 integrity inspection on a bounded private copy.

The authorized source directory and every SQLite-family source file are accessed
through descriptors retained from authorization.  SQLite itself opens only a
fresh private descriptor-rooted scratch copy; it never opens or mutates the
receipt-authorized database.  ``open_authorized_recovery`` retains the
validated descriptors while delegating receipt semantics to
``authorize_offline_target``.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from scripts.system.bridge.recovery_safety import (
    FileIdentity,
    HeldDirectory,
    RecoveryBudget,
    RecoveryRefusal,
    RecoverySource,
    SourceSnapshot,
    account_staging_tree,
    assert_source_unchanged,
    copy_named_regular_files,
    hold_private_regular_file,
    open_authorized_recovery,
    private_scratch_directory,
    snapshot_source_tree,
)
from scripts.system.memory.common import ValidationError

DATABASE_NAME = "chroma.sqlite3"
SQLITE_SIDECAR_SUFFIXES = ("", "-wal", "-shm")
FTS5_INTEGRITY_COMMAND = "integrity-check"
FTS5_EXTERNAL_CONTENT_CHECK = 1

_CREATE_FTS5_RE = re.compile(
    r"""
    \ACREATE\s+VIRTUAL\s+TABLE\s+
    (?:IF\s+NOT\s+EXISTS\s+)?
    (?:
        "(?:""|[^"])*"
        | '(?:''|[^'])*'
        | `(?:``|[^`])*`
        | \[(?:\]\]|[^\]])*\]
        | [^\s]+
    )
    \s+USING\s+fts5\s*\(
    """,
    re.IGNORECASE | re.VERBOSE,
)
_FTS5_QUICK_CHECK_MARKERS = (
    "malformed inverted index for fts5 table",
    "fts5: corruption found",
)


class FindingCode(str, Enum):
    """Stable machine-facing integrity finding codes."""

    FTS5_INDEX_CORRUPT = "fts5-index-corrupt"
    SQLITE_CORRUPTION_UNCLASSIFIED = "sqlite-corruption-unclassified"
    PROBE_UNAVAILABLE = "integrity-probe-unavailable"
    DATABASE_MISSING = "sqlite-database-missing"
    SOURCE_CHANGED = "source-bytes-changed-during-probe"


class FindingClass(str, Enum):
    """Repair classification applied to a finding."""

    FTS5_INDEX = "fts5-index-corruption"
    UNCLASSIFIED = "unclassified-corruption"


@dataclass(frozen=True)
class IntegrityFinding:
    """Content-free description of one integrity failure."""

    code: FindingCode
    classification: FindingClass
    table: str | None = None
    sqlite_error_name: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return {
            "code": self.code.value,
            "classification": self.classification.value,
            "table": self.table,
            "sqlite_error_name": self.sqlite_error_name,
        }


@dataclass(frozen=True)
class IntegrityReport:
    """Typed result of inspecting one authorized database via a temp copy."""

    sqlite_version: str
    fts5_tables: tuple[str, ...]
    findings: tuple[IntegrityFinding, ...]
    source_bytes_unchanged: bool

    @property
    def ok(self) -> bool:
        return not self.findings

    @property
    def repair_safe(self) -> bool:
        return all(
            finding.classification is not FindingClass.UNCLASSIFIED for finding in self.findings
        )

    @property
    def corrupt_fts5_tables(self) -> tuple[str, ...]:
        return tuple(
            finding.table
            for finding in self.findings
            if finding.code is FindingCode.FTS5_INDEX_CORRUPT and finding.table is not None
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "probe_type": "temporary-copy-sqlite-fts5-integrity",
            "ok": self.ok,
            "repair_safe": self.repair_safe,
            "sqlite_version": self.sqlite_version,
            "fts5_tables": list(self.fts5_tables),
            "findings": [finding.to_dict() for finding in self.findings],
            "source_bytes_unchanged": self.source_bytes_unchanged,
            "diagnostic_scratch": "fresh-private-descriptor-rooted-sqlite-copy",
            "diagnostic_scratch_retained": False,
            "content_included": False,
        }


def _sqlite_error_name(error: sqlite3.Error) -> str:
    name = getattr(error, "sqlite_errorname", None)
    return str(name) if name else type(error).__name__


def _is_corruption_error(error: sqlite3.Error) -> bool:
    code = getattr(error, "sqlite_errorcode", None)
    return isinstance(code, int) and code & 0xFF == sqlite3.SQLITE_CORRUPT


def _snapshot_family_identities(snapshot: SourceSnapshot) -> dict[str, FileIdentity]:
    family_names = {DATABASE_NAME + suffix for suffix in SQLITE_SIDECAR_SUFFIXES}
    identities: dict[str, FileIdentity] = {}
    for member in snapshot.members:
        if member.relative_path not in family_names:
            continue
        if member.kind != "file":
            raise ValidationError("SQLite source family contains a non-file member")
        identities[member.relative_path] = FileIdentity(
            member.device,
            member.inode,
            member.mode,
            member.size,
            member.modified_ns,
            member.changed_ns,
        )
    return identities


@contextmanager
def materialize_sqlite_family(
    directory: HeldDirectory,
    *,
    expected_snapshot: SourceSnapshot | None = None,
    account_as_input: bool,
) -> Iterator[Path]:
    """Yield a stable path to a private copy made from held source file fds."""

    names = tuple(DATABASE_NAME + suffix for suffix in SQLITE_SIDECAR_SUFFIXES)
    expected = (
        _snapshot_family_identities(expected_snapshot) if expected_snapshot is not None else None
    )
    with private_scratch_directory(directory.budget, prefix="fts5-integrity") as scratch:
        copied = copy_named_regular_files(
            directory,
            scratch.handle,
            names,
            account_as_input=account_as_input,
            expected=expected,
        )
        if DATABASE_NAME not in copied:
            raise FileNotFoundError(DATABASE_NAME)
        account_staging_tree(scratch.handle)
        with hold_private_regular_file(scratch.handle, DATABASE_NAME) as database_descriptor:
            yield Path("/proc/self/fd") / str(database_descriptor)
            directory.budget.checkpoint()
        account_staging_tree(scratch.handle)


@contextmanager
def sqlite_budget_guard(
    connection: sqlite3.Connection,
    budget: RecoveryBudget,
) -> Iterator[None]:
    """Interrupt SQLite VM work when the total deadline/cancellation fires."""

    refusal: list[RecoveryRefusal] = []

    def progress() -> int:
        try:
            budget.checkpoint()
        except RecoveryRefusal as exc:
            refusal.append(exc)
            return 1
        return 0

    budget.checkpoint()
    connection.set_progress_handler(progress, 1_000)
    try:
        yield
    except sqlite3.Error:
        if refusal:
            raise refusal[0]
        raise
    finally:
        connection.set_progress_handler(None, 0)
    if refusal:
        raise refusal[0]
    budget.checkpoint()


def _quote_identifier(identifier: str) -> str:
    """Quote one schema-derived SQLite identifier without treating it as SQL."""

    if "\x00" in identifier:
        raise ValueError("SQLite identifier contains NUL")
    return '"' + identifier.replace('"', '""') + '"'


def _enumerate_fts5_tables(connection: sqlite3.Connection) -> tuple[str, ...]:
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL ORDER BY name",
        ("table",),
    ).fetchall()
    return tuple(
        str(name)
        for name, create_sql in rows
        if isinstance(name, str)
        and isinstance(create_sql, str)
        and _CREATE_FTS5_RE.match(create_sql)
    )


def _fts5_finding(connection: sqlite3.Connection, table: str) -> IntegrityFinding | None:
    identifier = _quote_identifier(table)
    statement = f"INSERT INTO {identifier} ({identifier}, rank) VALUES (?, ?)"
    try:
        connection.execute(
            statement,
            (FTS5_INTEGRITY_COMMAND, FTS5_EXTERNAL_CONTENT_CHECK),
        )
    except sqlite3.Error as error:
        if _is_corruption_error(error):
            return IntegrityFinding(
                code=FindingCode.FTS5_INDEX_CORRUPT,
                classification=FindingClass.FTS5_INDEX,
                table=table,
                sqlite_error_name=_sqlite_error_name(error),
            )
        return IntegrityFinding(
            code=FindingCode.PROBE_UNAVAILABLE,
            classification=FindingClass.UNCLASSIFIED,
            table=table,
            sqlite_error_name=_sqlite_error_name(error),
        )
    return None


def _known_fts5_quick_check_error(message: str, corrupt_tables: set[str]) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _FTS5_QUICK_CHECK_MARKERS) and any(
        table.lower() in lowered for table in corrupt_tables
    )


def _quick_check_findings(
    connection: sqlite3.Connection,
    corrupt_tables: set[str],
) -> list[IntegrityFinding]:
    findings: list[IntegrityFinding] = []
    try:
        rows = connection.execute("PRAGMA quick_check").fetchall()
    except sqlite3.Error as error:
        return [
            IntegrityFinding(
                code=FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
                classification=FindingClass.UNCLASSIFIED,
                sqlite_error_name=_sqlite_error_name(error),
            )
        ]
    for row in rows:
        message = str(row[0]) if row else ""
        if message.lower() == "ok" or _known_fts5_quick_check_error(message, corrupt_tables):
            continue
        findings.append(
            IntegrityFinding(
                code=FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
                classification=FindingClass.UNCLASSIFIED,
            )
        )
    return findings


def _probe_temporary_database(
    database: Path,
    budget: RecoveryBudget,
) -> tuple[tuple[str, ...], list[IntegrityFinding]]:
    findings: list[IntegrityFinding] = []
    budget.checkpoint()
    with sqlite3.connect(database, isolation_level=None) as connection:
        with sqlite_budget_guard(connection, budget):
            tables = _enumerate_fts5_tables(connection)
            for table in tables:
                budget.checkpoint()
                finding = _fts5_finding(connection, table)
                if finding is not None:
                    findings.append(finding)
            corrupt_tables = {
                finding.table
                for finding in findings
                if finding.code is FindingCode.FTS5_INDEX_CORRUPT and finding.table is not None
            }
            findings.extend(_quick_check_findings(connection, corrupt_tables))
    return tables, findings


def _missing_report() -> IntegrityReport:
    finding = IntegrityFinding(
        code=FindingCode.DATABASE_MISSING,
        classification=FindingClass.UNCLASSIFIED,
    )
    return IntegrityReport(sqlite3.sqlite_version, (), (finding,), True)


def probe_database_directory(
    directory: HeldDirectory,
    *,
    expected_snapshot: SourceSnapshot | None = None,
    account_as_input: bool = False,
) -> IntegrityReport:
    """Probe one held directory only through a bounded private SQLite copy."""

    tables: tuple[str, ...] = ()
    findings: list[IntegrityFinding] = []
    try:
        with materialize_sqlite_family(
            directory,
            expected_snapshot=expected_snapshot,
            account_as_input=account_as_input,
        ) as copied_database:
            tables, findings = _probe_temporary_database(copied_database, directory.budget)
    except FileNotFoundError:
        return _missing_report()
    except RecoveryRefusal:
        raise
    except sqlite3.Error as error:
        findings.append(
            IntegrityFinding(
                code=FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
                classification=FindingClass.UNCLASSIFIED,
                sqlite_error_name=_sqlite_error_name(error),
            )
        )
    except (OSError, ValueError, ValidationError):
        findings.append(
            IntegrityFinding(
                code=FindingCode.PROBE_UNAVAILABLE,
                classification=FindingClass.UNCLASSIFIED,
            )
        )
    return IntegrityReport(
        sqlite_version=sqlite3.sqlite_version,
        fts5_tables=tables,
        findings=tuple(findings),
        source_bytes_unchanged=True,
    )


def probe_authorized_database(
    source: RecoverySource,
    snapshot: SourceSnapshot,
) -> IntegrityReport:
    """Inspect an authorized source while retaining its original descriptors."""

    report = probe_database_directory(
        source.root,
        expected_snapshot=snapshot,
        account_as_input=True,
    )
    try:
        assert_source_unchanged(source, snapshot)
    except RecoveryRefusal:
        raise
    except ValidationError:
        changed = IntegrityFinding(
            code=FindingCode.SOURCE_CHANGED,
            classification=FindingClass.UNCLASSIFIED,
        )
        return IntegrityReport(
            report.sqlite_version,
            report.fts5_tables,
            report.findings + (changed,),
            False,
        )
    return report


def probe_offline_database(offline_target: Path, receipt: Path) -> IntegrityReport:
    """Authorize one copied target and run the descriptor-bound integrity probe."""

    with open_authorized_recovery(offline_target, receipt) as source:
        snapshot = snapshot_source_tree(source)
        return probe_authorized_database(source, snapshot)
