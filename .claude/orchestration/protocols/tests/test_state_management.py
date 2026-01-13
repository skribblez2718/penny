"""
State Management Tests
======================

Tests for state creation, serialization, persistence, and loading:
- ProtocolState (reasoning)
- SkillExecutionState (skill)

Run: pytest protocols/tests/test_state_management.py -v
"""

from __future__ import annotations

import json
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
# Reasoning Protocol State Tests
# ==============================================================================

class TestReasoningStateCreation:
    """Tests for ProtocolState creation."""

    def test_creates_valid_state_with_defaults(self):
        """ProtocolState creates with valid defaults."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test query")

        assert state.user_query == "Test query"
        assert state.session_id is not None
        assert state.status == "initialized"
        assert state.iteration_count == 0
        assert state.routing_decision is None
        assert state.halt_reason is None

    def test_session_id_format_12_chars(self):
        """Session ID should be 12 characters (from UUID[:12])."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test query")

        assert len(state.session_id) == 12
        # Should be alphanumeric (hex from UUID)
        assert state.session_id.replace("-", "").isalnum()

    def test_custom_session_id_preserved(self):
        """Custom session ID is preserved."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(
            session_id="custom12char",
            user_query="Test query"
        )

        assert state.session_id == "custom12char"

    def test_fsm_initialized_correctly(self):
        """FSM should be initialized in INITIALIZED state."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        state = ProtocolState(user_query="Test query")

        assert state.fsm is not None
        assert state.fsm.state == ReasoningState.INITIALIZED
        assert state.current_step is None  # No step yet


class TestReasoningStateSerialization:
    """Tests for ProtocolState serialization."""

    def test_to_dict_includes_all_fields(self):
        """to_dict() includes all required fields."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test query")
        data = state.to_dict()

        assert "schema_version" in data
        assert "protocol_name" in data
        assert "protocol_version" in data
        assert "session_id" in data
        assert "user_query" in data
        assert "fsm" in data
        assert "step_outputs" in data
        assert "iteration_count" in data
        assert "routing_decision" in data

    def test_fsm_serializes_with_state_key(self):
        """FSM serializes using 'state' key (not 'current_state')."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test query")
        data = state.to_dict()

        # FSM data should use 'state' key for alignment with skill FSM
        assert "state" in data["fsm"]
        assert "current_state" not in data["fsm"]
        assert data["fsm"]["state"] == "INITIALIZED"

    def test_from_dict_restores_state(self):
        """from_dict() restores state correctly."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        original = ProtocolState(user_query="Test query")
        original.iteration_count = 2
        original.routing_decision = "skill-orchestration"

        data = original.to_dict()
        restored = ProtocolState.from_dict(data)

        assert restored.session_id == original.session_id
        assert restored.user_query == original.user_query
        assert restored.iteration_count == 2
        assert restored.routing_decision == "skill-orchestration"
        assert restored.fsm.state == ReasoningState.INITIALIZED

    def test_from_dict_supports_legacy_current_state_key(self):
        """from_dict() supports legacy 'current_state' key for backwards compatibility."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        # Simulate legacy state file with 'current_state' key
        legacy_data = {
            "schema_version": "1.0",
            "protocol_name": "mandatory-reasoning",
            "protocol_version": "4.0",
            "session_id": "test12345678",
            "user_query": "Legacy test",
            "query_timestamp": "2024-01-01T00:00:00Z",
            "fsm": {
                "current_state": "INITIALIZED",  # Legacy key
                "history": ["INITIALIZED"],
            },
            "step_outputs": {},
            "step_timestamps": {},
            "iteration_count": 0,
            "preliminary_routes": [],
        }

        restored = ProtocolState.from_dict(legacy_data)

        assert restored.fsm.state == ReasoningState.INITIALIZED


