#!/usr/bin/env python3
"""Register agent or skill documentation without duplicating runtime registries.

Local agent discovery is catalog-driven: ``.pi/agents/*.md`` frontmatter is the
project-local catalog. Remote harness or service presence belongs to its own
harness/service registry and is never inferred or registered here.

This utility creates capability docs and updates only their documentation
indexes. It never adds operational content to an ``AGENTS.md`` file and never
creates a MemPalace room, workflow handoff, or durable-memory record.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DOCS_HUMANS = PROJECT_ROOT / "docs" / "humans" / "capabilities"
DOCS_AGENTS = PROJECT_ROOT / "docs" / "agents" / "capabilities"
AGENTS_INDEX = DOCS_AGENTS / "AGENTS.md"
HUMANS_INDEX = DOCS_HUMANS / "index.md"


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


def _atomic_write(path: Path, content: str) -> None:
    """Atomically publish one complete UTF-8 text file."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _title(name: str) -> str:
    return name.replace("-", " ").title()


def _one_line(text: str, limit: int = 140) -> str:
    compact = " ".join(text.split()).replace("|", "\\|")
    return compact if len(compact) <= limit else compact[: limit - 1].rstrip() + "…"


class CapabilityIndexUpdater:
    """Update the agent-facing and human-facing capability indexes."""

    def __init__(
        self,
        agents_index: Path = AGENTS_INDEX,
        humans_index: Path = HUMANS_INDEX,
    ) -> None:
        self.agents_index = agents_index
        self.humans_index = humans_index
        self.agent_content = agents_index.read_text(encoding="utf-8")
        self.human_content = humans_index.read_text(encoding="utf-8")
        self._agent_original = self.agent_content
        self._human_original = self.human_content

    def update(self, spec: ArtifactSpec) -> Tuple[bool, str]:
        slug = _slug(spec.name)
        title = _title(slug)
        agent_link = f"{slug}/AGENTS.md"
        if f"]({agent_link})" not in self.agent_content:
            label = "Agent role" if spec.artifact_type == "agent" else "Workflow skill"
            line = f"- [{title}]({agent_link}): {label} — {_one_line(spec.description)}"
            lines = self.agent_content.rstrip().splitlines()
            lines.append(line)
            heading = lines[:2]
            entries = sorted(lines[2:], key=str.casefold)
            self.agent_content = "\n".join(heading + entries).rstrip() + "\n"

        human_link = f"{slug}/{slug}.md"
        if f"]({human_link})" not in self.human_content:
            marker = "\n## How This Index Is Organized"
            if marker not in self.human_content:
                return False, "Could not find the human capability index insertion point"
            row = f"| [{title}]({human_link}) | {_one_line(spec.description)} |\n"
            self.human_content = self.human_content.replace(marker, f"{row}{marker}", 1)
        return True, f"Indexed {slug} capability docs"

    def write(self) -> None:
        if self.agent_content != self._agent_original:
            _atomic_write(self.agents_index, self.agent_content)
        if self.human_content != self._human_original:
            _atomic_write(self.humans_index, self.human_content)

    def rollback(self) -> None:
        _atomic_write(self.agents_index, self._agent_original)
        _atomic_write(self.humans_index, self._human_original)


