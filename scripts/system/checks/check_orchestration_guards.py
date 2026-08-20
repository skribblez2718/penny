#!/usr/bin/env python3
"""Fail-closed source guards for TypeScript-only orchestration."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "apps" / "orchestration"
RUNTIME = APP / "src"
SKILL = ROOT / ".pi" / "extensions" / "skill"

FORBIDDEN = {
    "legacy state replay": r"_force_state",
    "argv state transport": r"--state",
    "Python orchestration import": r"(?:from|import)\s+orchestration\b",
    "Python delegate": r"orchestrate\.py",
    "Python artifact child": r"orchestration\.artifact_cli",
    "legacy database selector": r"PENNY_ORCH_DB",
}


def main() -> int:
    violations: list[str] = []
    python_runtime = (
        sorted((RUNTIME / "orchestration").rglob("*.py"))
        if (RUNTIME / "orchestration").exists()
        else []
    )
    for path in python_runtime:
        violations.append(f"{path.relative_to(ROOT)}: Python orchestration runtime remains")

    files = [*RUNTIME.rglob("*.ts"), *SKILL.rglob("*.ts")]
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

    delegate = ROOT / ".pi" / "skills" / "research" / "scripts" / "orchestrate.py"
    if delegate.exists():
        violations.append(f"{delegate.relative_to(ROOT)}: executable delegate remains")

    if violations:
        print("FAIL: TypeScript-only orchestration guard")
        for violation in violations:
            print(f"  {violation}")
        return 1
    print(
        "PASS: orchestration is TypeScript-only; no delegate, Python child, or legacy DB selector"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
