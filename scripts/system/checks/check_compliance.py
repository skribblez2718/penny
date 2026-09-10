"""Unified Definition of Done compliance helper.

Runs four substantive repository checks and executes configured Python tests in
isolated suite processes. File and node coverage are verified against an
independent filesystem inventory plus closed pytest lifecycle evidence.

Usage:
    python scripts/system/checks/check_compliance.py
"""

from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from enum import Enum
from pathlib import Path, PureWindowsPath
from typing import Literal, Mapping, Protocol

COMMAND_TIMEOUT_SECONDS = 120
MAX_EXECUTION_EVIDENCE_BYTES = 4 * 1024 * 1024
MAX_EVIDENCE_ENTRIES = 100_000
MAX_NODE_ID_CHARS = 16_384
MAX_DIAGNOSTIC_CHARS = 4096
DEFAULT_PYTHON_FILE_PATTERNS = ("test_*.py", "*_test.py")
EXECUTION_EVIDENCE_SCHEMA_ID = "penny.pytest-execution-evidence.v2"
EXECUTION_EVIDENCE_KEYS = {
    "schemaId",
    "schemaVersion",
    "complete",
    "pytestExitStatus",
    "collectionComplete",
    "collectionTruncated",
    "expectedFiles",
    "executedFiles",
    "failedFiles",
    "expectedNodes",
    "terminalOutcomes",
    "phaseFailures",
    "deselectedNodes",
    "collectionErrors",
    "collectionSkips",
}

Phase = Literal["setup", "call", "teardown"]
TerminalPhase = Literal["setup", "call"]
TerminalOutcomeName = Literal["passed", "failed", "skipped", "xfailed", "xpassed"]

# TypeScript engine model: playbook FSM + tests live in apps/orchestration/.
# Skills carry no executable delegate; per-skill domain tooling remains optional.
SKILL_REQUIRED_FILES = [
    "SKILL.md",
    "README.md",
    "assets/prompts",
    "resources/reference.md",
]

# A flow diagram (state-machine mirror) is required in either format. The newer
# self-contained HTML is standard; the legacy Mermaid file remains accepted.
SKILL_FLOW_DIAGRAM_ANY = [
    "resources/flow.html",
    "resources/flow.mmd",
]


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def succeeded(self) -> bool:
        return self.returncode == 0

    @property
    def combined_output(self) -> str:
        return "\n".join(part.rstrip() for part in (self.stdout, self.stderr) if part.strip())


class CommandRunner(Protocol):
    def __call__(
        self,
        cmd: list[str],
        cwd: str = ".",
        extra_env: Mapping[str, str] | None = None,
    ) -> CommandResult: ...


class OwnershipStatus(Enum):
    APPLICABLE = "applicable"
    NOT_APPLICABLE = "not_applicable"
    MISSING = "missing"


@dataclass(frozen=True)
class TestSuiteOwnership:
    display_path: str
    path: Path | None
    status: OwnershipStatus
    reason: str
    test_files: tuple[Path, ...] = ()


@dataclass(frozen=True)
class AllowedSkip:
    node_id: str
    reason: str


@dataclass(frozen=True)
class NodeReference:
    node_id: str
    file: str


@dataclass(frozen=True)
class TerminalOutcome:
    node_id: str
    file: str
    phase: TerminalPhase
    outcome: TerminalOutcomeName
    reason: str | None
    reason_truncated: bool


@dataclass(frozen=True)
class PhaseFailure:
    node_id: str
    file: str
    phase: Phase


@dataclass(frozen=True)
class CollectionIssue:
    node_id: str
    file: str | None
    message: str
    message_truncated: bool


@dataclass(frozen=True)
class SkipReport:
    node_id: str
    phase: Literal["setup", "call", "collection"]
    reason: str
    reason_truncated: bool
    allowed: bool


@dataclass(frozen=True)
class TestExecutionEvidence:
    complete: bool
    pytest_exit_status: int
    collection_complete: bool
    collection_truncated: bool
    expected_files: tuple[str, ...]
    executed_files: tuple[str, ...]
    failed_files: tuple[str, ...]
    expected_nodes: tuple[NodeReference, ...]
    terminal_outcomes: tuple[TerminalOutcome, ...]
    phase_failures: tuple[PhaseFailure, ...]
    deselected_nodes: tuple[NodeReference, ...]
    collection_errors: tuple[CollectionIssue, ...]
    collection_skips: tuple[CollectionIssue, ...]

    @property
    def collected_tests(self) -> int:
        return len(self.expected_nodes)

    @property
    def executed_tests(self) -> int:
        return sum(
            outcome.phase == "call" and outcome.outcome != "skipped"
            for outcome in self.terminal_outcomes
        )


@dataclass(frozen=True)
class EvidenceProjection:
    failed_files: tuple[str, ...]
    discovery_missing: tuple[str, ...]
    discovery_unexpected: tuple[str, ...]
    host_manifest_mismatch: tuple[str, ...]
    missing_nodes: tuple[str, ...]
    unexpected_nodes: tuple[str, ...]
    deselected_nodes: tuple[str, ...]
    unapproved_skips: tuple[str, ...]
    allowed_skips: tuple[str, ...]
    xfailed_nodes: tuple[str, ...]
    xpassed_nodes: tuple[str, ...]
    non_call_xfailed_nodes: tuple[str, ...]
    skip_reports: tuple[SkipReport, ...]
    collection_errors: tuple[str, ...]
    collection_error_details: tuple[CollectionIssue, ...]
    collection_skips: tuple[str, ...]
    collection_truncated: bool
    no_call_execution: bool


class TestOwnershipError(ValueError):
    """The live pytest ownership configuration could not be interpreted safely."""


class TestExecutionEvidenceError(ValueError):
    """Structured pytest file evidence was malformed, ambiguous, or truncated."""


def run(
    cmd: list[str],
    cwd: str = ".",
    extra_env: Mapping[str, str] | None = None,
) -> CommandResult:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=cwd,
            env=env,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return CommandResult(returncode=-1, stdout="", stderr=f"subprocess failed: {error}")
    return CommandResult(
        returncode=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
    )


def _print_streams(result: CommandResult) -> None:
    if result.stdout.strip():
        print("      stdout: " + "\n      ".join(result.stdout.strip().splitlines()))
    if result.stderr.strip():
        print("      stderr: " + "\n      ".join(result.stderr.strip().splitlines()))


