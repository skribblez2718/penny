"""
End-to-end tests for PRD skill.

Tests the complete lifecycle from CLI invocation to final output.
These are SLOW tests — they exercise the full orchestration loop.

Mark with @pytest.mark.e2e:
    PYTHONPATH=/home/skribblez/projects/penny python3 -m pytest test_e2e.py -m e2e -v
"""

import json
import pytest
import subprocess
from pathlib import Path

ORCHESTRATE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "orchestrate.py"
SKILL_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _clean_e2e_session_files():
    """Remove leftover session files from prior e2e runs to ensure determinism."""
    tmp = Path("/tmp")
    for f in tmp.glob("prd-e2e-*.json"):
        f.unlink(missing_ok=True)
    for f in tmp.glob("prd-cli-test-*.json"):
        f.unlink(missing_ok=True)
    # E2E tests exercise the orchestrator without a real mempalace
    # round-trip. Disable the artifact verification so tests can
    # assert the orchestrator's pure state-machine behavior.
    import os
    os.environ["PRD_SKIP_MEMPALACE_VERIFY"] = "1"
    yield
    os.environ.pop("PRD_SKIP_MEMPALACE_VERIFY", None)
    for f in tmp.glob("prd-e2e-*.json"):
        f.unlink(missing_ok=True)
    for f in tmp.glob("prd-cli-test-*.json"):
        f.unlink(missing_ok=True)


