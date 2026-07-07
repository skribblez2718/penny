#!/usr/bin/env python3
"""
register_artifact.py — Shared registration utility for Penny artifacts.

Updates AGENTS.md and scaffolds documentation when a new agent or skill is created.
Called by:
  - Penny post-approval (agent skill standalone mode)
  - Parent skill orchestrator (e.g., create skill sub-skill mode)

Usage:
  python3 scripts/system/register_artifact.py agent \
    --name compliance \
    --description "Audit work products against Penny standards. Use when the task requires checking a deliverable for standards compliance — signals like 'audit this', 'check against standards', 'is this compliant'. Do not use when exploring (echo) or planning (piper)." \
    --file-path .pi/agents/compliance.md \
    --purpose "Audit agent definitions, skills, and plans against Penny standards" \
    --rules "READ-ONLY: Never modify files; EVIDENCE-BASED: Every verdict cites specific evidence"

  python3 scripts/system/register_artifact.py skill \
    --name weather-analysis \
    --description "Analyze weather data and generate trend reports. Use when the task requires turning weather data into pattern reports — signals like 'analyze weather', 'weather trends', 'generate a weather report'. Do not use for live forecasting or non-weather data." \
    --skill-dir .pi/skills/weather-analysis
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

# ============================================================
# Config
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
AGENTS_MD = PROJECT_ROOT / "AGENTS.md"
DOCS_HUMANS = PROJECT_ROOT / "docs" / "humans" / "capabilities"
DOCS_AGENTS = PROJECT_ROOT / "docs" / "agents" / "capabilities"


# ============================================================
# Data Classes
# ============================================================


@dataclass
class ArtifactSpec:
    artifact_type: str  # "agent" | "skill"
    name: str
    description: str
    file_path: Optional[Path] = None
    purpose: str = ""
    rules: str = ""
    design_doc: Optional[str] = ""
    implementation_dir: Optional[str] = ""


@dataclass
class RegistrationResult:
    success: bool
    agents_md_updated: bool
    human_doc_created: bool
    agent_doc_created: bool
    links_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


# ============================================================
# AGENTS.md Updater
# ============================================================


class AgentsMdUpdater:
    """Safely update AGENTS.md structure table and Feature Index."""

    def __init__(self, path: Path = AGENTS_MD):
        self.path = path
        self.content = path.read_text(encoding="utf-8")
        self.original = self.content

    def _escape_table_cell(self, text: str) -> str:
        """Escape pipe characters in table cells."""
        return text.replace("|", "\\|")

    def update_structure_table(self, spec: ArtifactSpec) -> Tuple[bool, str]:
        """Add the artifact to the Structure table if it's an agent."""
        if spec.artifact_type != "agent":
            return True, "Only agents appear in Structure table — skipped"

        # Find the .pi/agents/ row — flexible regex for different path formats
        pattern = r"(\|\s*`.*/\.pi/agents/`\s*\|\s*Agent definitions \(runtime\) — .*? \|)"
        match = re.search(pattern, self.content)
        if not match:
            # Fallback: try without full path
            pattern = r"(\|\s*`.pi/agents/`\s*\|\s*Agent definitions \(runtime\) — .*? \|)"
            match = re.search(pattern, self.content)
        if not match:
            return False, "Could not find .pi/agents/ row in Structure table"

        old_row = match.group(1)
        # Extract existing agent names from the row
        names_match = re.search(r"—\s*(.*?)\s*\|", old_row)
        if not names_match:
            return False, "Could not parse agent names from .pi/agents/ row"

        existing = names_match.group(1).strip()
        # Check if already present
        if f"`{spec.name}.md`" in existing:
            return True, f"`{spec.name}.md` already present in .pi/agents/ row"

        new_names = f"{existing}, `{spec.name}.md`"
        new_row = old_row.replace(existing, new_names)
        self.content = self.content.replace(old_row, new_row)
        return True, f"Added `{spec.name}.md` to .pi/agents/ row"

    def update_feature_index(self, spec: ArtifactSpec) -> Tuple[bool, str]:
        """Add a Feature Index entry for the artifact."""
        # Find the last row of the Feature Index table
        table_end = self.content.rfind("| Tiered Memory |")
        if table_end == -1:
            return False, "Could not find Feature Index table"

        # Find the end of that row
        line_end = self.content.find("\n", table_end)
        if line_end == -1:
            line_end = len(self.content)

        if spec.artifact_type == "agent":
            human_doc = f"`docs/humans/capabilities/{spec.name}/{spec.name}.md`"
            agent_doc = f"`docs/agents/capabilities/{spec.name}/{spec.name}.md`"
            design = "`N/A`"
            impl = f"`.pi/agents/{spec.name}.md`"
        else:  # skill
            human_doc = f"`docs/humans/capabilities/{spec.name}/{spec.name}.md`"
            agent_doc = f"`docs/agents/capabilities/{spec.name}/{spec.name}.md`"
            design = (
                f"`.pi/skills/{spec.name}/README.md`"
                if not spec.design_doc
                else f"`{spec.design_doc}`"
            )
            impl = (
                f"`.pi/skills/{spec.name}/`"
                if not spec.implementation_dir
                else f"`{spec.implementation_dir}`"
            )

        # Escape description to avoid breaking table formatting
        desc = self._escape_table_cell(spec.description)
        if len(desc) > 80:
            desc = desc[:77] + "..."

        new_row = f"| {spec.name.replace('-', ' ').title().replace(' ', '-')} | {human_doc} | {agent_doc} | {design} | {impl} |\n"

        self.content = self.content[:line_end] + "\n" + new_row + self.content[line_end:]
        return True, f"Added Feature Index row for {spec.name}"

    def write(self) -> None:
        """Write changes back to disk."""
        if self.content != self.original:
            self.path.write_text(self.content, encoding="utf-8")

    def rollback(self) -> None:
        """Restore original content."""
        self.path.write_text(self.original, encoding="utf-8")


