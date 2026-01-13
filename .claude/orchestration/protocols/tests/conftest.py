"""
Pytest Configuration and Fixtures
=================================

Provides shared fixtures for all test modules:
- Temporary directories for state and memory files
- Mock task_id and session_id generation
- State file creation helpers
- Memory file creation helpers
- Cleanup utilities

Usage in tests:
    def test_something(temp_state_dir, mock_task_id):
        # temp_state_dir is a Path to a temporary directory
        # mock_task_id is a unique task ID for this test
        pass
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Generator, Optional

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
# Directory Fixtures
# ==============================================================================

@pytest.fixture
def temp_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Provide a temporary directory that's cleaned up after test."""
    yield tmp_path
    # Cleanup handled by pytest's tmp_path


@pytest.fixture
def temp_state_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Provide a temporary state directory for protocol states."""
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    yield state_dir


@pytest.fixture
def temp_memory_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Provide a temporary memory directory for agent memory files."""
    memory_dir = tmp_path / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    yield memory_dir


@pytest.fixture
def temp_orchestration_dirs(tmp_path: Path) -> Generator[Dict[str, Path], None, None]:
    """
    Provide a complete temporary orchestration directory structure.

    Returns dict with:
        - root: Orchestration root
        - state: State files directory
        - memory: Memory files directory
        - reasoning_state: Reasoning protocol state dir
        - skill_state: Skill protocol state dir
        - agent_state: Agent protocol state dir
    """
    dirs = {
        "root": tmp_path,
        "state": tmp_path / "state",
        "memory": tmp_path / "memory",
        "reasoning_state": tmp_path / "reasoning" / "state",
        "skill_state": tmp_path / "skill" / "state",
        "agent_state": tmp_path / "agent" / "state",
    }

    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    yield dirs


# ==============================================================================
# ID Generation Fixtures
# ==============================================================================

@pytest.fixture
def mock_task_id() -> str:
    """Generate a unique task ID for testing (16 char format)."""
    return f"test-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def mock_session_id_12() -> str:
    """Generate a 12-char session ID (reasoning/execution format)."""
    return str(uuid.uuid4())[:12]


@pytest.fixture
def mock_session_id_8() -> str:
    """Generate an 8-char session ID (skill format)."""
    return str(uuid.uuid4())[:8]


@pytest.fixture
def mock_ids() -> Dict[str, str]:
    """Generate a complete set of mock IDs for a workflow."""
    return {
        "task_id": f"test-{uuid.uuid4().hex[:12]}",
        "reasoning_session": str(uuid.uuid4())[:12],
        "skill_session": str(uuid.uuid4())[:8],
        "execution_session": str(uuid.uuid4())[:12],
    }


# ==============================================================================
# State Creation Helpers
# ==============================================================================

@pytest.fixture
def create_reasoning_state(temp_state_dir: Path):
    """
    Factory fixture to create reasoning protocol state files.

    Usage:
        state_data = create_reasoning_state(session_id, user_query="test query")
    """
    def _create(
        session_id: str,
        user_query: str = "Test query",
        current_state: str = "INITIALIZED",
        step_outputs: Optional[Dict] = None,
        **kwargs
    ) -> Dict[str, Any]:
        state_data = {
            "schema_version": "1.0",
            "protocol_name": "mandatory-reasoning",
            "protocol_version": "4.0",
            "session_id": session_id,
            "user_query": user_query,
            "query_timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "initialized" if current_state == "INITIALIZED" else "in_progress",
            "fsm": {
                "state": current_state,
                "current_step": None,
                "history": [current_state],
                "is_final": False,
                "is_halted": False,
                "is_completed": False,
            },
            "step_outputs": step_outputs or {},
            "step_timestamps": {},
            "metadata": {},
            "iteration_count": 0,
            "preliminary_routes": [],
            "contradiction_detected": False,
            "routing_decision": None,
            "routing_justification": None,
            "halt_reason": None,
            "clarification_questions": [],
            "dispatch_pending": None,
        }
        state_data.update(kwargs)

        # Write to file
        state_file = temp_state_dir / f"reasoning-{session_id}.json"
        state_file.write_text(json.dumps(state_data, indent=2))

        return state_data

    return _create


@pytest.fixture
def create_skill_state(temp_state_dir: Path):
    """
    Factory fixture to create skill execution state files.

    Usage:
        state_data = create_skill_state("develop-skill", session_id, task_id)
    """
    def _create(
        skill_name: str,
        session_id: str,
        task_id: str,
        current_phase: Optional[str] = None,
        status: str = "initialized",
        phase_outputs: Optional[Dict] = None,
        **kwargs
    ) -> Dict[str, Any]:
        state_data = {
            "schema_version": "1.0",
            "skill_name": skill_name,
            "task_id": task_id,
            "session_id": session_id,
            "execution_session_id": kwargs.pop("execution_session_id", None),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "halt_reason": None,
            "fsm": {
                "skill_name": skill_name,
                "current_phase_id": current_phase,
                "state": "INITIALIZED" if status == "initialized" else "EXECUTING",
                "history": ["INITIALIZED"],
                "phase_info": {},
                "iteration_counters": {},
                "skipped_phases": [],
                "parallel_branches": {},
            } if kwargs.get("include_fsm", True) else None,
            "phase_outputs": phase_outputs or {},
            "phase_timestamps": {},
            "memory_files": [],
            "configuration": {},
            "metadata": {},
        }
        state_data.update(kwargs)

        # Write to file
        state_file = temp_state_dir / f"{skill_name}-{session_id}.json"
        state_file.write_text(json.dumps(state_data, indent=2))

        return state_data

    return _create


