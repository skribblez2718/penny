"""Integration tests for Code Skill Orchestrator.

Tests the orchestrator's CLI protocol — start, step, status — simulating
the skill extension's loop. Uses subprocess calls to match real usage.

All tests use --state-data with a valid IDEAL_STATE since PRD is now a
hard dependency.
"""

import json
import subprocess
import sys
from pathlib import Path

ORCHESTRATOR = str(Path(__file__).parent.parent / "scripts" / "orchestrate.py")


def _run(*args):
    """Run orchestrator and return parsed JSON."""
    result = subprocess.run(
        [sys.executable, ORCHESTRATOR] + list(args),
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent.parent.parent.parent,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Orchestrator failed (exit {result.returncode}): {result.stderr}")
    return json.loads(result.stdout)


def _make_ideal_state(**overrides):
    """Build a valid IDEAL STATE for tests."""
    base = {
        "goal": "Add rate limiting",
        "success_criteria": ["429 after 5 attempts"],
        "anti_criteria": ["Don't break login"],
        "security_review": ["authentication", "injection"],
        "edge_cases": ["Shared IP"],
        "deliverables": ["src/rate_limit.py"],
        "language": "python",
        "verification": {"lint": True, "type_check": True, "unit_tests": True},
    }
    base.update(overrides)
    return base


class TestStartCommand:
    """Test the start command and initial flow."""

    def test_start_without_prd_emits_error(self):
        """start without state-data returns chain-contract error."""
        result = _run("start", "--session-id", "itest-001", "--goal", "Add rate limiting")
        assert result["action"] == "error"
        assert "PRD dependency" in result["errors"][0]
        assert "chain" in result["errors"][2].lower()

    def test_start_with_state_data_invokes_echo(self):
        """start with valid state_data starts at explore (echo)."""
        ideal = _make_ideal_state()
        state_data = {"ideal_state": ideal, "goal": "Add rate limiting"}
        result = _run(
            "start", "--session-id", "itest-001",
            "--goal", "Add rate limiting",
            "--state-data", json.dumps(state_data),
            "--project-root", ".",
        )
        assert result["action"] == "invoke_agent"
        assert result["agent"] == "echo"
        assert result["state_id"] == "explore"
        assert "Add rate limiting" in result["task"]

    def test_start_returns_valid_json(self):
        """start always emits valid JSON, even on error."""
        result = _run("start", "--session-id", "itest-003", "--goal", "Refactor module")
        assert "action" in result
        assert result["action"] == "error"

    def test_start_with_project_root(self):
        """start with project_root works correctly."""
        ideal = _make_ideal_state()
        state_data = {"ideal_state": ideal, "goal": "Fix bug"}
        result = _run(
            "start", "--session-id", "itest-002",
            "--goal", "Fix bug", "--project-root", "/tmp/test",
            "--state-data", json.dumps(state_data),
        )
        assert result["action"] == "invoke_agent"


class TestStepFlow:
    """Test the step-by-step flow simulating the extension loop."""

    def test_explore_to_analyze(self):
        """After explore (echo), step invokes annie for analysis."""
        ideal = _make_ideal_state()
        fake_state = {
            "session_id": "itest-step-001",
            "goal": "Add logging to auth module",
            "language": "python",
            "ideal_state": ideal,
            "prd": {"source": "prd_skill"},
            "_state_id": "explore",
        }
        fake_result = {
            "summary": {"confidence": "PROBABLE", "findings_count": 3},
        }

        result = _run(
            "step", "--session-id", "itest-step-001",
            "--state", json.dumps(fake_state),
            "--agent", "echo",
            "--result", json.dumps(fake_result),
            "--project-root", ".",
        )

        assert result["action"] == "invoke_agent"
        assert result["agent"] == "annie"  # analyze

    def test_full_flow_with_prd_input(self):
        """Walk explore → analyze → plan → implement → verify → learn → complete."""
        session_id = "itest-full-001"
        ideal = _make_ideal_state()

        # Use the real orchestrator_state from each step result as the
        # input to the next, exactly like the real extension does.

        # Step 1: explore → analyze
        state = {
            "session_id": session_id,
            "goal": "Add rate limiting",
            "language": "python",
            "ideal_state": ideal,
            "prd": {"source": "prd_skill"},
            "_state_id": "explore",
            # Bypass the criteria and plan-approval gates so this test
            # exercises the core flow without interactive user steps.
            "_criteria_validated": True,
            "_plan_approved": True,
        }
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "echo",
            "--result", json.dumps({"summary": {"confidence": "PROBABLE"}}),
            "--project-root", ".",
        )
        assert result["agent"] == "annie"  # analyze
        assert result["state_id"] == "analyze"
        state = result["orchestrator_state"]

        # Step 2: analyze → plan
        state["_state_id"] = "analyze"
        state["explore_findings"] = {"findings": ["auth.py, middleware.py"]}
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "annie",
            "--result", json.dumps({"summary": {"confidence": "PROBABLE"}}),
            "--project-root", ".",
        )
        assert result["agent"] == "piper"  # plan
        state = result["orchestrator_state"]

        # Step 3: plan → implement
        state["_state_id"] = "plan"
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "piper",
            "--result", json.dumps({"summary": {"confidence": "PROBABLE"}}),
            "--project-root", ".",
        )
        assert result["agent"] == "skribble"  # implement
        assert "security-checklist.md" in result["task"]
        assert "secure-coding" in result["task"]
        assert result["state_id"] == "implement"
        state = result["orchestrator_state"]

        # Step 4: implement → verify
        state["_state_id"] = "implement"
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "skribble",
            "--result", json.dumps({"summary": {"confidence": "PROBABLE"}}),
            "--project-root", ".",
        )
        assert result["agent"] == "skribble"  # verify
        assert result["state_id"] == "verify"
        state = result["orchestrator_state"]

        # Step 5: verify → learn
        state["_state_id"] = "verify"
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "skribble",
            "--result", json.dumps({"summary": {"passed": True}}),
            "--project-root", ".",
        )
        assert result["agent"] == "carren"  # learn
        assert result["state_id"] == "learn"
        state = result["orchestrator_state"]

        # Step 6: learn → verify (final verification before complete)
        state["_state_id"] = "learn"
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "carren",
            "--result", json.dumps({"summary": {"gap": False, "findings": []}}),
            "--project-root", ".",
        )
        assert result["agent"] == "skribble"  # final verify
        assert result["state_id"] == "verify"
        state = result["orchestrator_state"]

        # Step 7: final verify → complete
        state["_state_id"] = "verify"
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "skribble",
            "--result", json.dumps({"summary": {"passed": True}}),
            "--project-root", ".",
        )
        assert result["action"] == "complete"
        assert result["state_id"] == "complete"

    def test_implement_includes_security_gates(self):
        """Implement state should mandate security + language doc review."""
        session_id = "itest-security-001"
        ideal = _make_ideal_state(
            goal="Add auth endpoint",
            security_review=["authentication", "injection", "secrets"],
            deliverables=["src/auth.py"],
        )

        state = {
            "session_id": session_id,
            "goal": "Add auth",
            "language": "python",
            "ideal_state": ideal,
            "prd": {"source": "prd_skill"},
            "_state_id": "plan",
            "_criteria_validated": True,
            "_plan_approved": True,
        }
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "piper",
            "--result", json.dumps({"summary": {"confidence": "PROBABLE"}}),
            "--project-root", ".",
        )

        assert result["agent"] == "skribble"
        task = result["task"]
        assert "security-checklist.md" in task
        assert "secure-coding/authentication.md" in task
        assert "secure-coding/injection.md" in task
        assert "secure-coding/secrets.md" in task
        assert "resources/python.md" in task
        assert "RED" in task  # TDD reference
        assert "NEVER install globally" in task

    def test_learn_evaluates_ideal_state(self):
        """Learn state should evaluate against IDEAL STATE criteria."""
        session_id = "itest-learn-001"
        ideal = _make_ideal_state(
            success_criteria=["429 after 5 attempts", "Counter resets"],
            anti_criteria=["Don't break login"],
            edge_cases=["Shared IP", "Redis down"],
        )

        state = {
            "session_id": session_id,
            "goal": "Add rate limiting",
            "language": "python",
            "ideal_state": ideal,
            "prd": {"source": "prd_skill"},
            "_state_id": "verify",
        }
        result = _run(
            "step", "--session-id", session_id,
            "--state", json.dumps(state),
            "--agent", "skribble",
            "--result", json.dumps({"summary": {"passed": True}}),
            "--project-root", ".",
        )

        assert result["agent"] == "carren"
        task = result["task"]
        assert "success_criteria" in task
        assert "anti_criteria" in task
        assert "edge_cases" in task
        assert "gap" in task.lower()


