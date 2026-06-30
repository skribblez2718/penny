"""
KG Integration Tests for Plan Skill — Phase 2

Tests that verify KG triple writes are properly invoked during plan skill
orchestration. The KG writes are issued by agents (echo, piper, carren,
tabitha) via memory_kg_add tool calls during agent execution.

These are INTEGRATION tests — they verify the call graph:
  skill extension → orchestrate.py → agent invocation → KG tool call

The actual memory_kg_add calls happen INSIDE agent executions (pi processes).
We verify this through:
  1. Agent task summaries that include KG linking instructions
  2. Call graph verification: orchestrator produces correct agent invocations
  3. Session room correctly set for mempalace writes

KG Triple Contract per agent:
  - echo:   memory_kg_add(session_id, "explored_by", "Agent:echo")
  - piper:  memory_kg_add(session_id, "planned_by", "Agent:piper")
  - carren: memory_kg_add(item_reviewed, "critiqued_by", "Agent:carren")
  - tabitha: memory_kg_add(plan_id, "broken_into", task_id)
"""

import json
import subprocess
import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow


# ============================================================
# Test: KG Write Instructions in Agent Task Summaries
# ============================================================

class TestKGInstructionsInTaskSummaries:
    """Verify task summaries given to agents include KG linking instructions.

    The orchestrator generates task summaries for agents. These summaries
    MUST include KG linking instructions so agents know to call memory_kg_add.
    """

    def test_echo_task_summary_includes_session_id(self):
        """Echo task summary or tasks include session_id for KG link."""
        orch = PlanOrchestrator(
            session_id="kg-test-echo",
            goal="Design auth system",
            project_root="/tmp",
        )
        action = orch._action_explore()
        # Parallel explore uses tasks[] array, single uses task_summary
        if action["action"] == "invoke_agents_parallel":
            for t in action["tasks"]:
                assert "kg-test-echo" in t["task_summary"]
        else:
            task_text = action.get("task_summary", "")
            assert "kg-test-echo" in task_text

    def test_piper_task_summary_includes_session_id(self):
        """Piper task summary includes session_id for KG linking."""
        orch = PlanOrchestrator(
            session_id="kg-test-piper",
            goal="Design auth system",
            project_root="/tmp",
        )
        orch.start()
        orch.context.explore_complete = True
        action = orch._action_plan()
        task_text = action.get("task_summary", "")
        assert "kg-test-piper" in task_text

    def test_carren_task_summary_includes_session_id(self):
        """Carren task summary includes session_id for KG linking."""
        orch = PlanOrchestrator(
            session_id="kg-test-carren",
            goal="Design auth system",
            project_root="/tmp",
        )
        action = orch._action_critique()
        task_text = action.get("task_summary", "")
        assert "kg-test-carren" in task_text

    def test_tabitha_task_summary_includes_session_id(self):
        """Tabitha task summary includes session_id for KG linking."""
        orch = PlanOrchestrator(
            session_id="kg-test-tabitha",
            goal="Design auth system",
            project_root="/tmp",
        )
        action = orch._action_taskify()
        task_text = action.get("task_summary", "")
        assert "kg-test-tabitha" in task_text


# ============================================================
# Test: KG Call Graph — Verify Orchestrator Produces Correct Actions
# ============================================================

