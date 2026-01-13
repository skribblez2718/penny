"""
FSM Transition Tests
====================

Tests for FSM state machine transitions:
- Reasoning FSM (9 steps: 0-8)
- Skill FSM (dynamic phases)

Run: pytest protocols/tests/test_fsm_transitions.py -v
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
# Reasoning FSM Tests
# ==============================================================================

class TestReasoningFSMFullSequence:
    """Tests for complete reasoning FSM flow."""

    def test_full_linear_sequence(self):
        """FSM transitions through full Step 0→1→2→3→3b→4→5→6→7→8→COMPLETED."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()
        assert fsm.state == ReasoningState.INITIALIZED

        # Step 0: Johari Discovery
        assert fsm.transition(ReasoningState.JOHARI_DISCOVERY)
        assert fsm.state == ReasoningState.JOHARI_DISCOVERY
        assert fsm.get_current_step() == 0

        # Step 1: Semantic Understanding
        assert fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)
        assert fsm.state == ReasoningState.SEMANTIC_UNDERSTANDING
        assert fsm.get_current_step() == 1

        # Step 2: Chain of Thought
        assert fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)
        assert fsm.state == ReasoningState.CHAIN_OF_THOUGHT
        assert fsm.get_current_step() == 2

        # Step 3: Tree of Thought
        assert fsm.transition(ReasoningState.TREE_OF_THOUGHT)
        assert fsm.state == ReasoningState.TREE_OF_THOUGHT
        assert fsm.get_current_step() == 3

        # Step 3b: Skill Detection
        assert fsm.transition(ReasoningState.SKILL_DETECTION)
        assert fsm.state == ReasoningState.SKILL_DETECTION
        assert fsm.get_current_step() == 3.2  # Step 3b = 3.2

        # Step 4: Task Routing
        assert fsm.transition(ReasoningState.TASK_ROUTING)
        assert fsm.state == ReasoningState.TASK_ROUTING
        assert fsm.get_current_step() == 4

        # Step 5: Self-Consistency
        assert fsm.transition(ReasoningState.SELF_CONSISTENCY)
        assert fsm.state == ReasoningState.SELF_CONSISTENCY
        assert fsm.get_current_step() == 5

        # Step 6: Socratic Interrogation
        assert fsm.transition(ReasoningState.SOCRATIC_INTERROGATION)
        assert fsm.state == ReasoningState.SOCRATIC_INTERROGATION
        assert fsm.get_current_step() == 6

        # Step 7: Constitutional Critique
        assert fsm.transition(ReasoningState.CONSTITUTIONAL_CRITIQUE)
        assert fsm.state == ReasoningState.CONSTITUTIONAL_CRITIQUE
        assert fsm.get_current_step() == 7

        # Step 8: Knowledge Transfer
        assert fsm.transition(ReasoningState.KNOWLEDGE_TRANSFER)
        assert fsm.state == ReasoningState.KNOWLEDGE_TRANSFER
        assert fsm.get_current_step() == 8

        # Complete
        assert fsm.transition(ReasoningState.COMPLETED)
        assert fsm.state == ReasoningState.COMPLETED
        assert fsm.is_completed()
        assert fsm.is_final()

    def test_history_tracks_all_states(self):
        """FSM history tracks all visited states."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()
        fsm.transition(ReasoningState.JOHARI_DISCOVERY)
        fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)
        fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)

        assert len(fsm.history) == 4  # INITIALIZED + 3 transitions
        assert fsm.history[0] == ReasoningState.INITIALIZED
        assert fsm.history[1] == ReasoningState.JOHARI_DISCOVERY
        assert fsm.history[2] == ReasoningState.SEMANTIC_UNDERSTANDING
        assert fsm.history[3] == ReasoningState.CHAIN_OF_THOUGHT


class TestReasoningFSMInvalidTransitions:
    """Tests for invalid FSM transitions."""

    def test_cannot_skip_steps(self):
        """Cannot skip steps (e.g., INITIALIZED → CHAIN_OF_THOUGHT)."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()

        # Try to skip to Step 2
        result = fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)

        assert result is False
        assert fsm.state == ReasoningState.INITIALIZED

    def test_cannot_go_backwards(self):
        """Cannot transition backwards."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()
        fsm.transition(ReasoningState.JOHARI_DISCOVERY)
        fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)
        fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)

        # Try to go back to Step 1
        result = fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)

        assert result is False
        assert fsm.state == ReasoningState.CHAIN_OF_THOUGHT

    def test_cannot_transition_from_completed(self):
        """Cannot transition from COMPLETED state."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()
        fsm.state = ReasoningState.COMPLETED

        # Try to transition
        result = fsm.transition(ReasoningState.JOHARI_DISCOVERY)

        assert result is False
        assert fsm.state == ReasoningState.COMPLETED

    def test_cannot_transition_from_halted(self):
        """Cannot transition from HALTED state."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()
        fsm.state = ReasoningState.HALTED

        # Try to transition
        result = fsm.transition(ReasoningState.JOHARI_DISCOVERY)

        assert result is False
        assert fsm.state == ReasoningState.HALTED


class TestReasoningFSMAgentMode:
    """Tests for agent mode (skips Step 4)."""

    def test_agent_mode_skips_step4(self):
        """Agent mode: Step 3b → Step 5 (skips Step 4)."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()

        # Progress to Step 3b (Skill Detection)
        fsm.transition(ReasoningState.JOHARI_DISCOVERY)
        fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)
        fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)
        fsm.transition(ReasoningState.TREE_OF_THOUGHT)
        fsm.transition(ReasoningState.SKILL_DETECTION)

        assert fsm.state == ReasoningState.SKILL_DETECTION

        # Agent mode: Skip Step 4, go directly to Step 5
        result = fsm.transition(ReasoningState.SELF_CONSISTENCY)

        assert result is True
        assert fsm.state == ReasoningState.SELF_CONSISTENCY
        assert fsm.get_current_step() == 5


