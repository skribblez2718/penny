#!/usr/bin/env python3
"""
check_skill_structure.py — Validate Penny skill directory structure against canonical conventions.

Checks every skill in .pi/skills/ for structural compliance.
Exits with code 0 if all pass, 1 if any fail.

Usage:
    python scripts/system/checks/check_skill_structure.py
    python scripts/system/checks/check_skill_structure.py --skill plan
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".pi" / "skills"

# Canonical structure (relative to skill root), engine model.
# A migrated skill's `scripts/orchestrate.py` is a ~5-line delegate into the shared
# orchestration engine (apps/orchestration/); its FSM is a BasePlaybook subclass in
# the engine package and its playbook tests live in apps/orchestration/tests/. So a
# per-skill `tests/` dir, `requirements.txt`, and `scripts/__init__.py` are OPTIONAL
# (only skills with their own domain tooling — e.g. sca, jsa — carry them).
REQUIRED_DIRS = ["scripts", "assets/prompts", "resources"]
REQUIRED_FILES = [
    "SKILL.md",
    "README.md",
    "scripts/orchestrate.py",
    "resources/reference.md",
    "resources/flow.mmd",
]


def discover_skills() -> List[Path]:
    """Find all skill directories under .pi/skills/."""
    if not SKILLS_DIR.exists():
        print(f"ERROR: Skills directory not found: {SKILLS_DIR}")
        sys.exit(1)

    skills = []
    for entry in SKILLS_DIR.iterdir():
        if entry.is_dir() and not entry.name.startswith(".") and not entry.name.startswith("_"):
            skills.append(entry)

    return sorted(skills)


def check_skill(skill_dir: Path) -> List[Tuple[str, str]]:  # noqa: C901
    """Return list of (severity, message) issues for a skill."""
    issues = []
    name = skill_dir.name

    # Skip non-skill directories (shared resources, templates, etc.)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return issues  # Not a skill — silently skip

    # Detect delegate skills (thin wrappers that delegate to another skill)
    content = skill_md.read_text(encoding="utf-8")
    is_delegate = "delegates_to:" in content

    if not is_delegate:
        # Check required directories (only for full skills, not delegates)
        for rel_dir in REQUIRED_DIRS:
            full_path = skill_dir / rel_dir
            if not full_path.exists():
                issues.append(("ERROR", f"Missing directory: {rel_dir}"))
            elif not full_path.is_dir():
                issues.append(("ERROR", f"Not a directory: {rel_dir}"))

        # Check required files (only for full skills, not delegates)
        for rel_file in REQUIRED_FILES:
            full_path = skill_dir / rel_file
            if not full_path.exists():
                issues.append(("ERROR", f"Missing file: {rel_file}"))
            elif not full_path.is_file():
                issues.append(("ERROR", f"Not a file: {rel_file}"))

        # Check for test files in tests/
        tests_dir = skill_dir / "tests"
        if tests_dir.exists() and tests_dir.is_dir():
            test_files = list(tests_dir.glob("test_*.py"))
            if not test_files:
                issues.append(("WARN", "No test_*.py files in tests/"))
        elif tests_dir.exists():
            issues.append(("ERROR", "tests/ exists but is not a directory"))

        # Check that test files are NOT in scripts/
        scripts_dir = skill_dir / "scripts"
        if scripts_dir.exists() and scripts_dir.is_dir():
            misplaced_tests = list(scripts_dir.glob("test_*.py"))
            if misplaced_tests:
                issues.append(
                    (
                        "ERROR",
                        f"Test files found in scripts/: {[f.name for f in misplaced_tests]} — move to tests/",
                    )
                )

        # Check for prompt files in assets/prompts/
        prompts_dir = skill_dir / "assets" / "prompts"
        if prompts_dir.exists() and prompts_dir.is_dir():
            prompt_files = list(prompts_dir.glob("*.md"))
            if not prompt_files:
                issues.append(("WARN", "No prompt files in assets/prompts/"))
        elif prompts_dir.exists():
            issues.append(("ERROR", "assets/prompts/ exists but is not a directory"))

    # Check SKILL.md YAML frontmatter has required fields
    skill_md = skill_dir / "SKILL.md"
    if skill_md.exists():
        content = skill_md.read_text(encoding="utf-8")
        if not content.startswith("---"):
            issues.append(("ERROR", "SKILL.md missing YAML frontmatter"))
        else:
            for field in ("name:", "description:"):
                if field not in content:
                    issues.append(("ERROR", f"SKILL.md frontmatter missing '{field}'"))

            # Validate name format: lowercase a-z, 0-9, hyphens only
            name_match = re.search(r"^name:\s*(\S+)", content, re.MULTILINE)
            if name_match:
                declared_name = name_match.group(1)
                if not re.match(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", declared_name):
                    issues.append(
                        (
                            "ERROR",
                            f"SKILL.md name '{declared_name}' contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
                        )
                    )
                elif declared_name != name:
                    issues.append(
                        (
                            "ERROR",
                            f"SKILL.md name '{declared_name}' does not match directory name '{name}'",
                        )
                    )
            else:
                issues.append(("ERROR", "SKILL.md: could not parse name field"))

            # Engine model: a full (non-delegate) skill must route through the shared
            # orchestration engine. The legacy `state_machine: true` marker is removed.
            if not is_delegate:
                if "engine: orchestration" not in content:
                    issues.append(
                        (
                            "ERROR",
                            "SKILL.md frontmatter missing 'metadata.penny.engine: orchestration' "
                            "(the routing key for engine-backed skills)",
                        )
                    )
                if re.search(r"^\s*state_machine:\s*true", content, re.MULTILINE):
                    issues.append(
                        (
                            "ERROR",
                            "SKILL.md frontmatter has legacy 'state_machine: true' — removed; use "
                            "'engine: orchestration'",
                        )
                    )

            # Validate description follows canonical trigger pattern:
            # "[sentence]. Use when [trigger conditions + signal phrases]. Do not use when [anti-cases]."
            desc_match = re.search(r"^description:\s*(.+)", content, re.MULTILINE)
            if desc_match:
                desc = desc_match.group(1).strip().strip('"')
                if "use when" not in desc.lower():
                    issues.append(
                        (
                            "ERROR",
                            "SKILL.md description missing 'Use when' — must follow: '[sentence]. Use when [trigger conditions + signal phrases]. Do not use when [anti-cases].'",
                        )
                    )
                if "do not use when" not in desc.lower():
                    issues.append(
                        (
                            "ERROR",
                            "SKILL.md description missing 'Do not use when' — must follow: '[sentence]. Use when [trigger conditions + signal phrases]. Do not use when [anti-cases].'",
                        )
                    )

        # ── Content section validation ──
        # Check required sections exist (case-insensitive header match)
        # Note: no "Storing Learnings" section — the engine records run outcomes
        # automatically against run_id; skills no longer write learnings by hand.
        required_sections = {
            "When to Use": r"^##\s+When to Use\s*$",
            "When Not to Use": r"^##\s+When\s+(?i:Not|NOT)\s+to\s+Use\s*$",
            "Invocation": r"^##\s+Invocation",
        }

        for section_name, pattern in required_sections.items():
            if not re.search(pattern, content, re.MULTILINE):
                issues.append(("ERROR", f"SKILL.md missing required section: '{section_name}'"))

        # Check for prohibited content in SKILL.md (belongs in assets/prompts/)
        prohibited = [
            (r"CREST", "CREST domain table — belongs in assets/prompts/*.md"),
            (r"Domain Guidance", "Domain Guidance references — belongs in assets/prompts/*.md"),
        ]
        for pattern, msg in prohibited:
            # Only flag if it appears in a table or structured form (not just a passing mention)
            if re.search(r"\|[^\n]*" + pattern, content):
                issues.append(("WARN", f"SKILL.md may contain {msg}"))

    return issues


def check_skill_room_registration() -> List[Tuple[str, str]]:
    """Every live skill must be registered in tiered_memory/skill_rooms.json so its
    MemPalace scratch decays. A DEDICATED-wing skill missing here silently
    re-creates the wing_jsa accretion (2,086-drawer / 77% bloat this guard exists
    to prevent); a penny-wing skill missing here is a hygiene gap."""
    issues: List[Tuple[str, str]] = []
    manifest_path = (
        PROJECT_ROOT / "scripts" / "system" / "tiered_memory" / "skill_rooms.json"
    )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [("ERROR", f"skill_rooms.json unreadable ({exc}) — scratch retention is unverified")]
    registered = manifest.get("skills", {})
    live = [
        d.name
        for d in SKILLS_DIR.iterdir()
        if d.is_dir()
        and not d.name.startswith((".", "_"))
        and (d / "SKILL.md").exists()
    ]
    for name in sorted(live):
        cfg = registered.get(name)
        if cfg is None:
            issues.append(
                (
                    "ERROR",
                    f"skill '{name}' is not registered in tiered_memory/skill_rooms.json — its "
                    'scratch will not decay (accretion risk). Add {"convention":"penny-wing"} '
                    "(or a dedicated-wing entry).",
                )
            )
            continue
        conv = cfg.get("convention")
        if conv == "dedicated-wing":
            for req in ("wing", "scratch_prefixes", "curated_rooms"):
                if req not in cfg:
                    issues.append(
                        ("ERROR", f"skill '{name}' dedicated-wing entry missing '{req}'")
                    )
        elif conv != "penny-wing":
            issues.append(
                (
                    "ERROR",
                    f"skill '{name}' has invalid convention '{conv}' in skill_rooms.json "
                    "(expected 'penny-wing' or 'dedicated-wing')",
                )
            )
    return issues


def main():
    parser = argparse.ArgumentParser(description="Validate Penny skill structure")
    parser.add_argument("--skill", help="Validate only a specific skill name")
    args = parser.parse_args()

    skills = discover_skills()
    if not skills:
        print("No skills found.")
        sys.exit(0)

    if args.skill:
        target = SKILLS_DIR / args.skill
        if target not in skills:
            print(f"ERROR: Skill not found: {args.skill}")
            sys.exit(1)
        skills = [target]

    total_errors = 0
    total_warnings = 0

    for skill_dir in skills:
        name = skill_dir.name
        issues = check_skill(skill_dir)

        if not issues:
            print(f"  ✅ {name}")
            continue

        print(f"  ⚠️  {name}")
        for severity, msg in issues:
            icon_map = {"ERROR": "❌", "WARN": "⚠️", "INFO": "ℹ️"}
            icon = icon_map.get(severity, "•")
            print(f"     {icon} {msg}")
            if severity == "ERROR":
                total_errors += 1
            elif severity == "WARN":
                total_warnings += 1

    # Global check: MemPalace scratch retention is registered for every skill.
    room_issues = check_skill_room_registration()
    if room_issues:
        print("  🗄️  MemPalace room registration (tiered_memory/skill_rooms.json)")
        for severity, msg in room_issues:
            icon_map = {"ERROR": "❌", "WARN": "⚠️", "INFO": "ℹ️"}
            print(f"     {icon_map.get(severity, '•')} {msg}")
            if severity == "ERROR":
                total_errors += 1
            elif severity == "WARN":
                total_warnings += 1

    print()
    if total_errors == 0 and total_warnings == 0:
        print(f"All {len(skills)} skill(s) passed structural validation.")
        sys.exit(0)
    else:
        print(
            f"Results: {total_errors} error(s), {total_warnings} warning(s) across {len(skills)} skill(s)."
        )
        sys.exit(1 if total_errors > 0 else 0)


if __name__ == "__main__":
    main()
