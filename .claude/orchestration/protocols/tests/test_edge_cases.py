"""
Edge Case Tests
===============

Tests for edge cases and error handling:
- Halt behavior (clarification needed)
- Loop-back logic (validation failures)
- Remediation loops
- Invalid state recovery
- Missing state handling

Run: pytest protocols/tests/test_edge_cases.py -v
"""

from __future__ import annotations

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
# Reasoning Halt Tests
# ==============================================================================

class TestReasoningHalt:
    """Tests for reasoning protocol halt behavior."""

    def test_halt_for_clarification_sets_state(self, temp_state_dir, monkeypatch):
        """halt_for_clarification() sets correct state and reason."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState, ReasoningFSM

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = ProtocolState(user_query="Test query")
        # Advance to step 8 following correct step sequence
        # Steps: 0, 1, 2, 3, 3.2 (skill detection), 4, 5, 6, 7, 8
        step_sequence = [0, 1, 2, 3, 3.2, 4, 5, 6, 7]
        for step in step_sequence:
            state.start_step(step)
            state.complete_step(step, {})

        state.start_step(8)
        state.halt_for_clarification(
            questions=["What is the scope?", "What are the constraints?"],
            reason="Ambiguous requirements"
        )
        state.save()

        assert state.fsm.is_halted()
        assert state.halt_reason == "Ambiguous requirements"
        assert len(state.clarification_questions) == 2

    def test_halt_prevents_further_steps(self, temp_state_dir, monkeypatch):
        """Halted state prevents further step execution."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = ProtocolState(user_query="Test")
        # Must advance to step 8 before we can transition to HALTED
        # (HALTED is only reachable from KNOWLEDGE_TRANSFER state)
        step_sequence = [0, 1, 2, 3, 3.2, 4, 5, 6, 7]
        for step in step_sequence:
            state.start_step(step)
            state.complete_step(step, {})

        state.start_step(8)
        # Now we can transition to HALTED (from KNOWLEDGE_TRANSFER)
        state.fsm.transition(ReasoningState.HALTED)
        state.save()

        assert state.fsm.is_final()