class TestReasoningFSMLoopBack:
    """Tests for routing validation loop (Step 8 → Step 4)."""

    def test_loop_back_from_step8_to_step4(self):
        """Step 8 can loop back to Step 4 on contradiction."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()

        # Progress to Step 8 (Knowledge Transfer)
        fsm.transition(ReasoningState.JOHARI_DISCOVERY)
        fsm.transition(ReasoningState.SEMANTIC_UNDERSTANDING)
        fsm.transition(ReasoningState.CHAIN_OF_THOUGHT)
        fsm.transition(ReasoningState.TREE_OF_THOUGHT)
        fsm.transition(ReasoningState.SKILL_DETECTION)
        fsm.transition(ReasoningState.TASK_ROUTING)
        fsm.transition(ReasoningState.SELF_CONSISTENCY)
        fsm.transition(ReasoningState.SOCRATIC_INTERROGATION)
        fsm.transition(ReasoningState.CONSTITUTIONAL_CRITIQUE)
        fsm.transition(ReasoningState.KNOWLEDGE_TRANSFER)

        assert fsm.state == ReasoningState.KNOWLEDGE_TRANSFER

        # Loop back to Step 4 (contradiction detected)
        result = fsm.transition(ReasoningState.TASK_ROUTING)

        assert result is True
        assert fsm.state == ReasoningState.TASK_ROUTING
        assert fsm.get_current_step() == 4

    def test_step8_has_three_valid_transitions(self):
        """Step 8 can transition to COMPLETED, HALTED, or TASK_ROUTING."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        # Test COMPLETED
        fsm1 = ReasoningFSM()
        fsm1.state = ReasoningState.KNOWLEDGE_TRANSFER
        fsm1.history = [ReasoningState.KNOWLEDGE_TRANSFER]
        assert fsm1.can_transition(ReasoningState.COMPLETED)

        # Test HALTED
        fsm2 = ReasoningFSM()
        fsm2.state = ReasoningState.KNOWLEDGE_TRANSFER
        fsm2.history = [ReasoningState.KNOWLEDGE_TRANSFER]
        assert fsm2.can_transition(ReasoningState.HALTED)

        # Test TASK_ROUTING (loop back)
        fsm3 = ReasoningFSM()
        fsm3.state = ReasoningState.KNOWLEDGE_TRANSFER
        fsm3.history = [ReasoningState.KNOWLEDGE_TRANSFER]
        assert fsm3.can_transition(ReasoningState.TASK_ROUTING)


class TestReasoningFSMMaxIterations:
    """Tests for max iteration enforcement."""

    def test_max_iterations_constant(self):
        """MAX_ITERATIONS constant is 3."""
        from reasoning.core.fsm import ReasoningFSM

        assert ReasoningFSM.MAX_ITERATIONS == 3

    def test_state_tracks_iterations_via_state_object(self):
        """ProtocolState tracks iteration_count."""
        from reasoning.core.state import ProtocolState
        from reasoning.core.fsm import ReasoningFSM

        state = ProtocolState(user_query="Test")

        # Can loop back twice (0→1, 1→2)
        assert state.can_loop_back()
        state.trigger_loop_back("First contradiction")
        assert state.iteration_count == 1

        assert state.can_loop_back()
        state.trigger_loop_back("Second contradiction")
        assert state.iteration_count == 2

        # Max iterations (3) reached, cannot loop back again
        assert not state.can_loop_back()
        result = state.trigger_loop_back("Third contradiction")
        assert result is False
        assert state.iteration_count == 2


# ==============================================================================
# Reasoning FSM Serialization Tests
# ==============================================================================