class TestReasoningStatePersistence:
    """Tests for ProtocolState save/load."""

    def test_save_creates_file(self, temp_state_dir, monkeypatch):
        """save() creates state file."""
        from reasoning.core.state import ProtocolState
        from reasoning.config import config as reasoning_config

        monkeypatch.setattr(reasoning_config, "STATE_DIR", temp_state_dir)

        state = ProtocolState(user_query="Test query")
        state_file = state.save()

        assert state_file.exists()
        assert state_file.name.startswith("reasoning-")
        assert state_file.suffix == ".json"

    def test_load_restores_state(self, temp_state_dir, monkeypatch):
        """load() restores saved state."""
        from reasoning.core.state import ProtocolState
        from reasoning.config import config as reasoning_config

        monkeypatch.setattr(reasoning_config, "STATE_DIR", temp_state_dir)

        original = ProtocolState(user_query="Persistent test")
        original.save()

        loaded = ProtocolState.load(original.session_id)

        assert loaded is not None
        assert loaded.session_id == original.session_id
        assert loaded.user_query == original.user_query

    def test_load_returns_none_for_missing(self, temp_state_dir, monkeypatch):
        """load() returns None for non-existent session."""
        from reasoning.core.state import ProtocolState
        from reasoning.config import config as reasoning_config

        monkeypatch.setattr(reasoning_config, "STATE_DIR", temp_state_dir)

        loaded = ProtocolState.load("nonexistent123")

        assert loaded is None

    def test_roundtrip_preserves_all_data(self, temp_state_dir, monkeypatch):
        """Save/load roundtrip preserves all state data."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState
        from reasoning.config import config as reasoning_config

        monkeypatch.setattr(reasoning_config, "STATE_DIR", temp_state_dir)

        original = ProtocolState(user_query="Roundtrip test")
        original.iteration_count = 1
        original.add_preliminary_route("skill-orchestration", "Test justification")
        original.step_outputs[1] = {"test": "output"}
        original.metadata["custom_key"] = "custom_value"
        original.save()

        loaded = ProtocolState.load(original.session_id)

        assert loaded.iteration_count == 1
        assert len(loaded.preliminary_routes) == 1
        assert loaded.preliminary_routes[0]["route"] == "skill-orchestration"
        assert loaded.step_outputs.get(1) == {"test": "output"}
        assert loaded.metadata.get("custom_key") == "custom_value"


class TestReasoningStateMethods:
    """Tests for ProtocolState methods."""

    def test_start_step_transitions_fsm(self):
        """start_step() transitions FSM to correct state."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        state = ProtocolState(user_query="Test")

        # Step 0 (Johari Discovery) is first step
        result = state.start_step(0)

        assert result is True
        assert state.fsm.state == ReasoningState.JOHARI_DISCOVERY
        assert state.current_step == 0

    def test_complete_step_stores_output(self):
        """complete_step() stores step output."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test")
        state.start_step(0)  # Start step 0 first

        result = state.complete_step(0, {"key": "value"})

        assert result is True
        assert state.step_outputs[0] == {"key": "value"}

    def test_status_reflects_fsm_state(self):
        """status property reflects FSM state correctly."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        state = ProtocolState(user_query="Test")

        assert state.status == "initialized"

        state.start_step(0)
        assert state.status == "in_progress"

    def test_halt_for_clarification_sets_halt_state(self):
        """halt_for_clarification() transitions to HALTED."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        state = ProtocolState(user_query="Test")
        # Need to be at a state that can transition to HALTED (KNOWLEDGE_TRANSFER)
        state.fsm.state = ReasoningState.KNOWLEDGE_TRANSFER

        result = state.halt_for_clarification(
            reason="Need more info",
            questions=["What is X?", "How should Y work?"]
        )

        assert result is True
        assert state.fsm.state == ReasoningState.HALTED
        assert state.status == "halted"
        assert state.halt_reason == "Need more info"
        assert len(state.clarification_questions) == 2

    def test_trigger_loop_back_increments_iteration(self):
        """trigger_loop_back() increments iteration count."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test")

        assert state.iteration_count == 0
        result = state.trigger_loop_back("Contradiction found")

        assert result is True
        assert state.iteration_count == 1
        assert state.contradiction_detected is True

    def test_loop_back_fails_at_max_iterations(self):
        """trigger_loop_back() fails when max iterations reached."""
        from reasoning.core.state import ProtocolState

        state = ProtocolState(user_query="Test")
        state.iteration_count = 2  # Already at MAX_ITERATIONS - 1

        result = state.trigger_loop_back("Another contradiction")

        assert result is False
        assert state.iteration_count == 2  # Unchanged