@pytest.mark.e2e
class TestCLIFullFlow:
    """Full CLI start → step → step → step → complete flow with mocked agent results."""

    def _cli(self, *args) -> dict:
        """Run orchestrator CLI and return parsed JSON."""
        result = subprocess.run(
            ["python3", str(ORCHESTRATE_PATH)] + list(args),
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(SKILL_DIR),
        )
        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"
        return json.loads(result.stdout)

    def test_basic_flow_web_app(self):
        """Full flow: web-app PRD from start through completion."""
        session_id = "e2e-basic-flow"

        # Step 1: Start — should go directly to generate (auto-classify)
        action = self._cli(
            "start",
            "--session-id", session_id,
            "--goal", "Build a React dashboard with FastAPI backend",
            "--project-root", str(SKILL_DIR),
        )
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "synthia"
        assert action["state_id"] == "generate"
        state = action["orchestrator_state"]

        # Step 2: Mock synthia returning needs_clarification (first entry)
        result = json.dumps({
            "exitCode": 0,
            "summary": {
                "requirement_count": 0,
                "narrative_sections": 0,
                "verification_matrix_complete": False,
                "ideal_state_valid": False,
                "complete": True,
                "needs_clarification": True,
                "clarifying_questions": [
                    "What database?",
                    "What authentication method?",
                ],
                "confidence": "PROBABLE",
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "synthia",
            "--result", result,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["action"] == "escalate_to_user"
        assert len(action["questions"]) == 2
        state = action["orchestrator_state"]

        # Step 3: Mock user clarification
        user_result = json.dumps({
            "exitCode": 0,
            "action_choice": "retry",
            "user_responses": {
                "What database?": "PostgreSQL",
                "What authentication method?": "JWT",
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "user",
            "--result", user_result,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["state_id"] == "generate"
        state = action["orchestrator_state"]

        # Step 4: Mock synthia returning synthesized PRD
        synth_result = json.dumps({
            "exitCode": 0,
            "summary": {
                "requirement_count": 12,
                "narrative_sections": 12,
                "verification_matrix_complete": True,
                "ideal_state_valid": True,
                "complete": True,
                "needs_clarification": False,
                "clarifying_questions": [],
                "confidence": "PROBABLE",
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "synthia",
            "--result", synth_result,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["state_id"] == "validate"
        state = action["orchestrator_state"]

        # Step 5: Mock vera returning valid
        vera_result = json.dumps({
            "exitCode": 0,
            "summary": {
                "valid": True,
                "ideal_state_valid": True,
                "issues": [],
                "confidence": "CERTAIN",
                "complete": True,
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "vera",
            "--result", vera_result,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["action"] == "complete"
        assert action["prd_summary"]["requirement_count"] == 12
        assert action["prd_summary"]["ideal_state_valid"] == True
        assert action["session_room"] == f"skills/prd-{session_id}"

    def test_flow_with_revision_loop(self):
        """Full flow including revision loop (validate → generate → validate)."""
        session_id = "e2e-revision-loop"

        # Start
        action = self._cli(
            "start",
            "--session-id", session_id,
            "--goal", "Build a REST API",
            "--project-root", str(SKILL_DIR),
        )
        state = action["orchestrator_state"]

        # Step: Mock synthia returning PRD
        synth_result = json.dumps({
            "exitCode": 0,
            "summary": {
                "requirement_count": 10,
                "narrative_sections": 11,  # Missing one section
                "verification_matrix_complete": False,
                "ideal_state_valid": False,
                "complete": True,
                "needs_clarification": False,
                "clarifying_questions": [],
                "confidence": "PROBABLE",
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "synthia",
            "--result", synth_result,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["state_id"] == "validate"
        state = action["orchestrator_state"]

        # Step: Mock vera returning invalid (revision needed)
        vera_result = json.dumps({
            "exitCode": 0,
            "summary": {
                "valid": False,
                "ideal_state_valid": False,
                "issues": [
                    "Section 12 Deliverables missing",
                    "Verification matrix does not cover REQ-008",
                ],
                "confidence": "PROBABLE",
                "complete": True,
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "vera",
            "--result", vera_result,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        # Should go back to generate for revision
        assert action["state_id"] == "generate"
        assert "revision" in action["task_summary"].lower() or "REVISION" in action["task_summary"]
        state = action["orchestrator_state"]

        # Step: Mock synthia returning fixed PRD
        synth_fixed = json.dumps({
            "exitCode": 0,
            "summary": {
                "requirement_count": 10,
                "narrative_sections": 12,
                "verification_matrix_complete": True,
                "ideal_state_valid": True,
                "complete": True,
                "needs_clarification": False,
                "clarifying_questions": [],
                "confidence": "PROBABLE",
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "synthia",
            "--result", synth_fixed,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["state_id"] == "validate"
        state = action["orchestrator_state"]

        # Step: Mock vera returning valid now
        vera_valid = json.dumps({
            "exitCode": 0,
            "summary": {
                "valid": True,
                "ideal_state_valid": True,
                "issues": [],
                "confidence": "CERTAIN",
                "complete": True,
            },
        })
        action = self._cli(
            "step",
            "--session-id", session_id,
            "--agent", "vera",
            "--result", vera_valid,
            "--state", json.dumps(state),
            "--project-root", str(SKILL_DIR),
        )
        assert action["action"] == "complete"
        assert action["prd_summary"]["requirement_count"] == 10


@pytest.mark.e2e
class TestCLIStatus:
    """Test CLI status command."""

    def _cli(self, *args) -> dict:
        """Run orchestrator CLI and return parsed JSON."""
        result = subprocess.run(
            ["python3", str(ORCHESTRATE_PATH)] + list(args),
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(SKILL_DIR),
        )
        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"
        return json.loads(result.stdout)

    def test_status_shows_current_state(self):
        """Status command returns current state info."""
        session_id = "e2e-status-test"

        # Start a session first
        self._cli(
            "start",
            "--session-id", session_id,
            "--goal", "Build something",
            "--project-root", str(SKILL_DIR),
        )

        # Check status with a minimal state
        minimal_state = json.dumps({
            "session_id": session_id,
            "current_state_id": "generate",
            "context": {
                "complete": False,
                "goal": "Build something",
            },
        })

        result = subprocess.run(
            ["python3", str(ORCHESTRATE_PATH), "status",
             "--session-id", session_id,
             "--project-root", str(SKILL_DIR),
             "--state", minimal_state],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(SKILL_DIR),
        )
        assert result.returncode == 0
        action = json.loads(result.stdout)
        assert action["action"] == "status"
        assert action["session_id"] == session_id
        assert action["state"] == "generate"
        assert action["complete"] == False


@pytest.mark.e2e
class TestCLIErrorHandling:
    """Test CLI error handling."""

    def test_invalid_result_json(self):
        """Step with invalid result JSON is handled gracefully."""
        action = self._cli(
            "step",
            "--session-id", "e2e-invalid",
            "--agent", "synthia",
            "--result", "{invalid json",
            "--state", '{"session_id":"e2e-invalid","current_state_id":"generate","context":{"goal":"test"}}',
            "--project-root", str(SKILL_DIR),
        )
        assert action["action"] == "error"

    def test_invalid_state_json(self):
        """Step with invalid state JSON returns error."""
        result = subprocess.run(
            ["python3", str(ORCHESTRATE_PATH), "step",
             "--session-id", "e2e-invalid-state",
             "--agent", "echo",
             "--result", '{"exitCode":0}',
             "--state", "{invalid state}",
             "--project-root", str(SKILL_DIR)],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(SKILL_DIR),
        )
        assert result.returncode == 0
        action = json.loads(result.stdout)
        assert action["action"] == "error"

    def _cli(self, *args) -> dict:
        """Run orchestrator CLI and return parsed JSON."""
        result = subprocess.run(
            ["python3", str(ORCHESTRATE_PATH)] + list(args),
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(SKILL_DIR),
        )
        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"
        return json.loads(result.stdout)