def _print_check_output(result: CommandResult) -> None:
    output = result.combined_output
    if output:
        print("   " + "\n   ".join(output.splitlines()))


def check_token_budget() -> bool:
    print("[1/5] Checking SYSTEM.md token budget...")
    result = run([sys.executable, "scripts/system/checks/check_token_budget.py"], cwd=".")
    _print_check_output(result)
    return result.succeeded


def check_agents_links() -> bool:
    print("[2/5] Checking AGENTS.md link integrity...")
    result = run([sys.executable, "scripts/system/checks/check_agents_links.py"], cwd=".")
    _print_check_output(result)
    return result.succeeded


def _string_object_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TestOwnershipError(f"{label} must be a table")
    result: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise TestOwnershipError(f"{label} contains a non-string key")
        result[key] = item
    return result


def _string_list(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise TestOwnershipError(f"{label} must be a non-empty string array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise TestOwnershipError(f"{label} must contain only non-empty strings")
        result.append(item)
    return tuple(result)


def _load_pyproject(project_root: Path) -> dict[str, object]:
    config_path = project_root / "pyproject.toml"
    if not config_path.is_file():
        raise TestOwnershipError("pyproject.toml is missing")
    try:
        parsed: object = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise TestOwnershipError(f"pyproject.toml could not be parsed: {error}") from error
    return _string_object_mapping(parsed, "pyproject.toml")


def _pytest_config(project_root: Path) -> tuple[tuple[str, ...], tuple[str, ...]]:
    root = _load_pyproject(project_root)
    tool = _string_object_mapping(root.get("tool"), "[tool]")
    pytest_table = _string_object_mapping(tool.get("pytest"), "[tool.pytest]")
    options = _string_object_mapping(pytest_table.get("ini_options"), "[tool.pytest.ini_options]")
    testpaths = _string_list(options.get("testpaths"), "pytest testpaths")
    python_files_value = options.get("python_files")
    python_files = (
        DEFAULT_PYTHON_FILE_PATTERNS
        if python_files_value is None
        else _string_list(python_files_value, "pytest python_files")
    )
    return testpaths, python_files


def _allowed_skip_entry(value: object, index: int, project_root: Path) -> AllowedSkip:
    label = f"allowed_pytest_skips[{index}]"
    entry = _string_object_mapping(value, label)
    if set(entry) != {"node_id", "reason"}:
        raise TestOwnershipError(f"{label} must contain exactly node_id and reason")
    raw_node_id = entry["node_id"]
    reason = entry["reason"]
    if not isinstance(raw_node_id, str) or not raw_node_id.strip():
        raise TestOwnershipError(f"{label}.node_id must be a non-empty string")
    if not isinstance(reason, str) or not reason.strip():
        raise TestOwnershipError(f"{label}.reason must be a non-empty string")
    if len(reason) > MAX_DIAGNOSTIC_CHARS:
        raise TestOwnershipError(f"{label}.reason exceeds {MAX_DIAGNOSTIC_CHARS} characters")
    try:
        node_id, _ = _normalize_node_id(raw_node_id, project_root, f"{label}.node_id")
    except TestExecutionEvidenceError as error:
        raise TestOwnershipError(str(error)) from error
    return AllowedSkip(node_id=node_id, reason=reason.strip())


def _allowed_pytest_skips(project_root: Path) -> tuple[AllowedSkip, ...]:
    root = _load_pyproject(project_root)
    tool = _string_object_mapping(root.get("tool"), "[tool]")
    penny_value = tool.get("penny")
    if penny_value is None:
        return ()
    penny = _string_object_mapping(penny_value, "[tool.penny]")
    compliance_value = penny.get("compliance")
    if compliance_value is None:
        return ()
    compliance = _string_object_mapping(compliance_value, "[tool.penny.compliance]")
    allowed_value = compliance.get("allowed_pytest_skips")
    if allowed_value is None:
        return ()
    if not isinstance(allowed_value, list):
        raise TestOwnershipError("allowed_pytest_skips must be an array of tables")
    if len(allowed_value) > MAX_EVIDENCE_ENTRIES:
        raise TestOwnershipError(f"allowed_pytest_skips exceeds {MAX_EVIDENCE_ENTRIES} entries")

    allowed = tuple(
        _allowed_skip_entry(value, index, project_root) for index, value in enumerate(allowed_value)
    )
    node_ids = [rule.node_id for rule in allowed]
    if len(node_ids) != len(set(node_ids)):
        raise TestOwnershipError("allowed_pytest_skips contains duplicate node_id")
    return allowed


def _validate_relative_pattern(pattern: str) -> None:
    path = Path(pattern)
    if path.is_absolute() or PureWindowsPath(pattern).is_absolute() or ".." in path.parts:
        raise TestOwnershipError(f"pytest test path must stay within the project: {pattern}")


def _matching_test_files(
    owner_path: Path,
    python_file_patterns: tuple[str, ...],
    project_root: Path,
) -> list[Path]:
    candidates = [owner_path] if owner_path.is_file() else owner_path.rglob("*")
    matches: list[Path] = []
    for candidate in candidates:
        if not candidate.is_file() or not any(
            fnmatch.fnmatchcase(candidate.name, pattern) for pattern in python_file_patterns
        ):
            continue
        resolved = candidate.resolve()
        if not resolved.is_relative_to(project_root):
            raise TestOwnershipError(
                f"configured test file resolves outside the project: {candidate}"
            )
        matches.append(resolved)
    return sorted(set(matches))


def _configured_matches(root: Path, pattern: str) -> list[Path]:
    _validate_relative_pattern(pattern)
    try:
        return sorted(root.glob(pattern))
    except (OSError, ValueError) as error:
        raise TestOwnershipError(f"invalid pytest test path pattern {pattern}: {error}") from error


def _suite_for_match(
    matched_path: Path,
    root: Path,
    python_file_patterns: tuple[str, ...],
) -> TestSuiteOwnership:
    resolved = matched_path.resolve()
    if not resolved.is_relative_to(root):
        raise TestOwnershipError(
            f"configured test owner resolves outside the project: {matched_path}"
        )
    display_path = matched_path.relative_to(root).as_posix()
    if not resolved.exists() or (not resolved.is_file() and not resolved.is_dir()):
        return TestSuiteOwnership(
            display_path=display_path,
            path=None,
            status=OwnershipStatus.MISSING,
            reason="configured pytest owner path is missing or unsupported",
        )
    matching_files = _matching_test_files(resolved, python_file_patterns, root)
    if not matching_files:
        return TestSuiteOwnership(
            display_path=display_path,
            path=resolved,
            status=OwnershipStatus.NOT_APPLICABLE,
            reason=(
                "configured owner contains no Python files matching the live "
                f"python_files patterns: {', '.join(python_file_patterns)}"
            ),
        )
    return TestSuiteOwnership(
        display_path=display_path,
        path=resolved,
        status=OwnershipStatus.APPLICABLE,
        reason=f"owns {len(matching_files)} matching Python test file(s)",
        test_files=tuple(matching_files),
    )


def _assert_unambiguous_ownership(
    owners: list[TestSuiteOwnership],
    root: Path,
) -> None:
    file_owners: dict[Path, list[str]] = {}
    for owner in owners:
        for test_file in owner.test_files:
            file_owners.setdefault(test_file, []).append(owner.display_path)
    ambiguous = {test_file: paths for test_file, paths in file_owners.items() if len(paths) > 1}
    if not ambiguous:
        return
    details = "; ".join(
        f"{test_file.relative_to(root).as_posix()} via {', '.join(paths)}"
        for test_file, paths in sorted(ambiguous.items())
    )
    raise TestOwnershipError(f"Python test ownership overlaps: {details}")


def discover_test_suites(project_root: Path = Path(".")) -> list[TestSuiteOwnership]:
    """Derive isolated Python suite owners and expected files from live configuration."""

    root = project_root.resolve()
    testpaths, python_file_patterns = _pytest_config(root)
    owners: list[TestSuiteOwnership] = []
    seen_paths: set[Path] = set()

    for pattern in testpaths:
        matches = _configured_matches(root, pattern)
        if not matches:
            owners.append(
                TestSuiteOwnership(
                    display_path=pattern,
                    path=None,
                    status=OwnershipStatus.MISSING,
                    reason="configured pytest test path matched no files or directories",
                )
            )
        for matched_path in matches:
            resolved = matched_path.resolve()
            if resolved not in seen_paths:
                seen_paths.add(resolved)
                owners.append(_suite_for_match(matched_path, root, python_file_patterns))

    _assert_unambiguous_ownership(owners, root)
    return sorted(owners, key=lambda owner: owner.display_path)


def _evidence_record(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TestExecutionEvidenceError(f"{label} must be an object")
    result: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise TestExecutionEvidenceError(f"{label} contains a non-string key")
        result[key] = item
    return result


def _closed_evidence_record(
    value: object,
    label: str,
    keys: set[str],
) -> dict[str, object]:
    record = _evidence_record(value, label)
    actual = set(record)
    if actual != keys:
        raise TestExecutionEvidenceError(
            f"{label} fields are not closed; "
            f"missing={sorted(keys - actual) or 'none'}; "
            f"unknown={sorted(actual - keys) or 'none'}"
        )
    return record


def _evidence_array(value: object, label: str) -> list[object]:
    if not isinstance(value, list):
        raise TestExecutionEvidenceError(f"{label} must be an array")
    if len(value) > MAX_EVIDENCE_ENTRIES:
        raise TestExecutionEvidenceError(f"{label} exceeds {MAX_EVIDENCE_ENTRIES} entries")
    return value


def _evidence_boolean(value: object, label: str) -> bool:
    if not isinstance(value, bool):
        raise TestExecutionEvidenceError(f"{label} must be boolean")
    return value


def _bounded_evidence_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise TestExecutionEvidenceError(f"{label} must be a non-empty string")
    if len(value) > MAX_DIAGNOSTIC_CHARS:
        raise TestExecutionEvidenceError(f"{label} exceeds {MAX_DIAGNOSTIC_CHARS} characters")
    return value.strip()


def _normalize_evidence_path(value: str, project_root: Path, label: str) -> str:
    if not value.strip() or "\x00" in value:
        raise TestExecutionEvidenceError(f"{label} must be a non-empty filesystem path")
    if PureWindowsPath(value).is_absolute() and not Path(value).is_absolute():
        raise TestExecutionEvidenceError(f"{label} uses an unsupported absolute path")
    candidate_text = value.replace("\\", "/")
    candidate = Path(candidate_text)
    absolute = candidate if candidate.is_absolute() else project_root / candidate
    resolved = absolute.resolve()
    if not resolved.is_relative_to(project_root):
        raise TestExecutionEvidenceError(f"{label} resolves outside the project")
    return resolved.relative_to(project_root).as_posix()


def _normalize_node_id(value: str, project_root: Path, label: str) -> tuple[str, str]:
    if not value.strip() or "\x00" in value:
        raise TestExecutionEvidenceError(f"{label} must be a non-empty pytest node ID")
    if len(value) > MAX_NODE_ID_CHARS:
        raise TestExecutionEvidenceError(f"{label} exceeds {MAX_NODE_ID_CHARS} characters")
    file_part, separator, suffix = value.partition("::")
    normalized_file = _normalize_evidence_path(file_part, project_root, label)
    if not normalized_file.endswith(".py"):
        raise TestExecutionEvidenceError(f"{label} must identify a Python test file")
    normalized = normalized_file if not separator else f"{normalized_file}::{suffix}"
    return normalized, normalized_file


def _evidence_path_list(
    value: object,
    label: str,
    project_root: Path,
) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(_evidence_array(value, label)):
        if not isinstance(item, str):
            raise TestExecutionEvidenceError(f"{label}[{index}] must be a string")
        path = _normalize_evidence_path(item, project_root, f"{label}[{index}]")
        if path in seen:
            raise TestExecutionEvidenceError(f"{label} contains duplicate normalized path '{path}'")
        seen.add(path)
        normalized.append(path)
    return tuple(normalized)


def _node_reference(
    value: object,
    label: str,
    project_root: Path,
) -> NodeReference:
    record = _closed_evidence_record(value, label, {"nodeId", "file"})
    raw_node_id = record["nodeId"]
    raw_file = record["file"]
    if not isinstance(raw_node_id, str) or not isinstance(raw_file, str):
        raise TestExecutionEvidenceError(f"{label} nodeId and file must be strings")
    node_id, node_file = _normalize_node_id(raw_node_id, project_root, f"{label}.nodeId")
    if "::" not in node_id or not node_id.partition("::")[2]:
        raise TestExecutionEvidenceError(f"{label}.nodeId must identify one collected test")
    file_path = _normalize_evidence_path(raw_file, project_root, f"{label}.file")
    if node_file != file_path:
        raise TestExecutionEvidenceError(f"{label} nodeId file disagrees with file")
    return NodeReference(node_id=node_id, file=file_path)


def _node_reference_list(
    value: object,
    label: str,
    project_root: Path,
) -> tuple[NodeReference, ...]:
    references: list[NodeReference] = []
    seen: set[str] = set()
    for index, item in enumerate(_evidence_array(value, label)):
        reference = _node_reference(item, f"{label}[{index}]", project_root)
        if reference.node_id in seen:
            raise TestExecutionEvidenceError(
                f"{label} contains duplicate node ID '{reference.node_id}'"
            )
        seen.add(reference.node_id)
        references.append(reference)
    return tuple(references)


def _terminal_outcome(
    value: object,
    label: str,
    project_root: Path,
) -> TerminalOutcome:
    record = _closed_evidence_record(
        value,
        label,
        {"nodeId", "file", "phase", "outcome", "reason", "reasonTruncated"},
    )
    reference = _node_reference(
        {"nodeId": record["nodeId"], "file": record["file"]}, label, project_root
    )
    phase = record["phase"]
    outcome = record["outcome"]
    if phase not in ("setup", "call"):
        raise TestExecutionEvidenceError(f"{label}.phase is unsupported")
    if outcome not in ("passed", "failed", "skipped", "xfailed", "xpassed"):
        raise TestExecutionEvidenceError(f"{label}.outcome is unsupported")
    if phase == "setup" and outcome not in ("failed", "skipped", "xfailed"):
        raise TestExecutionEvidenceError(f"{label} has a non-terminal setup outcome")

    reason_value = record["reason"]
    reason = (
        None if reason_value is None else _bounded_evidence_string(reason_value, f"{label}.reason")
    )
    reason_truncated = _evidence_boolean(record["reasonTruncated"], f"{label}.reasonTruncated")
    if outcome in ("skipped", "xfailed", "xpassed") and reason is None:
        raise TestExecutionEvidenceError(f"{label} requires a reason for {outcome}")
    if outcome in ("passed", "failed") and reason is not None:
        raise TestExecutionEvidenceError(f"{label} must not attach a reason to {outcome}")
    if reason is None and reason_truncated:
        raise TestExecutionEvidenceError(f"{label} cannot truncate an absent reason")
    return TerminalOutcome(
        node_id=reference.node_id,
        file=reference.file,
        phase=phase,
        outcome=outcome,
        reason=reason,
        reason_truncated=reason_truncated,
    )


def _terminal_outcome_list(
    value: object,
    project_root: Path,
) -> tuple[TerminalOutcome, ...]:
    outcomes: list[TerminalOutcome] = []
    seen: set[str] = set()
    for index, item in enumerate(_evidence_array(value, "terminalOutcomes")):
        outcome = _terminal_outcome(item, f"terminalOutcomes[{index}]", project_root)
        if outcome.node_id in seen:
            raise TestExecutionEvidenceError(
                f"terminalOutcomes contains duplicate node ID '{outcome.node_id}'"
            )
        seen.add(outcome.node_id)
        outcomes.append(outcome)
    return tuple(outcomes)


def _phase_failure_list(
    value: object,
    project_root: Path,
) -> tuple[PhaseFailure, ...]:
    failures: list[PhaseFailure] = []
    for index, item in enumerate(_evidence_array(value, "phaseFailures")):
        label = f"phaseFailures[{index}]"
        record = _closed_evidence_record(item, label, {"nodeId", "file", "phase"})
        reference = _node_reference(
            {"nodeId": record["nodeId"], "file": record["file"]}, label, project_root
        )
        phase = record["phase"]
        if phase not in ("setup", "call", "teardown"):
            raise TestExecutionEvidenceError(f"{label}.phase is unsupported")
        failures.append(PhaseFailure(reference.node_id, reference.file, phase))
    if len({(item.node_id, item.phase) for item in failures}) != len(failures):
        raise TestExecutionEvidenceError("phaseFailures contains a duplicate node/phase")
    return tuple(failures)


def _collection_issue_list(
    value: object,
    label: str,
    project_root: Path,
) -> tuple[CollectionIssue, ...]:
    issues: list[CollectionIssue] = []
    for index, item in enumerate(_evidence_array(value, label)):
        item_label = f"{label}[{index}]"
        record = _closed_evidence_record(
            item,
            item_label,
            {"nodeId", "file", "message", "messageTruncated"},
        )
        raw_node_id = record["nodeId"]
        if not isinstance(raw_node_id, str):
            raise TestExecutionEvidenceError(f"{item_label}.nodeId must be a string")
        raw_file = record["file"]
        if raw_file is None:
            node_id = _bounded_evidence_string(raw_node_id, f"{item_label}.nodeId")
            file_path = None
        elif isinstance(raw_file, str):
            node_id, node_file = _normalize_node_id(
                raw_node_id, project_root, f"{item_label}.nodeId"
            )
            file_path = _normalize_evidence_path(raw_file, project_root, f"{item_label}.file")
            if node_file != file_path:
                raise TestExecutionEvidenceError(f"{item_label} nodeId file disagrees with file")
        else:
            raise TestExecutionEvidenceError(f"{item_label}.file must be a string or null")
        issues.append(
            CollectionIssue(
                node_id=node_id,
                file=file_path,
                message=_bounded_evidence_string(record["message"], f"{item_label}.message"),
                message_truncated=_evidence_boolean(
                    record["messageTruncated"], f"{item_label}.messageTruncated"
                ),
            )
        )
    if len({(item.node_id, item.file) for item in issues}) != len(issues):
        raise TestExecutionEvidenceError(f"{label} contains a duplicate node/file")
    return tuple(issues)


def _load_evidence_record(evidence_path: Path) -> dict[str, object]:
    try:
        size = evidence_path.stat().st_size
    except OSError as error:
        raise TestExecutionEvidenceError(f"execution evidence is missing: {error}") from error
    if size <= 0 or size > MAX_EXECUTION_EVIDENCE_BYTES:
        raise TestExecutionEvidenceError(
            f"execution evidence byte length {size} is outside 1..{MAX_EXECUTION_EVIDENCE_BYTES}"
        )
    try:
        parsed: object = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise TestExecutionEvidenceError(
            f"execution evidence is malformed or truncated: {error}"
        ) from error
    record = _closed_evidence_record(parsed, "execution evidence", EXECUTION_EVIDENCE_KEYS)
    if record["schemaId"] != EXECUTION_EVIDENCE_SCHEMA_ID or record["schemaVersion"] != 2:
        raise TestExecutionEvidenceError("execution evidence schema is unsupported")
    return record


def _validate_node_relationships(evidence: TestExecutionEvidence) -> None:
    expected = {item.node_id: item for item in evidence.expected_nodes}
    terminal = {item.node_id: item for item in evidence.terminal_outcomes}
    deselected = {item.node_id: item for item in evidence.deselected_nodes}
    unknown_terminal = sorted(set(terminal) - set(expected))
    unknown_deselected = sorted(set(deselected) - set(expected))
    unknown_failures = sorted({item.node_id for item in evidence.phase_failures} - set(expected))
    if unknown_terminal or unknown_deselected or unknown_failures:
        raise TestExecutionEvidenceError(
            "node evidence references unknown expected nodes; "
            f"terminal={unknown_terminal or 'none'}; "
            f"deselected={unknown_deselected or 'none'}; "
            f"failures={unknown_failures or 'none'}"
        )
    overlap = sorted(set(terminal) & set(deselected))
    if overlap:
        raise TestExecutionEvidenceError(f"nodes cannot be both terminal and deselected: {overlap}")
    for node_id, terminal_item in terminal.items():
        if terminal_item.file != expected[node_id].file:
            raise TestExecutionEvidenceError(
                f"terminal outcome file disagrees for node '{node_id}'"
            )
    for node_id, deselected_item in deselected.items():
        if deselected_item.file != expected[node_id].file:
            raise TestExecutionEvidenceError(f"deselected file disagrees for node '{node_id}'")
    for failure in evidence.phase_failures:
        if failure.file != expected[failure.node_id].file:
            raise TestExecutionEvidenceError(
                f"phase failure file disagrees for node '{failure.node_id}'"
            )


def _validate_failure_relationships(evidence: TestExecutionEvidence) -> None:
    terminal = {item.node_id: item for item in evidence.terminal_outcomes}
    phase_failure_keys = {(item.node_id, item.phase) for item in evidence.phase_failures}
    terminal_failure_keys = {
        (item.node_id, item.phase)
        for item in evidence.terminal_outcomes
        if item.outcome == "failed"
    }
    missing_phase_failures = sorted(terminal_failure_keys - phase_failure_keys)
    if missing_phase_failures:
        raise TestExecutionEvidenceError(
            f"failed terminal outcomes lack phaseFailures: {missing_phase_failures}"
        )
    for failure in evidence.phase_failures:
        if failure.phase == "teardown":
            continue
        outcome = terminal.get(failure.node_id)
        if (
            outcome is None
            or outcome.phase != failure.phase
            or outcome.outcome
            not in (
                "failed",
                "xpassed",
            )
        ):
            raise TestExecutionEvidenceError(
                "setup/call phaseFailure disagrees with its terminal outcome: "
                f"{failure.node_id} ({failure.phase})"
            )


def _validate_file_projections(evidence: TestExecutionEvidence) -> None:
    expected_files = set(evidence.expected_files)
    referenced_files = (
        {item.file for item in evidence.expected_nodes}
        | {item.file for item in evidence.terminal_outcomes}
        | {item.file for item in evidence.phase_failures}
        | {item.file for item in evidence.deselected_nodes}
        | {item.file for item in evidence.collection_errors if item.file is not None}
        | {item.file for item in evidence.collection_skips if item.file is not None}
    )
    if not referenced_files.issubset(expected_files):
        raise TestExecutionEvidenceError(
            "node or collection evidence references files outside expectedFiles"
        )
    derived_executed_files = {
        item.file
        for item in evidence.terminal_outcomes
        if item.phase == "call" and item.outcome != "skipped"
    }
    if set(evidence.executed_files) != derived_executed_files:
        raise TestExecutionEvidenceError(
            "executedFiles disagrees with non-skipped call-phase outcomes"
        )
    derived_failed_files = {item.file for item in evidence.phase_failures} | {
        item.file for item in evidence.collection_errors if item.file is not None
    }
    if set(evidence.failed_files) != derived_failed_files:
        raise TestExecutionEvidenceError(
            "failedFiles disagrees with phase failures and collection errors"
        )


def _validate_completion_fields(evidence: TestExecutionEvidence) -> None:
    expected_complete = (
        evidence.collection_complete
        and not evidence.collection_truncated
        and evidence.pytest_exit_status in (0, 1, 5)
    )
    if evidence.complete != expected_complete:
        raise TestExecutionEvidenceError(
            "complete disagrees with collection state and pytestExitStatus"
        )
    if not evidence.collection_complete and not evidence.collection_truncated:
        raise TestExecutionEvidenceError("unfinished collection must be marked truncated")


def _validate_evidence_structure(evidence: TestExecutionEvidence) -> None:
    _validate_node_relationships(evidence)
    _validate_failure_relationships(evidence)
    _validate_file_projections(evidence)
    _validate_completion_fields(evidence)


def parse_execution_evidence(
    evidence_path: Path,
    project_root: Path,
) -> TestExecutionEvidence:
    """Parse bounded, closed, node-level evidence emitted by the isolated test host."""

    record = _load_evidence_record(evidence_path)
    exit_status = record["pytestExitStatus"]
    if (
        isinstance(exit_status, bool)
        or not isinstance(exit_status, int)
        or not 0 <= exit_status <= 5
    ):
        raise TestExecutionEvidenceError("pytestExitStatus must be an integer from 0 through 5")
    evidence = TestExecutionEvidence(
        complete=_evidence_boolean(record["complete"], "complete"),
        pytest_exit_status=exit_status,
        collection_complete=_evidence_boolean(record["collectionComplete"], "collectionComplete"),
        collection_truncated=_evidence_boolean(
            record["collectionTruncated"], "collectionTruncated"
        ),
        expected_files=_evidence_path_list(record["expectedFiles"], "expectedFiles", project_root),
        executed_files=_evidence_path_list(record["executedFiles"], "executedFiles", project_root),
        failed_files=_evidence_path_list(record["failedFiles"], "failedFiles", project_root),
        expected_nodes=_node_reference_list(record["expectedNodes"], "expectedNodes", project_root),
        terminal_outcomes=_terminal_outcome_list(record["terminalOutcomes"], project_root),
        phase_failures=_phase_failure_list(record["phaseFailures"], project_root),
        deselected_nodes=_node_reference_list(
            record["deselectedNodes"], "deselectedNodes", project_root
        ),
        collection_errors=_collection_issue_list(
            record["collectionErrors"], "collectionErrors", project_root
        ),
        collection_skips=_collection_issue_list(
            record["collectionSkips"], "collectionSkips", project_root
        ),
    )
    _validate_evidence_structure(evidence)
    return evidence


def _skip_is_allowed(
    node_id: str,
    reason: str,
    truncated: bool,
    allowed: Mapping[str, str],
) -> bool:
    return not truncated and allowed.get(node_id) == reason


def _coverage_projection(
    suite: TestSuiteOwnership,
    evidence: TestExecutionEvidence,
    project_root: Path,
    allowed_skips: tuple[AllowedSkip, ...],
) -> EvidenceProjection:
    independently_expected = {
        test_file.relative_to(project_root).as_posix() for test_file in suite.test_files
    }
    host_expected = set(evidence.expected_files)
    allowed = {item.node_id: item.reason for item in allowed_skips}
    expected_nodes = {item.node_id: item for item in evidence.expected_nodes}
    terminal = {item.node_id: item for item in evidence.terminal_outcomes}
    deselected_ids = {item.node_id for item in evidence.deselected_nodes}

    reported_files = (
        host_expected
        | set(evidence.executed_files)
        | set(evidence.failed_files)
        | {item.file for item in evidence.expected_nodes}
        | {item.file for item in evidence.terminal_outcomes}
        | {item.file for item in evidence.phase_failures}
        | {item.file for item in evidence.deselected_nodes}
        | {item.file for item in evidence.collection_errors if item.file is not None}
        | {item.file for item in evidence.collection_skips if item.file is not None}
    )
    discovery_unexpected = tuple(sorted(reported_files - independently_expected))
    host_manifest_mismatch = tuple(sorted(independently_expected ^ host_expected))

    skipped_outcomes = [item for item in evidence.terminal_outcomes if item.outcome == "skipped"]
    allowed_terminal_skips = {
        item.node_id
        for item in skipped_outcomes
        if item.reason is not None
        and _skip_is_allowed(item.node_id, item.reason, item.reason_truncated, allowed)
    }
    allowed_collection_skips = {
        item.node_id
        for item in evidence.collection_skips
        if _skip_is_allowed(item.node_id, item.message, item.message_truncated, allowed)
    }
    allowed_skip_ids = allowed_terminal_skips | allowed_collection_skips
    actual_skip_ids = {item.node_id for item in skipped_outcomes} | {
        item.node_id for item in evidence.collection_skips
    }

    accepted_nodes: set[str] = set()
    for item in evidence.terminal_outcomes:
        if item.phase == "call" and item.outcome != "skipped":
            accepted_nodes.add(item.node_id)
        elif item.phase == "setup" and item.outcome == "failed":
            accepted_nodes.add(item.node_id)
        elif item.outcome == "skipped" and item.node_id in allowed_terminal_skips:
            accepted_nodes.add(item.node_id)

    missing_nodes = tuple(sorted(set(expected_nodes) - accepted_nodes - deselected_ids))
    unexpected_nodes = tuple(sorted(set(terminal) - set(expected_nodes)))
    non_call_xfailed = tuple(
        sorted(
            item.node_id
            for item in evidence.terminal_outcomes
            if item.outcome == "xfailed" and item.phase != "call"
        )
    )

    nodes_by_file: dict[str, set[str]] = {}
    for expected_item in evidence.expected_nodes:
        nodes_by_file.setdefault(expected_item.file, set()).add(expected_item.node_id)
    allowed_collection_files = {
        item.file
        for item in evidence.collection_skips
        if item.file is not None and item.node_id in allowed_collection_skips
    }
    accepted_files: set[str] = set()
    for file_path in independently_expected:
        file_nodes = nodes_by_file.get(file_path, set())
        if (file_nodes and file_nodes.issubset(accepted_nodes)) or (
            file_path in allowed_collection_files
        ):
            accepted_files.add(file_path)

    def issue_label(issue: CollectionIssue) -> str:
        return issue.node_id if issue.file is None else f"{issue.node_id} ({issue.file})"

    skip_reports = tuple(
        sorted(
            (
                *(
                    SkipReport(
                        node_id=item.node_id,
                        phase=item.phase,
                        reason=item.reason or "pytest supplied no reason",
                        reason_truncated=item.reason_truncated,
                        allowed=item.node_id in allowed_terminal_skips,
                    )
                    for item in skipped_outcomes
                ),
                *(
                    SkipReport(
                        node_id=item.node_id,
                        phase="collection",
                        reason=item.message,
                        reason_truncated=item.message_truncated,
                        allowed=item.node_id in allowed_collection_skips,
                    )
                    for item in evidence.collection_skips
                ),
            ),
            key=lambda item: (item.node_id, item.phase),
        )
    )

    return EvidenceProjection(
        failed_files=tuple(sorted(evidence.failed_files)),
        discovery_missing=tuple(sorted(independently_expected - accepted_files)),
        discovery_unexpected=discovery_unexpected,
        host_manifest_mismatch=host_manifest_mismatch,
        missing_nodes=missing_nodes,
        unexpected_nodes=unexpected_nodes,
        deselected_nodes=tuple(sorted(deselected_ids)),
        unapproved_skips=tuple(sorted(actual_skip_ids - allowed_skip_ids)),
        allowed_skips=tuple(sorted(allowed_skip_ids)),
        xfailed_nodes=tuple(
            sorted(item.node_id for item in evidence.terminal_outcomes if item.outcome == "xfailed")
        ),
        xpassed_nodes=tuple(
            sorted(item.node_id for item in evidence.terminal_outcomes if item.outcome == "xpassed")
        ),
        non_call_xfailed_nodes=non_call_xfailed,
        skip_reports=skip_reports,
        collection_errors=tuple(issue_label(item) for item in evidence.collection_errors),
        collection_error_details=evidence.collection_errors,
        collection_skips=tuple(issue_label(item) for item in evidence.collection_skips),
        collection_truncated=evidence.collection_truncated,
        no_call_execution=evidence.executed_tests == 0,
    )


def _print_execution_projection(
    suite: TestSuiteOwnership,
    projection: EvidenceProjection,
) -> None:
    printable = {
        "allowedSkippedNodes": projection.allowed_skips,
        "collectionErrorDetails": [
            {
                "file": item.file,
                "message": item.message,
                "messageTruncated": item.message_truncated,
                "nodeId": item.node_id,
            }
            for item in projection.collection_error_details
        ],
        "collectionErrors": projection.collection_errors,
        "collectionSkips": projection.collection_skips,
        "collectionTruncated": projection.collection_truncated,
        "deselectedNodes": projection.deselected_nodes,
        "discoveryMissing": projection.discovery_missing,
        "discoveryUnexpected": projection.discovery_unexpected,
        "failedFiles": projection.failed_files,
        "missingNodes": projection.missing_nodes,
        "reportedSkips": [
            {
                "allowed": item.allowed,
                "nodeId": item.node_id,
                "phase": item.phase,
                "reason": item.reason,
                "reasonTruncated": item.reason_truncated,
            }
            for item in projection.skip_reports
        ],
        "unapprovedSkippedNodes": projection.unapproved_skips,
        "unexpectedNodes": projection.unexpected_nodes,
        "xfailedNodes": projection.xfailed_nodes,
        "xpassedNodes": projection.xpassed_nodes,
    }
    print(
        f"   EVIDENCE {suite.display_path}: "
        f"{json.dumps(printable, sort_keys=True, separators=(',', ':'))}"
    )


def _pytest_plugin_env(root: Path, evidence_path: Path) -> dict[str, str]:
    plugin_root = Path(__file__).resolve().parents[1]
    existing_pythonpath = os.environ.get("PYTHONPATH", "")
    pythonpath = str(plugin_root)
    if existing_pythonpath:
        pythonpath = f"{pythonpath}{os.pathsep}{existing_pythonpath}"
    return {
        "PYTHONPATH": pythonpath,
        "PENNY_PYTEST_EXECUTION_REPORT": str(evidence_path),
        "PENNY_PYTEST_PROJECT_ROOT": str(root),
    }


def _run_with_evidence(
    suite: TestSuiteOwnership,
    root: Path,
    runner: CommandRunner,
) -> tuple[CommandResult, TestExecutionEvidence | None, TestExecutionEvidenceError | None]:
    if suite.path is None:
        raise TestOwnershipError("applicable owner has no path")
    with tempfile.TemporaryDirectory(prefix="penny-pytest-evidence-") as temporary:
        evidence_path = Path(temporary) / "execution-evidence.json"
        result = runner(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "-p",
                "no:cacheprovider",
                "-p",
                "checks.pytest_execution_report",
                "--tb=short",
                str(suite.path),
            ],
            cwd=str(root),
            extra_env=_pytest_plugin_env(root, evidence_path),
        )
        try:
            return result, parse_execution_evidence(evidence_path, root), None
        except TestExecutionEvidenceError as error:
            return result, None, error


def _append_failure_reason(reasons: list[str], failed: bool, message: str) -> None:
    if failed:
        reasons.append(message)


def _execution_failure_reasons(
    result: CommandResult,
    evidence: TestExecutionEvidence,
    projection: EvidenceProjection,
) -> list[str]:
    reasons: list[str] = []
    _append_failure_reason(reasons, not evidence.complete, "test host marked evidence incomplete")
    _append_failure_reason(
        reasons, not evidence.collection_complete, "collection did not reach completion"
    )
    _append_failure_reason(reasons, projection.collection_truncated, "collection was truncated")
    _append_failure_reason(
        reasons,
        bool(projection.collection_errors),
        f"collection errors were reported: {list(projection.collection_errors)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.host_manifest_mismatch),
        f"host expectedFiles disagreed at {list(projection.host_manifest_mismatch)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.discovery_missing),
        "independently owned files lacked accepted node evidence: "
        f"{list(projection.discovery_missing)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.discovery_unexpected),
        f"unknown files were reported: {list(projection.discovery_unexpected)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.missing_nodes),
        f"expected nodes lacked terminal evidence: {list(projection.missing_nodes)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.unexpected_nodes),
        f"unknown terminal nodes were reported: {list(projection.unexpected_nodes)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.deselected_nodes),
        f"expected nodes were deselected: {list(projection.deselected_nodes)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.unapproved_skips),
        "skips were not exactly allowlisted by node ID and reason: "
        f"{list(projection.unapproved_skips)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.non_call_xfailed_nodes),
        "xfail nodes did not reach the call phase: " f"{list(projection.non_call_xfailed_nodes)}",
    )
    _append_failure_reason(
        reasons,
        bool(projection.xpassed_nodes),
        f"unexpectedly passing xfail nodes: {list(projection.xpassed_nodes)}",
    )
    _append_failure_reason(
        reasons,
        projection.no_call_execution,
        "no non-skipped call-phase tests executed in the protected suite",
    )
    _append_failure_reason(
        reasons,
        result.returncode != evidence.pytest_exit_status,
        "subprocess exit disagreed with evidence: "
        f"{result.returncode} != {evidence.pytest_exit_status}",
    )
    _append_failure_reason(reasons, result.returncode != 0, f"subprocess exit {result.returncode}")
    _append_failure_reason(
        reasons,
        result.returncode == 0 and bool(projection.failed_files),
        "successful subprocess reported failed files",
    )
    return reasons


def _execution_controls_ok(
    result: CommandResult,
    evidence: TestExecutionEvidence,
    projection: EvidenceProjection,
) -> bool:
    return (
        evidence.complete
        and evidence.collection_complete
        and not projection.collection_truncated
        and not projection.collection_errors
        and not projection.host_manifest_mismatch
        and not projection.discovery_missing
        and not projection.discovery_unexpected
        and not projection.missing_nodes
        and not projection.unexpected_nodes
        and not projection.deselected_nodes
        and not projection.unapproved_skips
        and not projection.non_call_xfailed_nodes
        and not projection.xpassed_nodes
        and not projection.no_call_execution
        and result.returncode == evidence.pytest_exit_status
    )


def _print_malformed_projection(
    suite: TestSuiteOwnership,
    independently_expected: list[str],
) -> None:
    printable = {
        "allowedSkippedNodes": [],
        "collectionErrorDetails": [],
        "collectionErrors": [],
        "collectionSkips": [],
        "collectionTruncated": True,
        "deselectedNodes": [],
        "discoveryMissing": independently_expected,
        "discoveryUnexpected": [],
        "failedFiles": [],
        "missingNodes": [],
        "reportedSkips": [],
        "unapprovedSkippedNodes": [],
        "unexpectedNodes": [],
        "xfailedNodes": [],
        "xpassedNodes": [],
    }
    print(
        f"   EVIDENCE {suite.display_path}: "
        f"{json.dumps(printable, sort_keys=True, separators=(',', ':'))}"
    )


def _execute_applicable_suite(
    suite: TestSuiteOwnership,
    project_root: Path,
    runner: CommandRunner,
    allowed_skips: tuple[AllowedSkip, ...],
) -> tuple[bool, int, int]:
    if suite.path is None:
        print(f"   DISCOVERY ERROR {suite.display_path}: applicable owner has no path")
        return False, 0, 0

    root = project_root.resolve()
    independently_expected = sorted(
        test_file.relative_to(root).as_posix() for test_file in suite.test_files
    )
    result, evidence, evidence_error = _run_with_evidence(suite, root, runner)
    if evidence is None:
        _print_malformed_projection(suite, independently_expected)
        print(f"   MALFORMED {suite.display_path}: {evidence_error}")
        _print_streams(result)
        return False, 0, 0

    projection = _coverage_projection(suite, evidence, root, allowed_skips)
    _print_execution_projection(suite, projection)
    controls_ok = _execution_controls_ok(result, evidence, projection)

    if (
        result.returncode == 1
        and evidence.pytest_exit_status == 1
        and projection.failed_files
        and controls_ok
    ):
        print(
            f"   TESTS FAILED {suite.display_path}: {len(projection.failed_files)} file(s), "
            f"{evidence.executed_tests}/{evidence.collected_tests} collected nodes executed"
        )
        _print_streams(result)
        return False, evidence.executed_tests, len(projection.allowed_skips)

    if not controls_ok or result.returncode != 0 or projection.failed_files:
        reasons = _execution_failure_reasons(result, evidence, projection)
        print(f"   EXECUTION FAILED {suite.display_path}: {'; '.join(reasons)}")
        _print_streams(result)
        return False, evidence.executed_tests, len(projection.allowed_skips)

    print(
        f"   EXECUTED {suite.display_path}: {evidence.executed_tests} call-phase test cases "
        f"across {len(independently_expected)} independently verified file(s); "
        f"{len(projection.allowed_skips)} explicitly allowed skip(s)"
    )
    return True, evidence.executed_tests, len(projection.allowed_skips)


def check_tests(
    project_root: Path = Path("."),
    runner: CommandRunner = run,
) -> bool:
    print("[3/5] Executing Python tests with independent file-discovery verification...")
    root = project_root.resolve()
    try:
        suites = discover_test_suites(root)
        allowed_skips = _allowed_pytest_skips(root)
    except TestOwnershipError as error:
        print(f"   DISCOVERY ERROR: {error}")
        print("   TOTAL EXECUTED: 0 call-phase test cases; 0 explicitly allowed skips")
        return False

    if not suites:
        print("   DISCOVERY ERROR: live pytest configuration produced no suite owners")
        print("   TOTAL EXECUTED: 0 call-phase test cases; 0 explicitly allowed skips")
        return False

    total = 0
    allowed_skip_total = 0
    all_ok = True
    applicable_count = 0
    not_applicable_count = 0

    for suite in suites:
        if suite.status is OwnershipStatus.MISSING:
            print(f"   MISSING {suite.display_path}: {suite.reason}")
            all_ok = False
        elif suite.status is OwnershipStatus.NOT_APPLICABLE:
            print(f"   N/A {suite.display_path}: {suite.reason}")
            not_applicable_count += 1
        else:
            applicable_count += 1
            suite_ok, count, skip_count = _execute_applicable_suite(
                suite, root, runner, allowed_skips
            )
            all_ok = suite_ok and all_ok
            total += count
            allowed_skip_total += skip_count

    applicable_label = "suite" if applicable_count == 1 else "suites"
    not_applicable_label = "suite" if not_applicable_count == 1 else "suites"
    print(
        f"   TOTAL EXECUTED: {total} call-phase test cases across {applicable_count} applicable "
        f"{applicable_label}; {allowed_skip_total} explicitly allowed skip(s); "
        f"{not_applicable_count} {not_applicable_label} N/A"
    )
    return all_ok


def check_skills() -> bool:
    print("[4/5] Checking skill directory structure...")
    skills_dir = Path(".pi/skills")
    if not skills_dir.exists():
        print("   .pi/skills/ does not exist — N/A for skill structure")
        return True

    all_ok = True
    for skill_path in sorted(skills_dir.iterdir()):
        if not skill_path.is_dir() or skill_path.name.startswith("."):
            continue

        missing = []
        for required in SKILL_REQUIRED_FILES:
            if not (skill_path / required).exists():
                missing.append(required)

        if not any((skill_path / relative).is_file() for relative in SKILL_FLOW_DIAGRAM_ANY):
            missing.append("resources/flow.html (or legacy flow.mmd)")

        if missing:
            print(f"   ❌ {skill_path.name}: missing {', '.join(missing)}")
            all_ok = False
        else:
            print(f"   ✅ {skill_path.name}: all required files present")

    return all_ok


def check_no_raw_memory_peer() -> bool:
    print("[5/5] Checking raw memory peer boundary...")
    result = run([sys.executable, "scripts/system/checks/check_no_raw_memory_peer.py"])
    _print_check_output(result)
    return result.succeeded


def main() -> int:
    results = {
        "token_budget": check_token_budget(),
        "agents_links": check_agents_links(),
        "test_discovery": check_tests(),
        "skills": check_skills(),
        "no_raw_memory_peer": check_no_raw_memory_peer(),
    }
    print()
    if all(results.values()):
        print("✅ Configured compliance checks and Python tests succeeded.")
        print(
            "   Python node outcomes and configured skip exceptions matched the "
            "independent owned-test inventory."
        )
        return 0
    failed = [name for name, succeeded in results.items() if not succeeded]
    print(f"❌ Failed checks: {', '.join(failed)}")
    print(
        "   Failed files, skips, node outcomes, and discovery mismatches are reported "
        "above from structured evidence."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
