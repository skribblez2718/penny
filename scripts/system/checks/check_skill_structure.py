#!/usr/bin/env python3
"""
check_skill_structure.py — Validate Penny skill directory structure against canonical conventions.

Checks every skill in .pi/skills/ for structural compliance.
Exits with code 0 if all pass, 1 if any fail.

Usage:
    python scripts/system/checks/check_skill_structure.py
    python scripts/system/checks/check_skill_structure.py --skill research
"""

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".pi" / "skills"

# Canonical structure (relative to skill root), TypeScript engine model.
# Engine-backed skills dispatch through the TypeScript playbook registry; no
# per-skill executable delegate exists. Domain-only tooling and tests remain optional.
REQUIRED_DIRS = ["assets/prompts", "resources"]
REQUIRED_FILES = [
    "SKILL.md",
    "README.md",
]
# A flow diagram (state machine mirror) IS required. resources/flow.html (the
# self-contained interactive HTML) is THE standard; the legacy mermaid
# resources/flow.mmd is still accepted for not-yet-migrated skills but is
# deprecated (WARN). Other resource files have NO mandated filename.
FLOW_DIAGRAM_HTML = "resources/flow.html"
FLOW_DIAGRAM_MMD = "resources/flow.mmd"
DESCRIPTION_HARD_LIMIT = 1024
DESCRIPTION_PREFERRED_LIMIT = 500

KB_DESCRIPTION = (
    "Private advisory knowledge-base workflows. Use when the operator explicitly asks to "
    "initialize, ingest approved sources, query, save, lint, inspect, resume, or prepare "
    "promotion for a configured KB profile. Do not use for canonical current-state lookup "
    "without verification, automatic research ingestion, arbitrary filesystem access, or "
    "unapproved canonical writes."
)
KB_ACTIONS = ["init", "ingest", "query", "save", "lint", "promote", "status", "resume"]
KB_SUBAGENTS = ["echo", "synthia", "carren", "vera", "piper", "skribble"]
KB_INVOCATION_FIXTURES = [
    'knowledge_base({schema_version: 1, action: "init", kb_profile_id: "kbp_demo", create: true, title: "Demo advisory KB"})',
    'knowledge_base({schema_version: 1, action: "ingest", kb_profile_id: "kbp_demo", source_capability_ids: ["src_cap_1"]})',
    'knowledge_base({schema_version: 1, action: "query", kb_profile_id: "kbp_demo", query: "...", answer_delivery: "artifact_ref"})',
    'knowledge_base({schema_version: 1, action: "query", kb_profile_id: "kbp_demo", query: "...", answer_delivery: "parent_tool_result"}) // requires exact ParentDeliveryGrantV1 + policy',
    'knowledge_base({schema_version: 1, action: "save", kb_profile_id: "kbp_demo", query_run_id: "run_1", page_kind: "synthesis", title: "..."})',
    'knowledge_base({schema_version: 1, action: "lint", kb_profile_id: "kbp_demo", mode: "deterministic_and_semantic"})',
    'knowledge_base({schema_version: 1, action: "promote", kb_profile_id: "kbp_demo", page_revisions: [{page_id: "page_1", revision_id: "rev_1"}], canonical_target_capability_ids: ["target_cap_1"]})',
    'knowledge_base({schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_1"})',
    'knowledge_base({schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_1"})',
]


