"""Unit tests for Code Skill Orchestrator."""

import json
import sys
import pytest
from pathlib import Path

# Add scripts directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from orchestrate import (
    CodeSession,
    CodeWorkflow,
    handle_explore,
    handle_implement,
    handle_verify,
    handle_learn,
    start,
    _prd_available,
    _apply_server_detection,
)


class TestCodeSession:
    def test_session_creation(self):
        session = CodeSession("test-001", "Fix login bug")
        assert session.session_id == "test-001"
        assert session.goal == "Fix login bug"
        assert session.iteration == 0
        assert session.language is None

    def test_session_serialization(self):
        session = CodeSession("test-001", "Fix login bug")
        session.language = "python"
        session.iteration = 3

        data = session.to_dict()
        restored = CodeSession.from_dict(data)

        assert restored.session_id == "test-001"
        assert restored.language == "python"
        assert restored.iteration == 3

    def test_session_language_persistence(self):
        session = CodeSession("test-002", "Add rate limiting")
        session.language = "python"
        session.ideal_state = {
            "goal": "Add rate limiting",
            "success_criteria": ["429 on 5 attempts"],
            "language": "python",
        }

        data = session.to_dict()
        restored = CodeSession.from_dict(data)

        assert restored.language == "python"
        assert restored.ideal_state["goal"] == "Add rate limiting"


class TestPRDAvailable:
    """Tests for _prd_available() — PRD dependency check."""

    def test_prd_available_with_ideal_state(self):
        """_prd_available returns exists=True when ideal_state present."""
        state_data = {
            "ideal_state": {
                "goal": "Build auth API",
                "success_criteria": ["Login works"],
                "language": "python",
            },
            "goal": "Build auth API",
        }
        result = _prd_available(state_data)
        assert result["exists"] is True
        assert result["ideal_state"]["goal"] == "Build auth API"
        assert result["prd_goal"] == "Build auth API"

    def test_prd_available_missing(self):
        """_prd_available returns exists=False when state_data is empty."""
        result = _prd_available({})
        assert result["exists"] is False
        assert result["ideal_state"] is None

    def test_prd_available_none(self):
        """_prd_available returns exists=False when state_data is None."""
        result = _prd_available(None)
        assert result["exists"] is False

    def test_prd_available_missing_success_criteria(self):
        """_prd_available returns exists=False when ideal_state has no success_criteria."""
        state_data = {
            "ideal_state": {
                "goal": "Build something",
            }
        }
        result = _prd_available(state_data)
        assert result["exists"] is False


class TestOrchestratorActions:
    def test_explore_is_initial_state(self):
        """Workflow starts at explore (not intake)."""
        session = CodeSession("test-001", "Build something")
        machine = CodeWorkflow(session)
        assert machine.explore.is_active

    def test_start_without_prd_emits_chain_contract_error(self):
        """start() without state_data returns error with chain instructions."""
        result = start("test-001", "Build something")
        assert result["action"] == "error"
        assert "PRD dependency" in result["errors"][0]
        assert "chain" in result["errors"][2].lower()

    def test_start_with_prd_advances_to_explore(self):
        """start() with valid state_data starts at explore."""
        state_data = {
            "ideal_state": {
                "goal": "Fix login timeout in Flask auth",
                "success_criteria": ["Login works within 5s"],
                "security_review": ["authentication"],
                "deliverables": ["src/auth.py"],
                "language": "python",
            },
            "goal": "Fix login timeout in Flask auth",
        }
        result = start("test-001", "Fix login timeout in Flask auth", state_data=state_data)
        assert result["action"] == "invoke_agent"
        assert result["agent"] == "echo"
        assert result["state_id"] == "explore"
        assert "Fix login timeout" in result["task"]

    def test_server_detection_runs_in_explore(self, tmp_path):
        """_apply_server_detection is called from handle_explore when project_root is set."""
        # Write a minimal server project
        (tmp_path / "pyproject.toml").write_text(
            '[project]\ndependencies = ["fastapi"]\n'
        )
        (tmp_path / "backend").mkdir()
        (tmp_path / "backend" / "main.py").write_text(
            "from fastapi import FastAPI\napp = FastAPI()\n"
        )

        session = CodeSession("test-001", "Build API")
        session.project_root = str(tmp_path)
        session.language = "python"
        session.ideal_state = {
            "goal": "Build API",
            "success_criteria": ["It works"],
            "language": "python",
            "verification": {"lint": True, "type_check": True, "unit_tests": True},
        }
        session.prd = {"source": "prd_skill"}

        result = handle_explore(session)
        assert result["action"] == "invoke_agent"
        assert result["agent"] == "echo"
        # Server detection should have been applied
        assert session.server_info.get("is_server") is True
        assert session.server_info.get("framework") == "fastapi"
        assert session.ideal_state["verification"]["server_startup"] is True

    def test_implement_includes_security_docs(self):
        session = CodeSession("test-001", "Add rate limiting")
        session.language = "python"
        session.ideal_state = {
            "goal": "Add rate limiting",
            "success_criteria": ["429 on 5 attempts"],
            "security_review": ["authentication", "injection"],
        }

        result = handle_implement(session)

        assert result["agent"] == "skribble"
        assert "security-checklist.md" in result["task"]
        assert "secure-coding/authentication.md" in result["task"]
        assert "secure-coding/injection.md" in result["task"]
        assert "resources/python.md" in result["task"]
        assert "uv" in result["task"]
        assert "NEVER install globally" in result["task"]

    def test_implement_increments_iteration(self):
        session = CodeSession("test-001", "Add rate limiting")
        session.language = "python"
        session.ideal_state = {"goal": "test", "success_criteria": ["test"]}
        session.iteration = 2

        handle_implement(session)
        assert session.iteration == 3

    def test_verify_includes_language_specific_commands(self):
        session = CodeSession("test-001", "Add rate limiting")
        session.language = "python"
        session.ideal_state = {
            "goal": "Add rate limiting",
            "success_criteria": ["test"],
            "verification": {
                "lint": True,
                "type_check": True,
                "unit_tests": True,
                "integration_tests": False,
                "e2e_tests": False,
            },
        }

        result = handle_verify(session)

        assert "ruff check" in result["task"]
        assert "mypy" in result["task"]
        assert "pytest" in result["task"]

    def test_verify_typescript_commands(self):
        session = CodeSession("test-001", "Fix React component")
        session.language = "typescript"
        session.ideal_state = {
            "goal": "Fix component",
            "success_criteria": ["test"],
            "verification": {
                "lint": True,
                "type_check": True,
                "unit_tests": True,
                "integration_tests": False,
                "e2e_tests": False,
            },
        }

        result = handle_verify(session)

        assert "eslint" in result["task"]
        assert "tsc --noEmit" in result["task"]
        assert "vitest" in result["task"]

    def test_learn_evaluates_gap(self):
        session = CodeSession("test-001", "Add rate limiting")
        session.ideal_state = {
            "goal": "Add rate limiting",
            "success_criteria": ["429 on 5 attempts"],
            "anti_criteria": ["Don't break login"],
            "edge_cases": ["Shared IP scenario"],
        }

        result = handle_learn(session)

        assert result["agent"] == "carren"
        assert "success_criteria" in result["task"]
        assert "anti_criteria" in result["task"]
        assert "edge_cases" in result["task"]
        assert "gap" in result["task"].lower()  # Gap evaluation