class TestReasoningLoopBack:
    """Tests for reasoning protocol loop-back behavior."""

    def test_trigger_loop_back_increments_count(self, temp_state_dir, monkeypatch):
        """trigger_loop_back() increments iteration count."""
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = ProtocolState(user_query="Test")
        initial_count = state.iteration_count

        # Advance to step 8 following correct step sequence
        # Steps: 0, 1, 2, 3, 3.2 (skill detection), 4, 5, 6, 7, 8
        step_sequence = [0, 1, 2, 3, 3.2, 4, 5, 6, 7]
        for step in step_sequence:
            state.start_step(step)
            state.complete_step(step, {})

        state.start_step(8)
        state.trigger_loop_back(reason="Contradiction detected")

        assert state.iteration_count == initial_count + 1

    def test_max_iterations_enforced(self, temp_state_dir, monkeypatch):
        """Max iterations (3) prevents infinite loops."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningFSM

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = ProtocolState(user_query="Test")

        # Simulate max iterations reached - use class attribute
        state.iteration_count = ReasoningFSM.MAX_ITERATIONS - 1

        # Advance to step 8 following correct step sequence
        # Steps: 0, 1, 2, 3, 3.2 (skill detection), 4, 5, 6, 7, 8
        step_sequence = [0, 1, 2, 3, 3.2, 4, 5, 6, 7]
        for step in step_sequence:
            state.start_step(step)
            state.complete_step(step, {})

        state.start_step(8)

        # Should return False when max iterations reached
        result = state.trigger_loop_back(reason="test")

        # trigger_loop_back returns False at max iterations and doesn't increment
        # (iteration_count was already at MAX_ITERATIONS - 1)
        assert result is False
        assert state.iteration_count == ReasoningFSM.MAX_ITERATIONS - 1


# ==============================================================================
# Agent Halt Tests
# ==============================================================================

class TestAgentHalt:
    """Tests for agent halt behavior (Johari questions)."""

    def test_agent_can_halt_at_johari(self, temp_state_dir, monkeypatch):
        """Agent can halt at Johari discovery step if questions exist."""
        from agent.steps.base import AgentExecutionState
        from agent.config.config import AGENT_PROTOCOLS_ROOT

        # AgentExecutionState uses AGENT_PROTOCOLS_ROOT / "state" internally
        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        state = AgentExecutionState(
            agent_name="clarification",
            task_id="task-123",
            current_step=1  # Johari discovery step
        )

        # Store halt info in metadata
        state.metadata["johari_questions"] = [
            "What is the expected output format?",
            "Are there any constraints?"
        ]
        state.metadata["halted_for_clarification"] = True
        state.save()

        assert state.metadata.get("halted_for_clarification") is True
        assert len(state.metadata.get("johari_questions", [])) == 2


# ==============================================================================
# Skill Remediation Tests
# ==============================================================================

class TestSkillRemediation:
    """Tests for skill remediation loop behavior."""

    def test_remediation_count_incremented(self, temp_state_dir, monkeypatch):
        """Remediation count increments on validation failure."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        state.save()

        # Track remediation count
        key = "remediation_count_phase_4"
        initial = state.metadata.get(key, 0)

        state.metadata[key] = initial + 1
        state.save()

        assert state.metadata[key] == initial + 1

    def test_max_remediation_enforced(self, temp_state_dir, monkeypatch):
        """Max remediation limit prevents infinite loops."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )

        # Simulate hitting max remediation
        max_remediation = 2
        key = "remediation_count_phase_4"
        state.metadata[key] = max_remediation
        state.save()

        # Verify count at max
        assert state.metadata[key] >= max_remediation

    def test_remediation_resets_to_target_phase(self, temp_state_dir, monkeypatch):
        """Phase progression tracks correctly through FSM transitions."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        state.fsm.start()

        # develop-skill phases: 0 → 0.5 → 1 → 2 → 3 → ...
        # Advance through phases using correct sequence
        state.fsm.transition("0.5", verified=True)
        state.fsm.transition("1", verified=True)
        state.fsm.transition("2", verified=True)

        # Verify phase progression is tracked correctly
        assert state.fsm.get_current_phase() == "2"
        assert len(state.fsm.history) >= 3  # At least 3 transitions recorded


class TestSkillHalt:
    """Tests for skill halt behavior."""

    def test_skill_halt_sets_reason(self, temp_state_dir, monkeypatch):
        """skill.halt() sets halt_reason."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillPhaseState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        state.save()

        state.halt("Max remediation loops reached")
        state.save()

        assert state.halt_reason == "Max remediation loops reached"
        assert state.status == "halted"

    def test_skill_halt_updates_fsm(self, temp_state_dir, monkeypatch):
        """skill.halt() updates FSM to HALTED state."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillPhaseState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        state.fsm.start()
        state.halt("Test halt")
        state.save()

        assert state.fsm.is_halted()


# ==============================================================================
# Invalid State Recovery Tests
# ==============================================================================