# ============================================================
# Doc Scaffolder
# ============================================================


class DocScaffolder:
    """Scaffold human and agent docs from artifact metadata."""

    def __init__(self):
        self.humans_dir = DOCS_HUMANS
        self.agents_dir = DOCS_AGENTS

    def _slug(self, name: str) -> str:
        return name.lower().replace(" ", "-")

    def scaffold_human_doc(self, spec: ArtifactSpec) -> Tuple[bool, Path, str]:
        """Create docs/humans/capabilities/<name>/<name>.md"""
        slug = self._slug(spec.name)
        dir_path = self.humans_dir / slug
        dir_path.mkdir(parents=True, exist_ok=True)
        file_path = dir_path / f"{slug}.md"

        if spec.artifact_type == "agent":
            content = self._human_agent_template(spec)
        else:
            content = self._human_skill_template(spec)

        file_path.write_text(content, encoding="utf-8")
        return True, file_path, f"Created {file_path}"

    def scaffold_agent_doc(self, spec: ArtifactSpec) -> Tuple[bool, Path, str]:
        """Create docs/agents/capabilities/<name>/<name>.md"""
        slug = self._slug(spec.name)
        dir_path = self.agents_dir / slug
        dir_path.mkdir(parents=True, exist_ok=True)
        file_path = dir_path / f"{slug}.md"

        if spec.artifact_type == "agent":
            content = self._agent_agent_template(spec)
        else:
            content = self._agent_skill_template(spec)

        file_path.write_text(content, encoding="utf-8")
        return True, file_path, f"Created {file_path}"

    def _human_agent_template(self, spec: ArtifactSpec) -> str:
        title = spec.name.replace("-", " ").title()
        return f"""# {title} Agent

## What It Is

{spec.description}

## When to Use

- [Add specific use cases based on the agent's purpose]

## When Not to Use

- [Add exclusions based on the agent's constraints]

## Key Capabilities

- {spec.purpose}

## Constraints

{spec.rules}

## Learn More

- Agent docs: `docs/agents/capabilities/{spec.name}/{spec.name}.md`
- Definition: `.pi/agents/{spec.name}.md`
"""

    def _human_skill_template(self, spec: ArtifactSpec) -> str:
        title = spec.name.replace("-", " ").title()
        return f"""# {title} Skill

## What It Is

{spec.description}

## When to Use

- [Add specific use cases]

## When Not to Use

- [Add exclusions]

## How It Works

- [High-level workflow description]

## Constraints

| Constraint | Meaning |
|-----------|---------|
| [Add constraints] | [Descriptions] |

## Learn More

- Agent docs: `docs/agents/capabilities/{spec.name}/{spec.name}.md`
- Implementation: `.pi/skills/{spec.name}/`
"""

    def _agent_agent_template(self, spec: ArtifactSpec) -> str:
        title = spec.name.replace("-", " ").title()
        return f"""# {title} Agent — Agent Implementation Notes

## Architecture

- **Role**: [Agent role based on purpose]
- **Tools**: [List tools from definition]
- **Model**: [Model from definition]

## Key Rules

{spec.rules}

## Prompt Architecture Compliance

- **Agent definition** (`.pi/agents/{spec.name}.md`) is the **Role Definition** layer
- Domain Guidance is injected via `assets/prompts/` when used in skills
- No domain-specific content in SYSTEM.md

## Files

- `.pi/agents/{spec.name}.md` — role definition
"""

    def _agent_skill_template(self, spec: ArtifactSpec) -> str:
        title = spec.name.replace("-", " ").title()
        return f"""# {title} Skill — Agent Implementation Notes

## Architecture

Hybrid extension + Python orchestrator:
- **Skill extension** (`skill` tool): Routes orchestrator actions
- **Python state machine** (`scripts/orchestrate.py`): Drives the workflow

## Key Rules

1. **Penny is a router in the skill loop** — she sees agent names and session IDs, never full prompts/results
2. **All substantial data flows through mempalace** — agents read/write it directly
3. **Approve/Refine cycle is mandatory** — never execute before user approval
4. **TDD enforced** — unit, integration, and E2E tests required
5. **Lint clean** — `orchestrate.py` passes `flake8`

## Files

- `.pi/skills/{spec.name}/SKILL.md` — skill manifest
- `.pi/skills/{spec.name}/scripts/orchestrate.py` — state machine
- `.pi/skills/{spec.name}/assets/prompts/*.md` — domain guidance
- `.pi/skills/{spec.name}/scripts/test_*.py` — tests
"""