class TestStateMachine:
    def test_workflow_creation(self):
        session = CodeSession("test-001", "Fix login bug")
        machine = CodeWorkflow(session)
        assert machine.explore.is_active

    def test_explore_to_analyze(self):
        session = CodeSession("test-001", "Fix login bug")
        machine = CodeWorkflow(session)
        machine.send("explore_done")
        assert machine.analyze.is_active

    def test_full_flow_basic(self):
        session = CodeSession("test-001", "Fix login bug")
        machine = CodeWorkflow(session)

        # explore → analyze
        machine.send("explore_done")
        assert machine.analyze.is_active

        # analyze → plan
        machine.send("analyze_done")
        assert machine.plan.is_active

        # plan → implement
        machine.send("plan_ready")
        assert machine.implement.is_active

        # implement → verify
        machine.send("implement_done")
        assert machine.verify.is_active

    def test_verify_loop(self):
        session = CodeSession("test-001", "Fix login bug")
        session.verify_result = {"passed": False}
        machine = CodeWorkflow(session)

        # Advance to verify state
        for transition in ["explore_done", "analyze_done", "plan_ready", "implement_done"]:
            machine.send(transition)

        # Verify fails (criteria_not_met)
        machine.send("verify_fail")
        assert machine.learn.is_active

        # Learn finds gap → back to implement
        session.learn_result = {"gap": True}
        machine2 = CodeWorkflow(session)
        for t in ["explore_done", "analyze_done", "plan_ready", "implement_done", "verify_fail"]:
            machine2.send(t)
        machine2.send("learn_retry")
        assert machine2.implement.is_active

    def test_verify_complete(self):
        session = CodeSession("test-001", "Fix login bug")
        session.verify_result = {"passed": True}
        session.learn_result = {"gap": False}
        machine = CodeWorkflow(session)

        for transition in [
            "explore_done", "analyze_done",
            "plan_ready", "implement_done", "verify_pass",
        ]:
            machine.send(transition)

        machine.send("learn_done")
        assert machine.complete.is_active

    def test_resume_goes_to_explore(self):
        """awaiting_clarification resume transition goes to explore."""
        session = CodeSession("test-001", "Fix login bug")
        session.clarification_text = "Use FastAPI"
        machine = CodeWorkflow(session)

        # Go to unknown then awaiting_clarification
        machine.send("explore_blocked")
        assert machine.unknown.is_active
        machine.send("escalate")
        assert machine.awaiting_clarification.is_active

        # Resume goes to explore (was intake previously)
        machine.send("resume")
        assert machine.explore.is_active

    @pytest.mark.skip(reason="Conditional guard transitions need integration testing")
    def test_escalation_flow(self):
        pass
