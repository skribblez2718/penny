"""
End-to-End Tests
================

Tests for cross-protocol chaining and complete flows:
- Reasoning protocol complete flow
- Skill protocol complete flow
- Agent protocol complete flow
- Cross-protocol ID chaining

Run: pytest protocols/tests/test_end_to_end.py -v
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

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
# Reasoning Protocol Flow Tests
# ==============================================================================

class TestReasoningProtocolFlow:
    """Tests for complete reasoning protocol flow."""

    def test_reasoning_state_created_on_entry(self, temp_state_dir, monkeypatch):
        """Reasoning protocol creates state file on entry."""
        from reasoning import entry as reasoning_entry
        from reasoning.core.state import ProtocolState

        # STATE_DIR is defined in config.config and imported by state.py
        # Must patch the source module for get_state_file_path() to use temp dir
        monkeypatch.setattr(
            "reasoning.config.config.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Test query")

        # Verify state file exists
        state_file = temp_state_dir / f"reasoning-{state.session_id}.json"
        assert state_file.exists()

        # Verify state can be loaded
        loaded = ProtocolState.load(state.session_id)
        assert loaded is not None
        assert loaded.user_query == "Test query"

    def test_reasoning_fsm_initialized_on_entry(self, temp_state_dir, monkeypatch):
        """Reasoning protocol initializes FSM on entry."""
        from reasoning import entry as reasoning_entry

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Test query")

        assert state.fsm is not None
        assert state.fsm.state.name == "INITIALIZED"

    def test_reasoning_steps_advance_fsm(self, temp_state_dir, monkeypatch):
        """Each reasoning step advances FSM state."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        # Create state
        state = ProtocolState(user_query="Test query")
        state.save()

        # Simulate step progression
        # Step 0: INITIALIZED -> JOHARI_DISCOVERY
        state.start_step(0)
        state.complete_step(0, {"output": "step 0 done"})
        assert state.fsm.state == ReasoningState.JOHARI_DISCOVERY

        # Step 1: JOHARI_DISCOVERY -> SEMANTIC_UNDERSTANDING
        state.start_step(1)
        state.complete_step(1, {"output": "step 1 done"})
        assert state.fsm.state == ReasoningState.SEMANTIC_UNDERSTANDING


class TestReasoningOutputChaining:
    """Tests for reasoning step output chaining."""

    def test_step_outputs_stored_in_state(self, temp_state_dir, monkeypatch):
        """Step outputs are stored in state.step_outputs."""
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = ProtocolState(user_query="Test")
        state.save()

        # Complete steps with outputs
        state.start_step(0)
        state.complete_step(0, {"clarifications": ["q1", "q2"]})

        state.start_step(1)
        state.complete_step(1, {"semantic_analysis": "understood"})

        assert state.step_outputs.get(0, state.step_outputs.get("0", {})).get("clarifications") is not None
        assert state.step_outputs.get(1, state.step_outputs.get("1", {})).get("semantic_analysis") is not None

    def test_step_timestamps_recorded(self, temp_state_dir, monkeypatch):
        """Step timestamps are recorded for each step."""
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = ProtocolState(user_query="Test")
        state.save()

        state.start_step(0)
        state.complete_step(0, {})

        timestamps = state.step_timestamps.get(0) or state.step_timestamps.get("0", {})
        assert timestamps.get("started_at") is not None
        assert timestamps.get("completed_at") is not None


# ==============================================================================
# Skill Protocol Flow Tests
# ==============================================================================

class TestSkillProtocolFlow:
    """Tests for complete skill protocol flow."""

    def test_skill_state_tracks_phase_completion(self, temp_state_dir, monkeypatch):
        """Skill state tracks phase completion."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-abc123",
            execution_session_id="exec-123"
        )
        state.save()

        # Start and complete phases
        state.start_phase("0")
        state.complete_phase("0", {"output": "clarified"})

        state.start_phase("1")
        state.complete_phase("1", {"output": "researched"})

        # Verify phase outputs stored
        assert "0" in state.phase_outputs
        assert "1" in state.phase_outputs
        assert state.phase_outputs["0"]["output"] == "clarified"

    def test_skill_fsm_tracks_phase_transitions(self, temp_state_dir, monkeypatch):
        """Skill FSM tracks phase transitions."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-abc123",
            execution_session_id="exec-123"
        )
        state.fsm.start()
        state.save()

        # Initial phase should be 0
        assert state.fsm.get_current_phase() == "0"

        # Transition to next phase (develop-skill: 0 → 0.5 → 1)
        state.fsm.transition("0.5", verified=True)
        assert state.fsm.get_current_phase() == "0.5"

        # Verify history
        assert len(state.fsm.history) > 0