def parse_frontmatter(content: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    match = re.match(r"^---\n(.*?)\n---(?:\n|$)", content, re.DOTALL)
    if match is None:
        return None, "SKILL.md missing or malformed YAML frontmatter"
    try:
        parsed = yaml.safe_load(match.group(1))
    except yaml.YAMLError as error:
        return None, f"SKILL.md frontmatter is invalid YAML: {error}"
    if not isinstance(parsed, dict):
        return None, "SKILL.md frontmatter must be a YAML mapping"
    return parsed, None


def nested_mapping(value: object, *keys: str) -> Optional[Dict[str, Any]]:
    current: object = value
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current if isinstance(current, dict) else None


def check_kb_pi_tool_contract(
    skill_dir: Path, content: str, frontmatter: Dict[str, Any]
) -> List[Tuple[str, str]]:
    issues: List[Tuple[str, str]] = []
    penny = nested_mapping(frontmatter, "metadata", "penny")
    expected = {
        "name": "knowledge-base",
        "description": KB_DESCRIPTION,
        "license": "MIT",
        "metadata": {
            "version": "1.0.0",
            "penny": {
                "engine": "orchestration",
                "entrypoint": "pi-tool",
                "tool": "knowledge_base",
                "mempalace": "metadata-only",
                "subagents": KB_SUBAGENTS,
                "actions": KB_ACTIONS,
            },
        },
    }
    if frontmatter != expected:
        issues.append(
            (
                "ERROR",
                "knowledge_base pi-tool frontmatter fields/values are not the exact Section 5.12 contract",
            )
        )
    if list(frontmatter.keys()) != ["name", "description", "license", "metadata"]:
        issues.append(("ERROR", "knowledge_base frontmatter top-level field order changed"))
    if penny is not None and list(penny.keys()) != [
        "engine",
        "entrypoint",
        "tool",
        "mempalace",
        "subagents",
        "actions",
    ]:
        issues.append(("ERROR", "knowledge_base metadata.penny field order changed"))

    invocation = re.search(
        r"^## Invocation\s*$.*?^```ts\n(.*?)\n```",
        content,
        re.MULTILINE | re.DOTALL,
    )
    actual = [] if invocation is None else invocation.group(1).splitlines()
    if actual != KB_INVOCATION_FIXTURES:
        issues.append(
            (
                "ERROR",
                "knowledge_base invocation fixtures/field order are not the exact Section 5.12 sequence",
            )
        )

    readme_path = skill_dir / "README.md"
    if readme_path.is_file():
        readme = readme_path.read_text(encoding="utf-8")
        table = re.search(
            r"^## Order rules and prevented failure modes\s*$\n\n"
            r"\|\s*Order rule\s*\|\s*Failure mode it prevents\s*\|\n"
            r"\|[-: ]+\|[-: ]+\|\n"
            r"((?:\|[^\n]+\|\n?)+)",
            readme,
            re.MULTILINE,
        )
        if (
            table is None
            or len([line for line in table.group(1).splitlines() if line.strip()]) == 0
        ):
            issues.append(
                (
                    "ERROR",
                    "knowledge_base README missing the required order-rule to failure-mode table",
                )
            )
    return issues


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
    issues: List[Tuple[str, str]] = []
    name = skill_dir.name

    # Skip non-skill directories (shared resources, templates, etc.)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return issues  # Not a skill — silently skip

    # Parse YAML once; substring matching is not a contract validator.
    content = skill_md.read_text(encoding="utf-8")
    frontmatter, frontmatter_error = parse_frontmatter(content)
    if frontmatter_error is not None:
        issues.append(("ERROR", frontmatter_error))
    is_delegate = frontmatter is not None and "delegates_to" in frontmatter

    if not is_delegate:
        penny = nested_mapping(frontmatter or {}, "metadata", "penny")
        entrypoint_value = None if penny is None else penny.get("entrypoint")
        entrypoint = (
            entrypoint_value if isinstance(entrypoint_value, str) else "typescript-playbook"
        )

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

        if entrypoint == "pi-tool":
            # pi-tool skills need a non-empty metadata.penny.tool.
            tool = None if penny is None else penny.get("tool")
            if not isinstance(tool, str) or not tool:
                issues.append(("ERROR", "pi-tool skill missing metadata.penny.tool"))
            elif tool == "knowledge_base" and frontmatter is not None:
                issues.extend(check_kb_pi_tool_contract(skill_dir, content, frontmatter))

        # Flow diagram: resources/flow.html is THE standard. Require a diagram; a skill
        # still shipping only the legacy resources/flow.mmd gets a WARN to migrate.
        has_html = (skill_dir / FLOW_DIAGRAM_HTML).is_file()
        has_mmd = (skill_dir / FLOW_DIAGRAM_MMD).is_file()
        if not (has_html or has_mmd):
            issues.append(
                ("ERROR", "Missing flow diagram: expected resources/flow.html (the standard)")
            )
        elif not has_html and has_mmd:
            issues.append(
                (
                    "WARN",
                    "Legacy resources/flow.mmd — convert to resources/flow.html (the "
                    "standard) and delete the .mmd (see docs/agents/skills/flow-diagrams.md)",
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

    # Check parsed SKILL.md YAML frontmatter has required fields.
    if frontmatter is not None:
        for field in ("name", "description"):
            if field not in frontmatter:
                issues.append(("ERROR", f"SKILL.md frontmatter missing '{field}:'"))

        declared_name = frontmatter.get("name")
        if isinstance(declared_name, str):
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
            issues.append(("ERROR", "SKILL.md: name field must be a string"))

        # Engine model: a full (non-delegate) skill must route through the shared
        # orchestration engine. The legacy `state_machine` key is removed.
        if not is_delegate:
            penny = nested_mapping(frontmatter, "metadata", "penny")
            if penny is None or penny.get("engine") != "orchestration":
                issues.append(
                    (
                        "ERROR",
                        "SKILL.md frontmatter missing 'metadata.penny.engine: orchestration' "
                        "(the routing key for engine-backed skills)",
                    )
                )
            if penny is not None and "state_machine" in penny:
                issues.append(
                    (
                        "ERROR",
                        "SKILL.md frontmatter has legacy 'state_machine' — removed; use "
                        "'engine: orchestration'",
                    )
                )

        # Validate description follows the canonical trigger pattern.
        description = frontmatter.get("description")
        if isinstance(description, str):
            desc = description
            if len(desc) > DESCRIPTION_HARD_LIMIT:
                issues.append(
                    (
                        "ERROR",
                        f"SKILL.md description is {len(desc)} chars, above the hard limit of "
                        f"{DESCRIPTION_HARD_LIMIT}",
                    )
                )
            elif len(desc) > DESCRIPTION_PREFERRED_LIMIT:
                issues.append(
                    (
                        "WARN",
                        f"SKILL.md description is {len(desc)} chars, above the preferred "
                        f"target of {DESCRIPTION_PREFERRED_LIMIT}; retain the extra text only "
                        "when it improves routing",
                    )
                )
            if "use when" not in desc.lower():
                issues.append(
                    (
                        "ERROR",
                        "SKILL.md description missing 'Use when' — must follow: '[sentence]. Use when [trigger conditions + signal phrases]. Do not use when [anti-cases].'",
                    )
                )
            anti_case_markers = ("do not use", "don't use", "do not apply", "avoid using")
            if not any(marker in desc.lower() for marker in anti_case_markers):
                issues.append(
                    (
                        "ERROR",
                        "SKILL.md description missing an anti-case clause — include 'Do not use …' "
                        "(e.g. 'Do not use when/for/to …') describing when NOT to use this skill.",
                    )
                )
        elif "description" in frontmatter:
            issues.append(("ERROR", "SKILL.md description field must be a string"))

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


def main() -> None:  # noqa: C901
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