class DocScaffolder:
    """Create capability leaves and their index-only agent sub-index."""

    def __init__(self) -> None:
        self.humans_dir = DOCS_HUMANS
        self.agents_dir = DOCS_AGENTS

    @staticmethod
    def _publish_new(path: Path, content: str) -> Tuple[bool, Path, str]:
        if path.exists():
            return True, path, f"Kept existing {path}"
        _atomic_write(path, content)
        return True, path, f"Created {path}"

    def scaffold_human_doc(self, spec: ArtifactSpec) -> Tuple[bool, Path, str]:
        slug = _slug(spec.name)
        path = self.humans_dir / slug / f"{slug}.md"
        content = (
            self._human_agent_template(spec)
            if spec.artifact_type == "agent"
            else self._human_skill_template(spec)
        )
        return self._publish_new(path, content)

    def scaffold_agent_doc(self, spec: ArtifactSpec) -> Tuple[bool, Path, str]:
        slug = _slug(spec.name)
        directory = self.agents_dir / slug
        path = directory / f"{slug}.md"
        content = (
            self._agent_agent_template(spec)
            if spec.artifact_type == "agent"
            else self._agent_skill_template(spec)
        )
        ok, published, message = self._publish_new(path, content)
        if ok:
            index = directory / "AGENTS.md"
            self._publish_new(
                index,
                f"# {_title(slug)} Feature Index\n\n- [{_title(slug)}]({slug}.md): Operational reference\n",
            )
        return ok, published, message

    @staticmethod
    def _human_agent_template(spec: ArtifactSpec) -> str:
        slug = _slug(spec.name)
        return f"""# {_title(slug)} Agent

## What It Is

{spec.description}

## Local Catalog and Remote Presence

The local definition in `.pi/agents/{slug}.md` is part of the project-local
agent catalog. Remote harness or service availability is owned by the separate
harness/service registry; this document does not assert remote presence.

## Purpose

{spec.purpose or "[Describe the role's durable purpose.]"}

## Constraints

{spec.rules or "[Describe role-specific consequence and evidence boundaries.]"}

## Current-Run Inputs

When the execution owner grants exact artifacts, the worker reads them with
`artifact_read` and follows typed continuation until complete. Workers do not
receive durable-memory tools.

## Learn More

- Agent reference: `docs/agents/capabilities/{slug}/{slug}.md`
- Local definition: `.pi/agents/{slug}.md`
"""

    @staticmethod
    def _human_skill_template(spec: ArtifactSpec) -> str:
        slug = _slug(spec.name)
        return f"""# {_title(slug)} Skill

## What It Is

{spec.description}

## How It Works

The workflow runs as a registered TypeScript playbook. Exact current-run stage output
moves through execution-owner artifacts: workers read granted predecessors with
`artifact_read`, return complete stage content, and append only the routing
`SUMMARY` required by the state contract.

Durable memory is optional. It may preserve curated reusable knowledge, but it
is never workflow transport, run state, or persistence proof.

## Learn More

- Agent reference: `docs/agents/capabilities/{slug}/{slug}.md`
- Manifest: `.pi/skills/{slug}/SKILL.md`
"""

    @staticmethod
    def _agent_agent_template(spec: ArtifactSpec) -> str:
        slug = _slug(spec.name)
        return f"""# {_title(slug)} Agent — Operational Reference

## Catalog

- Local project catalog entry: `.pi/agents/{slug}.md`
- Remote harness/service presence: separate harness/service registry only
- Durable-memory discovery: prohibited as an availability signal

## Role Contract

{spec.rules or "[Document role-specific constraints and evidence requirements.]"}

Granted current-run artifacts are read with `artifact_read` and typed
continuation. The worker has no durable-memory tools.
"""

    @staticmethod
    def _agent_skill_template(spec: ArtifactSpec) -> str:
        slug = _slug(spec.name)
        implementation = spec.implementation_dir or f".pi/skills/{slug}/"
        return f"""# {_title(slug)} Skill — Operational Reference

## Architecture

- A registered TypeScript playbook owns states and routing.
- `OrchestrationService` handles the closed request vocabulary in-process.
- Each cognitive directive declares exact `input_artifacts` and an owner
  `output_artifact` contract.
- Workers use `artifact_read` for granted inputs and return complete stage
  content before the routing-only `SUMMARY`.
- Durable memory is optional and never carries active workflow handoff.

## Files

- `.pi/skills/{slug}/SKILL.md` — manifest
- `{implementation}` — implementation
- `.pi/skills/{slug}/assets/prompts/*.md` — domain guidance
"""


class LinkValidator:
    """Validate repository-relative Markdown and backtick paths in selected indexes."""

    def __init__(
        self, paths: Optional[List[Path]] = None, project_root: Path = PROJECT_ROOT
    ) -> None:
        self.paths = paths or [AGENTS_INDEX, HUMANS_INDEX]
        self.project_root = project_root

    def validate(self) -> Tuple[bool, List[str]]:
        errors: List[str] = []
        for source in self.paths:
            content = source.read_text(encoding="utf-8")
            candidates = re.findall(r"\[[^\]]+\]\(([^)]+)\)", content)
            candidates += re.findall(r"`((?:docs/|\.pi/|scripts/)[^`]+?)`", content)
            for value in candidates:
                if value.startswith(("http://", "https://", "#")) or "*" in value:
                    continue
                target = (
                    self.project_root / value
                    if value.startswith(("docs/", ".pi/", "scripts/"))
                    else source.parent / value.split("#", 1)[0]
                )
                if not target.exists():
                    errors.append(f"MISSING from {source}: {value}")
        return not errors, errors


