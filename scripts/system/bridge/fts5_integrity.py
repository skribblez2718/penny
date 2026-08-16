"""Receipt-gated SQLite/FTS5 integrity inspection on a disposable copy.

The SQLite connection used for schema enumeration, ``PRAGMA quick_check``, and
FTS5 ``integrity-check`` commands is opened only against a temporary physical
copy.  The authorized source database is read as bytes for copying and hashing;
it is never opened by SQLite and is never mutated by this probe.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from scripts.system.memory.offline_access import OfflineAuthorization, authorize_offline_target

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
            "content_included": False,
        }


def _sqlite_error_name(error: sqlite3.Error) -> str:
    name = getattr(error, "sqlite_errorname", None)
    return str(name) if name else type(error).__name__


def _is_corruption_error(error: sqlite3.Error) -> bool:
    code = getattr(error, "sqlite_errorcode", None)
    return isinstance(code, int) and code & 0xFF == sqlite3.SQLITE_CORRUPT


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_snapshot(database: Path) -> dict[str, str]:
    snapshot: dict[str, str] = {}
    for suffix in SQLITE_SIDECAR_SUFFIXES:
        candidate = database.with_name(database.name + suffix)
        if not candidate.exists():
            continue
        if candidate.is_symlink() or not candidate.is_file():
            raise OSError(f"SQLite source member is not a regular file: {candidate.name}")
        snapshot[candidate.name] = _sha256(candidate)
    return snapshot


def _copy_sqlite_family(database: Path, destination: Path) -> None:
    destination.mkdir(mode=0o700, exist_ok=True)
    for suffix in SQLITE_SIDECAR_SUFFIXES:
        source = database.with_name(database.name + suffix)
        if not source.exists():
            continue
        if source.is_symlink() or not source.is_file():
            raise OSError(f"SQLite source member is not a regular file: {source.name}")
        shutil.copy2(source, destination / source.name, follow_symlinks=False)


def _quote_identifier(identifier: str) -> str:
    """Quote one schema-derived SQLite identifier without treating it as SQL."""

    if "\x00" in identifier:
        raise ValueError("SQLite identifier contains NUL")
    return '"' + identifier.replace('"', '""') + '"'


def _enumerate_fts5_tables(connection: sqlite3.Connection) -> tuple[str, ...]:
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master " "WHERE type = ? AND sql IS NOT NULL ORDER BY name",
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


def _probe_temporary_database(database: Path) -> tuple[tuple[str, ...], list[IntegrityFinding]]:
    findings: list[IntegrityFinding] = []
    with sqlite3.connect(database, isolation_level=None) as connection:
        tables = _enumerate_fts5_tables(connection)
        for table in tables:
            finding = _fts5_finding(connection, table)
            if finding is not None:
                findings.append(finding)

        corrupt_tables = {
            finding.table
            for finding in findings
            if finding.code is FindingCode.FTS5_INDEX_CORRUPT and finding.table is not None
        }
        try:
            quick_check_rows = connection.execute("PRAGMA quick_check").fetchall()
        except sqlite3.Error as error:
            findings.append(
                IntegrityFinding(
                    code=FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
                    classification=FindingClass.UNCLASSIFIED,
                    sqlite_error_name=_sqlite_error_name(error),
                )
            )
        else:
            for row in quick_check_rows:
                message = str(row[0]) if row else ""
                if message.lower() == "ok":
                    continue
                if _known_fts5_quick_check_error(message, corrupt_tables):
                    continue
                findings.append(
                    IntegrityFinding(
                        code=FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
                        classification=FindingClass.UNCLASSIFIED,
                    )
                )
    return tables, findings


def probe_authorized_database(authorization: OfflineAuthorization) -> IntegrityReport:
    """Inspect the receipt-authorized SQLite database only through a temp copy."""

    database = authorization.target / DATABASE_NAME
    if not database.exists():
        finding = IntegrityFinding(
            code=FindingCode.DATABASE_MISSING,
            classification=FindingClass.UNCLASSIFIED,
        )
        return IntegrityReport(sqlite3.sqlite_version, (), (finding,), True)

    try:
        before = _source_snapshot(database)
    except OSError:
        finding = IntegrityFinding(
            code=FindingCode.PROBE_UNAVAILABLE,
            classification=FindingClass.UNCLASSIFIED,
        )
        return IntegrityReport(sqlite3.sqlite_version, (), (finding,), False)

    tables: tuple[str, ...] = ()
    findings: list[IntegrityFinding] = []
    try:
        with tempfile.TemporaryDirectory(prefix="penny-fts5-integrity-") as temporary:
            temporary_root = Path(temporary)
            _copy_sqlite_family(database, temporary_root)
            tables, findings = _probe_temporary_database(temporary_root / DATABASE_NAME)
    except sqlite3.Error as error:
        findings.append(
            IntegrityFinding(
                code=FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
                classification=FindingClass.UNCLASSIFIED,
                sqlite_error_name=_sqlite_error_name(error),
            )
        )
    except (OSError, ValueError):
        findings.append(
            IntegrityFinding(
                code=FindingCode.PROBE_UNAVAILABLE,
                classification=FindingClass.UNCLASSIFIED,
            )
        )

    try:
        unchanged = before == _source_snapshot(database)
    except OSError:
        unchanged = False
    if not unchanged:
        findings.append(
            IntegrityFinding(
                code=FindingCode.SOURCE_CHANGED,
                classification=FindingClass.UNCLASSIFIED,
            )
        )
    return IntegrityReport(
        sqlite_version=sqlite3.sqlite_version,
        fts5_tables=tables,
        findings=tuple(findings),
        source_bytes_unchanged=unchanged,
    )


def probe_offline_database(offline_target: Path, receipt: Path) -> IntegrityReport:
    """Authorize one copied target, then run the temporary-copy integrity probe."""

    authorization = authorize_offline_target(offline_target, receipt)
    return probe_authorized_database(authorization)