# ============================================================
# Link Validator
# ============================================================


class LinkValidator:
    """Validate that AGENTS.md references resolve to existing files."""

    def __init__(self, agents_md: Path = AGENTS_MD):
        self.agents_md = agents_md
        self.project_root = agents_md.parent

    def validate(self) -> Tuple[bool, List[str]]:
        """Return (all_valid, list_of_errors)."""
        content = self.agents_md.read_text(encoding="utf-8")
        errors = []

        # Find all backtick-quoted paths starting with docs/ or .pi/ or scripts/
        paths = re.findall(r"`((?:docs/|\.pi/|scripts/)[^`]+?)`", content)

        for path_str in paths:
            # Skip wildcards and non-file references
            if "*" in path_str or path_str.endswith("/"):
                continue
            full_path = self.project_root / path_str
            if not full_path.exists():
                errors.append(f"MISSING: {path_str}")

        return len(errors) == 0, errors


# ============================================================
# Main Orchestrator
# ============================================================


class RegisterArtifact:
    """High-level registration workflow."""

    def __init__(self, agents_md: Optional[Path] = None):
        self.agents_md = agents_md or AGENTS_MD
        self.agents_updater = AgentsMdUpdater(self.agents_md)
        self.scaffolder = DocScaffolder()
        self.validator = LinkValidator(self.agents_md)

    def register(self, spec: ArtifactSpec) -> RegistrationResult:
        result = RegistrationResult(
            success=False,
            agents_md_updated=False,
            human_doc_created=False,
            agent_doc_created=False,
            links_valid=False,
        )

        try:
            # 1. Update AGENTS.md
            ok, msg = self.agents_updater.update_structure_table(spec)
            if not ok:
                result.errors.append(f"Structure table: {msg}")
            else:
                result.warnings.append(msg)

            ok, msg = self.agents_updater.update_feature_index(spec)
            if not ok:
                result.errors.append(f"Feature Index: {msg}")
            else:
                result.warnings.append(msg)

            if result.errors:
                self.agents_updater.rollback()
                return result

            self.agents_updater.write()
            result.agents_md_updated = True

            # 2. Scaffold docs
            ok, path, msg = self.scaffolder.scaffold_human_doc(spec)
            if ok:
                result.human_doc_created = True
                result.warnings.append(msg)
            else:
                result.errors.append(msg)

            ok, path, msg = self.scaffolder.scaffold_agent_doc(spec)
            if ok:
                result.agent_doc_created = True
                result.warnings.append(msg)
            else:
                result.errors.append(msg)

            # 3. Validate links
            valid, link_errors = self.validator.validate()
            result.links_valid = valid
            if not valid:
                result.errors.extend(link_errors)

            result.success = len(result.errors) == 0
            return result

        except Exception as e:
            self.agents_updater.rollback()
            result.errors.append(f"Exception during registration: {e}")
            return result


# ============================================================
# CLI
# ============================================================


def main():
    parser = argparse.ArgumentParser(description="Register a Penny artifact (agent or skill)")
    parser.add_argument("artifact_type", choices=["agent", "skill"], help="Type of artifact")
    parser.add_argument("--name", required=True, help="Artifact name (kebab-case)")
    parser.add_argument("--description", required=True, help="1-2 sentence description")
    parser.add_argument("--file-path", help="Path to the artifact file (for agents)")
    parser.add_argument("--purpose", default="", help="Agent purpose or skill goal")
    parser.add_argument("--rules", default="", help="Key rules/constraints")
    parser.add_argument("--design-doc", default="", help="Path to design documentation")
    parser.add_argument("--implementation-dir", default="", help="Path to implementation directory")
    parser.add_argument(
        "--dry-run", action="store_true", help="Show what would change without writing"
    )

    args = parser.parse_args()

    spec = ArtifactSpec(
        artifact_type=args.artifact_type,
        name=args.name,
        description=args.description,
        file_path=Path(args.file_path) if args.file_path else None,
        purpose=args.purpose,
        rules=args.rules,
        design_doc=args.design_doc,
        implementation_dir=args.implementation_dir,
    )

    registrar = RegisterArtifact()
    result = registrar.register(spec)

    print(f"Registration {'SUCCEEDED' if result.success else 'FAILED'}")
    print(f"  AGENTS.md updated: {result.agents_md_updated}")
    print(f"  Human doc created: {result.human_doc_created}")
    print(f"  Agent doc created: {result.agent_doc_created}")
    print(f"  Links valid: {result.links_valid}")

    if result.warnings:
        print("\nWarnings:")
        for w in result.warnings:
            print(f"  ⚠ {w}")

    if result.errors:
        print("\nErrors:")
        for e in result.errors:
            print(f"  ✗ {e}")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
