"""Validate the docs/agents/**/AGENTS.md indexing rules.

Rules enforced:
1. Every AGENTS.md under docs/agents/ must reference only its direct children:
   - A leaf .md file in the same directory.
   - A subdirectory's AGENTS.md that is a direct child of the current directory.
2. No AGENTS.md files may exist under docs/humans/.
3. Every directory under docs/agents/ that contains .md files must have an AGENTS.md.
4. All referenced files must exist.
"""

import re
import sys
from pathlib import Path

DOCS_ROOT = Path("docs")
AGENTS_ROOT = DOCS_ROOT / "agents"
HUMANS_ROOT = DOCS_ROOT / "humans"


def collect_links(text: str) -> list[tuple[str, str]]:
    return re.findall(r"\[([^\]]+)\]\(([^)]+)\)", text)


def check_direct_children_only() -> list[str]:
    errors: list[str] = []
    for agents_md in sorted(AGENTS_ROOT.rglob("AGENTS.md")):
        parent = agents_md.parent.resolve()
        text = agents_md.read_text()
        for label, target in collect_links(text):
            if target.startswith(("http://", "https://", "#")):
                continue
            resolved = (parent / target).resolve()
            try:
                rel = resolved.relative_to(parent)
            except ValueError:
                errors.append(f"{agents_md} -> [{label}]({target}) resolves outside its directory")
                continue
            parts = rel.parts
            ok = len(parts) == 1 and parts[0].endswith(".md")
            ok = ok or (len(parts) == 2 and parts[1] == "AGENTS.md")
            if not ok:
                errors.append(
                    f"{agents_md} -> [{label}]({target}) resolves to {rel} (not a direct child)"
                )
    return errors


def check_referenced_files_exist() -> list[str]:
    errors: list[str] = []
    for agents_md in sorted(AGENTS_ROOT.rglob("AGENTS.md")):
        parent = agents_md.parent
        text = agents_md.read_text()
        for label, target in collect_links(text):
            if target.startswith(("http://", "https://", "#")):
                continue
            resolved = (parent / target).resolve()
            if not resolved.exists():
                errors.append(
                    f"{agents_md} -> [{label}]({target}) points to missing file {resolved}"
                )
    return errors


def check_missing_agents_indexes() -> list[str]:
    missing: list[str] = []
    for subdir in sorted(AGENTS_ROOT.rglob("*/")):
        if subdir == AGENTS_ROOT:
            continue
        md_files = [
            f
            for f in subdir.iterdir()
            if f.is_file() and f.suffix == ".md" and f.name != "AGENTS.md"
        ]
        if md_files and not (subdir / "AGENTS.md").exists():
            missing.append(str(subdir.relative_to(AGENTS_ROOT)))
    return missing


def check_humans_agents_files() -> list[Path]:
    if not HUMANS_ROOT.exists():
        return []
    return sorted(HUMANS_ROOT.rglob("AGENTS.md"))


def main() -> int:
    ok = True

    child_errors = check_direct_children_only()
    if child_errors:
        ok = False
        print(f"FAIL: {len(child_errors)} AGENTS.md link(s) violate direct-children rule")
        for err in child_errors:
            print(f"  {err}")

    missing_files = check_referenced_files_exist()
    if missing_files:
        ok = False
        print(f"FAIL: {len(missing_files)} AGENTS.md link(s) point to missing files")
        for err in missing_files:
            print(f"  {err}")

    missing_indexes = check_missing_agents_indexes()
    if missing_indexes:
        ok = False
        print(
            f"FAIL: {len(missing_indexes)} directories under docs/agents/ have .md files but no AGENTS.md"
        )
        for path in missing_indexes:
            print(f"  {path}")

    humans_agents = check_humans_agents_files()
    if humans_agents:
        ok = False
        print(f"FAIL: {len(humans_agents)} AGENTS.md file(s) found under docs/humans/")
        for path in humans_agents:
            print(f"  {path}")

    if ok:
        print("OK: docs/agents/**/AGENTS.md structure is valid.")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