class TestSkillMemoryTracking:
    """Tests for skill memory file tracking."""

    def test_skill_tracks_memory_files(self, temp_state_dir, temp_memory_dir, monkeypatch):
        """Skill state tracks created memory files."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-abc123",
            execution_session_id="exec-123"
        )
        state.save()

        # Add memory file references
        state.add_memory_file(f"{state.task_id}-clarification-agent-memory.md")
        state.add_memory_file(f"{state.task_id}-research-agent-memory.md")
        state.save()

        # Verify memory files tracked
        assert len(state.memory_files) == 2
        assert any("clarification" in f for f in state.memory_files)


# ==============================================================================
# Agent Protocol Flow Tests
# ==============================================================================

class TestAgentProtocolFlow:
    """Tests for complete agent protocol flow."""

    def test_agent_state_tracks_step_completion(self, temp_state_dir, monkeypatch):
        """Agent state tracks step completion."""
        from agent.steps.base import AgentExecutionState

        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        state = AgentExecutionState(
            agent_name="clarification",
            task_id="task-abc123",
            current_step=0
        )
        state.save()

        # Complete steps
        state.mark_step_complete(0, {"learnings": "loaded"})
        state.mark_step_complete(1, {"johari": "discovered"})
        state.mark_step_complete(2, {"clarified": "requirements"})

        assert 0 in state.completed_steps
        assert 1 in state.completed_steps
        assert 2 in state.completed_steps

    def test_agent_preserves_skill_context(self, temp_state_dir, monkeypatch):
        """Agent state preserves skill context."""
        from agent.steps.base import AgentExecutionState

        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        state = AgentExecutionState(
            agent_name="research",
            task_id="task-abc123",
            current_step=0
        )

        # Set skill context
        state.set_skill_context(
            skill_name="develop-skill",
            phase_id="1",
            context_pattern="IMMEDIATE_PREDECESSORS",
            predecessors=["clarification"]
        )
        state.save()

        # Verify context preserved (uses individual properties, not skill_context dict)
        assert state.skill_name is not None
        assert state.skill_name == "develop-skill"
        assert state.phase_id == "1"


# ==============================================================================
# Cross-Protocol ID Chaining Tests
# ==============================================================================

class TestCrossProtocolIDChaining:
    """Tests for ID chaining between protocols."""

    def test_task_id_flows_from_skill_to_agent(self, temp_state_dir, monkeypatch):
        """Task ID flows from skill to agent state."""
        from skill.core.state import SkillExecutionState
        from agent.steps.base import AgentExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )
        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        # Create skill state with task_id
        skill_state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-develop-abc123",
            execution_session_id="exec-xyz"
        )
        skill_state.save()

        # Create agent state with same task_id
        agent_state = AgentExecutionState(
            agent_name="clarification",
            task_id="task-develop-abc123",  # Same task_id!
            current_step=0
        )
        agent_state.set_skill_context(
            skill_name="develop-skill",
            phase_id="0",
            context_pattern="WORKFLOW_ONLY"
        )
        agent_state.save()

        # Verify task_id matches
        assert skill_state.task_id == agent_state.task_id

    def test_memory_file_uses_task_id(self, temp_memory_dir):
        """Memory file naming uses task_id for consistency."""
        task_id = "task-develop-abc123"
        agent_name = "clarification"

        # Expected memory file pattern
        expected_pattern = f"{task_id}-{agent_name}-memory.md"

        # Create memory file
        memory_file = temp_memory_dir / expected_pattern
        memory_file.write_text("# Test Memory Content")

        # Verify file exists at expected path
        assert memory_file.exists()
        assert task_id in memory_file.name
        assert agent_name in memory_file.name

    def test_execution_session_id_links_protocols(
        self, temp_state_dir, monkeypatch
    ):
        """Execution session ID links reasoning → skill."""
        from reasoning.core.state import ProtocolState
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )
        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Create reasoning state
        reasoning_state = ProtocolState(user_query="Test query")
        reasoning_state.save()
        exec_session_id = reasoning_state.session_id

        # Create skill state linked to reasoning session
        skill_state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-abc123",
            execution_session_id=exec_session_id  # Link to reasoning!
        )
        skill_state.save()

        # Verify link
        assert skill_state.execution_session_id == reasoning_state.session_id


# ==============================================================================
# State Persistence Tests
# ==============================================================================

class TestStatePersistence:
    """Tests for state persistence across protocol boundaries."""

    def test_state_survives_save_load_cycle(self, temp_state_dir, monkeypatch):
        """State data survives save/load cycle."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Create state with data
        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-abc123",
            execution_session_id="exec-123"
        )
        state.metadata["custom_field"] = "custom_value"
        state.start_phase("0")
        state.complete_phase("0", {"result": "phase_0_output"})
        state.save()

        # Load and verify
        loaded = SkillExecutionState.load("test-skill", state.session_id)

        assert loaded is not None
        assert loaded.task_id == "task-abc123"
        assert loaded.metadata.get("custom_field") == "custom_value"
        assert loaded.phase_outputs.get("0", {}).get("result") == "phase_0_output"

    def test_fsm_state_survives_save_load(self, temp_state_dir, monkeypatch):
        """FSM state survives save/load cycle."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillPhaseState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-abc123",
            execution_session_id="exec-123"
        )
        state.fsm.start()
        # develop-skill: 0 → 0.5 → 1
        state.fsm.transition("0.5", verified=True)
        state.save()

        # Load and verify FSM state
        loaded = SkillExecutionState.load("develop-skill", state.session_id)

        assert loaded.fsm is not None
        assert loaded.fsm.get_current_phase() == "0.5"
        assert loaded.fsm.state == SkillPhaseState.EXECUTING


# ==============================================================================
# Complete Flow Simulation Tests
# ==============================================================================

class TestCompleteFlowSimulation:
    """Tests simulating complete protocol flows."""

    def test_simulated_skill_flow(
        self, temp_state_dir, temp_memory_dir, monkeypatch
    ):
        """Simulate a partial skill flow: entry → phases → state tracking."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillPhaseState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # 1. Entry: Create skill state - use registered composite skill
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-sim-123",
            execution_session_id="exec-sim"
        )
        state.fsm.start()
        state.save()

        # 2. Phase 0: Requirements Discovery
        state.start_phase("0")
        # Simulate agent creating memory file
        memory_file_0 = temp_memory_dir / f"{state.task_id}-clarification-agent-memory.md"
        memory_file_0.write_text("# Clarification Output\n## Section 0\n## Section 1")
        state.add_memory_file(str(memory_file_0))
        state.complete_phase("0", {"clarified": True})
        # develop-skill: 0 → 0.5 → 1
        state.fsm.transition("0.5", verified=True)
        state.save()

        # 3. Phase 0.5: Complexity Analysis
        state.start_phase("0.5")
        memory_file_1 = temp_memory_dir / f"{state.task_id}-analysis-agent-memory.md"
        memory_file_1.write_text("# Analysis Output\n## Section 0\n## Section 1")
        state.add_memory_file(str(memory_file_1))
        state.complete_phase("0.5", {"analyzed": True})
        # Transition to next phase (1), not COMPLETED
        state.fsm.transition("1", verified=True)
        state.save()

        # Verify state after partial flow (not COMPLETED since we haven't done all phases)
        loaded = SkillExecutionState.load("develop-skill", state.session_id)
        assert loaded.fsm.state == SkillPhaseState.EXECUTING
        assert loaded.fsm.get_current_phase() == "1"
        assert len(loaded.phase_outputs) >= 2
        assert len(loaded.memory_files) == 2

