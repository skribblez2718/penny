"""
E2E Tests for Plan Skill — CLI Protocol Tests

Tests the Python orchestrate.py CLI protocol directly without spawning pi.
Uses subprocess calls to validate the start/step/status command interface.

The orchestrator CLI uses a stateless protocol:
  - start: returns action JSON with orchestrator_state (no disk persistence)
  - step: requires --state (JSON blob from previous orchestrator_state)
  - status: requires --state (JSON blob from previous orchestrator_state)

The --result parameter for step expects the skill extension format:
  {exitCode: 0, summary: {parsed_summary_fields}, error: "..."}

Run with:
  PYTHONPATH=. python3 -m pytest test_e2e.py -v -s
"""

import json
import os
import subprocess
import pytest
from pathlib import Path


# ============================================================
# Configuration
# ============================================================

PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent.parent)
ORCHESTRATE = str(Path(__file__).resolve().parent.parent / "scripts" / "orchestrate.py")
PYTHON = os.environ.get("PLAN_PYTHON", str(Path(PROJECT_ROOT) / ".venv" / "bin" / "python3"))
if not Path(PYTHON).exists():
    PYTHON = "python3"


# ============================================================
# Test Data — Realistic Summary Objects
# ============================================================

ECHO_RESULT = [{"exitCode": 0, "summary": {"findings_count": 5, "files_count": 3, "unknowns_count": 1, "explore_complete": True}, "error": ""}]
ECHO_RESULT_ERROR = [{"exitCode": 1, "summary": {"findings_count": 0, "files_count": 0, "unknowns_count": 0, "explore_complete": False}, "error": "Connection timeout"}]
PIPER_RESULT = {"exitCode": 0, "summary": {"plan_steps": [{"id": 1, "title": "Create module"}, {"id": 2, "title": "Add test"}, {"id": 3, "title": "Run tests"}], "plan_complete": True}, "error": ""}
CARREN_APPROVE = {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}, "error": ""}
CARREN_REJECT = {"exitCode": 0, "summary": {"verdict": "NEEDS_REVISION", "issues": ["Missing detail"]}, "error": ""}
TABITHA_RESULT = {"exitCode": 0, "summary": {"title": "Plan", "step_count": 2, "complete": True}, "error": ""}


# ============================================================
# Helpers
# ============================================================

def run_orchestrate(*args):
    """Run orchestrate.py with given args, return parsed JSON output."""
    cmd = [PYTHON, ORCHESTRATE] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=PROJECT_ROOT)
    try:
        return json.loads(result.stdout) if result.stdout else None
    except json.JSONDecodeError:
        return {"error": result.stderr, "stdout": result.stdout, "returncode": result.returncode}


def run_start(session_id, goal, project_root, constraints="{}"):
    """Helper: Run start command, return action dict with orchestrator_state."""
    return run_orchestrate(
        "start", "--session-id", session_id,
        "--goal", goal, "--project-root", str(project_root),
        "--constraints", constraints,
    )


def run_step(session_id, agent, result, state, project_root):
    """Helper: Run step command, passing state from previous step."""
    return run_orchestrate(
        "step", "--session-id", session_id,
        "--agent", agent, "--result", json.dumps(result),
        "--state", json.dumps(state), "--project-root", str(project_root),
    )


def run_status(session_id, state, project_root):
    """Helper: Run status command, passing state."""
    return run_orchestrate(
        "status", "--session-id", session_id,
        "--state", json.dumps(state), "--project-root", str(project_root),
    )


# ============================================================
# CLI Protocol Tests
# ============================================================

