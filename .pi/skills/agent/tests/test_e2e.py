"""
E2E tests for agent skill CLI protocol.
Uses subprocess to call orchestrate.py start/step/status.
"""

import json
import subprocess
import sys
from pathlib import Path

ORCHESTRATE = str(Path(__file__).parent.parent / "scripts" / "orchestrate.py")
PYTHON = sys.executable


def run_orchestrate(*args):
    cmd = [PYTHON, ORCHESTRATE] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=Path(__file__).parent)
    assert result.returncode == 0, f"CLI error: {result.stderr}"
    return json.loads(result.stdout.strip())


class TestStartCommand:
    def test_start_returns_valid_action(self):
        action = run_orchestrate("start", "--session-id", "e2e-001", "--goal", "Build test agent")
        assert "action" in action
        assert action["session_id"] == "e2e-001"

    def test_start_parallel_explore(self):
        action = run_orchestrate("start", "--session-id", "e2e-002", "--goal", "Build test agent")
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")


class TestStepCommand:
    def test_step_advances_state(self):
        action = run_orchestrate("start", "--session-id", "e2e-003", "--goal", "Build test agent")
        state = json.dumps(action["orchestrator_state"])

        result = json.dumps({"exitCode": 0, "summary": {"findings_count": 2, "files_count": 3, "unknowns_count": 0, "explore_complete": True}})
        action = run_orchestrate("step", "--session-id", "e2e-003", "--agent", "echo", "--result", result, "--state", state)
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")

    def test_step_design(self):
        # Start + explore
        action = run_orchestrate("start", "--session-id", "e2e-004", "--goal", "Build test agent")
        state = json.dumps(action["orchestrator_state"])
        result = json.dumps({"exitCode": 0, "summary": {"findings_count": 2, "files_count": 3, "unknowns_count": 0, "explore_complete": True}})
        action = run_orchestrate("step", "--session-id", "e2e-004", "--agent", "echo", "--result", result, "--state", state)

        # Design
        state = json.dumps(action["orchestrator_state"])
        result = json.dumps({"exitCode": 0, "summary": {"design_steps": [{"field": "name", "value": "test"}], "design_complete": True}})
        action = run_orchestrate("step", "--session-id", "e2e-004", "--agent", "piper", "--result", result, "--state", state)
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")


class TestErrorPath:
    def test_step_with_error_result(self):
        action = run_orchestrate("start", "--session-id", "e2e-005", "--goal", "Build test agent")
        state = json.dumps(action["orchestrator_state"])
        result = json.dumps({"exitCode": 1, "error": "Agent crashed", "summary": {}})
        action = run_orchestrate("step", "--session-id", "e2e-005", "--agent", "echo", "--result", result, "--state", state)
        assert action["action"] == "error"


class TestSubskillMode:
    def test_start_with_parent_session(self):
        action = run_orchestrate(
            "start", "--session-id", "e2e-006", "--goal", "Build research agent",
            "--constraints", '{"parent_session_id": "parent-123"}'
        )
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")
        # The orchestrator state should contain the parent_session_id
        state = action["orchestrator_state"]
        assert state["parent_session_id"] == "parent-123"
        assert state["subskill_mode"] is True


class TestStatusCommand:
    def test_status_returns_current_state(self):
        action = run_orchestrate("start", "--session-id", "e2e-007", "--goal", "Build test agent")
        state = json.dumps(action["orchestrator_state"])

        status = run_orchestrate("status", "--session-id", "e2e-007", "--state", state)
        assert status["session_id"] == "e2e-007"
        assert "current_state" in status