# ==============================================================================
# Memory File Helpers
# ==============================================================================

@pytest.fixture
def create_memory_file(temp_memory_dir: Path):
    """
    Factory fixture to create agent memory files.

    Usage:
        path = create_memory_file(task_id, "research", content="...")
    """
    def _create(
        task_id: str,
        agent_name: str,
        content: Optional[str] = None,
        sections: Optional[Dict[str, str]] = None,
    ) -> Path:
        if content is None:
            # Generate valid memory file content
            sections = sections or {
                "Section 0: Context Loaded": f"Task ID: {task_id}\nAgent: {agent_name}",
                "Section 1: Step Overview": "Test step overview content.",
                "Section 2: Johari Summary": "Known Knowns: Test\nKnown Unknowns: Test",
                "Section 3: Downstream Directives": "Test directives for next phase.",
            }

            content = f"# {agent_name.title().replace('-', ' ')} Output: Test Task\n\n"
            for section_name, section_content in sections.items():
                content += f"## {section_name}\n\n{section_content}\n\n"
            content += f"---\n**{agent_name.upper().replace('-', '_')}_COMPLETE**\n"

        memory_file = temp_memory_dir / f"{task_id}-{agent_name}-memory.md"
        memory_file.write_text(content)

        return memory_file

    return _create


@pytest.fixture
def create_valid_memory_file(create_memory_file):
    """
    Create a valid memory file with all required sections.

    Shortcut for create_memory_file with default valid content.
    """
    def _create(task_id: str, agent_name: str) -> Path:
        return create_memory_file(task_id, agent_name)

    return _create


@pytest.fixture
def create_invalid_memory_file(temp_memory_dir: Path):
    """
    Factory to create invalid memory files for testing validation.

    Usage:
        path = create_invalid_memory_file(task_id, "agent", missing_sections=["Section 2"])
    """
    def _create(
        task_id: str,
        agent_name: str,
        missing_sections: Optional[list] = None,
        empty: bool = False,
        too_short: bool = False,
    ) -> Path:
        if empty:
            content = ""
        elif too_short:
            content = "Short content"
        else:
            # Create content with missing sections
            all_sections = {
                "Section 0: Context Loaded": f"Task ID: {task_id}",
                "Section 1: Step Overview": "Step overview.",
                "Section 2: Johari Summary": "Johari content.",
                "Section 3: Downstream Directives": "Directives.",
            }

            missing_sections = missing_sections or []
            for section in missing_sections:
                # Remove sections that match
                keys_to_remove = [k for k in all_sections if section in k]
                for k in keys_to_remove:
                    del all_sections[k]

            content = f"# {agent_name} Output: Test\n\n"
            for section_name, section_content in all_sections.items():
                content += f"## {section_name}\n\n{section_content}\n\n"

        memory_file = temp_memory_dir / f"{task_id}-{agent_name}-memory.md"
        memory_file.write_text(content)

        return memory_file

    return _create


# ==============================================================================
# Cleanup Fixtures
# ==============================================================================

@pytest.fixture
def cleanup_state_files():
    """
    Fixture to clean up state files after test.

    Usage:
        def test_something(cleanup_state_files):
            # Your test
            cleanup_state_files(Path("path/to/state"))
    """
    paths_to_clean = []

    def _register(path: Path):
        paths_to_clean.append(path)

    yield _register

    for path in paths_to_clean:
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()


# ==============================================================================
# Monkeypatch Helpers
# ==============================================================================

@pytest.fixture
def mock_state_dir(monkeypatch, temp_state_dir: Path):
    """
    Monkeypatch STATE_DIR to use temporary directory.

    Patches all protocol state directories.
    """
    # Patch reasoning STATE_DIR
    try:
        from reasoning.config import config as reasoning_config
        monkeypatch.setattr(reasoning_config, "STATE_DIR", temp_state_dir)
    except ImportError:
        pass

    # Patch skill STATE_DIR
    try:
        from skill.core import state as skill_state_module
        monkeypatch.setattr(skill_state_module, "STATE_DIR", temp_state_dir)
    except ImportError:
        pass

    return temp_state_dir


@pytest.fixture
def mock_memory_dir(monkeypatch, temp_memory_dir: Path):
    """
    Monkeypatch MEMORY_BASE to use temporary directory.
    """
    try:
        from skill import memory_verifier
        monkeypatch.setattr(memory_verifier, "MEMORY_BASE", temp_memory_dir)
    except ImportError:
        pass

    return temp_memory_dir


# ==============================================================================
# Test Data Fixtures
# ==============================================================================

@pytest.fixture
def sample_user_queries() -> list:
    """Provide sample user queries for testing."""
    return [
        "Help me build a REST API",
        "Research best practices for MCP servers",
        "Create a new skill for code review",
        "Fix the bug in authentication",
        "Simple: what time is it?",
    ]


@pytest.fixture
def sample_skill_names() -> list:
    """Provide sample composite skill names for testing."""
    return [
        "develop-skill",
        "develop-learnings",
    ]


@pytest.fixture
def sample_agent_names() -> list:
    """Provide sample agent names for testing."""
    return [
        "clarification",
        "research",
        "analysis",
        "synthesis",
        "generation",
        "validation",
        "memory",
    ]


# ==============================================================================
# Integration Test Markers
# ==============================================================================

def pytest_configure(config):
    """Configure custom markers."""
    config.addinivalue_line(
        "markers", "unit: mark test as a unit test"
    )
    config.addinivalue_line(
        "markers", "integration: mark test as an integration test"
    )
    config.addinivalue_line(
        "markers", "slow: mark test as slow-running"
    )
    config.addinivalue_line(
        "markers", "critical: mark test as testing critical functionality"
    )