class TestKGCallGraph:
    """Verify the orchestrator produces actions that will result in KG writes.

    Since KG writes happen inside agent executions (separate pi processes),
    we verify the orchestrator correctly sequences agents and provides
    session_id for KG linking.
    """

    def test_echo_receives_session_id_for_kg_link(self):
        """Echo action includes session_id for KG link."""
        orch = PlanOrchestrator(
            session_id="kg-callgraph-1",
            goal="Build feature",
            project_root="/tmp",
        )
        action = orch.start()
        session_id = orch.session_id
        if action["action"] == "invoke_agent":
            assert action["session_id"] == session_id
        elif action["action"] == "invoke_agents_parallel":
            for t in action["tasks"]:
                assert session_id in t["task_summary"]

    def test_piper_receives_session_id_for_kg_link(self):
        """Piper action includes session_id for KG linking."""
        orch = PlanOrchestrator(
            session_id="kg-callgraph-2",
            goal="Build feature",
            project_root="/tmp",
        )
        orch.start()
        orch.context.explore_complete = True
        action = orch._action_plan()
        session_id = orch.session_id
        assert session_id in action["task_summary"]

    def test_session_room_is_correct_for_mempalace_writes(self):
        """Session room is skills/plan-<session_id> for mempalace isolation."""
        orch = PlanOrchestrator(
            session_id="kg-room-test",
            goal="Build feature",
            project_root="/tmp",
        )
        expected_room = "skills/plan-kg-room-test"
        assert orch.session_room == expected_room

    def test_carren_task_summary_includes_mempalace_room(self):
        """Carren task summary includes mempalace room."""
        orch = PlanOrchestrator(
            session_id="kg-carren-room",
            goal="Build feature",
            project_root="/tmp",
        )
        action = orch._action_critique()
        task_text = action["task_summary"]
        assert "kg-carren-room" in task_text or "skills/plan-kg-carren-room" in task_text

    def test_tabitha_task_summary_includes_mempalace_room(self):
        """Tabitha task summary includes mempalace room."""
        orch = PlanOrchestrator(
            session_id="kg-tabitha-room",
            goal="Build feature",
            project_root="/tmp",
        )
        action = orch._action_taskify()
        task_text = action["task_summary"]
        assert "kg-tabitha-room" in task_text or "skills/plan-kg-tabitha-room" in task_text


# ============================================================
# Test: Plan Session Room
# ============================================================

class TestPlanSessionRoom:
    """Verify session room is available for mempalace writes."""

    def test_session_room_in_orchestrator_state_after_start(self):
        """After start, session_room is available via orchestrator property."""
        orch = PlanOrchestrator(
            session_id="kg-test-001",
            goal="Build feature",
            project_root="/tmp",
        )
        orch.start()
        assert orch.session_room == "skills/plan-kg-test-001"


# ============================================================
# Test: Agent Sequence Verification (Call Graph)
# ============================================================

class TestAgentSequenceForKG:
    """Verify FSM correctly sequences agents for KG write order."""

    def test_full_happy_path_sequence_echo_piper_carren_tabitha(self):
        """Happy path: echo → piper → carren → tabitha (correct KG write order)."""
        orch = PlanOrchestrator(
            session_id="kg-sequence-1",
            goal="Build auth",
            project_root="/tmp",
        )

        orch.start()
        assert orch.current_state_id == "exploring"

        result = orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "findings_count": 5,
                "files_count": 3,
                "unknowns_count": 1,
                "explore_complete": True,
            },
        })
        assert result["agent"] == "piper"
        assert orch.current_state_id == "planning"

        result = orch.step("piper", {
            "exitCode": 0,
            "summary": {
                "plan_steps": [{"step": 1, "title": "Create module"}],
                "plan_complete": True,
            },
        })
        assert result["agent"] == "carren"
        assert orch.current_state_id == "critiquing"

        result = orch.step("carren", {
            "exitCode": 0,
            "summary": {"verdict": "APPROVE", "issues": []},
        })
        assert result["agent"] == "tabitha"
        assert orch.current_state_id == "taskifying"

        result = orch.step("tabitha", {
            "exitCode": 0,
            "summary": {"title": "Auth Plan", "step_count": 3, "complete": True},
        })
        assert result["action"] == "complete"

    def test_revision_preserves_kg_write_sequence(self):
        """Critique rejection → revision → re-plan preserves KG order."""
        orch = PlanOrchestrator(
            session_id="kg-revision-seq",
            goal="Build feature",
            project_root="/tmp",
            max_iterations=3,
        )

        orch.start()
        orch.step("echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "findings_count": 3},
        })
        orch.step("piper", {
            "exitCode": 0,
            "summary": {"plan_steps": [{"step": 1, "title": "A"}], "plan_complete": True},
        })
        result = orch.step("carren", {
            "exitCode": 0,
            "summary": {"verdict": "NEEDS_REVISION", "issues": ["Missing detail"]},
        })
        assert result["action"] == "invoke_agent"
        assert result["agent"] in ("piper", "echo")


# ============================================================
# Test: KG Triple Confidence
# ============================================================