class TestStartCommand:
    """Test the start command CLI protocol."""

    def test_start_returns_invoke_action(self, tmp_path):
        """Start returns invoke_agent or invoke_agents_parallel action."""
        output = run_start("cli-test-start", "Add hello() to utils.py", tmp_path)
        assert output is not None
        assert output["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert output["session_id"] == "cli-test-start"
        assert "orchestrator_state" in output

    def test_start_parallel_explore_has_tasks(self, tmp_path):
        """Start returns invoke_agents_parallel with echo agent tasks."""
        output = run_start("cli-test-parallel", "Implement OAuth authentication system", tmp_path)
        assert output["action"] == "invoke_agents_parallel"
        assert "tasks" in output
        assert len(output["tasks"]) >= 1
        for task in output["tasks"]:
            assert task["agent"] == "echo"

    def test_start_includes_orchestrator_state(self, tmp_path):
        """Start response includes orchestrator_state for subsequent step calls."""
        output = run_start("cli-test-state", "Add feature X", tmp_path)
        assert "orchestrator_state" in output
        state = output["orchestrator_state"]
        assert state["context"]["goal"] == "Add feature X"

    def test_start_with_constraints(self, tmp_path):
        """Start accepts constraints as JSON."""
        output = run_start("cli-test-constraints", "Build a feature", tmp_path,
                           constraints='{"must_not_touch": ["src/core.py"]}')
        assert output is not None
        assert output["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert output["orchestrator_state"]["context"]["constraints"] == {"must_not_touch": ["src/core.py"]}


class TestStepCommand:
    """Test the step command CLI protocol — state must be passed between calls."""

    def test_step_echo_advances_to_planning(self, tmp_path):
        """Echo (explore) step transitions to planning state."""
        start = run_start("cli-step-test-1", "Test goal", tmp_path)
        state = start["orchestrator_state"]

        output = run_step("cli-step-test-1", "echo", ECHO_RESULT, state, tmp_path)
        assert output is not None
        assert output["action"] == "invoke_agent"
        assert output["agent"] == "piper"
        assert output["state_id"] == "planning"

    def test_step_piper_advances_to_critiquing(self, tmp_path):
        """Piper (planner) step transitions to critiquing state."""
        start = run_start("cli-step-test-2", "Test goal", tmp_path)
        state = start["orchestrator_state"]

        step1 = run_step("cli-step-test-2", "echo", ECHO_RESULT, state, tmp_path)
        state = step1["orchestrator_state"]

        output = run_step("cli-step-test-2", "piper", PIPER_RESULT, state, tmp_path)
        assert output["action"] == "invoke_agent"
        assert output["agent"] == "carren"
        assert output["state_id"] == "critiquing"

    def test_step_carren_approve_to_taskifying(self, tmp_path):
        """Carren (critique) APPROVE transitions to taskifying state."""
        start = run_start("cli-step-test-3", "Test goal", tmp_path)
        state = start["orchestrator_state"]

        step1 = run_step("cli-step-test-3", "echo", ECHO_RESULT, state, tmp_path)
        state = step1["orchestrator_state"]

        step2 = run_step("cli-step-test-3", "piper", PIPER_RESULT, state, tmp_path)
        state = step2["orchestrator_state"]

        output = run_step("cli-step-test-3", "carren", CARREN_APPROVE, state, tmp_path)
        assert output["action"] == "invoke_agent"
        assert output["agent"] == "tabitha"
        assert output["state_id"] == "taskifying"

    def test_step_carren_reject_returns_agent(self, tmp_path):
        """Carren (critique) REJECT returns echo or piper agent."""
        start = run_start("cli-step-test-4", "Test goal", tmp_path)
        state = start["orchestrator_state"]

        step1 = run_step("cli-step-test-4", "echo", ECHO_RESULT, state, tmp_path)
        state = step1["orchestrator_state"]

        step2 = run_step("cli-step-test-4", "piper", PIPER_RESULT, state, tmp_path)
        state = step2["orchestrator_state"]

        output = run_step("cli-step-test-4", "carren", CARREN_REJECT, state, tmp_path)
        assert output["action"] in ("invoke_agent", "invoke_agents_parallel")
        if output["action"] == "invoke_agent":
            assert output["agent"] in ("echo", "piper")


class TestFullWorkflowCLI:
    """Test complete workflow via CLI commands."""

    def test_full_happy_path(self, tmp_path):
        """Complete workflow: start → echo → piper → carren → tabitha → complete."""
        session_id = "cli-full-workflow"
        project_root = str(tmp_path)

        # START
        start = run_start(session_id, "Add hello() function", project_root)
        assert start["action"] == "invoke_agents_parallel"
        state = start["orchestrator_state"]

        # ECHO
        echo = run_step(session_id, "echo", ECHO_RESULT, state, project_root)
        assert echo["action"] == "invoke_agent"
        assert echo["agent"] == "piper"
        state = echo["orchestrator_state"]

        # PIPER
        piper = run_step(session_id, "piper", PIPER_RESULT, state, project_root)
        assert piper["action"] == "invoke_agent"
        assert piper["agent"] == "carren"
        state = piper["orchestrator_state"]

        # CARREN (APPROVE)
        carren = run_step(session_id, "carren", CARREN_APPROVE, state, project_root)
        assert carren["action"] == "invoke_agent"
        assert carren["agent"] == "tabitha"
        state = carren["orchestrator_state"]

        # TABITHA
        tabitha = run_step(session_id, "tabitha", TABITHA_RESULT, state, project_root)
        assert tabitha["action"] == "complete"
        assert tabitha["state_id"] == "complete"
        assert "plan_summary" in tabitha
        assert tabitha["plan_summary"]["step_count"] >= 1

    def test_reject_and_revise_path(self, tmp_path):
        """Workflow: start → echo → piper → carren(REJECT) → revise."""
        session_id = "cli-reject-path"
        project_root = str(tmp_path)

        start = run_start(session_id, "Refactor auth module", project_root)
        state = start["orchestrator_state"]

        step1 = run_step(session_id, "echo", ECHO_RESULT, state, project_root)
        state = step1["orchestrator_state"]

        step2 = run_step(session_id, "piper", PIPER_RESULT, state, project_root)
        state = step2["orchestrator_state"]

        carren = run_step(session_id, "carren", CARREN_REJECT, state, project_root)
        assert carren["action"] in ("invoke_agent", "invoke_agents_parallel")

    def test_agent_error_returns_error(self, tmp_path):
        """Agent error (non-zero exit code) returns error action."""
        session_id = "cli-agent-error"
        project_root = str(tmp_path)

        start = run_start(session_id, "Test error", project_root)
        state = start["orchestrator_state"]

        echo = run_step(session_id, "echo", ECHO_RESULT_ERROR, state, project_root)
        assert echo["action"] == "error"
        assert len(echo.get("errors", [])) > 0


class TestStatusCommand:
    """Test the status command."""

    def test_status_of_active_session(self, tmp_path):
        """Status returns session state from provided state."""
        session_id = "cli-status-test"
        project_root = str(tmp_path)

        start = run_start(session_id, "Test status", project_root)
        state = start["orchestrator_state"]

        status = run_status(session_id, state, project_root)
        assert status["session_id"] == session_id
        assert status["state"] in ("Exploring", "exploring", "Intake", "intake")

    def test_status_fields(self, tmp_path):
        """Status returns expected fields."""
        session_id = "cli-status-fields"
        project_root = str(tmp_path)

        start = run_start(session_id, "Test status fields", project_root)
        state = start["orchestrator_state"]

        status = run_status(session_id, state, project_root)
        assert "action" in status
        assert "session_id" in status
        assert "state" in status

    def test_status_with_minimal_state(self, tmp_path):
        """Status with minimal state returns appropriate response."""
        session_id = "cli-status-minimal"
        project_root = str(tmp_path)

        status = run_status(session_id, {"current_state_id": "unknown", "context": {"complete": False}}, project_root)
        assert status["session_id"] == session_id
        assert status["state"] == "unknown"


class TestOrchestratorState:
    """Test that orchestrator_state is properly passed and restored between calls."""

    def test_state_carries_context_across_steps(self, tmp_path):
        """Orchestrator state preserves goal across steps."""
        session_id = "cli-state-preserve"
        project_root = str(tmp_path)

        start = run_start(session_id, "Build auth system", project_root)
        state = start["orchestrator_state"]
        assert state["context"]["goal"] == "Build auth system"

        step1 = run_step(session_id, "echo", ECHO_RESULT, state, project_root)
        state = step1["orchestrator_state"]
        assert state["context"]["goal"] == "Build auth system"

    def test_step_requires_state_parameter(self, tmp_path):
        """Step without --state parameter fails gracefully."""
        result = subprocess.run(
            [PYTHON, ORCHESTRATE, "step",
             "--session-id", "cli-no-state",
             "--agent", "echo",
             "--result", '{"exitCode": 0}',
             "--project-root", str(tmp_path)],
            capture_output=True, text=True, cwd=PROJECT_ROOT,
        )
        assert result.returncode != 0

    def test_status_requires_state_parameter(self, tmp_path):
        """Status without --state parameter fails gracefully."""
        result = subprocess.run(
            [PYTHON, ORCHESTRATE, "status",
             "--session-id", "cli-no-state",
             "--project-root", str(tmp_path)],
            capture_output=True, text=True, cwd=PROJECT_ROOT,
        )
        assert result.returncode != 0


# ============================================================
# UNKNOWN_STATE and Verification E2E Tests
# ============================================================

class TestUnknownStateE2E:
    """E2E tests for UNKNOWN_STATE escalation path via CLI."""

    def test_uncertain_explore_escalates_to_user(self, tmp_path):
        """start → echo(UNCERTAIN) → escalate_to_user questionnaire."""
        session_id = "e2e-unknown-escalate"
        project_root = str(tmp_path)

        start = run_start(session_id, "Research unknown tech", project_root)
        state = start["orchestrator_state"]

        echo = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "findings_count": 0,
                "confidence": "UNCERTAIN",
                "unknown_reason": "No sources found",
            },
        }, state, project_root)

        assert echo["action"] == "escalate_to_user"
        assert "questions" in echo
        assert echo["state_id"] == "awaiting_clarification"

    def test_retry_resumes_exploring(self, tmp_path):
        """User retry → resumes to exploring."""
        session_id = "e2e-retry"
        project_root = str(tmp_path)

        start = run_start(session_id, "Test retry", project_root)
        state = start["orchestrator_state"]

        s1 = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "Need more context",
            },
        }, state, project_root)
        assert s1["action"] == "escalate_to_user"

        s2 = run_step(session_id, "user", {"action_choice": "retry"}, s1["orchestrator_state"], project_root)
        assert s2["action"] in ("invoke_agent", "invoke_agents_parallel")

    def test_restart_aborts_to_error(self, tmp_path):
        """User restart → error action."""
        session_id = "e2e-restart"
        project_root = str(tmp_path)

        start = run_start(session_id, "Test restart", project_root)
        state = start["orchestrator_state"]

        # Trigger unknown
        s1 = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "Blocked",
            },
        }, state, project_root)

        # User says restart
        s2 = run_step(session_id, "user", {"action_choice": "restart"}, s1["orchestrator_state"], project_root)
        assert s2["action"] == "error"


