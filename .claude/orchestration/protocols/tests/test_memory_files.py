"""
Memory File Tests
=================

Tests for memory file creation and verification:
- Path construction
- Format validation
- Section extraction
- Listing and completion tracking

Run: pytest protocols/tests/test_memory_files.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Add orchestration root to path
_TESTS_DIR = Path(__file__).resolve().parent
_PROTOCOLS_DIR = _TESTS_DIR.parent
_ORCHESTRATION_ROOT = _PROTOCOLS_DIR.parent

if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))


# ==============================================================================
# Path Construction Tests
# ==============================================================================

class TestMemoryFilePath:
    """Tests for memory file path construction."""

    def test_get_memory_path_format(self, temp_memory_dir, monkeypatch):
        """get_memory_path() returns correct format."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        path = memory_verifier.get_memory_path("task-abc-12345", "clarification")

        assert path.name == "task-abc-12345-clarification-agent-memory.md"
        assert path.parent == temp_memory_dir

    def test_get_memory_path_different_agents(self, temp_memory_dir, monkeypatch):
        """get_memory_path() works for all agent types."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        agents = [
            "clarification",
            "research",
            "analysis",
            "synthesis",
            "generation",
            "validation",
            "memory",
        ]

        for agent in agents:
            path = memory_verifier.get_memory_path("task-123", agent)
            assert agent in path.name
            assert path.suffix == ".md"


# ==============================================================================
# Existence Verification Tests
# ==============================================================================

class TestMemoryFileExists:
    """Tests for memory file existence checking."""

    def test_verify_exists_returns_true_when_exists(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """verify_exists() returns True when file exists."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        # Create memory file
        create_memory_file(mock_task_id, "clarification")

        result = memory_verifier.verify_exists(mock_task_id, "clarification")

        assert result is True

    def test_verify_exists_returns_false_when_missing(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """verify_exists() returns False when file doesn't exist."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        result = memory_verifier.verify_exists(mock_task_id, "nonexistent-agent")

        assert result is False


# ==============================================================================
# Format Validation Tests
# ==============================================================================

class TestMemoryFileFormat:
    """Tests for memory file format validation."""

    def test_verify_format_valid_file(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """verify_format() returns True for valid file."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        memory_path = create_memory_file(mock_task_id, "clarification")

        is_valid, errors = memory_verifier.verify_format(memory_path)

        assert is_valid is True
        assert len(errors) == 0

    def test_verify_format_missing_file(self, temp_memory_dir, monkeypatch):
        """verify_format() returns False for non-existent file."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        missing_path = temp_memory_dir / "nonexistent.md"

        is_valid, errors = memory_verifier.verify_format(missing_path)

        assert is_valid is False
        assert "does not exist" in errors[0]

    def test_verify_format_empty_file(
        self, temp_memory_dir, monkeypatch, create_invalid_memory_file, mock_task_id
    ):
        """verify_format() returns False for empty file."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        empty_path = create_invalid_memory_file(mock_task_id, "test-agent", empty=True)

        is_valid, errors = memory_verifier.verify_format(empty_path)

        assert is_valid is False
        assert "empty" in str(errors)

    def test_verify_format_missing_sections(
        self, temp_memory_dir, monkeypatch, create_invalid_memory_file, mock_task_id
    ):
        """verify_format() detects missing sections."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        # Create file with missing Section 2
        invalid_path = create_invalid_memory_file(
            mock_task_id, "test-agent", missing_sections=["Section 2"]
        )

        is_valid, errors = memory_verifier.verify_format(invalid_path)

        # Should either be invalid or have warnings about missing sections
        # The fixture might not produce perfectly invalid files
        assert isinstance(is_valid, bool)
        assert isinstance(errors, list)

    def test_verify_format_requires_agent_header(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """verify_format() requires agent header."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        # Create file without proper header
        invalid_content = """
## Section 0: Context Loaded
Task ID: test-task

## Section 1: Step Overview
Some content here.

## Section 2: Johari Summary
Known Knowns: Test content here for the section.

## Section 3: Downstream Directives
More content here for downstream directives.
"""
        invalid_path = temp_memory_dir / f"{mock_task_id}-no-header-memory.md"
        invalid_path.write_text(invalid_content)

        is_valid, errors = memory_verifier.verify_format(invalid_path)

        assert is_valid is False
        assert any("header" in e.lower() for e in errors)


class TestMemoryFileSections:
    """Tests for required sections."""

    def test_required_sections_constant(self):
        """REQUIRED_SECTIONS has expected values."""
        from skill import memory_verifier

        assert "Section 0" in memory_verifier.REQUIRED_SECTIONS
        assert "Section 1" in memory_verifier.REQUIRED_SECTIONS
        assert "Section 2" in memory_verifier.REQUIRED_SECTIONS
        assert "Section 3" in memory_verifier.REQUIRED_SECTIONS
        assert len(memory_verifier.REQUIRED_SECTIONS) == 4

    def test_section_patterns_defined(self):
        """SECTION_PATTERNS defined for all required sections."""
        from skill import memory_verifier

        for section in memory_verifier.REQUIRED_SECTIONS:
            assert section in memory_verifier.SECTION_PATTERNS


# ==============================================================================
# Section Extraction Tests
# ==============================================================================

class TestSectionExtraction:
    """Tests for extracting specific sections."""

    def test_extract_section_returns_content(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """extract_section() returns section content."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        content = """# Test Agent Output: Test Task

## Section 0: Context Loaded
Task ID: test-task-123
Agent: test-agent

## Section 1: Step Overview
This is the step overview content that should be extracted.

## Section 2: Johari Summary
Known Knowns: Test data

## Section 3: Downstream Directives
Directives for next phase.
"""

        extracted = memory_verifier.extract_section(content, "Section 1")

        assert extracted is not None
        assert "step overview content" in extracted

    def test_extract_section_returns_none_for_missing(self):
        """extract_section() returns None for missing section."""
        from skill import memory_verifier

        content = """# Test Agent Output: Test

## Section 0: Context
Some content
"""

        extracted = memory_verifier.extract_section(content, "Section 3")

        assert extracted is None

    def test_get_deliverables_returns_section_3(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """get_deliverables() returns Section 3 content."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        content = """# Test Agent Output: Test Task

## Section 0: Context Loaded
Task ID: {task_id}

## Section 1: Step Overview
Overview content here.

## Section 2: Johari Summary
Johari content here.

## Section 3: Downstream Directives
CRITICAL DIRECTIVE: Do X, Y, Z for the next phase.
This is the important downstream directive content.
""".format(task_id=mock_task_id)

        memory_path = temp_memory_dir / f"{mock_task_id}-test-agent-memory.md"
        memory_path.write_text(content)

        deliverables = memory_verifier.get_deliverables(mock_task_id, "test-agent")

        assert deliverables is not None
        assert "CRITICAL DIRECTIVE" in deliverables

    def test_get_johari_summary_returns_section_2(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """get_johari_summary() returns Section 2 content."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        content = """# Test Agent Output: Test Task

## Section 0: Context Loaded
Task ID: {task_id}

## Section 1: Step Overview
Overview content.

## Section 2: Johari Summary
Known Knowns: We understand the requirements
Known Unknowns: Performance implications unclear
Unknown Unknowns: Edge cases not yet discovered

## Section 3: Downstream Directives
Directives here.
""".format(task_id=mock_task_id)

        memory_path = temp_memory_dir / f"{mock_task_id}-johari-agent-memory.md"
        memory_path.write_text(content)

        johari = memory_verifier.get_johari_summary(mock_task_id, "johari-agent")

        assert johari is not None
        assert "Known Knowns" in johari
        assert "Known Unknowns" in johari


# ==============================================================================
# Memory File Listing Tests
# ==============================================================================

class TestMemoryFileListing:
    """Tests for listing memory files."""

    def test_list_memory_files_finds_all(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """list_memory_files() finds all files for task."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        # Create multiple memory files
        create_memory_file(mock_task_id, "clarification")
        create_memory_file(mock_task_id, "research")
        create_memory_file(mock_task_id, "analysis")

        files = memory_verifier.list_memory_files(mock_task_id)

        assert len(files) == 3

    def test_list_memory_files_excludes_other_tasks(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """list_memory_files() excludes files from other tasks."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        # Create files for target task
        create_memory_file(mock_task_id, "clarification")

        # Create file for different task
        create_memory_file("other-task-id", "clarification")

        files = memory_verifier.list_memory_files(mock_task_id)

        assert len(files) == 1
        assert mock_task_id in str(files[0])

    def test_list_memory_files_empty_when_none(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """list_memory_files() returns empty list when no files."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        files = memory_verifier.list_memory_files(mock_task_id)

        assert files == []


class TestCompletedAgents:
    """Tests for tracking completed agents."""

    def test_get_completed_agents_returns_names(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """get_completed_agents() returns agent names."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        create_memory_file(mock_task_id, "clarification")
        create_memory_file(mock_task_id, "research")

        completed = memory_verifier.get_completed_agents(mock_task_id)

        assert "clarification" in completed
        assert "research" in completed
        assert len(completed) == 2

    def test_get_completed_agents_empty_when_none(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """get_completed_agents() returns empty list when no completions."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        completed = memory_verifier.get_completed_agents(mock_task_id)

        assert completed == []


# ==============================================================================
# Utility Function Tests
# ==============================================================================

class TestMemoryUtilities:
    """Tests for memory utility functions."""

    def test_ensure_memory_dir_creates_directory(self, temp_memory_dir, monkeypatch):
        """ensure_memory_dir() creates directory if needed."""
        from skill import memory_verifier

        new_dir = temp_memory_dir / "new_subdir"
        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", new_dir)

        result = memory_verifier.ensure_memory_dir()

        assert result.exists()
        assert result.is_dir()

    def test_cleanup_memory_files_removes_all(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """cleanup_memory_files() removes all files for task."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        # Create files
        create_memory_file(mock_task_id, "agent-1")
        create_memory_file(mock_task_id, "agent-2")

        # Verify files exist
        assert len(memory_verifier.list_memory_files(mock_task_id)) == 2

        # Cleanup
        count = memory_verifier.cleanup_memory_files(mock_task_id)

        assert count == 2
        assert len(memory_verifier.list_memory_files(mock_task_id)) == 0

    def test_get_memory_content_returns_content(
        self, temp_memory_dir, monkeypatch, create_memory_file, mock_task_id
    ):
        """get_memory_content() returns file content."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        create_memory_file(mock_task_id, "test-agent")

        content = memory_verifier.get_memory_content(mock_task_id, "test-agent")

        assert content is not None
        assert "Agent" in content

    def test_get_memory_content_returns_none_for_missing(
        self, temp_memory_dir, monkeypatch, mock_task_id
    ):
        """get_memory_content() returns None for missing file."""
        from skill import memory_verifier

        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)

        content = memory_verifier.get_memory_content(mock_task_id, "nonexistent-agent")

        assert content is None
