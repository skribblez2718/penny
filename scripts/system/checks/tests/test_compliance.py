from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Mapping

import pytest

import checks.check_compliance as compliance
from checks.check_compliance import CommandResult, OwnershipStatus


def write_pyproject(
    root: Path,
    testpaths: list[str],
    python_files: list[str] | None = None,
    *,
    addopts: str | None = None,
    allowed_skips: list[tuple[str, str]] | None = None,
) -> None:
    patterns = python_files or ["test_*.py"]
    quoted_paths = ", ".join(json.dumps(path) for path in testpaths)
    quoted_patterns = ", ".join(json.dumps(pattern) for pattern in patterns)
    lines = [
        "[tool.pytest.ini_options]",
        f"testpaths = [{quoted_paths}]",
        f"python_files = [{quoted_patterns}]",
    ]
    if addopts is not None:
        lines.append(f"addopts = {json.dumps(addopts)}")
    for node_id, reason in allowed_skips or []:
        lines.extend(
            [
                "",
                "[[tool.penny.compliance.allowed_pytest_skips]]",
                f"node_id = {json.dumps(node_id)}",
                f"reason = {json.dumps(reason)}",
            ]
        )
    (root / "pyproject.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def create_owner(root: Path, relative: str, filename: str = "test_fixture.py") -> Path:
    owner = root / relative
    owner.mkdir(parents=True)
    (owner / filename).write_text("def test_fixture():\n    assert True\n", encoding="utf-8")
    return owner


def node(file_path: str, name: str = "test_fixture") -> dict[str, object]:
    return {"nodeId": f"{file_path}::{name}", "file": file_path}


def terminal(
    file_path: str,
    name: str = "test_fixture",
    *,
    outcome: str = "passed",
    phase: str = "call",
    reason: str | None = None,
    reason_truncated: bool = False,
) -> dict[str, object]:
    return {
        **node(file_path, name),
        "phase": phase,
        "outcome": outcome,
        "reason": reason,
        "reasonTruncated": reason_truncated,
    }


def collection_issue(
    file_path: str | None,
    *,
    message: str,
    node_id: str | None = None,
    truncated: bool = False,
) -> dict[str, object]:
    return {
        "nodeId": node_id or file_path or "<collection-root>",
        "file": file_path,
        "message": message,
        "messageTruncated": truncated,
    }


def evidence(
    *,
    expected: list[str],
    expected_nodes: list[dict[str, object]] | None = None,
    terminals: list[dict[str, object]] | None = None,
    phase_failures: list[dict[str, object]] | None = None,
    deselected: list[dict[str, object]] | None = None,
    collection_errors: list[dict[str, object]] | None = None,
    collection_skips: list[dict[str, object]] | None = None,
    complete: bool = True,
    exit_status: int = 0,
    collection_complete: bool = True,
    collection_truncated: bool = False,
) -> dict[str, object]:
    nodes = (
        [node(file_path) for file_path in expected] if expected_nodes is None else expected_nodes
    )
    outcomes = (
        [terminal(str(item["file"]), str(item["nodeId"]).partition("::")[2]) for item in nodes]
        if terminals is None
        else terminals
    )
    failures = [] if phase_failures is None else phase_failures
    errors = [] if collection_errors is None else collection_errors
    executed_files = sorted(
        {
            str(item["file"])
            for item in outcomes
            if item["phase"] == "call" and item["outcome"] != "skipped"
        }
    )
    failed_files = sorted(
        {str(item["file"]) for item in failures}
        | {str(item["file"]) for item in errors if item["file"] is not None}
    )
    return {
        "schemaId": compliance.EXECUTION_EVIDENCE_SCHEMA_ID,
        "schemaVersion": 2,
        "complete": complete,
        "pytestExitStatus": exit_status,
        "collectionComplete": collection_complete,
        "collectionTruncated": collection_truncated,
        "expectedFiles": expected,
        "executedFiles": executed_files,
        "failedFiles": failed_files,
        "expectedNodes": nodes,
        "terminalOutcomes": outcomes,
        "phaseFailures": failures,
        "deselectedNodes": [] if deselected is None else deselected,
        "collectionErrors": errors,
        "collectionSkips": [] if collection_skips is None else collection_skips,
    }


class FakeRunner:
    def __init__(
        self,
        results: Mapping[str, CommandResult],
        reports: Mapping[str, object | str | None],
    ) -> None:
        self.results = results
        self.reports = reports
        self.calls: list[list[str]] = []

    def __call__(
        self,
        cmd: list[str],
        cwd: str = ".",
        extra_env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        self.calls.append(cmd)
        key = Path(cmd[-1]).resolve().relative_to(Path(cwd).resolve()).as_posix()
        result = self.results.get(key)
        if result is None:
            raise AssertionError(f"unexpected test owner: {key}")
        if extra_env is None:
            raise AssertionError("structured evidence environment is absent")
        evidence_path = Path(extra_env["PENNY_PYTEST_EXECUTION_REPORT"])
        report = self.reports.get(key)
        if isinstance(report, str):
            evidence_path.write_text(report, encoding="utf-8")
        elif report is not None:
            evidence_path.write_text(json.dumps(report), encoding="utf-8")
        return result


def passing_report(paths: list[str], count: int) -> dict[str, object]:
    if not paths:
        raise AssertionError("passing report needs at least one file")
    nodes = [node(paths[index % len(paths)], f"test_case_{index}") for index in range(count)]
    outcomes = [
        terminal(
            str(item["file"]),
            str(item["nodeId"]).partition("::")[2],
        )
        for item in nodes
    ]
    return evidence(expected=paths, expected_nodes=nodes, terminals=outcomes)


def passing_runner(root: Path, owners: list[str], counts: list[int] | None = None) -> FakeRunner:
    case_counts = counts or [1] * len(owners)
    results: dict[str, CommandResult] = {}
    reports: dict[str, object] = {}
    for owner, count in zip(owners, case_counts, strict=True):
        paths = sorted(
            path.relative_to(root).as_posix() for path in (root / owner).glob("test_*.py")
        )
        results[owner] = CommandResult(0, f"{count} passed\n", "")
        reports[owner] = passing_report(paths, count)
    return FakeRunner(results, reports)


def test_discover_test_suites_uses_live_pytest_paths_and_marks_owned_na(tmp_path: Path) -> None:
    write_pyproject(tmp_path, ["owners/*/tests", "system/tests"])
    create_owner(tmp_path, "owners/alpha/tests")
    empty_owner = tmp_path / "owners" / "docs" / "tests"
    empty_owner.mkdir(parents=True)
    (empty_owner / "notes.ts").write_text("export {};\n", encoding="utf-8")
    create_owner(tmp_path, "system/tests", "test_system.py")

    suites = compliance.discover_test_suites(tmp_path)

    assert [(suite.display_path, suite.status) for suite in suites] == [
        ("owners/alpha/tests", OwnershipStatus.APPLICABLE),
        ("owners/docs/tests", OwnershipStatus.NOT_APPLICABLE),
        ("system/tests", OwnershipStatus.APPLICABLE),
    ]
    assert [path.name for path in suites[0].test_files] == ["test_fixture.py"]


def test_discover_test_suites_rejects_overlapping_file_ownership(tmp_path: Path) -> None:
    write_pyproject(tmp_path, ["suite", "suite/tests"])
    create_owner(tmp_path, "suite/tests")

    with pytest.raises(compliance.TestOwnershipError, match="ownership overlaps"):
        compliance.discover_test_suites(tmp_path)


def test_check_tests_propagates_collection_error_and_truncation_with_truthful_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests")
    test_file = "suite/tests/test_fixture.py"
    error = collection_issue(test_file, message="ImportError: missing")
    runner = FakeRunner(
        {"suite/tests": CommandResult(2, "collected 0 items\n", "ImportError: missing\n")},
        {
            "suite/tests": evidence(
                expected=[test_file],
                expected_nodes=[],
                terminals=[],
                collection_errors=[error],
                complete=False,
                exit_status=2,
                collection_truncated=True,
            )
        },
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert '"failedFiles":["suite/tests/test_fixture.py"]' in output
    assert (
        '"collectionErrors":["suite/tests/test_fixture.py (suite/tests/test_fixture.py)"]' in output
    )
    assert '"collectionTruncated":true' in output
    assert '"discoveryMissing":["suite/tests/test_fixture.py"]' in output
    assert "collection errors were reported" in output
    assert "subprocess exit 2" in output
    assert "EXECUTED suite/tests" not in output


def test_check_tests_rejects_collection_truncation_without_reported_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests")
    test_file = "suite/tests/test_fixture.py"
    runner = FakeRunner(
        {"suite/tests": CommandResult(2, "collected 0 items\n", "interrupted\n")},
        {
            "suite/tests": evidence(
                expected=[test_file],
                expected_nodes=[],
                terminals=[],
                complete=False,
                exit_status=2,
                collection_complete=False,
                collection_truncated=True,
            )
        },
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert '"collectionErrors":[]' in output
    assert '"collectionTruncated":true' in output
    assert "collection did not reach completion" in output
    assert "collection was truncated" in output


def test_check_tests_fails_closed_for_malformed_truncated_and_missing_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["malformed/tests", "missing/tests"])
    create_owner(tmp_path, "malformed/tests")
    create_owner(tmp_path, "missing/tests")
    runner = FakeRunner(
        {
            "malformed/tests": CommandResult(0, "1 passed\n", ""),
            "missing/tests": CommandResult(0, "1 passed\n", ""),
        },
        {"malformed/tests": '{"schemaId":', "missing/tests": None},
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert "MALFORMED malformed/tests" in output
    assert "malformed or truncated" in output
    assert "MALFORMED missing/tests" in output
    assert "execution evidence is missing" in output
    assert '"discoveryMissing":["malformed/tests/test_fixture.py"]' in output
    assert '"discoveryMissing":["missing/tests/test_fixture.py"]' in output


def test_check_tests_distinguishes_missing_path_and_explicit_na(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["missing/tests", "docs/tests"])
    docs = tmp_path / "docs" / "tests"
    docs.mkdir(parents=True)
    (docs / "fixture.test.ts").write_text("export {};\n", encoding="utf-8")
    runner = FakeRunner({}, {})

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert "MISSING missing/tests" in output
    assert "N/A docs/tests" in output
    assert "contains no Python files" in output
    assert runner.calls == []


def test_check_tests_allows_an_ownership_backed_all_na_result(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["typescript/tests"])
    owner = tmp_path / "typescript" / "tests"
    owner.mkdir(parents=True)
    (owner / "fixture.test.ts").write_text("export {};\n", encoding="utf-8")

    assert compliance.check_tests(tmp_path, FakeRunner({}, {})) is True
    output = capsys.readouterr().out
    assert "N/A typescript/tests" in output
    assert "TOTAL EXECUTED: 0 call-phase test cases" in output
    assert "1 suite N/A" in output


def test_check_tests_verifies_accurate_execution_without_trusting_counts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["alpha/tests", "beta/tests", "docs/tests"])
    create_owner(tmp_path, "alpha/tests")
    create_owner(tmp_path, "beta/tests")
    docs = tmp_path / "docs" / "tests"
    docs.mkdir(parents=True)
    runner = passing_runner(tmp_path, ["alpha/tests", "beta/tests"], [2, 3])

    assert compliance.check_tests(tmp_path, runner) is True
    output = capsys.readouterr().out
    assert "EXECUTED alpha/tests: 2 call-phase test cases" in output
    assert "EXECUTED beta/tests: 3 call-phase test cases" in output
    assert "TOTAL EXECUTED: 5 call-phase test cases across 2 applicable suites" in output
    assert '"discoveryMissing":[]' in output
    assert '"discoveryUnexpected":[]' in output


def test_check_tests_rejects_false_green_when_host_omits_owned_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests", "test_first.py")
    (tmp_path / "suite/tests/test_omitted.py").write_text(
        "def test_omitted():\n    assert False\n", encoding="utf-8"
    )
    falsely_self_consistent = ["suite/tests/test_first.py"]
    runner = FakeRunner(
        {"suite/tests": CommandResult(0, "1 passed\n", "")},
        {"suite/tests": evidence(expected=falsely_self_consistent)},
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert '"discoveryMissing":["suite/tests/test_omitted.py"]' in output
    assert "host expectedFiles disagreed" in output
    assert "independently owned files lacked accepted node evidence" in output


def test_check_tests_rejects_unknown_reported_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests")
    files = ["suite/tests/test_fixture.py", "suite/tests/test_unknown.py"]
    runner = FakeRunner(
        {"suite/tests": CommandResult(0, "2 passed\n", "")},
        {"suite/tests": evidence(expected=files)},
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert '"discoveryUnexpected":["suite/tests/test_unknown.py"]' in output
    assert "unknown files were reported" in output


def test_parse_execution_evidence_rejects_duplicate_normalized_paths(tmp_path: Path) -> None:
    report = evidence(expected=["suite/tests/test_fixture.py"])
    report["executedFiles"] = [
        "suite/tests/test_fixture.py",
        "suite\\tests\\test_fixture.py",
    ]
    evidence_path = tmp_path / "report.json"
    evidence_path.write_text(json.dumps(report), encoding="utf-8")

    with pytest.raises(compliance.TestExecutionEvidenceError, match="duplicate normalized path"):
        compliance.parse_execution_evidence(evidence_path, tmp_path)


def test_parse_execution_evidence_rejects_duplicate_and_unknown_nodes(tmp_path: Path) -> None:
    test_file = "suite/tests/test_fixture.py"
    duplicate = evidence(
        expected=[test_file],
        expected_nodes=[node(test_file), node(test_file)],
        terminals=[terminal(test_file)],
    )
    duplicate_path = tmp_path / "duplicate.json"
    duplicate_path.write_text(json.dumps(duplicate), encoding="utf-8")
    with pytest.raises(compliance.TestExecutionEvidenceError, match="duplicate node ID"):
        compliance.parse_execution_evidence(duplicate_path, tmp_path)

    unknown = evidence(
        expected=[test_file],
        expected_nodes=[node(test_file)],
        terminals=[terminal(test_file, "test_unknown")],
    )
    unknown_path = tmp_path / "unknown.json"
    unknown_path.write_text(json.dumps(unknown), encoding="utf-8")
    with pytest.raises(compliance.TestExecutionEvidenceError, match="unknown expected nodes"):
        compliance.parse_execution_evidence(unknown_path, tmp_path)


def test_parse_execution_evidence_rejects_failed_outcome_without_phase_failure(
    tmp_path: Path,
) -> None:
    test_file = "suite/tests/test_fixture.py"
    report = evidence(
        expected=[test_file],
        terminals=[terminal(test_file, outcome="failed")],
        exit_status=1,
    )
    evidence_path = tmp_path / "failed-without-phase.json"
    evidence_path.write_text(json.dumps(report), encoding="utf-8")

    with pytest.raises(compliance.TestExecutionEvidenceError, match="lack phaseFailures"):
        compliance.parse_execution_evidence(evidence_path, tmp_path)


def test_check_tests_rejects_expected_node_without_terminal_outcome(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests")
    test_file = "suite/tests/test_fixture.py"
    report = evidence(
        expected=[test_file],
        expected_nodes=[node(test_file, "test_ran"), node(test_file, "test_omitted")],
        terminals=[terminal(test_file, "test_ran")],
    )
    runner = FakeRunner(
        {"suite/tests": CommandResult(0, "1 passed\n", "")},
        {"suite/tests": report},
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert '"missingNodes":["suite/tests/test_fixture.py::test_omitted"]' in output
    assert "expected nodes lacked terminal evidence" in output


def test_check_tests_emits_truthful_failed_filenames(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests", "test_pass.py")
    (tmp_path / "suite/tests/test_failure.py").write_text(
        "def test_failure():\n    assert False\n", encoding="utf-8"
    )
    failure_file = "suite/tests/test_failure.py"
    pass_file = "suite/tests/test_pass.py"
    nodes = [node(failure_file, "test_failure"), node(pass_file, "test_pass")]
    outcomes = [
        terminal(failure_file, "test_failure", outcome="failed"),
        terminal(pass_file, "test_pass"),
    ]
    failures = [{**node(failure_file, "test_failure"), "phase": "call"}]
    runner = FakeRunner(
        {"suite/tests": CommandResult(1, "1 failed, 1 passed\n", "assert False\n")},
        {
            "suite/tests": evidence(
                expected=[failure_file, pass_file],
                expected_nodes=nodes,
                terminals=outcomes,
                phase_failures=failures,
                exit_status=1,
            )
        },
    )

    assert compliance.check_tests(tmp_path, runner) is False
    output = capsys.readouterr().out
    assert '"failedFiles":["suite/tests/test_failure.py"]' in output
    assert '"discoveryMissing":[]' in output
    assert '"discoveryUnexpected":[]' in output
    assert "TESTS FAILED suite/tests: 1 file(s)" in output


def test_check_tests_parses_real_atomic_pytest_execution_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    create_owner(tmp_path, "suite/tests")

    assert compliance.check_tests(tmp_path) is True
    output = capsys.readouterr().out
    assert "EXECUTED suite/tests: 1 call-phase test cases" in output
    assert '"failedFiles":[]' in output
    assert '"discoveryMissing":[]' in output
    assert '"missingNodes":[]' in output


def test_check_tests_rejects_even_allowlisted_all_skipped_suite(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    test_file = "suite/tests/test_all_skip.py"
    node_ids = [f"{test_file}::test_first", f"{test_file}::test_second"]
    write_pyproject(
        tmp_path,
        ["suite/tests"],
        allowed_skips=[(node_id, "synthetic platform unavailable") for node_id in node_ids],
    )
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_all_skip.py").write_text(
        "import pytest\n\n"
        "@pytest.mark.skip(reason='synthetic platform unavailable')\n"
        "def test_first():\n    assert False\n\n"
        "@pytest.mark.skip(reason='synthetic platform unavailable')\n"
        "def test_second():\n    assert False\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    assert f'"allowedSkippedNodes":["{node_ids[0]}","{node_ids[1]}"]' in output
    assert '"unapprovedSkippedNodes":[]' in output
    assert "no non-skipped call-phase tests executed" in output
    assert "EXECUTED suite/tests" not in output


def test_check_tests_rejects_setup_skip_as_execution_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_setup_skip.py").write_text(
        "import pytest\n\n"
        "@pytest.fixture(autouse=True)\n"
        "def unavailable_service():\n    pytest.skip('service unavailable')\n\n"
        "def test_protected_behavior():\n    assert False\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    node_id = "suite/tests/test_setup_skip.py::test_protected_behavior"
    assert f'"unapprovedSkippedNodes":["{node_id}"]' in output
    assert f'"missingNodes":["{node_id}"]' in output
    assert "no non-skipped call-phase tests executed" in output


def test_check_tests_rejects_deselected_expected_node(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"], addopts="-k selected")
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_selection.py").write_text(
        "def test_selected():\n    assert True\n\n" "def test_hidden():\n    assert False\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    hidden = "suite/tests/test_selection.py::test_hidden"
    assert f'"deselectedNodes":["{hidden}"]' in output
    assert "expected nodes were deselected" in output


def test_check_tests_accepts_call_phase_xfail_as_executed_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_expected_failure.py").write_text(
        "import pytest\n\n"
        "@pytest.mark.xfail(reason='known defect')\n"
        "def test_known_defect():\n    assert False\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is True
    output = capsys.readouterr().out
    xfailed = "suite/tests/test_expected_failure.py::test_known_defect"
    assert f'"xfailedNodes":["{xfailed}"]' in output
    assert '"xpassedNodes":[]' in output
    assert "EXECUTED suite/tests: 1 call-phase test cases" in output


def test_check_tests_reports_xfail_and_rejects_xpass(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_expected_failure.py").write_text(
        "import pytest\n\n"
        "@pytest.mark.xfail(reason='known defect')\n"
        "def test_known_defect():\n    assert False\n\n"
        "@pytest.mark.xfail(reason='stale defect')\n"
        "def test_stale_defect():\n    assert True\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    xfailed = "suite/tests/test_expected_failure.py::test_known_defect"
    xpassed = "suite/tests/test_expected_failure.py::test_stale_defect"
    assert f'"xfailedNodes":["{xfailed}"]' in output
    assert f'"xpassedNodes":["{xpassed}"]' in output
    assert "unexpectedly passing xfail nodes" in output
    assert '"discoveryMissing":[]' in output


def test_check_tests_reports_and_rejects_unapproved_collection_skip(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    skipped_file = "suite/tests/test_optional_dependency.py"
    (owner / "test_optional_dependency.py").write_text(
        "import pytest\n\n"
        "pytest.importorskip('penny_synthetic_missing_dependency')\n\n"
        "def test_optional_path():\n    assert False\n",
        encoding="utf-8",
    )
    (owner / "test_portable.py").write_text(
        "def test_portable():\n    assert True\n", encoding="utf-8"
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    assert f'"collectionSkips":["{skipped_file} ({skipped_file})"]' in output
    assert f'"unapprovedSkippedNodes":["{skipped_file}"]' in output
    assert '"phase":"collection"' in output
    assert "skips were not exactly allowlisted" in output


def test_check_tests_reports_real_collection_error_and_truncation_state(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["suite/tests"])
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_collection_error.py").write_text(
        "raise RuntimeError('synthetic collection failure')\n", encoding="utf-8"
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    assert (
        '"collectionErrors":["suite/tests/test_collection_error.py '
        '(suite/tests/test_collection_error.py)"]' in output
    )
    assert '"collectionTruncated":' in output
    assert '"failedFiles":["suite/tests/test_collection_error.py"]' in output
    assert "collection errors were reported" in output


def test_check_tests_allows_exact_platform_skip_when_other_node_executes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    test_file = "suite/tests/test_platform.py"
    skipped_node = f"{test_file}::test_platform_only"
    reason = "requires a different platform"
    write_pyproject(
        tmp_path,
        ["suite/tests"],
        allowed_skips=[(skipped_node, reason)],
    )
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_platform.py").write_text(
        "import sys\n\n"
        "import pytest\n\n"
        f"@pytest.mark.skipif(sys.platform == {sys.platform!r}, reason={reason!r})\n"
        "def test_platform_only():\n    assert False\n\n"
        "def test_portable_path():\n    assert True\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is True
    output = capsys.readouterr().out
    assert f'"allowedSkippedNodes":["{skipped_node}"]' in output
    assert '"unapprovedSkippedNodes":[]' in output
    assert "1 explicitly allowed skip(s)" in output
    assert "EXECUTED suite/tests: 1 call-phase test cases" in output


def test_check_tests_rejects_mismatched_skip_reason_even_for_allowlisted_node(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    test_file = "suite/tests/test_platform.py"
    skipped_node = f"{test_file}::test_platform_only"
    write_pyproject(
        tmp_path,
        ["suite/tests"],
        allowed_skips=[(skipped_node, "requires Windows")],
    )
    owner = tmp_path / "suite/tests"
    owner.mkdir(parents=True)
    (owner / "test_platform.py").write_text(
        "import pytest\n\n"
        "@pytest.mark.skip(reason='unknown outage')\n"
        "def test_platform_only():\n    assert False\n\n"
        "def test_portable_path():\n    assert True\n",
        encoding="utf-8",
    )

    assert compliance.check_tests(tmp_path) is False
    output = capsys.readouterr().out
    assert f'"unapprovedSkippedNodes":["{skipped_node}"]' in output
    assert "not exactly allowlisted by node ID and reason" in output


def test_check_tests_rejects_test_ownership_paths_outside_project(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_pyproject(tmp_path, ["../outside/tests"])

    assert compliance.check_tests(tmp_path, FakeRunner({}, {})) is False
    output = capsys.readouterr().out
    assert "DISCOVERY ERROR" in output
    assert "must stay within the project" in output


def test_check_tests_rejects_malformed_live_configuration(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "pyproject.toml").write_text(
        '[tool.pytest.ini_options]\ntestpaths = "not-an-array"\n', encoding="utf-8"
    )

    assert compliance.check_tests(tmp_path, FakeRunner({}, {})) is False
    output = capsys.readouterr().out
    assert "DISCOVERY ERROR" in output
    assert "pytest testpaths must be a non-empty string array" in output


def test_check_tests_rejects_duplicate_skip_configuration(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    node_id = "suite/tests/test_fixture.py::test_fixture"
    write_pyproject(
        tmp_path,
        ["suite/tests"],
        allowed_skips=[(node_id, "first"), (node_id, "second")],
    )
    create_owner(tmp_path, "suite/tests")

    assert compliance.check_tests(tmp_path, FakeRunner({}, {})) is False
    output = capsys.readouterr().out
    assert "DISCOVERY ERROR" in output
    assert "duplicate node_id" in output


def test_main_exit_and_summary_are_truthful_for_mixed_execution_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    write_pyproject(tmp_path, ["good/tests", "bad/tests"])
    create_owner(tmp_path, "good/tests")
    create_owner(tmp_path, "bad/tests")
    bad_file = "bad/tests/test_fixture.py"
    bad_failure = [{**node(bad_file), "phase": "call"}]
    reports = {
        "good/tests": passing_report(["good/tests/test_fixture.py"], 3),
        "bad/tests": evidence(
            expected=[bad_file],
            terminals=[terminal(bad_file, outcome="failed")],
            phase_failures=bad_failure,
            exit_status=1,
        ),
    }
    runner = FakeRunner(
        {
            "good/tests": CommandResult(0, "3 passed\n", ""),
            "bad/tests": CommandResult(1, "1 failed\n", "failure\n"),
        },
        reports,
    )

    check_tests = compliance.check_tests
    monkeypatch.setattr(compliance, "check_token_budget", lambda: True)
    monkeypatch.setattr(compliance, "check_agents_links", lambda: True)
    monkeypatch.setattr(compliance, "check_tests", lambda: check_tests(tmp_path, runner))
    monkeypatch.setattr(compliance, "check_skills", lambda: True)
    monkeypatch.setattr(compliance, "check_no_raw_memory_peer", lambda: True)

    assert compliance.main() == 1
    output = capsys.readouterr().out
    assert "EXECUTED good/tests: 3 call-phase test cases" in output
    assert "TESTS FAILED bad/tests" in output
    assert '"failedFiles":["bad/tests/test_fixture.py"]' in output
    assert "❌ Failed checks: test_discovery" in output
    assert "compliance checks and Python tests succeeded" not in output


def test_main_success_confirms_independently_covered_execution(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(compliance, "check_token_budget", lambda: True)
    monkeypatch.setattr(compliance, "check_agents_links", lambda: True)
    monkeypatch.setattr(compliance, "check_tests", lambda: True)
    monkeypatch.setattr(compliance, "check_skills", lambda: True)
    monkeypatch.setattr(compliance, "check_no_raw_memory_peer", lambda: True)

    assert compliance.main() == 0
    output = capsys.readouterr().out
    assert "Configured compliance checks and Python tests succeeded" in output
    assert "matched the independent owned-test inventory" in output