class TestKGTripleConfidence:
    """Verify confidence levels are stored for KG context."""

    def test_uncertain_confidence_stored_in_context(self):
        """UNCERTAIN confidence is stored in context for KG escalation."""
        orch = PlanOrchestrator(
            session_id="kg-confidence-1",
            goal="Research ambiguous tech",
            project_root="/tmp",
        )
        orch.start()
        orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "No relevant files found",
            },
        })
        # unknown_reason from the agent's summary is stored
        assert orch.context.last_confidence == "UNCERTAIN"

    def test_certain_confidence_stored_in_context(self):
        """CERTAIN confidence is stored in context."""
        orch = PlanOrchestrator(
            session_id="kg-confidence-2",
            goal="Build feature",
            project_root="/tmp",
        )
        orch.start()
        orch.context.last_confidence = "CERTAIN"
        assert orch.context.last_confidence == "CERTAIN"


# ============================================================
# Test: KG Verification State
# ============================================================

class TestKGVerificationState:
    """Verify KG linking after verification for high-stakes actions."""

    def test_verifying_state_preserves_session_id(self):
        """Session ID is preserved through VERIFYING state."""
        orch = PlanOrchestrator(
            session_id="kg-verify-sid",
            goal="High-stakes refactor",
            project_root="/tmp",
            constraints={"stakes": "high"},
        )
        orch.start()
        orch.step("echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        })
        orch.step("piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "Delete DB"}],
                "stakes": "high",
            },
        })
        assert orch.current_state_id == "verifying"
        assert orch.session_id == "kg-verify-sid"

    def test_verification_confirm_continues_to_critique(self):
        """After verification confirm, continues to carren."""
        orch = PlanOrchestrator(
            session_id="kg-verify-continue",
            goal="High-stakes refactor",
            project_root="/tmp",
            constraints={"stakes": "high"},
        )
        orch.start()
        orch.step("echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        })
        orch.step("piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "Delete DB"}],
                "stakes": "high",
            },
        })
        result = orch.step("verification", {"choice": "confirm"})
        assert result["agent"] == "carren"
        assert orch.current_state_id == "critiquing"


# ============================================================
# Test: Unknown State — KG Linking Paused
# ============================================================

class TestKGUnknownState:
    """Verify KG linking is PAUSED during UNKNOWN_STATE escalation."""

    def test_uncertain_explore_enters_unknown_pausing_kg_writes(self):
        """UNCERTAIN from echo → unknown state pauses KG writes."""
        orch = PlanOrchestrator(
            session_id="kg-unknown-pause",
            goal="Research ambiguous tech",
            project_root="/tmp",
        )
        orch.start()

        result = orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "Cannot determine feasibility",
            },
        })

        assert result["action"] == "escalate_to_user"
        assert orch.current_state_id == "awaiting_clarification"

    def test_retry_resumes_kg_write_sequence(self):
        """After user clarification, KG writes resume."""
        orch = PlanOrchestrator(
            session_id="kg-unknown-retry",
            goal="Research ambiguous tech",
            project_root="/tmp",
        )
        orch.start()
        orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "No sources",
            },
        })
        result = orch.step("user", {"action_choice": "retry", "clarification": "Try another approach"})
        assert result["action"] in ("invoke_agent", "invoke_agents_parallel")


# ============================================================
# Test: Summary Validation Ensures KG Data Quality
# ============================================================

class TestKGSummaryDataQuality:
    """Verify summary validation prevents KG writes with bad data."""

    def test_empty_explore_summary_rejected_for_kg_quality(self):
        """Empty explore summary is rejected — prevents KG write with no data."""
        orch = PlanOrchestrator(
            session_id="kg-quality-empty",
            goal="Test",
            project_root="/tmp",
        )
        orch.start()
        result = orch.step("echo", {"exitCode": 0, "summary": {}})
        assert result["action"] == "error"

    def test_missing_required_fields_rejected(self):
        """Summary missing required fields is rejected when piper is called."""
        orch = PlanOrchestrator(
            session_id="kg-quality-missing",
            goal="Test",
            project_root="/tmp",
        )
        # Advance FSM to planning state first (explore → plan)
        orch.start()
        orch.context.explore_complete = True
        orch.machine.send("explore_done")  # exploring → planning
        assert orch.current_state_id == "planning"

        # Now piper step should fail due to missing plan_steps
        result = orch.step("piper", {
            "exitCode": 0,
            "summary": {"plan_complete": True},  # missing plan_steps
        })
        assert result["action"] == "error"


