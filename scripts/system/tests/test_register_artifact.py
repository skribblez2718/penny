"""Tests for register_artifact.py."""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import register_artifact as ra


class TestAgentsMdUpdater:
    """Unit tests for AgentsMdUpdater."""

    def test_update_structure_table_agent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agents_md = Path(tmpdir) / "AGENTS.md"
            agents_md.write_text("""# Penny Index

## Structure

| Location | Description |
|----------|-------------|
| `.pi/agents/` | Agent definitions (runtime) — `carren.md`, `echo.md` |

## Feature Index

| Feature | Human Docs | Agent Docs | Design | Implementation |
|---------|-----------|------------|--------|----------------|
| Tiered Memory | `docs/humans/tiered-memory.md` | `docs/agents/tiered-memory.md` | `plans/design.md` | `scripts/system/tiered_memory/` |
""")

            updater = ra.AgentsMdUpdater(agents_md)
            spec = ra.ArtifactSpec(
                artifact_type="agent",
                name="vera",
                description="Verification agent",
            )

            ok, msg = updater.update_structure_table(spec)
            assert ok, msg
            assert "vera.md" in updater.content
            updater.write()

            updated = agents_md.read_text()
            assert "`carren.md`, `echo.md`, `vera.md`" in updated

    def test_update_structure_table_skipped_for_skill(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agents_md = Path(tmpdir) / "AGENTS.md"
            agents_md.write_text("""# Penny Index

## Structure

| `.pi/agents/` | Agent definitions — `echo.md` |
""")

            updater = ra.AgentsMdUpdater(agents_md)
            spec = ra.ArtifactSpec(
                artifact_type="skill",
                name="weather",
                description="Weather analysis skill",
            )

            ok, msg = updater.update_structure_table(spec)
            assert ok  # Should succeed with skip message
            assert "skipped" in msg.lower()

    def test_update_feature_index_agent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agents_md = Path(tmpdir) / "AGENTS.md"
            agents_md.write_text("""# Penny Index

## Feature Index

| Feature | Human Docs | Agent Docs | Design | Implementation |
|---------|-----------|------------|--------|----------------|
| Tiered Memory | `docs/humans/tiered-memory.md` | `docs/agents/tiered-memory.md` | `plans/design.md` | `scripts/system/tiered_memory/` |
""")

            updater = ra.AgentsMdUpdater(agents_md)
            spec = ra.ArtifactSpec(
                artifact_type="agent",
                name="vera",
                description="Verify agent definitions",
            )

            ok, msg = updater.update_feature_index(spec)
            assert ok, msg
            assert "Vera" in updater.content
            assert ".pi/agents/vera.md" in updater.content

    def test_rollback(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agents_md = Path(tmpdir) / "AGENTS.md"
            original = "# Original\n"
            agents_md.write_text(original)

            updater = ra.AgentsMdUpdater(agents_md)
            spec = ra.ArtifactSpec(
                artifact_type="agent",
                name="test",
                description="Test agent",
            )
            updater.update_structure_table(spec)
            updater.rollback()

            assert agents_md.read_text() == original


class TestDocScaffolder:
    """Unit tests for DocScaffolder."""

    def test_scaffold_human_doc_agent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            scaffolder = ra.DocScaffolder()
            scaffolder.humans_dir = Path(tmpdir)

            spec = ra.ArtifactSpec(
                artifact_type="agent",
                name="vera",
                description="Verify agent definitions",
                purpose="Validate generated files",
                rules="READ-ONLY: Never modify files",
            )

            ok, path, msg = scaffolder.scaffold_human_doc(spec)
            assert ok
            assert path.exists()
            content = path.read_text()
            assert "Vera Agent" in content
            assert "READ-ONLY" in content

    def test_scaffold_agent_doc_skill(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            scaffolder = ra.DocScaffolder()
            scaffolder.agents_dir = Path(tmpdir)

            spec = ra.ArtifactSpec(
                artifact_type="skill",
                name="weather-analysis",
                description="Analyze weather patterns",
            )

            ok, path, msg = scaffolder.scaffold_agent_doc(spec)
            assert ok
            assert path.exists()
            content = path.read_text()
            assert "Weather Analysis Skill" in content
            assert "orchestrate.py" in content


class TestLinkValidator:
    """Unit tests for LinkValidator."""

    def test_validate_all_valid(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            agents_md = root / "AGENTS.md"
            agents_md.write_text("""# Index
| `docs/humans/test.md` | Description |
""")
            (root / "docs" / "humans").mkdir(parents=True)
            (root / "docs" / "humans" / "test.md").write_text("test")

            validator = ra.LinkValidator(agents_md)
            valid, errors = validator.validate()
            assert valid
            assert errors == []

    def test_validate_missing_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            agents_md = root / "AGENTS.md"
            agents_md.write_text("""# Index
| `docs/humans/missing.md` | Description |
""")

            validator = ra.LinkValidator(agents_md)
            valid, errors = validator.validate()
            assert not valid
            assert any("missing.md" in e for e in errors)


class TestRegisterArtifactIntegration:
    """Integration tests for the full registration workflow."""

    def test_register_agent_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            agents_md = root / "AGENTS.md"
            agents_md.write_text("""# Penny Index

## Structure

| Location | Description |
|----------|-------------|
| `.pi/agents/` | Agent definitions (runtime) — `echo.md` |

## Feature Index

| Feature | Human Docs | Agent Docs | Design | Implementation |
|---------|-----------|------------|--------|----------------|
| Tiered Memory | `docs/humans/capabilities/tiered-memory/tiered-memory.md` | `docs/agents/capabilities/tiered-memory/tiered-memory.md` | `plans/design.md` | `scripts/system/tiered_memory/` |
""")

            # Create the referenced paths so link validation passes
            (root / "docs" / "humans" / "capabilities" / "tiered-memory").mkdir(parents=True)
            (root / "docs" / "humans" / "capabilities" / "tiered-memory" / "tiered-memory.md").write_text("test")
            (root / "docs" / "agents" / "capabilities" / "tiered-memory").mkdir(parents=True)
            (root / "docs" / "agents" / "capabilities" / "tiered-memory" / "tiered-memory.md").write_text("test")
            (root / "plans").mkdir()
            (root / "plans" / "design.md").write_text("test")
            (root / "scripts" / "system" / "tiered_memory").mkdir(parents=True)
            (root / ".pi" / "agents").mkdir(parents=True)
            (root / ".pi" / "agents" / "vera.md").write_text("test")

            # Patch global paths
            ra.AGENTS_MD = agents_md
            ra.DOCS_HUMANS = root / "docs" / "humans" / "capabilities"
            ra.DOCS_AGENTS = root / "docs" / "agents" / "capabilities"

            registrar = ra.RegisterArtifact()
            spec = ra.ArtifactSpec(
                artifact_type="agent",
                name="vera",
                description="Verify agent definitions against standards",
                purpose="Validate generated files for schema, security, and completeness",
                rules="READ-ONLY: Never modify files; EVIDENCE-BASED: Every verdict cites specific evidence",
            )

            result = registrar.register(spec)
            assert result.success, result.errors
            assert result.agents_md_updated
            assert result.human_doc_created
            assert result.agent_doc_created
            assert result.links_valid

            updated = agents_md.read_text()
            assert "vera.md" in updated
            assert "Vera" in updated

    def test_register_skill_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            agents_md = root / "AGENTS.md"
            agents_md.write_text("""# Penny Index

## Feature Index

| Feature | Human Docs | Agent Docs | Design | Implementation |
|---------|-----------|------------|--------|----------------|
| Tiered Memory | `docs/humans/capabilities/tiered-memory/tiered-memory.md` | `docs/agents/capabilities/tiered-memory/tiered-memory.md` | `plans/design.md` | `scripts/system/tiered_memory/` |
""")

            # Create referenced paths
            (root / "docs" / "humans" / "capabilities" / "tiered-memory").mkdir(parents=True)
            (root / "docs" / "humans" / "capabilities" / "tiered-memory" / "tiered-memory.md").write_text("test")
            (root / "docs" / "agents" / "capabilities" / "tiered-memory").mkdir(parents=True)
            (root / "docs" / "agents" / "capabilities" / "tiered-memory" / "tiered-memory.md").write_text("test")
            (root / "plans").mkdir()
            (root / "plans" / "design.md").write_text("test")
            (root / "scripts" / "system" / "tiered_memory").mkdir(parents=True)
            (root / ".pi" / "skills" / "weather-analysis").mkdir(parents=True)
            (root / ".pi" / "skills" / "weather-analysis" / "README.md").write_text("test")

            ra.AGENTS_MD = agents_md
            ra.DOCS_HUMANS = root / "docs" / "humans" / "capabilities"
            ra.DOCS_AGENTS = root / "docs" / "agents" / "capabilities"

            registrar = ra.RegisterArtifact()
            spec = ra.ArtifactSpec(
                artifact_type="skill",
                name="weather-analysis",
                description="Analyze weather data patterns",
            )

            result = registrar.register(spec)
            assert result.success, result.errors
            assert result.agents_md_updated
            assert result.human_doc_created
            assert result.agent_doc_created
            assert result.links_valid


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
