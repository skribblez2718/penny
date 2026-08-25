#!/usr/bin/env python3
"""Reject Penny tool guidance that is invisible under the custom system prompt.

Penny uses .pi/SYSTEM.md. Pi still sends each active tool's name, description,
and parameter schema through the provider-native tool channel, but it does not
render ``promptGuidelines`` in the custom-prompt branch. Required guidance must
therefore live in provider-visible descriptions/schemas or in SYSTEM.md.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterable

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
EXTENSIONS_DIR = PROJECT_ROOT / ".pi" / "extensions"
PROMPT_GUIDELINES = re.compile(r"\bpromptGuidelines\s*:")


def source_files(root: Path = EXTENSIONS_DIR) -> Iterable[Path]:
    for path in sorted(root.rglob("*.ts")):
        if "node_modules" in path.parts or "tests" in path.parts:
            continue
        yield path


def find_invisible_guidance(root: Path = EXTENSIONS_DIR) -> list[str]:
    issues: list[str] = []
    for path in source_files(root):
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if PROMPT_GUIDELINES.search(line):
                relative = path.relative_to(root)
                issues.append(
                    f"{relative}:{line_number}: promptGuidelines is invisible under Penny's "
                    "custom system prompt; move required guidance to description/schema or SYSTEM.md"
                )
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()

    issues = find_invisible_guidance()
    if issues:
        print(f"FAIL: provider-visible tool guidance ({len(issues)} issue(s))")
        for issue in issues:
            print(f"  - {issue}")
        return 1

    print("PASS: tool guidance uses provider-visible channels")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
