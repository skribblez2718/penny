#!/usr/bin/env python3
"""check_public_boundary.py — CI guard for the AGENTS.md "Public repository boundary" invariant.

Penny is a PUBLIC repo: no TRACKED file may hardcode the operator's filesystem or a specific
downstream project path. Tools must reference the project root via ``ctx.project_root`` /
``$PROJECT_ROOT`` and receive every other path as a caller constraint.

The patterns are OPERATOR-SPECIFIC on purpose. A broad ``/home/`` or ``~/`` check false-positives
on synthetic test fixtures (``/home/testuser``, ``/home/x/a.md``) and legitimate generic examples
(``~/src/NodeGoat``, ``/home/comfy-ui``). Add new operator-specific vectors to FORBIDDEN as the
operator's layout grows.

Exits 0 if clean, 1 on any violation. Run standalone via ``make check-public``; also runs inside
``make test``.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

# (regex, human reason). Operator-specific leak vectors ONLY — never broad `/home/` or `~/`.
FORBIDDEN: list[tuple[str, str]] = [
    (r"/home/skribblez", "operator home directory (use $PROJECT_ROOT / ctx.project_root)"),
    (r"~/projects/", "operator project path (use $PROJECT_ROOT / ctx.project_root)"),
    (r"~/quantum", "operator content directory (pass as a caller constraint)"),
    (r"basics_of_quantum_information", "operator-specific course layout (belongs in the operator's project)"),
]

# Allowed to hold a placeholder path (the env template) or the patterns themselves (this guard).
ALLOW_PATHSPECS = [
    ":!.env.example",
    ":!scripts/system/checks/check_public_boundary.py",
]


def main() -> int:
    combined = "|".join(pat for pat, _ in FORBIDDEN)
    try:
        proc = subprocess.run(
            ["git", "grep", "-nIE", combined, "--", *ALLOW_PATHSPECS],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        print("ERROR: git not found; cannot run the public-boundary guard.")
        return 1

    # git grep: returncode 0 = matches found, 1 = none, >1 = real error.
    if proc.returncode > 1:
        print(f"ERROR: git grep failed: {proc.stderr.strip()}")
        return 1

    hits = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if hits:
        pats = [(re.compile(pat), why) for pat, why in FORBIDDEN]
        print("❌ check-public FAILED — operator-filesystem references in TRACKED files:\n")
        for ln in hits:
            content = ln.split(":", 2)[-1]
            reason = next((why for rx, why in pats if rx.search(content)), "operator path")
            print(f"   {ln.strip()[:140]}")
            print(f"       -> {reason}")
        print(
            "\nPublic-repo invariant (AGENTS.md 'Public repository boundary'):\n"
            "  reference PROJECT_ROOT via ctx.project_root / $PROJECT_ROOT; receive all other\n"
            "  paths as caller constraints; keep operator-private inputs gitignored."
        )
        return 1

    print("✅ check-public passed — no operator-filesystem references in tracked files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
