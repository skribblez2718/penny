"""Tests for artifact/document registration under the catalog architecture."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import register_artifact as ra  # noqa: E402


def _tree(tmp_path: Path) -> tuple[Path, Path]:
    agents = tmp_path / "docs" / "agents" / "capabilities" / "AGENTS.md"
    humans = tmp_path / "docs" / "humans" / "capabilities" / "index.md"
    agents.parent.mkdir(parents=True)
    humans.parent.mkdir(parents=True)
    agents.write_text(
        "# Capabilities Feature Index\n\n"
        "- [Existing](existing/AGENTS.md): Existing capability\n",
        encoding="utf-8",
    )
    humans.write_text(
        "# Penny Capabilities\n\n"
        "| Capability | What it does |\n"
        "| --- | --- |\n"
        "| [Existing](existing/existing.md) | Existing capability. |\n\n"
        "## How This Index Is Organized\n\nText.\n",
        encoding="utf-8",
    )
    (agents.parent / "existing").mkdir()
    (agents.parent / "existing" / "AGENTS.md").write_text(
        "# Existing Feature Index\n\n- [Existing](existing.md): Reference\n",
        encoding="utf-8",
    )
    (agents.parent / "existing" / "existing.md").write_text("# Existing\n", encoding="utf-8")
    (humans.parent / "existing").mkdir()
    (humans.parent / "existing" / "existing.md").write_text("# Existing\n", encoding="utf-8")
    return agents, humans


def test_index_updater_keeps_agents_md_as_list_only(tmp_path: Path) -> None:
    agents, humans = _tree(tmp_path)
    updater = ra.CapabilityIndexUpdater(agents, humans)
    ok, message = updater.update(
        ra.ArtifactSpec("agent", "vera-two", "Verify a supplied product against a standard")
    )
    assert ok, message
    updater.write()

    agent_text = agents.read_text(encoding="utf-8")
    assert "- [Vera Two](vera-two/AGENTS.md): Agent role" in agent_text
    assert "| Feature" not in agent_text
    assert "[Vera Two](vera-two/vera-two.md)" in humans.read_text(encoding="utf-8")


def test_agent_scaffold_states_catalog_and_remote_registry_boundary(tmp_path: Path) -> None:
    scaffolder = ra.DocScaffolder()
    scaffolder.humans_dir = tmp_path / "humans"
    scaffolder.agents_dir = tmp_path / "agents"
    spec = ra.ArtifactSpec(
        "agent",
        "reviewer",
        "Review supplied products",
        purpose="Provide evidence-based review",
        rules="READ-ONLY",
    )

    assert scaffolder.scaffold_human_doc(spec)[0]
    assert scaffolder.scaffold_agent_doc(spec)[0]
    text = (scaffolder.agents_dir / "reviewer" / "reviewer.md").read_text(encoding="utf-8")
    assert ".pi/agents/reviewer.md" in text
    assert "harness/service registry" in text
    assert "artifact_read" in text
    assert "memory_*" not in text
    index = scaffolder.agents_dir / "reviewer" / "AGENTS.md"
    assert index.read_text(encoding="utf-8").splitlines()[2].startswith("- [Reviewer]")


def test_skill_scaffold_is_artifact_first_and_memory_optional(tmp_path: Path) -> None:
    scaffolder = ra.DocScaffolder()
    scaffolder.humans_dir = tmp_path / "humans"
    scaffolder.agents_dir = tmp_path / "agents"
    spec = ra.ArtifactSpec("skill", "weather-analysis", "Analyze supplied weather data")

    assert scaffolder.scaffold_human_doc(spec)[0]
    assert scaffolder.scaffold_agent_doc(spec)[0]
    texts = [
        (scaffolder.humans_dir / "weather-analysis" / "weather-analysis.md").read_text(
            encoding="utf-8"
        ),
        (scaffolder.agents_dir / "weather-analysis" / "weather-analysis.md").read_text(
            encoding="utf-8"
        ),
    ]
    combined = "\n".join(texts)
    assert "input_artifacts" in combined
    assert "artifact_read" in combined
    assert "Durable memory is optional" in combined
    assert "session room" not in combined.lower()


def test_link_validator_checks_markdown_links(tmp_path: Path) -> None:
    agents, _ = _tree(tmp_path)
    validator = ra.LinkValidator([agents], project_root=tmp_path)
    assert validator.validate() == (True, [])
    agents.write_text(agents.read_text(encoding="utf-8") + "- [Missing](missing/AGENTS.md): x\n")
    valid, errors = validator.validate()
    assert not valid
    assert any("missing/AGENTS.md" in error for error in errors)


def test_register_skill_updates_docs_only(tmp_path: Path) -> None:
    agents, humans = _tree(tmp_path)
    registrar = ra.RegisterArtifact(agents, humans)
    registrar.scaffolder.humans_dir = humans.parent
    registrar.scaffolder.agents_dir = agents.parent
    spec = ra.ArtifactSpec("skill", "weather-analysis", "Analyze supplied weather data")

    result = registrar.register(spec)

    assert result.success, result.errors
    assert result.agents_md_updated
    assert result.human_doc_created and result.agent_doc_created and result.links_valid
    assert (agents.parent / "weather-analysis" / "AGENTS.md").exists()
    assert (humans.parent / "weather-analysis" / "weather-analysis.md").exists()


def test_invalid_name_fails_without_writes(tmp_path: Path) -> None:
    agents, humans = _tree(tmp_path)
    before = (agents.read_text(encoding="utf-8"), humans.read_text(encoding="utf-8"))
    registrar = ra.RegisterArtifact(agents, humans)
    registrar.scaffolder.humans_dir = humans.parent
    registrar.scaffolder.agents_dir = agents.parent

    result = registrar.register(ra.ArtifactSpec("agent", "Not Valid", "bad"))

    assert not result.success
    assert "kebab-case" in result.errors[0]
    assert before == (agents.read_text(encoding="utf-8"), humans.read_text(encoding="utf-8"))