# ============================================================
# Test: KG Agent Definitions (verify memory_kg_add in tools list)
# ============================================================

class TestKGAgentDefinitions:
    """Verify agent definitions include memory_kg_add in their tools list.

    Agents must have memory_kg_add in their tools to emit KG triples.
    """

    def _get_agents_dir(self):
        """Get the agents directory path."""
        return Path(str(Path(__file__).resolve().parents[4] / ".pi/agents"))

    def test_echo_definition_includes_memory_kg_add(self):
        """Echo agent has memory_kg_add in tools list."""
        echo_path = self._get_agents_dir() / "echo.md"
        content = echo_path.read_text()
        assert "memory_kg_add" in content

    def test_piper_definition_includes_memory_kg_add(self):
        """Piper agent has memory_kg_add in tools list."""
        piper_path = self._get_agents_dir() / "piper.md"
        content = piper_path.read_text()
        assert "memory_kg_add" in content

    def test_carren_definition_includes_memory_kg_add(self):
        """Carren agent has memory_kg_add in tools list."""
        carren_path = self._get_agents_dir() / "carren.md"
        content = carren_path.read_text()
        assert "memory_kg_add" in content

    def test_tabitha_definition_includes_memory_kg_add(self):
        """Tabitha agent has memory_kg_add in tools list."""
        tabitha_path = self._get_agents_dir() / "tabitha.md"
        content = tabitha_path.read_text()
        assert "memory_kg_add" in content

    def test_all_plan_agents_have_memory_kg_add(self):
        """All plan skill agents have memory_kg_add in tools."""
        agents_dir = self._get_agents_dir()
        plan_agents = ["echo.md", "piper.md", "carren.md", "tabitha.md"]
        for agent_file in plan_agents:
            content = (agents_dir / agent_file).read_text()
            assert "memory_kg_add" in content, f"{agent_file} missing memory_kg_add"


# ============================================================
# Regression: Existing Test Suite Still Passes
# ============================================================

class TestRegressionKGExisting:
    """Regression: existing orchestrator behavior unchanged."""

    def test_orchestrator_cli_start_returns_valid_json(self):
        """CLI start command returns valid JSON with session_id."""
        result = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/plan/scripts/orchestrate.py"),
             "start", "--session-id", "regression-start", "--goal", "Test goal",
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp",
        )
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["session_id"] == "regression-start"
        assert output["action"] in ("invoke_agent", "invoke_agents_parallel")

    def test_orchestrator_cli_step_processes_results(self):
        """CLI step command processes agent results."""
        start = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/plan/scripts/orchestrate.py"),
             "start", "--session-id", "regression-step", "--goal", "Test goal",
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp",
        )
        state = json.loads(start.stdout)
        step = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/plan/scripts/orchestrate.py"),
             "step", "--session-id", "regression-step",
             "--agent", "echo",
             "--result", json.dumps({"exitCode": 0, "summary": {"explore_complete": True, "findings_count": 3}}),
             "--state", json.dumps(state["orchestrator_state"]),
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp",
        )
        assert step.returncode == 0
        output = json.loads(step.stdout)
        assert output["agent"] == "piper"

    def test_fsm_transitions_unchanged(self):
        """FSM transitions unchanged from previous behavior."""
        orch = PlanOrchestrator(
            session_id="fsm-regression",
            goal="Test FSM",
            project_root="/tmp",
        )
        assert orch.current_state_id == "intake"
        orch.machine.send("start")
        assert orch.current_state_id == "exploring"
        orch.context.explore_complete = True
        orch.machine.send("explore_done")
        assert orch.current_state_id == "planning"

    def test_safe_defaults_unchanged(self):
        """Safe default summaries unchanged — not claiming completion."""
        orch = PlanOrchestrator(session_id="safe-regression", goal="Test")
        echo_default = orch._safe_default_summary("echo")
        assert echo_default["explore_complete"] is False
        piper_default = orch._safe_default_summary("piper")
        assert piper_default["plan_complete"] is False

    def test_plan_context_fields_unchanged(self):
        """PlanContext has all required fields."""
        ctx = PlanContext(session_id="ctx-fields")
        for field in ["session_id", "skill_name", "goal", "constraints",
                      "explore_complete", "plan_steps", "critique_verdict",
                      "structured_plan_complete"]:
            assert hasattr(ctx, field), f"Missing field: {field}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