class TestVerificationStateE2E:
    """E2E tests for VERIFICATION state gate via CLI."""

    def test_high_stakes_triggers_verification(self, tmp_path):
        """POSSIBLE + high stakes → verifying state with questionnaire."""
        session_id = "e2e-verify-high-stakes"
        project_root = str(tmp_path)
        constraints = '{"stakes": "high", "verification_mode": "default"}'

        start = run_start(session_id, "High-stakes refactor", project_root, constraints)
        state = start["orchestrator_state"]

        echo = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        }, state, project_root)
        state = echo["orchestrator_state"]

        piper = run_step(session_id, "piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        }, state, project_root)

        assert piper["action"] == "escalate_to_user"
        assert piper["state_id"] == "verifying"
        assert "questions" in piper

    def test_verification_confirm_advances(self, tmp_path):
        """User confirms verification → critiquing."""
        session_id = "e2e-verify-confirm"
        project_root = str(tmp_path)
        constraints = '{"stakes": "high", "verification_mode": "default"}'

        start = run_start(session_id, "Confirm path", project_root, constraints)
        state = start["orchestrator_state"]

        echo = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        }, state, project_root)
        state = echo["orchestrator_state"]

        piper = run_step(session_id, "piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        }, state, project_root)
        state = piper["orchestrator_state"]

        confirm = run_step(session_id, "verification", {"choice": "confirm"}, state, project_root)
        assert confirm["action"] == "invoke_agent"
        assert confirm["agent"] == "carren"

    def test_verification_reject_revises(self, tmp_path):
        """User rejects verification → revising."""
        session_id = "e2e-verify-reject"
        project_root = str(tmp_path)
        constraints = '{"stakes": "high", "verification_mode": "default"}'

        start = run_start(session_id, "Reject path", project_root, constraints)
        state = start["orchestrator_state"]

        echo = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        }, state, project_root)
        state = echo["orchestrator_state"]

        piper = run_step(session_id, "piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        }, state, project_root)
        state = piper["orchestrator_state"]

        reject = run_step(session_id, "verification", {"choice": "reject"}, state, project_root)
        assert reject["action"] == "invoke_agent"
        assert reject["agent"] == "piper"

    def test_low_stakes_skips_verification(self, tmp_path):
        """LOW stakes → skips verification → critiquing."""
        session_id = "e2e-low-stakes"
        project_root = str(tmp_path)
        constraints = '{"stakes": "low"}'

        start = run_start(session_id, "Low stakes task", project_root, constraints)
        state = start["orchestrator_state"]

        echo = run_step(session_id, "echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        }, state, project_root)
        state = echo["orchestrator_state"]

        piper = run_step(session_id, "piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
            },
        }, state, project_root)

        assert piper["action"] == "invoke_agent"
        assert piper["agent"] == "carren"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])