"""Pytest plugin that atomically records node-level execution evidence.

Loaded only by ``check_compliance.py``. The compliance owner independently
inventories filesystem-owned test files and treats every report field as
untrusted input.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final, Literal, Sequence

from _pytest.main import Session
from _pytest.nodes import Item
from _pytest.reports import CollectReport, TestReport

REPORT_PATH_ENV: Final = "PENNY_PYTEST_EXECUTION_REPORT"
PROJECT_ROOT_ENV: Final = "PENNY_PYTEST_PROJECT_ROOT"
SCHEMA_ID: Final = "penny.pytest-execution-evidence.v2"
MAX_DIAGNOSTIC_CHARS: Final = 4096

Phase = Literal["setup", "call", "teardown"]
TerminalPhase = Literal["setup", "call"]
TerminalOutcomeName = Literal["passed", "failed", "skipped", "xfailed", "xpassed"]


@dataclass(frozen=True)
class NodeReference:
    nodeId: str
    file: str


@dataclass(frozen=True)
class TerminalOutcome:
    nodeId: str
    file: str
    phase: TerminalPhase
    outcome: TerminalOutcomeName
    reason: str | None
    reasonTruncated: bool


@dataclass(frozen=True)
class PhaseFailure:
    nodeId: str
    file: str
    phase: Phase


@dataclass(frozen=True)
class CollectionIssue:
    nodeId: str
    file: str | None
    message: str
    messageTruncated: bool


_collected_by_nodeid: dict[str, str] = {}
_collected_files: set[str] = set()
_deselected_by_nodeid: dict[str, str] = {}
_terminal_by_nodeid: dict[str, TerminalOutcome] = {}
_phase_failures: set[PhaseFailure] = set()
_collection_errors: list[CollectionIssue] = []
_collection_skips: list[CollectionIssue] = []
_failed_files: set[str] = set()
_collection_complete = False
_collection_truncated = False


def _project_root() -> Path:
    configured = os.environ.get(PROJECT_ROOT_ENV)
    if configured is None or not configured.strip():
        raise RuntimeError(f"{PROJECT_ROOT_ENV} is required")
    return Path(configured).resolve()


def _absolute_file(value: object) -> str | None:
    if not isinstance(value, (str, os.PathLike)):
        return None
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = _project_root() / candidate
    return str(candidate.resolve())


def _nodeid_file(nodeid: str) -> str | None:
    relative = nodeid.partition("::")[0]
    if not relative.endswith(".py"):
        return None
    return _absolute_file(relative)


def _bounded(value: str) -> tuple[str, bool]:
    if len(value) <= MAX_DIAGNOSTIC_CHARS:
        return value, False
    return value[:MAX_DIAGNOSTIC_CHARS], True


def _skip_reason(report: CollectReport | TestReport) -> tuple[str, bool]:
    was_xfail = getattr(report, "wasxfail", None)
    if isinstance(was_xfail, str) and was_xfail.strip():
        return _bounded(was_xfail.strip())

    longrepr = report.longrepr
    if isinstance(longrepr, tuple) and len(longrepr) >= 3 and isinstance(longrepr[2], str):
        reason = longrepr[2].strip()
    else:
        reason = report.longreprtext.strip()
    for prefix in ("Skipped: ", "XFailed: "):
        if reason.startswith(prefix):
            reason = reason.removeprefix(prefix).strip()
    return _bounded(reason or "pytest supplied no reason")


def _collection_issue(report: CollectReport) -> CollectionIssue:
    message, truncated = _bounded(report.longreprtext.strip() or report.outcome)
    return CollectionIssue(
        nodeId=report.nodeid or "<collection-root>",
        file=_nodeid_file(report.nodeid),
        message=message,
        messageTruncated=truncated,
    )


def _terminal_outcome(report: TestReport, file_path: str) -> TerminalOutcome | None:
    if report.when == "setup" and report.passed:
        return None
    if report.when == "teardown":
        return None

    reason: str | None = None
    reason_truncated = False
    was_xfail = getattr(report, "wasxfail", None)
    strict_xpass = (
        report.when == "call" and report.failed and "[XPASS(strict)]" in report.longreprtext
    )

    if isinstance(was_xfail, str) and report.skipped:
        outcome: TerminalOutcomeName = "xfailed"
        reason, reason_truncated = _bounded(was_xfail.strip() or "pytest supplied no reason")
    elif isinstance(was_xfail, str) and report.passed:
        outcome = "xpassed"
        reason, reason_truncated = _bounded(was_xfail.strip() or "pytest supplied no reason")
    elif strict_xpass:
        outcome = "xpassed"
        marker = report.longreprtext.partition("[XPASS(strict)]")[2].strip()
        reason, reason_truncated = _bounded(marker or "pytest supplied no reason")
    elif report.skipped:
        outcome = "skipped"
        reason, reason_truncated = _skip_reason(report)
    elif report.failed:
        outcome = "failed"
    else:
        outcome = "passed"

    phase: TerminalPhase = "call" if report.when == "call" else "setup"
    return TerminalOutcome(
        nodeId=report.nodeid,
        file=file_path,
        phase=phase,
        outcome=outcome,
        reason=reason,
        reasonTruncated=reason_truncated,
    )


def pytest_sessionstart(session: Session) -> None:
    """Reset process-local evidence before collection begins."""

    del session
    global _collection_complete, _collection_truncated
    _collected_by_nodeid.clear()
    _collected_files.clear()
    _deselected_by_nodeid.clear()
    _terminal_by_nodeid.clear()
    _phase_failures.clear()
    _collection_errors.clear()
    _collection_skips.clear()
    _failed_files.clear()
    _collection_complete = False
    _collection_truncated = False


def pytest_collectreport(report: CollectReport) -> None:
    """Record Python collection files and every collection skip or error."""

    file_path = _nodeid_file(report.nodeid)
    if file_path is not None:
        _collected_files.add(file_path)
    if report.failed:
        issue = _collection_issue(report)
        _collection_errors.append(issue)
        if issue.file is not None:
            _failed_files.add(issue.file)
    elif report.skipped:
        reason, truncated = _skip_reason(report)
        _collection_skips.append(
            CollectionIssue(
                nodeId=report.nodeid or "<collection-root>",
                file=file_path,
                message=reason,
                messageTruncated=truncated,
            )
        )


def pytest_deselected(items: Sequence[Item]) -> None:
    """Retain items removed by selectors as explicit non-execution evidence."""

    for item in items:
        file_path = _absolute_file(item.path)
        if file_path is None:
            continue
        _collected_files.add(file_path)
        _collected_by_nodeid[item.nodeid] = file_path
        _deselected_by_nodeid[item.nodeid] = file_path


def pytest_collection_finish(session: Session) -> None:
    """Capture selected items and whether collection reached a terminal boundary."""

    global _collection_complete, _collection_truncated
    for item in session.items:
        file_path = _absolute_file(item.path)
        if file_path is not None:
            _collected_files.add(file_path)
            _collected_by_nodeid[item.nodeid] = file_path
    _collection_complete = True
    _collection_truncated = bool(session.shouldfail or session.shouldstop)


def pytest_runtest_logreport(report: TestReport) -> None:
    """Record terminal setup/call outcomes and failures from every phase."""

    file_path = _collected_by_nodeid.get(report.nodeid) or _nodeid_file(report.nodeid)
    if file_path is None:
        return
    _collected_files.add(file_path)
    _collected_by_nodeid[report.nodeid] = file_path

    if report.failed:
        phase: Phase = report.when
        _phase_failures.add(PhaseFailure(report.nodeid, file_path, phase))
        _failed_files.add(file_path)

    terminal = _terminal_outcome(report, file_path)
    if terminal is not None:
        _terminal_by_nodeid[report.nodeid] = terminal


def _write_atomic(report_path: Path, payload: dict[str, object]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{report_path.name}.", suffix=".tmp", dir=report_path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, report_path)
    finally:
        temporary.unlink(missing_ok=True)


def pytest_sessionfinish(session: Session, exitstatus: int) -> None:
    """Publish one complete or explicitly incomplete structured report."""

    del session
    configured = os.environ.get(REPORT_PATH_ENV)
    if configured is None or not configured.strip():
        raise RuntimeError(f"{REPORT_PATH_ENV} is required")

    expected_nodes = [
        NodeReference(node_id, file_path)
        for node_id, file_path in sorted(_collected_by_nodeid.items())
    ]
    terminal_outcomes = sorted(_terminal_by_nodeid.values(), key=lambda item: item.nodeId)
    executed_files = sorted(
        {
            item.file
            for item in terminal_outcomes
            if item.phase == "call" and item.outcome != "skipped"
        }
    )
    status = int(exitstatus)
    payload: dict[str, object] = {
        "schemaId": SCHEMA_ID,
        "schemaVersion": 2,
        "complete": (_collection_complete and not _collection_truncated and status in (0, 1, 5)),
        "pytestExitStatus": status,
        "collectionComplete": _collection_complete,
        "collectionTruncated": _collection_truncated or not _collection_complete,
        "expectedFiles": sorted(_collected_files),
        "executedFiles": executed_files,
        "failedFiles": sorted(_failed_files),
        "expectedNodes": [asdict(item) for item in expected_nodes],
        "terminalOutcomes": [asdict(item) for item in terminal_outcomes],
        "phaseFailures": [
            asdict(item)
            for item in sorted(_phase_failures, key=lambda item: (item.nodeId, item.phase))
        ],
        "deselectedNodes": [
            asdict(NodeReference(node_id, file_path))
            for node_id, file_path in sorted(_deselected_by_nodeid.items())
        ],
        "collectionErrors": [asdict(item) for item in _collection_errors],
        "collectionSkips": [asdict(item) for item in _collection_skips],
    }
    _write_atomic(Path(configured), payload)