class TestStepStartupWithStateData:
    """Test that step() can use --state-data for first-step IDEAL_STATE loading."""

    def test_step_loads_ideal_state_from_state_data(self):
        """First step after start can load IDEAL_STATE from state_data."""
        ideal = _make_ideal_state()
        # Session without ideal_state
        session_state = {
            "session_id": "itest-load-001",
            "goal": "Add rate limiting",
            "language": "python",
            "_state_id": "explore",
            # No ideal_state — state_data provides it
        }
        state_data = {"ideal_state": ideal, "goal": "Add rate limiting"}

        result = _run(
            "step", "--session-id", "itest-load-001",
            "--state", json.dumps(session_state),
            "--state-data", json.dumps(state_data),
            "--agent", "echo",
            "--result", json.dumps({"summary": {"confidence": "PROBABLE"}}),
            "--project-root", ".",
        )

        assert result["action"] == "invoke_agent"
        # Should advance to analyze since we're past explore
        assert result["agent"] in ("annie", "echo")
        assert isinstance(result["orchestrator_state"], dict)


class TestStatusCommand:
    """Test the status command."""

    def test_status_returns_valid_json(self):
        result = _run("status", "--session-id", "itest-status-001")
        assert result["session_id"] == "itest-status-001"
        assert result["status"] == "active"