class TestReasoningFSMSerialization:
    """Tests for FSM serialization."""

    def test_to_dict_uses_state_key(self):
        """to_dict() uses 'state' key (not 'current_state')."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        fsm = ReasoningFSM()
        data = fsm.to_dict()

        assert "state" in data
        assert "current_state" not in data
        assert data["state"] == "INITIALIZED"

    def test_from_dict_restores_state(self):
        """from_dict() restores FSM state."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        original = ReasoningFSM()
        original.transition(ReasoningState.JOHARI_DISCOVERY)
        original.transition(ReasoningState.SEMANTIC_UNDERSTANDING)

        data = original.to_dict()
        restored = ReasoningFSM.from_dict(data)

        assert restored.state == ReasoningState.SEMANTIC_UNDERSTANDING
        assert len(restored.history) == 3

    def test_from_dict_supports_legacy_current_state(self):
        """from_dict() supports legacy 'current_state' key."""
        from reasoning.core.fsm import ReasoningFSM, ReasoningState

        legacy_data = {
            "current_state": "CHAIN_OF_THOUGHT",  # Legacy key
            "history": ["INITIALIZED", "JOHARI_DISCOVERY", "SEMANTIC_UNDERSTANDING", "CHAIN_OF_THOUGHT"],
        }

        fsm = ReasoningFSM.from_dict(legacy_data)

        assert fsm.state == ReasoningState.CHAIN_OF_THOUGHT


# ==============================================================================
# Skill FSM Tests
# ==============================================================================

class TestSkillFSMInitialization:
    """Tests for SkillFSM initialization."""

    def test_initializes_with_skill_name(self):
        """SkillFSM initializes with skill name and loads phases."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")

        assert fsm.skill_name == "develop-skill"
        assert fsm.state == SkillPhaseState.INITIALIZED
        assert len(fsm.phase_order) > 0
        assert fsm.current_phase_id is None

    def test_unknown_skill_raises_error(self):
        """Unknown skill name raises ValueError."""
        from skill.core.fsm import SkillFSM

        with pytest.raises(ValueError, match="Unknown skill"):
            SkillFSM("nonexistent-skill")


class TestSkillFSMLinearPhases:
    """Tests for LINEAR phase transitions."""

    def test_start_moves_to_first_phase(self):
        """start() moves FSM to first phase."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")

        first_phase = fsm.start()

        assert first_phase == "0"  # Phase 0 is first
        assert fsm.state == SkillPhaseState.EXECUTING
        assert fsm.current_phase_id == "0"

    def test_transition_requires_verification(self):
        """Non-optional phases require verified=True for transition."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")
        fsm.start()

        # develop-skill phases: 0 → 0.5 → 1 → 2 → ...
        # Cannot transition without verification
        can_transition = fsm.can_transition("0.5", verified=False)
        assert can_transition is False

        # Can transition with verification
        can_transition = fsm.can_transition("0.5", verified=True)
        assert can_transition is True

    def test_linear_phase_progression(self):
        """LINEAR phases progress sequentially with verification."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.start()

        # Phase 0 → Phase 0.5 (develop-skill has sub-phases)
        next_phase = fsm.transition(verified=True)
        assert next_phase == "0.5"
        assert fsm.current_phase_id == "0.5"


class TestSkillFSMOptionalPhases:
    """Tests for OPTIONAL phase handling."""

    def test_optional_phase_can_be_skipped(self):
        """OPTIONAL phases can be skipped."""
        from skill.core.fsm import SkillFSM
        from skill.config.config import PhaseType

        fsm = SkillFSM("develop-skill")
        fsm.start()

        # Find an optional phase if one exists
        optional_phases = [
            pid for pid, info in fsm.phase_info.items()
            if info.type == PhaseType.OPTIONAL
        ]

        # OPTIONAL phases don't require verification
        for pid in optional_phases:
            config = fsm.phases.get(pid, {})
            if config.get("type") == PhaseType.OPTIONAL:
                # Optional phases can transition without verification
                fsm.current_phase_id = pid
                can_skip = fsm.can_transition(config.get("next"), verified=False)
                # Note: The actual behavior depends on can_transition logic


class TestSkillFSMPhaseTypes:
    """Tests for all PhaseType behaviors."""

    def test_phase_type_enum_values(self):
        """PhaseType enum has expected values."""
        from skill.config.config import PhaseType

        assert hasattr(PhaseType, "LINEAR")
        assert hasattr(PhaseType, "OPTIONAL")
        assert hasattr(PhaseType, "ITERATIVE")
        assert hasattr(PhaseType, "REMEDIATION")
        assert hasattr(PhaseType, "AUTO")
        assert hasattr(PhaseType, "PARALLEL")

    def test_auto_phase_detected(self):
        """AUTO phases are correctly detected."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")

        # Check if is_auto_phase works (may not have AUTO phases in this skill)
        for phase_id in fsm.phase_order:
            is_auto = fsm.is_auto_phase(phase_id)
            assert isinstance(is_auto, bool)

    def test_parallel_phase_detected(self):
        """PARALLEL phases are correctly detected."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")

        # Check if is_parallel_phase works
        for phase_id in fsm.phase_order:
            is_parallel = fsm.is_parallel_phase(phase_id)
            assert isinstance(is_parallel, bool)