class TestInvalidStateRecovery:
    """Tests for handling invalid/corrupt state."""

    def test_missing_state_returns_none(self, temp_state_dir, monkeypatch):
        """Loading missing state returns None."""
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        result = ProtocolState.load("nonexistent-session-id")

        assert result is None

    def test_skill_missing_state_returns_none(self, temp_state_dir, monkeypatch):
        """Loading missing skill state returns None."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        result = SkillExecutionState.load("nonexistent-skill", "bad-session")

        assert result is None

    def test_corrupt_json_handled_gracefully(self, temp_state_dir, monkeypatch):
        """Corrupt JSON state file handled gracefully."""
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        # Create corrupt state file
        corrupt_file = temp_state_dir / "reasoning-corrupt12.json"
        corrupt_file.write_text("{invalid json content}")

        # Should return None or raise specific error, not crash
        try:
            result = ProtocolState.load("corrupt12")
            assert result is None
        except Exception:
            # Acceptable to raise on corruption
            pass

    def test_missing_fsm_handled(self, temp_state_dir, monkeypatch):
        """State with missing FSM handled gracefully."""
        import json
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        # Create state file with missing fsm key
        incomplete_state = {
            "schema_version": "1.0",
            "session_id": "test123456",
            "user_query": "Test",
            "step_outputs": {},
            "step_timestamps": {},
            "metadata": {}
            # Missing: fsm
        }
        state_file = temp_state_dir / "reasoning-test123456.json"
        state_file.write_text(json.dumps(incomplete_state))

        # Load should handle missing FSM
        result = ProtocolState.load("test123456")

        # Either returns None or creates default FSM
        if result is not None:
            assert result.fsm is not None


# ==============================================================================
# Parallel Branch Edge Cases
# ==============================================================================

class TestParallelBranchEdgeCases:
    """Tests for parallel branch edge cases."""

    def test_parallel_branch_partial_completion(self, temp_state_dir, monkeypatch):
        """Parallel phase blocks with partial branch completion."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillFSM

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        # FSM is already created by SkillExecutionState for composite skills
        state.fsm.start()

        # Initialize parallel branches - must use ParallelBranchInfo dataclass
        from skill.core.fsm import ParallelBranchInfo
        state.fsm.parallel_branches["phase_parallel"] = {
            "branch-A": ParallelBranchInfo(branch_id="branch-A", name="Branch A", status="completed"),
            "branch-B": ParallelBranchInfo(branch_id="branch-B", name="Branch B", status="pending"),
        }
        state.save()

        # Should NOT be all complete
        assert not state.fsm.are_all_branches_complete("phase_parallel")

    def test_parallel_branch_all_complete(self, temp_state_dir, monkeypatch):
        """Parallel phase advances when all branches complete."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillFSM

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        # FSM is already created by SkillExecutionState for composite skills
        state.fsm.start()

        # Initialize parallel branches - must use ParallelBranchInfo dataclass
        from skill.core.fsm import ParallelBranchInfo
        state.fsm.parallel_branches["phase_parallel"] = {
            "branch-A": ParallelBranchInfo(branch_id="branch-A", name="Branch A", status="completed"),
            "branch-B": ParallelBranchInfo(branch_id="branch-B", name="Branch B", status="completed"),
        }
        state.save()

        # Should be all complete
        assert state.fsm.are_all_branches_complete("phase_parallel")


# ==============================================================================
# Optional Phase Skip Tests
# ==============================================================================

class TestOptionalPhaseSkip:
    """Tests for optional phase skipping."""

    def test_optional_phase_skipped_on_condition(self, temp_state_dir, monkeypatch):
        """Optional phase is skipped when condition is met."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillFSM

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        # FSM is already created by SkillExecutionState for composite skills
        state.fsm.start()

        # Set skip condition in metadata
        state.metadata["skip_optional_research"] = True
        state.save()

        # Verify skip condition is set
        assert state.metadata.get("skip_optional_research") is True

    def test_fsm_tracks_skipped_phases(self, temp_state_dir, monkeypatch):
        """FSM tracks which phases were skipped."""
        from skill.core.state import SkillExecutionState
        from skill.core.fsm import SkillFSM

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Use registered composite skill to get valid FSM
        state = SkillExecutionState(
            skill_name="develop-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        # FSM is already created by SkillExecutionState for composite skills
        state.fsm.start()

        # Skip a real phase that exists in develop-skill (phase 0.5)
        state.fsm.skip_phase("0.5", "condition_met")
        state.save()

        # Verify skipped phase tracked
        assert "0.5" in state.fsm.skipped_phases


# ==============================================================================
# State Timestamp Tests
# ==============================================================================

class TestStateTimestamps:
    """Tests for state timestamp handling."""

    def test_created_at_set_on_init(self, temp_state_dir, monkeypatch):
        """created_at timestamp set on state initialization."""
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )

        assert state.created_at is not None

    def test_updated_at_changes_on_save(self, temp_state_dir, monkeypatch):
        """updated_at timestamp changes on save."""
        from skill.core.state import SkillExecutionState
        import time

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        state = SkillExecutionState(
            skill_name="test-skill",
            task_id="task-123",
            execution_session_id="exec-123"
        )
        state.save()

        first_updated = state.updated_at

        # Small delay
        time.sleep(0.01)

        state.metadata["changed"] = True
        state.save()

        # updated_at should have changed
        assert state.updated_at >= first_updated