class RegisterArtifact:
    """Create docs, update docs indexes, and validate links as one workflow."""

    def __init__(
        self,
        agents_index: Optional[Path] = None,
        humans_index: Optional[Path] = None,
    ) -> None:
        self.agents_index = agents_index or AGENTS_INDEX
        self.humans_index = humans_index or HUMANS_INDEX
        self.indexes = CapabilityIndexUpdater(self.agents_index, self.humans_index)
        self.scaffolder = DocScaffolder()

    def register(self, spec: ArtifactSpec) -> RegistrationResult:  # noqa: C901
        result = RegistrationResult(False, False, False, False, False)
        try:
            if spec.artifact_type not in {"agent", "skill"}:
                result.errors.append("artifact_type must be agent or skill")
                return result
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", spec.name):
                result.errors.append("name must be lowercase kebab-case")
                return result
            for field_name, value in (
                ("design_doc", spec.design_doc),
                ("implementation_dir", spec.implementation_dir),
            ):
                if value:
                    candidate = Path(value)
                    if candidate.is_absolute() or ".." in candidate.parts:
                        result.errors.append(
                            f"{field_name} must be a generic project-relative path"
                        )
                        return result

            ok, message = self.indexes.update(spec)
            if not ok:
                result.errors.append(message)
                return result
            self.indexes.write()
            result.agents_md_updated = True
            result.warnings.append(message)

            ok, _, message = self.scaffolder.scaffold_human_doc(spec)
            result.human_doc_created = ok
            (result.warnings if ok else result.errors).append(message)

            ok, _, message = self.scaffolder.scaffold_agent_doc(spec)
            result.agent_doc_created = ok
            (result.warnings if ok else result.errors).append(message)

            validator = LinkValidator(
                [self.agents_index, self.humans_index],
                project_root=self.agents_index.parents[3],
            )
            result.links_valid, link_errors = validator.validate()
            result.errors.extend(link_errors)
            result.success = not result.errors
            return result
        except Exception as exc:  # registration is an operator utility; report full failure
            try:
                self.indexes.rollback()
            except OSError:
                pass
            result.errors.append(f"Exception during registration: {exc}")
            return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Register Penny agent or skill documentation")
    parser.add_argument("artifact_type", choices=["agent", "skill"])
    parser.add_argument("--name", required=True, help="Artifact name (kebab-case)")
    parser.add_argument("--description", required=True, help="One-line description")
    parser.add_argument("--file-path", help="Local agent definition path")
    parser.add_argument("--purpose", default="")
    parser.add_argument("--rules", default="")
    parser.add_argument("--design-doc", default="")
    parser.add_argument("--implementation-dir", default="")
    parser.add_argument("--dry-run", action="store_true")
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
    if args.dry_run:
        slug = _slug(spec.name)
        print(f"Would index and scaffold capability docs for {slug}")
        print(DOCS_HUMANS / slug / f"{slug}.md")
        print(DOCS_AGENTS / slug / "AGENTS.md")
        print(DOCS_AGENTS / slug / f"{slug}.md")
        raise SystemExit(0)

    result = RegisterArtifact().register(spec)
    print(f"Registration {'SUCCEEDED' if result.success else 'FAILED'}")
    print(f"  Agent docs index updated: {result.agents_md_updated}")
    print(f"  Human doc created: {result.human_doc_created}")
    print(f"  Agent doc created: {result.agent_doc_created}")
    print(f"  Links valid: {result.links_valid}")
    for warning in result.warnings:
        print(f"  WARN: {warning}")
    for error in result.errors:
        print(f"  ERROR: {error}", file=sys.stderr)
    raise SystemExit(0 if result.success else 1)


if __name__ == "__main__":
    main()
