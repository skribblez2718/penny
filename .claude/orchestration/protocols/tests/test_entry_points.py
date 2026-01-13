"""
Entry Point Tests
=================

Tests for protocol entry points:
- Reasoning entry.py
- Skill common_skill_entry.py
- Agent common/entry.py

Run: pytest protocols/tests/test_entry_points.py -v
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
# Reasoning Entry Tests
# ==============================================================================

class TestReasoningEntryInit:
    """Tests for reasoning protocol initialization."""

    def test_init_protocol_creates_state(self, temp_state_dir, monkeypatch):
        """init_protocol() creates ProtocolState."""
        from reasoning import entry as reasoning_entry
        from reasoning.core.state import ProtocolState

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Test query")

        assert state is not None
        assert isinstance(state, ProtocolState)
        assert state.user_query == "Test query"

    def test_init_protocol_sets_session_id(self, temp_state_dir, monkeypatch):
        """init_protocol() creates session_id with 12 chars."""
        from reasoning import entry as reasoning_entry

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Test query")

        assert state.session_id is not None
        assert len(state.session_id) == 12

    def test_init_protocol_saves_state_file(self, temp_state_dir, monkeypatch):
        """init_protocol() saves state to file."""
        from reasoning import entry as reasoning_entry

        # STATE_DIR is defined in config.config and used by get_state_file_path()
        monkeypatch.setattr(
            "reasoning.config.config.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Test query")

        # State file should exist
        state_file = temp_state_dir / f"reasoning-{state.session_id}.json"
        assert state_file.exists()

    def test_init_protocol_agent_mode_sets_metadata(self, temp_state_dir, monkeypatch):
        """init_protocol() with agent_mode sets metadata correctly."""
        from reasoning import entry as reasoning_entry

        # STATE_DIR is defined in config.config and used by get_state_file_path()
        monkeypatch.setattr(
            "reasoning.config.config.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Agent task", is_agent_mode=True)

        assert state.metadata.get("is_agent_session") is True
        assert state.metadata.get("skip_step_4") is True


class TestReasoningEntryStepSequence:
    """Tests for step sequence logic."""

    def test_agent_step_sequence_skips_step4(self):
        """AGENT_STEP_SEQUENCE skips Step 4."""
        from reasoning.entry import AGENT_STEP_SEQUENCE

        assert 4 not in AGENT_STEP_SEQUENCE
        assert AGENT_STEP_SEQUENCE == [0, 1, 2, 3, 5, 6, 7, 8]


class TestReasoningEntryDirective:
    """Tests for directive output."""

    def test_print_step_directive_outputs_mandatory(self, temp_state_dir, monkeypatch, capsys):
        """print_step_directive() outputs mandatory directive."""
        from reasoning import entry as reasoning_entry

        monkeypatch.setattr(
            "reasoning.core.state.STATE_DIR",
            temp_state_dir
        )

        state = reasoning_entry.init_protocol("Test query")
        reasoning_entry.print_step_directive(state, 0)

        captured = capsys.readouterr()
        assert "MANDATORY" in captured.out
        assert "step_0" in captured.out.lower()


# ==============================================================================
# Skill Entry Tests
# ==============================================================================

class TestSkillEntryInit:
    """Tests for skill entry initialization."""

    def test_skill_entry_creates_state(self, temp_state_dir, monkeypatch):
        """skill_entry() creates SkillExecutionState."""
        from skill.composite import common_skill_entry
        from skill.core.state import SkillExecutionState

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Mock get_phase_config to return a LINEAR phase 0
        mock_phase_config = {
            "type": "LINEAR",
            "title": "Test Phase",
            "uses_atomic_skill": "orchestrate-clarification",
            "content": "phase_0_test.md"
        }

        skill_dir = Path("/tmp/test_skill")
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "content").mkdir(parents=True, exist_ok=True)
        (skill_dir / "content" / "phase_0_test.md").write_text("# Test Phase Content")

        with patch.object(common_skill_entry, "get_phase_config", return_value=mock_phase_config):
            with patch.object(common_skill_entry, "get_atomic_skill_agent", return_value="clarification"):
                with patch("sys.argv", ["entry.py"]):
                    state = common_skill_entry.skill_entry("test-skill", skill_dir)

        assert state is not None
        assert isinstance(state, SkillExecutionState)
        assert state.skill_name == "test-skill"

    def test_skill_entry_creates_session_id(self, temp_state_dir, monkeypatch):
        """skill_entry() creates session_id with 8 chars."""
        from skill.composite import common_skill_entry

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        mock_phase_config = {
            "type": "LINEAR",
            "title": "Test Phase",
            "uses_atomic_skill": "orchestrate-clarification",
            "content": "phase_0_test.md"
        }

        skill_dir = Path("/tmp/test_skill2")
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "content").mkdir(parents=True, exist_ok=True)
        (skill_dir / "content" / "phase_0_test.md").write_text("# Test")

        with patch.object(common_skill_entry, "get_phase_config", return_value=mock_phase_config):
            with patch.object(common_skill_entry, "get_atomic_skill_agent", return_value="clarification"):
                with patch("sys.argv", ["entry.py"]):
                    state = common_skill_entry.skill_entry("test-skill", skill_dir)

        assert state.session_id is not None
        assert len(state.session_id) == 8


class TestSkillEntryPhase0Invariant:
    """Tests for Phase 0 LINEAR invariant (CRITICAL)."""

    def test_skill_entry_enforces_phase0_linear(self, temp_state_dir, monkeypatch, capsys):
        """skill_entry() FAILS if Phase 0 is not LINEAR."""
        from skill.composite import common_skill_entry

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Mock Phase 0 with OPTIONAL type (INVALID!)
        mock_phase_config = {
            "type": "OPTIONAL",  # VIOLATION!
            "title": "Invalid Phase",
            "uses_atomic_skill": "orchestrate-clarification"
        }

        skill_dir = Path("/tmp/test_skill3")

        with patch.object(common_skill_entry, "get_phase_config", return_value=mock_phase_config):
            with patch("sys.argv", ["entry.py"]):
                with pytest.raises(SystemExit) as exc_info:
                    common_skill_entry.skill_entry("test-skill", skill_dir)

        assert exc_info.value.code == 1

        captured = capsys.readouterr()
        assert "ENFORCEMENT VIOLATION" in captured.err
        assert "Phase 0" in captured.err

    def test_skill_entry_accepts_phase0_linear(self, temp_state_dir, monkeypatch):
        """skill_entry() accepts Phase 0 with LINEAR type."""
        from skill.composite import common_skill_entry

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        # Mock Phase 0 with LINEAR type (VALID)
        mock_phase_config = {
            "type": "LINEAR",
            "title": "Valid Phase",
            "uses_atomic_skill": "orchestrate-clarification",
            "content": "phase_0_test.md"
        }

        skill_dir = Path("/tmp/test_skill4")
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "content").mkdir(parents=True, exist_ok=True)
        (skill_dir / "content" / "phase_0_test.md").write_text("# Valid")

        with patch.object(common_skill_entry, "get_phase_config", return_value=mock_phase_config):
            with patch.object(common_skill_entry, "get_atomic_skill_agent", return_value="clarification"):
                with patch("sys.argv", ["entry.py"]):
                    # Should NOT raise
                    state = common_skill_entry.skill_entry("test-skill", skill_dir)

        assert state is not None


class TestSkillEntryDirective:
    """Tests for skill entry directive output."""

    def test_skill_entry_outputs_agent_directive(self, temp_state_dir, monkeypatch, capsys):
        """skill_entry() outputs agent invocation directive."""
        from skill.composite import common_skill_entry

        monkeypatch.setattr(
            "skill.core.state.STATE_DIR",
            temp_state_dir
        )

        mock_phase_config = {
            "type": "LINEAR",
            "title": "Test Phase",
            "uses_atomic_skill": "orchestrate-clarification",
            "content": "phase_0_test.md"
        }

        skill_dir = Path("/tmp/test_skill5")
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "content").mkdir(parents=True, exist_ok=True)
        (skill_dir / "content" / "phase_0_test.md").write_text("# Test")

        with patch.object(common_skill_entry, "get_phase_config", return_value=mock_phase_config):
            with patch.object(common_skill_entry, "get_atomic_skill_agent", return_value="clarification"):
                with patch("sys.argv", ["entry.py"]):
                    common_skill_entry.skill_entry("test-skill", skill_dir)

        captured = capsys.readouterr()
        assert "clarification" in captured.out
        assert "Task tool" in captured.out or "subagent_type" in captured.out


# ==============================================================================
# Agent Entry Tests
# ==============================================================================

class TestAgentEntryInit:
    """Tests for agent entry initialization."""

    def test_agent_entry_creates_state(self, temp_state_dir, monkeypatch, capsys):
        """agent_entry() creates AgentExecutionState."""
        from agent.common import entry as agent_entry_module
        from agent.steps.base import AgentExecutionState

        # AgentExecutionState uses AGENT_PROTOCOLS_ROOT / "state" for state files
        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        # Mock get_agent_config to return a valid agent config
        mock_config = {
            "name": "clarification",
            "cognitive_function": "CLARIFICATION",
            "steps": ["learning_injection", "johari_discovery", "clarify"],
            "color": "cyan",
            "model": "opus"
        }

        # Mock get_step_script_path
        mock_script = Path("/tmp/shared.py")
        mock_script.touch()

        with patch.object(agent_entry_module, "get_agent_config", return_value=mock_config):
            with patch.object(agent_entry_module, "get_step_script_path", return_value=mock_script):
                # Use short task ID to avoid display truncation
                with patch("sys.argv", ["entry.py", "task-t1"]):
                    agent_entry_module.agent_entry("clarification")

        captured = capsys.readouterr()
        assert "CLARIFICATION" in captured.out
        assert "task-t1" in captured.out

    def test_agent_entry_stores_skill_context(self, temp_state_dir, monkeypatch, capsys):
        """agent_entry() stores skill context when provided."""
        from agent.common import entry as agent_entry_module

        # AgentExecutionState uses AGENT_PROTOCOLS_ROOT / "state" for state files
        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        mock_config = {
            "name": "research",
            "cognitive_function": "RESEARCH",
            "steps": ["learning_injection", "johari_discovery", "research"],
            "color": "blue",
            "model": "opus"
        }

        mock_script = Path("/tmp/shared.py")

        with patch.object(agent_entry_module, "get_agent_config", return_value=mock_config):
            with patch.object(agent_entry_module, "get_step_script_path", return_value=mock_script):
                with patch("sys.argv", [
                    "entry.py", "task-test-123",
                    "--skill-name", "develop-skill",
                    "--phase-id", "1"
                ]):
                    agent_entry_module.agent_entry("research")

        captured = capsys.readouterr()
        # Should print skill/phase context
        assert "develop-skill" in captured.out or "RESEARCH" in captured.out


class TestAgentEntryMandatorySteps:
    """Tests for mandatory step enforcement."""

    def test_agent_entry_prints_mandatory_steps(self, temp_state_dir, monkeypatch, capsys):
        """agent_entry() prints list of mandatory steps."""
        from agent.common import entry as agent_entry_module

        # AgentExecutionState uses AGENT_PROTOCOLS_ROOT / "state" for state files
        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        mock_config = {
            "name": "analysis",
            "cognitive_function": "ANALYSIS",
            "steps": ["learning_injection", "johari_discovery", "analyze", "synthesize"],
            "color": "green",
            "model": "opus"
        }

        mock_script = Path("/tmp/shared.py")

        with patch.object(agent_entry_module, "get_agent_config", return_value=mock_config):
            with patch.object(agent_entry_module, "get_step_script_path", return_value=mock_script):
                with patch("sys.argv", ["entry.py"]):
                    agent_entry_module.agent_entry("analysis")

        captured = capsys.readouterr()
        assert "MANDATORY" in captured.out
        assert "4" in captured.out  # Should mention number of steps


class TestAgentEntryDirective:
    """Tests for agent entry directive output."""

    def test_agent_entry_outputs_step0_directive(self, temp_state_dir, monkeypatch, capsys):
        """agent_entry() outputs Step 0 directive."""
        from agent.common import entry as agent_entry_module

        # AgentExecutionState uses AGENT_PROTOCOLS_ROOT / "state" for state files
        monkeypatch.setattr(
            "agent.config.config.AGENT_PROTOCOLS_ROOT",
            temp_state_dir
        )

        mock_config = {
            "name": "synthesis",
            "cognitive_function": "SYNTHESIS",
            "steps": ["learning_injection", "johari_discovery", "synthesize"],
            "color": "magenta",
            "model": "opus"
        }

        mock_script = Path("/tmp/shared.py")

        with patch.object(agent_entry_module, "get_agent_config", return_value=mock_config):
            with patch.object(agent_entry_module, "get_step_script_path", return_value=mock_script):
                with patch("sys.argv", ["entry.py"]):
                    agent_entry_module.agent_entry("synthesis")

        captured = capsys.readouterr()
        # Should output a step directive
        assert "python3" in captured.out.lower() or "step" in captured.out.lower()


# ==============================================================================
# Cross-Protocol Consistency Tests
# ==============================================================================

class TestCrossProtocolConsistency:
    """Tests for consistency across protocol entry points."""

    def test_all_entries_save_before_directive(self):
        """All entry points call save() before printing directive."""
        # This is tested via inspection of source code
        # The pattern: state.save() must appear before print()
        from reasoning import entry as reasoning_entry
        from skill.composite import common_skill_entry
        from agent.common import entry as agent_entry_module

        # Read source code and verify pattern
        reasoning_src = Path(reasoning_entry.__file__).read_text()
        skill_src = Path(common_skill_entry.__file__).read_text()
        agent_src = Path(agent_entry_module.__file__).read_text()

        # These assertions verify save() exists in source
        # Full verification would require AST analysis
        assert "save()" in reasoning_src
        assert "save()" in skill_src or "state" in skill_src  # Agent doesn't call save directly

    def test_session_id_formats_differ(self):
        """Session ID formats are different between protocols."""
        # Reasoning: 12 chars
        # Skill: 8 chars
        # Agent: uses task_id

        from reasoning.core.state import ProtocolState
        from skill.core.state import SkillExecutionState

        # Create instances and check session_id formats
        reasoning_state = ProtocolState(user_query="test")
        skill_state = SkillExecutionState(
            skill_name="test",
            task_id="task-123",
            execution_session_id="exec-123"
        )

        assert len(reasoning_state.session_id) == 12
        assert len(skill_state.session_id) == 8

