"""Source guards for artifact-first workers and primary-only durable memory."""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AGENTS = tuple(sorted((ROOT / ".pi" / "agents").glob("*.md")))
RESEARCH = (
    ROOT / ".pi" / "skills" / "research" / "SKILL.md",
    ROOT / ".pi" / "skills" / "research" / "README.md",
    *(sorted((ROOT / ".pi" / "skills" / "research" / "assets" / "prompts").glob("*.md"))),
)
SCOPED_AGENT_INDEXES = (
    ROOT / "docs" / "agents" / "agents" / "AGENTS.md",
    ROOT / "docs" / "agents" / "architecture" / "AGENTS.md",
    ROOT / "docs" / "agents" / "capabilities" / "AGENTS.md",
    ROOT / "docs" / "agents" / "memory" / "AGENTS.md",
    ROOT / "docs" / "agents" / "orchestration" / "AGENTS.md",
    ROOT / "docs" / "agents" / "prompts" / "AGENTS.md",
    ROOT / "docs" / "agents" / "skills" / "AGENTS.md",
    ROOT / "docs" / "agents" / "state-management" / "AGENTS.md",
)
ACTIVE_DOCS = (
    ROOT / "docs" / "agents" / "agents" / "overview.md",
    ROOT / "docs" / "agents" / "agents" / "definition-format.md",
    ROOT / "docs" / "agents" / "agents" / "discovery-and-tools.md",
    ROOT / "docs" / "agents" / "agents" / "invocation.md",
    ROOT / "docs" / "agents" / "skills" / "skill-standard.md",
    ROOT / "docs" / "agents" / "skills" / "orchestration.md",
    ROOT / "docs" / "agents" / "prompts" / "architecture.md",
    ROOT / "docs" / "agents" / "prompts" / "role-and-domain-standards.md",
    ROOT / "docs" / "humans" / "agents" / "overview.md",
    ROOT / "docs" / "humans" / "skills" / "overview.md",
    ROOT / "docs" / "humans" / "skills" / "orchestration.md",
    ROOT / "docs" / "humans" / "prompts" / "overview.md",
)
RETIRED_ACTIVE_PATTERNS = {
    "retired unconditional worker protocol": re.compile(r"m[e]mpalace" r"-first", re.IGNORECASE),
    "model-authored drawer locator": re.compile(r"m[e]mpalace_drawer", re.IGNORECASE),
    "worker memory call": re.compile(
        r"memory_(?:smart_search|add_drawer|check_duplicate|kg_add)\s*\(", re.IGNORECASE
    ),
    "memory full-output claim": re.compile(
        r"(?:full|complete) (?:output|results?|reasoning).{0,40}(?:in|to) mempalace",
        re.IGNORECASE,
    ),
    "active session-room handoff": re.compile(
        r"(?:read|write|search|communicat\w*).{0,50}session room", re.IGNORECASE
    ),
}


# The exact read-only recall subset a worker may declare. Any memory tool
# outside this set (writes, diary write, KG mutation, logstream) is a
# regression of the no-memory-channel boundary.
WORKER_READ_MEMORY_TOOLS = frozenset(
    {
        "memory_search",
        "memory_smart_search",
        "memory_get_drawer",
        "memory_list_drawers",
        "memory_get_taxonomy",
        "memory_check_duplicate",
        "memory_kg_query",
        "memory_kg_timeline",
        "memory_kg_stats",
        "memory_diary_read",
    }
)


def _frontmatter_tools(text: str) -> list[str]:
    match = re.search(r"^tools:\s*(.+)$", text, re.MULTILINE)
    assert match, "agent definition has no tools field"
    return [item.strip() for item in match.group(1).split(",")]


def test_every_worker_has_artifact_read_and_no_memory_tools_or_protocol() -> None:
    problems: list[str] = []
    for path in AGENTS:
        text = path.read_text(encoding="utf-8")
        tools = _frontmatter_tools(text)
        if "artifact_read" not in tools:
            problems.append(f"{path.name}: missing artifact_read")
        # Operator-approved 2026-08-17: workers may hold the read-only recall
        # subset. The load-bearing invariant is that no worker holds a memory
        # WRITE or logstream surface, because a write surface is what would turn
        # durable memory back into an agent-to-agent channel.
        forbidden = [
            tool
            for tool in tools
            if tool.startswith("memory_") and tool not in WORKER_READ_MEMORY_TOOLS
        ]
        if forbidden:
            problems.append(f"{path.name}: non-read memory tools {forbidden}")
        for label, pattern in RETIRED_ACTIVE_PATTERNS.items():
            if pattern.search(text):
                problems.append(f"{path.name}: {label}")
        for required in ("input_artifacts", "artifact_read", "complete"):
            if required not in text:
                problems.append(f"{path.name}: missing {required}")
    assert not problems, "worker contract regressions:\n" + "\n".join(problems)


