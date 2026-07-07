#!/usr/bin/env python3
"""check_orchestration_guards.py — CI guards for the orchestration package.

Enforces the overhaul's invariants (pack 06-technical-reference.md §16):
  * ZERO ``_force_state`` in apps/orchestration/src (no transition-replay).
  * ZERO ``--state`` argv handling in apps/orchestration/src (state lives in the
    durable checkpointer, keyed by run_id).

Exits 0 if clean, 1 on any violation. Scans .py sources only (ignores caches).
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "apps" / "orchestration" / "src"

# Literal tokens that must never appear in the package source.
FORBIDDEN = {
    "_force_state": r"_force_state",
    "--state": r"--state",
}


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: orchestration src not found: {SRC}")
        return 1

    violations: list[str] = []
    for py in sorted(SRC.rglob("*.py")):
        if "__pycache__" in py.parts:
            continue
        text = py.read_text(encoding="utf-8")
        for label, pattern in FORBIDDEN.items():
            for i, line in enumerate(text.splitlines(), 1):
                if re.search(pattern, line):
                    rel = py.relative_to(ROOT)
                    violations.append(f"{rel}:{i}: forbidden '{label}' -> {line.strip()}")

    if violations:
        print("❌ orchestration CI guards FAILED:")
        for v in violations:
            print(f"   {v}")
        print(
            "\nState must live in the durable checkpointer (keyed by run_id); "
            "never reintroduce --state argv transport or _force_state replay."
        )
        return 1

    print(
        "✅ orchestration CI guards passed (zero _force_state, zero --state in apps/orchestration/src)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