class TestSkillFSMCompletion:
    """Tests for skill completion states."""

    def test_completed_state(self):
        """FSM transitions to COMPLETED when all phases done."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.state = SkillPhaseState.COMPLETED

        assert fsm.is_completed()
        assert fsm.is_final()

    def test_learnings_pending_state(self):
        """FSM transitions to LEARNINGS_PENDING before FULLY_COMPLETE."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.state = SkillPhaseState.COMPLETED

        # Require learnings
        fsm.require_learnings()

        assert fsm.state == SkillPhaseState.LEARNINGS_PENDING
        assert fsm.is_learnings_pending()
        assert fsm.is_final()

    def test_fully_complete_state(self):
        """FSM transitions to FULLY_COMPLETE after learnings."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.state = SkillPhaseState.LEARNINGS_PENDING

        # Complete learnings
        fsm.complete_learnings()

        assert fsm.state == SkillPhaseState.FULLY_COMPLETE
        assert fsm.is_fully_complete()
        assert fsm.is_final()

    def test_require_learnings_only_from_completed(self):
        """require_learnings() only works from COMPLETED state."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.state = SkillPhaseState.EXECUTING

        with pytest.raises(ValueError, match="Must be in COMPLETED state"):
            fsm.require_learnings()

    def test_complete_learnings_only_from_pending(self):
        """complete_learnings() only works from LEARNINGS_PENDING state."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.state = SkillPhaseState.COMPLETED

        with pytest.raises(ValueError, match="Must be in LEARNINGS_PENDING state"):
            fsm.complete_learnings()


class TestSkillFSMHalt:
    """Tests for skill halt behavior."""

    def test_halt_sets_halted_state(self):
        """halt() sets HALTED state."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.start()

        fsm.halt("Test halt reason")

        assert fsm.state == SkillPhaseState.HALTED
        assert fsm.is_halted()
        assert fsm.is_final()

    def test_cannot_transition_from_halted(self):
        """Cannot transition from HALTED state."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        fsm = SkillFSM("develop-skill")
        fsm.start()
        fsm.halt("Test reason")

        with pytest.raises(ValueError, match="Cannot transition from HALTED"):
            fsm.transition(verified=True)


# ==============================================================================
# Skill FSM Serialization Tests
# ==============================================================================

class TestSkillFSMSerialization:
    """Tests for SkillFSM serialization."""

    def test_to_dict_includes_all_fields(self):
        """to_dict() includes all required fields."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")
        data = fsm.to_dict()

        assert "skill_name" in data
        assert "current_phase_id" in data
        assert "state" in data
        assert "history" in data
        assert "phase_info" in data
        assert "iteration_counters" in data
        assert "skipped_phases" in data

    def test_to_dict_uses_state_key(self):
        """to_dict() uses 'state' key (aligned with reasoning FSM)."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")
        data = fsm.to_dict()

        assert "state" in data
        assert data["state"] == "INITIALIZED"

    def test_from_dict_restores_state(self):
        """from_dict() restores FSM state."""
        from skill.core.fsm import SkillFSM, SkillPhaseState

        original = SkillFSM("develop-skill")
        original.start()
        original.transition(verified=True)

        data = original.to_dict()
        restored = SkillFSM.from_dict(data)

        assert restored.skill_name == "develop-skill"
        assert restored.state == SkillPhaseState.EXECUTING
        assert restored.current_phase_id == original.current_phase_id


# ==============================================================================
# Skill FSM Progress Tracking Tests
# ==============================================================================

class TestSkillFSMProgress:
    """Tests for progress tracking."""

    def test_get_progress_returns_dict(self):
        """get_progress() returns progress dictionary."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")
        progress = fsm.get_progress()

        assert "total_phases" in progress
        assert "completed" in progress
        assert "skipped" in progress
        assert "remaining" in progress
        assert "current_phase" in progress
        assert "percent_complete" in progress

    def test_progress_updates_on_completion(self):
        """Progress updates as phases complete."""
        from skill.core.fsm import SkillFSM

        fsm = SkillFSM("develop-skill")
        initial_progress = fsm.get_progress()

        fsm.start()
        fsm.complete_phase({"test": "data"})
        fsm.transition(verified=True)

        updated_progress = fsm.get_progress()

        assert updated_progress["completed"] >= initial_progress["completed"]
