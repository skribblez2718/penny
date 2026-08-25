#!/usr/bin/env python3
"""Fail-closed source guards and G10 inventory for TypeScript-only orchestration."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "apps" / "orchestration"
RUNTIME = APP / "src"
SKILL = ROOT / ".pi" / "extensions" / "skill"
OBSERVABILITY_APP = ROOT / "apps" / "observability"
OBSERVABILITY_EXTENSION = ROOT / ".pi" / "extensions" / "observability"
RETIREMENT_COMMIT = "d6c1ae96191e81aeaae7ff6e275b88e465483eaf"

FORBIDDEN = {
    "legacy state replay": r"_force_state",
    "argv state transport": r"--state",
    "Python orchestration import": r"(?:from|import)\s+orchestration\b",
    "Python delegate": r"orchestrate\.py",
    "Python artifact child": r"orchestration\.artifact_cli",
    "legacy unpersisted prose control parser": r"parseSummaryFrom(?:Output|Text)",
}

RETIRED_PATHS = (
    ".pi/extensions/skill/engine-selection.ts",
    ".pi/skills/research/scripts/orchestrate.py",
    "apps/orchestration/pyproject.toml",
    "apps/orchestration/src/orchestration",
    "apps/orchestration/tests/python-parity-map.test.ts",
)


def source_violations() -> list[str]:  # noqa: C901 - one deterministic source audit
    violations: list[str] = []
    python_runtime = (
        sorted((RUNTIME / "orchestration").rglob("*.py"))
        if (RUNTIME / "orchestration").exists()
        else []
    )
    for path in python_runtime:
        violations.append(f"{path.relative_to(ROOT)}: Python orchestration runtime remains")

    files = [*RUNTIME.rglob("*.ts"), *SKILL.rglob("*.ts")]
    retired_selectors = ("PENNY_ORCH_DB", "PENNY_ORCH_V2_DB", "PENNY_ARTIFACT_ROOT")
    for path in sorted(files):
        if "node_modules" in path.parts or "tests" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for label, pattern in FORBIDDEN.items():
            for line_number, line in enumerate(text.splitlines(), 1):
                if re.search(pattern, line):
                    violations.append(
                        f"{path.relative_to(ROOT)}:{line_number}: forbidden {label}: {line.strip()}"
                    )
        for selector in retired_selectors:
            if selector not in text:
                continue
            if path == RUNTIME / "config.ts":
                continue
            violations.append(
                f"{path.relative_to(ROOT)}: retired state selector remains outside config refusal"
            )
        for line_number, line in enumerate(text.splitlines(), 1):
            if ".penny" in line:
                violations.append(
                    f"{path.relative_to(ROOT)}:{line_number}: project-local .penny runtime path remains"
                )

    for relative in RETIRED_PATHS:
        if (ROOT / relative).exists():
            violations.append(f"{relative}: retired orchestration surface remains")

    app_python_tests = sorted(str(path.relative_to(ROOT)) for path in (APP / "tests").rglob("*.py"))
    for relative in app_python_tests:
        violations.append(f"{relative}: Python orchestration test remains")

    observability_python = sorted(OBSERVABILITY_APP.rglob("*.py"))
    for path in observability_python:
        violations.append(f"{path.relative_to(ROOT)}: retired Python observability remains")
    observability_sources = [
        *OBSERVABILITY_APP.rglob("*.ts"),
        *OBSERVABILITY_EXTENSION.rglob("*.ts"),
    ]
    for path in observability_sources:
        if "tests" in path.parts or "dist" in path.parts or "node_modules" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for retired in (
            "PI_OBSERVABILITY_URL",
            "PI_OBSERVABILITY_DATA_DIR",
            "WebSocket",
            "/orchestration/runs",
            "/orchestration/events",
        ):
            if retired in text:
                violations.append(
                    f"{path.relative_to(ROOT)}: retired observability surface remains: {retired}"
                )

    root_pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    if re.search(r"apps/orchestration", root_pyproject):
        violations.append(
            "pyproject.toml: orchestration remains a Python workspace/package consumer"
        )
    if "penny-observability" in root_pyproject or "apps/observability" in root_pyproject:
        violations.append("pyproject.toml: retired Python observability workspace remains")
    return violations


def inventory() -> dict[str, object]:
    current_ts_tests = sorted(
        str(path.relative_to(ROOT)) for path in (APP / "tests").rglob("*.test.ts")
    )
    production_refs: list[str] = []
    patterns = re.compile(
        r"orchestrate\.py|PENNY_ORCHESTRATION_ENGINE|pythonStart|pythonStep|pythonRecover|"
        r"orchestration\.artifact_cli|parseSummaryFrom(?:Output|Text)"
    )
    roots = (ROOT / ".pi", APP / "src")
    for base in roots:
        for path in sorted(base.rglob("*")):
            if not path.is_file() or "node_modules" in path.parts or "tests" in path.parts:
                continue
            if path.suffix not in {".ts", ".js", ".json", ".md"}:
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if patterns.search(line):
                    production_refs.append(f"{path.relative_to(ROOT)}:{number}")

    result: dict[str, object] = {
        "schema_version": 1,
        "gate": "G10",
        "retirement_commit": RETIREMENT_COMMIT,
        "operator_authorized_at": "2026-08-20",
        "prior_final_python_test_disposition_count": 531,
        "current_python_pending_runs": 0,
        "current_python_runtime_files": [],
        "current_python_test_node_ids": [],
        "retired_paths": list(RETIRED_PATHS),
        "retired_paths_still_present": [
            relative for relative in RETIRED_PATHS if (ROOT / relative).exists()
        ],
        "production_consumer_hits": production_refs,
        "current_typescript_test_files": current_ts_tests,
        "replacement_matrix": {
            "runtime_and_checkpoint_owner": "apps/orchestration/src TypeScript engine/checkpointer",
            "skill_single_parallel_chain_resume": ".pi/extensions/skill TypeScript adapter",
            "artifact_owner_operations": ".pi/extensions/artifacts TypeScript owner service",
            "research_behavior": "apps/orchestration/tests/research-parity.test.ts",
            "recovery_and_receipts": "apps/orchestration/tests/core-runtime.test.ts and safety.test.ts",
        },
        "old_database_disposition": "preserved_private_archive_no_conversion_or_resume",
    }
    canonical = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    result["inventory_sha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pending-engine", choices=["python"])
    parser.add_argument("--inventory-output", type=Path)
    args = parser.parse_args()

    violations = source_violations()
    if violations:
        print("FAIL: TypeScript-only orchestration guard")
        for violation in violations:
            print(f"  {violation}")
        return 1

    evidence = inventory()
    if args.pending_engine == "python":
        print(
            json.dumps(
                {
                    "schema_version": 1,
                    "engine": "python",
                    "pending": evidence["current_python_pending_runs"],
                    "runtime_present": False,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
    else:
        print(
            "PASS: orchestration is TypeScript-only; no delegate, Python child, "
            "legacy unpersisted prose parser, legacy DB selector, or Python/WebSocket observability"
        )

    if args.inventory_output is not None:
        output = args.inventory_output
        if not output.is_absolute():
            output = ROOT / output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"inventory={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