def test_active_prompt_and_doc_surfaces_do_not_restore_semantic_memory_handoff() -> None:
    problems: list[str] = []
    for path in (*RESEARCH, *ACTIVE_DOCS):
        text = path.read_text(encoding="utf-8")
        for label, pattern in RETIRED_ACTIVE_PATTERNS.items():
            if pattern.search(text):
                problems.append(f"{path.relative_to(ROOT)}: {label}")
    assert not problems, "retired active handoff returned:\n" + "\n".join(problems)


def _load_scaffolder_module():
    path = ROOT / "scripts" / "tools" / "scaffold-skill.py"
    spec = importlib.util.spec_from_file_location("scaffold_skill", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_skill_scaffolder_generates_artifact_first_memory_optional_surfaces() -> None:
    module = _load_scaffolder_module()
    scaffolder = module.SkillScaffolder("example-skill", "Do example work", ["echo", "vera"])
    generated = {
        "SKILL.md": scaffolder._build_skill_md(),
        "README.md": scaffolder._build_readme_md(),
        "reference.md": scaffolder._build_reference_md(),
        "echo.md": scaffolder._build_prompt_md("echo", ["working_echo"]),
    }
    combined = "\n".join(generated.values())
    for required in ("input_artifacts", "output_artifact", "artifact_read", "routing data only"):
        assert required in combined
    assert "mempalace: false" in generated["SKILL.md"]
    for pattern in RETIRED_ACTIVE_PATTERNS.values():
        assert not pattern.search(combined)
    source = (ROOT / "scripts" / "tools" / "scaffold-skill.py").read_text(encoding="utf-8")
    assert "register_skill_rooms" not in source
    assert "skill_rooms.json" not in source


def test_live_skill_structure_has_no_room_manifest_requirement() -> None:
    source = (ROOT / "scripts" / "system" / "checks" / "check_skill_structure.py").read_text(
        encoding="utf-8"
    )
    assert "skill_rooms.json" not in source
    assert "check_skill_room_registration" not in source


def test_skill_room_file_is_legacy_classification_not_deletion_authority() -> None:
    path = ROOT / "scripts" / "system" / "tiered_memory" / "skill_rooms.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["classification"] == "legacy-corpus"
    comment = data["_comment"].lower()
    for required in (
        "not a live skill registry",
        "scaffolding requirement",
        "deletion authority",
        "setup and uninstall preserve",
    ):
        assert required in comment
    assert all(item.get("status") == "legacy-corpus" for item in data["skills"].values())


def test_track_a_dispatch_control_is_forward_only_and_documented() -> None:
    runtime_paths = (
        ROOT / "apps" / "orchestration" / "src" / "orchestration" / "contracts.py",
        ROOT / "apps" / "orchestration" / "src" / "orchestration" / "engine.py",
        ROOT / "apps" / "orchestration" / "src" / "orchestration" / "recovery.py",
        ROOT / ".pi" / "extensions" / "skill" / "dispatch-control.ts",
        ROOT / ".pi" / "extensions" / "skill" / "index.ts",
    )
    combined = "\n".join(path.read_text(encoding="utf-8") for path in runtime_paths)
    for forbidden in (
        "mempalace_drawer",
        "memory_smart_search(",
        "memory_add_drawer(",
        "semantic_memory_fallback",
        "semantic-memory fallback",
    ):
        assert forbidden not in combined.lower()
    for required in (
        "PENNY_ARTIFACT_DISPATCH_MODE",
        "ARTIFACT_DISPATCH_MODE_INVALID",
        "checkpoint_preserved",
    ):
        assert required in combined

    documentation = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (
            ROOT / "apps" / "orchestration" / "README.md",
            ROOT / ".pi" / "extensions" / "artifacts" / "README.md",
            ROOT / "docs" / "agents" / "orchestration" / "overview.md",
            ROOT / "docs" / "agents" / "skills" / "orchestration.md",
            ROOT / "CHANGELOG.md",
        )
    )
    for required in (
        "PENNY_ARTIFACT_DISPATCH_MODE",
        "forward-only",
        "exact artifact reads",
        "unknown",
    ):
        assert required in documentation


def test_memory_normative_doc_states_service_and_data_boundaries() -> None:
    text = (ROOT / "docs" / "agents" / "memory" / "integration.md").read_text(encoding="utf-8")
    for required in (
        "3.7.1 HTTP hub",
        "supervised",
        "Hub outage fails closed",
        "read-only recall subset",
        "skill-driver processes receive nothing",
        "Memory is neither channel",
        "copied target",
        "Uninstall",
        "typed opaque continuation",
    ):
        assert required in text


def test_scoped_agents_indexes_remain_list_only() -> None:
    problems: list[str] = []
    for path in SCOPED_AGENT_INDEXES:
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        for line in lines[1:]:
            if not line.startswith("- "):
                problems.append(f"{path.relative_to(ROOT)}: non-index line {line!r}")
    assert not problems, "AGENTS.md content drift:\n" + "\n".join(problems)