# ==============================================================================
# Skill Protocol State Tests
# ==============================================================================

class TestSkillStateCreation:
    """Tests for SkillExecutionState creation."""

    def test_creates_valid_state(self):
        """SkillExecutionState creates with valid defaults."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        assert state.skill_name == "develop-skill"
        assert state.task_id == "task-test-12345"
        assert state.session_id is not None
        assert state.status == "initialized"

    def test_session_id_format_8_chars(self):
        """Session ID should be 8 characters (from UUID[:8])."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        # Skill session IDs are 8 chars (different from reasoning's 12)
        assert len(state.session_id) == 8

    def test_custom_session_id_preserved(self):
        """Custom session ID is preserved."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345",
            session_id="custom88"
        )

        assert state.session_id == "custom88"

    def test_fsm_initialized_for_composite_skill(self):
        """FSM is initialized for composite skills."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillPhaseState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        assert state.fsm is not None
        assert state.fsm.state == SkillPhaseState.INITIALIZED


class TestSkillStateSerialization:
    """Tests for SkillExecutionState serialization."""

    def test_to_dict_includes_all_fields(self):
        """to_dict() includes all required fields."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        data = state.to_dict()

        assert "schema_version" in data
        assert "skill_name" in data
        assert "task_id" in data
        assert "session_id" in data
        assert "fsm" in data
        assert "phase_outputs" in data
        assert "memory_files" in data
        assert "status" in data

    def test_fsm_serializes_with_state_key(self):
        """FSM serializes using 'state' key."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        data = state.to_dict()

        # FSM data should use 'state' key (aligned with reasoning FSM)
        assert "state" in data["fsm"]
        assert data["fsm"]["state"] == "INITIALIZED"

    def test_from_dict_restores_state(self):
        """from_dict() restores state correctly."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillPhaseState

        original = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        original.status = "executing"
        original.phase_outputs["0"] = {"test": "data"}

        data = original.to_dict()
        restored = SkillExecutionState.from_dict(data)

        assert restored.skill_name == original.skill_name
        assert restored.task_id == original.task_id
        assert restored.session_id == original.session_id
        assert restored.status == "executing"
        assert restored.phase_outputs.get("0") == {"test": "data"}


class TestSkillStatePersistence:
    """Tests for SkillExecutionState save/load."""

    def test_save_creates_file(self, temp_state_dir, monkeypatch):
        """save() creates state file."""
        from skill.core import state as skill_state_module

        monkeypatch.setattr(skill_state_module, "STATE_DIR", temp_state_dir)

        state = skill_state_module.SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        state_file = state.save()

        assert state_file.exists()
        assert "develop-skill" in state_file.name
        assert state_file.suffix == ".json"

    def test_load_restores_state(self, temp_state_dir, monkeypatch):
        """load() restores saved state."""
        from skill.core import state as skill_state_module

        monkeypatch.setattr(skill_state_module, "STATE_DIR", temp_state_dir)

        original = skill_state_module.SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        original.save()

        loaded = skill_state_module.SkillExecutionState.load(
            "develop-skill",
            original.session_id
        )

        assert loaded is not None
        assert loaded.skill_name == original.skill_name
        assert loaded.session_id == original.session_id

    def test_roundtrip_preserves_all_data(self, temp_state_dir, monkeypatch):
        """Save/load roundtrip preserves all state data."""
        from skill.core import state as skill_state_module

        monkeypatch.setattr(skill_state_module, "STATE_DIR", temp_state_dir)

        original = skill_state_module.SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        original.phase_outputs["0"] = {"clarification": "done"}
        original.memory_files.append("/path/to/memory.md")
        original.configuration["depth"] = "standard"
        original.metadata["custom"] = "value"
        original.save()

        loaded = skill_state_module.SkillExecutionState.load(
            "develop-skill",
            original.session_id
        )

        assert loaded.phase_outputs.get("0") == {"clarification": "done"}
        assert "/path/to/memory.md" in loaded.memory_files
        assert loaded.configuration.get("depth") == "standard"
        assert loaded.metadata.get("custom") == "value"


class TestSkillStateMethods:
    """Tests for SkillExecutionState methods."""

    def test_start_phase_updates_status(self):
        """start_phase() updates status to executing."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        assert state.status == "initialized"
        state.start_phase("0")

        assert state.status == "executing"
        assert "0" in state.phase_timestamps
        assert "started_at" in state.phase_timestamps["0"]

    def test_complete_phase_stores_output(self):
        """complete_phase() stores phase output."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )
        state.start_phase("0")
        state.complete_phase("0", {"result": "success"})

        assert state.phase_outputs["0"] == {"result": "success"}
        assert "completed_at" in state.phase_timestamps["0"]

    def test_add_memory_file_tracks_path(self):
        """add_memory_file() tracks memory file path."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        state.add_memory_file("/path/to/memory.md")

        assert "/path/to/memory.md" in state.memory_files

    def test_add_memory_file_no_duplicates(self):
        """add_memory_file() doesn't add duplicates."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        state.add_memory_file("/path/to/memory.md")
        state.add_memory_file("/path/to/memory.md")

        assert len(state.memory_files) == 1

    def test_halt_sets_halt_state(self):
        """halt() sets halted status and reason."""
        from skill.core.state import SkillExecutionState

        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        state.halt("Validation failed")

        assert state.status == "halted"
        assert state.halt_reason == "Validation failed"


# ==============================================================================
# Cross-Protocol Consistency Tests
# ==============================================================================

class TestCrossProtocolConsistency:
    """Tests for consistency across protocols."""

    def test_session_id_formats_differ(self):
        """Reasoning (12 char) and skill (8 char) session IDs differ."""
        from reasoning.core.state import ProtocolState
        from skill.core.state import SkillExecutionState

        reasoning_state = ProtocolState(user_query="Test")
        skill_state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        # Different lengths by design
        assert len(reasoning_state.session_id) == 12
        assert len(skill_state.session_id) == 8

    def test_fsm_state_key_aligned(self):
        """Both protocols use 'state' key in FSM serialization."""
        from reasoning.core.state import ProtocolState
        from skill.core.state import SkillExecutionState

        reasoning_state = ProtocolState(user_query="Test")
        skill_state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        reasoning_data = reasoning_state.to_dict()
        skill_data = skill_state.to_dict()

        # Both should use 'state' key (aligned)
        assert "state" in reasoning_data["fsm"]
        assert "state" in skill_data["fsm"]

    def test_schema_version_consistent(self):
        """Both protocols have schema_version in serialized data."""
        from reasoning.core.state import ProtocolState
        from skill.core.state import SkillExecutionState

        reasoning_state = ProtocolState(user_query="Test")
        skill_state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-test-12345"
        )

        reasoning_data = reasoning_state.to_dict()
        skill_data = skill_state.to_dict()

        assert "schema_version" in reasoning_data
        assert "schema_version" in skill_data
        assert reasoning_data["schema_version"] == "1.0"
        assert skill_data["schema_version"] == "1.0"
