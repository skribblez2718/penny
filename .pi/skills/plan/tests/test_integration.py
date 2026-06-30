"""
Integration tests for Plan Skill.

Tests the PlanOrchestrator with its current API — action generation,
state machine transitions, summary parsing, and CLI interface.
"""

import json
import pytest
import subprocess
from pathlib import Path

from scripts.orchestrate import PlanOrchestrator


# ============================================================
# PlanOrchestrator Tests
# ============================================================

class TestPlanOrchestrator:
    """Test PlanOrchestrator initialization and basic lifecycle."""

    def test_init_with_defaults(self):
        """Manager initializes with defaults."""
        manager = PlanOrchestrator(
            session_id="test-001",
            goal="Add authentication",
            project_root="/tmp/test",
        )
        assert manager.session_id == "test-001"
        assert manager.context.goal == "Add authentication"
        assert manager.context.project_root == "/tmp/test"
        assert manager.context.constraints == {}
        assert manager.context.max_iterations == 3

    def test_init_with_constraints(self):
        """Manager accepts constraints."""
        manager = PlanOrchestrator(
            session_id="test-002",
            goal="Migrate database",
            constraints={"language": "python", "deadline": "2024-02-01"},
        )
        assert manager.context.constraints == {"language": "python", "deadline": "2024-02-01"}

    def test_constraints_passed_to_context(self):
        """Constraints are accessible from context."""
        manager = PlanOrchestrator(
            session_id="test-004",
            goal="Test",
        )
        manager.context.structured_plan_title = "Test Plan"
        manager.context.structured_plan_step_count = 3
        assert manager.context.structured_plan_title == "Test Plan"
        assert manager.context.structured_plan_step_count == 3

    def test_get_session_state(self):
        """Session state accessible from context."""
        manager = PlanOrchestrator(
            session_id="test-005",
            goal="Test goal",
        )
        assert manager.context.session_id == "test-005"
        assert manager.context.goal == "Test goal"
        assert manager.context.complete is False

    def test_current_state_id(self):
        """Manager exposes current_state_id property."""
        manager = PlanOrchestrator(
            session_id="test-006",
            goal="Test",
            project_root="/tmp/test",
        )
        assert manager.current_state_id == "intake"

    def test_current_state_display(self):
        """Manager exposes current_state display property."""
        manager = PlanOrchestrator(
            session_id="test-007",
            goal="Test",
            project_root="/tmp/test",
        )
        assert manager.current_state == "Intake"

    def test_is_terminal_initially_false(self):
        """Manager is not terminal at start."""
        manager = PlanOrchestrator(
            session_id="test-008",
            goal="Test",
            project_root="/tmp/test",
        )
        assert manager.is_terminal is False


# ============================================================
# Action Generation Tests
# ============================================================

class TestActionGeneration:
    """Test that the orchestrator produces correct actions."""

    def test_start_produces_explore_action(self):
        """Start with a goal produces an explore action."""
        manager = PlanOrchestrator(
            session_id="test-action-1",
            goal="Refactor auth system",
            project_root="/tmp",
        )
        action = manager.start()
        assert action["action"] in ["invoke_agent", "invoke_agents_parallel"]
        if action["action"] == "invoke_agent":
            assert action["agent"] == "echo"
        else:
            assert len(action["tasks"]) >= 2
            for t in action["tasks"]:
                assert t["agent"] == "echo"

    def test_start_without_goal_produces_error(self):
        """Start without a goal produces an error action."""
        manager = PlanOrchestrator(
            session_id="test-action-2",
            goal="",
            project_root="/tmp",
        )
        action = manager.start()
        assert action["action"] == "error"
        assert len(action["errors"]) > 0

    def test_start_includes_session_id(self):
        """Start action includes session_id."""
        manager = PlanOrchestrator(
            session_id="test-action-3",
            goal="Test goal",
            project_root="/tmp",
        )
        action = manager.start()
        assert action["session_id"] == "test-action-3"

    def test_start_includes_orchestrator_state(self):
        """Start action includes state blob for persistence."""
        manager = PlanOrchestrator(
            session_id="test-action-4",
            goal="Test goal",
            project_root="/tmp",
        )
        action = manager.start()
        assert "orchestrator_state" in action

    def test_parallel_exploration_by_default(self):
        """Default exploration is parallel — most goals benefit from multiple perspectives."""
        manager = PlanOrchestrator(
            session_id="test-action-5",
            goal="Implement OAuth authentication system",
            project_root="/tmp",
        )
        action = manager.start()
        assert action["action"] == "invoke_agents_parallel"
        assert len(action["tasks"]) == 3

    def test_single_exploration_for_simple_goal(self):
        """Simple goals with single-task keywords get single exploration."""
        manager = PlanOrchestrator(
            session_id="test-action-6",
            goal="Fix typo in README",
            project_root="/tmp",
            constraints={"exploration_mode": "auto"},
        )
        action = manager.start()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "echo"

    def test_single_exploration_with_explicit_constraint(self):
        """exploration_mode=single forces single agent regardless of goal."""
        manager = PlanOrchestrator(
            session_id="test-action-6b",
            goal="Implement OAuth authentication system",
            project_root="/tmp",
            constraints={"exploration_mode": "single"},
        )
        action = manager.start()
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "echo"


# ============================================================
# Summary Parsing Tests
# ============================================================

class TestSummaryParsing:
    """Test parsing of agent summary output."""

    def test_parse_explore_summary(self):
        """Parses explore summary correctly."""
        manager = PlanOrchestrator(
            session_id="test-sum-1",
            goal="Test",
            project_root="/tmp",
        )
        summary = {
            "findings_count": 5,
            "files_count": 3,
            "unknowns_count": 1,
            "explore_complete": True,
        }
        manager._parse_explore_summary(summary)
        assert manager.context.explore_findings_count == 5
        assert manager.context.explore_files_count == 3
        assert manager.context.explore_unknowns_count == 1
        assert manager.context.explore_complete is True

    def test_parse_plan_summary(self):
        """Parses plan summary correctly."""
        manager = PlanOrchestrator(
            session_id="test-sum-2",
            goal="Test",
            project_root="/tmp",
        )
        summary = {
            "plan_steps": [
                {"step": 1, "title": "Create middleware"},
                {"step": 2, "title": "Apply to routes"},
            ],
            "plan_complete": True,
        }
        manager._parse_plan_summary(summary)
        assert len(manager.context.plan_steps) == 2
        assert manager.context.plan_complete is True

    def test_parse_critique_summary_approve(self):
        """Parses APPROVE verdict correctly."""
        manager = PlanOrchestrator(
            session_id="test-sum-3",
            goal="Test",
            project_root="/tmp",
        )
        summary = {
            "verdict": "APPROVE",
            "issues": [],
        }
        manager._parse_critique_summary(summary)
        assert manager.context.critique_verdict == "APPROVE"
        assert len(manager.context.critique_issues) == 0

    def test_parse_critique_summary_needs_revision(self):
        """Parses NEEDS_REVISION verdict correctly."""
        manager = PlanOrchestrator(
            session_id="test-sum-4",
            goal="Test",
            project_root="/tmp",
        )
        summary = {
            "verdict": "NEEDS_REVISION",
            "issues": ["Vague step 1", "Missing rollback"],
        }
        manager._parse_critique_summary(summary)
        assert manager.context.critique_verdict == "NEEDS_REVISION"
        assert len(manager.context.critique_issues) == 2

    def test_parse_taskifier_summary(self):
        """Parses taskifier summary correctly."""
        manager = PlanOrchestrator(
            session_id="test-sum-5",
            goal="Test",
            project_root="/tmp",
        )
        summary = {
            "title": "Auth Migration Plan",
            "step_count": 5,
            "complete": True,
        }
        manager._parse_taskifier_summary(summary)
        assert manager.context.structured_plan_title == "Auth Migration Plan"
        assert manager.context.structured_plan_step_count == 5
        assert manager.context.structured_plan_complete is True


# ============================================================
# Step Processing Tests
# ============================================================

class TestStepProcessing:
    """Test the step() method for processing agent results."""

    def test_step_explore_advances_to_planning(self):
        """Processing explore result advances to planning."""
        manager = PlanOrchestrator(
            session_id="test-step-1",
            goal="Add auth",
            project_root="/tmp",
        )
        # Start → exploring
        manager.start()

        # Process explore result
        result = {
            "exitCode": 0,
            "summary": {
                "findings_count": 5,
                "files_count": 3,
                "unknowns_count": 1,
                "explore_complete": True,
            },
        }
        action = manager.step("echo", result)
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "piper"

    def test_step_plan_advances_to_critiquing(self):
        """Processing plan result advances to critiquing."""
        manager = PlanOrchestrator(
            session_id="test-step-2",
            goal="Add auth",
            project_root="/tmp",
        )
        manager.start()
        manager.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}})

        result = {
            "exitCode": 0,
            "summary": {
                "plan_steps": [{"step": 1, "title": "Create middleware"}],
                "plan_complete": True,
            },
        }
        action = manager.step("piper", result)
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "carren"

    def test_step_critique_approve_advances_to_taskifying(self):
        """Processing APPROVE critique advances to taskifying."""
        manager = PlanOrchestrator(
            session_id="test-step-3",
            goal="Add auth",
            project_root="/tmp",
        )
        manager.start()
        manager.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}})
        manager.step("piper", {"exitCode": 0, "summary": {"plan_steps": [{"step": 1, "title": "Create MW"}], "plan_complete": True}})

        result = {
            "exitCode": 0,
            "summary": {"verdict": "APPROVE", "issues": []},
        }
        action = manager.step("carren", result)
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "tabitha"

    def test_complete_produces_final_action(self):
        """Processing taskifier result produces complete action."""
        manager = PlanOrchestrator(
            session_id="test-step-4",
            goal="Add auth",
            project_root="/tmp",
        )
        manager.start()
        manager.step("echo", {"exitCode": 0, "summary": {"explore_complete": True}})
        manager.step("piper", {"exitCode": 0, "summary": {"plan_steps": [{"step": 1, "title": "Create MW"}], "plan_complete": True}})
        manager.step("carren", {"exitCode": 0, "summary": {"verdict": "APPROVE", "issues": []}})

        result = {
            "exitCode": 0,
            "summary": {"title": "Auth Plan", "step_count": 3, "complete": True},
        }
        action = manager.step("tabitha", result)
        assert action["action"] == "complete"
        assert "plan_summary" in action
        assert action["plan_summary"]["step_count"] == 3


# ============================================================
# CLI Entry Point Tests
# ============================================================

class TestCLI:
    """Test the CLI entry point."""

    def test_start_command_produces_valid_json(self):
        """The start command produces valid JSON output."""
        result = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/plan/scripts/orchestrate.py"),
             "start", "--session-id", "cli-test-1", "--goal", "Test goal", "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp"
        )
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["action"] in ["invoke_agent", "invoke_agents_parallel"]
        assert output["session_id"] == "cli-test-1"
        assert "orchestrator_state" in output

    def test_step_command_with_explore_result(self):
        """The step command processes explore results correctly."""
        # First get state from start
        start_result = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/plan/scripts/orchestrate.py"),
             "start", "--session-id", "cli-test-2", "--goal", "Test goal", "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp"
        )
        start_action = json.loads(start_result.stdout)
        state_json = json.dumps(start_action["orchestrator_state"])

        # Then step
        step_result = subprocess.run(
            [str(Path(__file__).resolve().parents[4] / ".venv/bin/python"),
             str(Path(__file__).resolve().parents[4] / ".pi/skills/plan/scripts/orchestrate.py"),
             "step", "--session-id", "cli-test-2", "--agent", "echo",
             "--result", json.dumps({"exitCode": 0, "summary": {"explore_complete": True, "findings_count": 3}}),
             "--state", state_json,
             "--project-root", "/tmp"],
            capture_output=True, text=True, cwd="/tmp"
        )
        assert step_result.returncode == 0
        step_action = json.loads(step_result.stdout)
        assert step_action["agent"] == "piper"


# ============================================================
# UNKNOWN_STATE and Verification Integration Tests
# ============================================================

class TestUnknownStateIntegration:
    """Test UNKNOWN_STATE escalation and recovery via PlanOrchestrator API."""

    def test_uncertain_explore_escalates_to_questionnaire(self):
        """UNCERTAIN confidence from explore triggers escalate_to_user."""
        orch = PlanOrchestrator(session_id="integ-unknown", goal="test")
        orch.start()

        result = {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "findings_count": 1,
                "confidence": "UNCERTAIN",
                "unknown_reason": "No relevant files found",
            },
        }
        action = orch.step("echo", result)

        assert action["action"] == "escalate_to_user"
        assert action["state_id"] == "awaiting_clarification"
        assert "questions" in action
        assert orch.current_state_id == "awaiting_clarification"

    def test_user_retry_resumes_exploring(self):
        """User selects 'retry' → resumes to exploring."""
        orch = PlanOrchestrator(session_id="integ-retry", goal="test")
        orch.start()

        orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "Missing context",
            },
        })
        assert orch.current_state_id == "awaiting_clarification"

        action = orch.step("user", {"action_choice": "retry", "clarification": "Need more research"})
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert orch.current_state_id == "exploring"

    def test_user_skip_resumes_planning(self):
        """User selects 'skip' → resumes to planning with best data."""
        orch = PlanOrchestrator(session_id="integ-skip", goal="test")
        orch.start()

        orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "Ambiguous",
            },
        })

        action = orch.step("user", {"action_choice": "skip", "clarification": "Proceed with what we have"})
        assert action["action"] in ("invoke_agent", "invoke_agents_parallel")
        assert orch.current_state_id == "exploring"

    def test_user_restart_aborts(self):
        """User selects 'restart' → error state."""
        orch = PlanOrchestrator(session_id="integ-restart", goal="test")
        orch.start()

        orch.step("echo", {
            "exitCode": 0,
            "summary": {
                "explore_complete": True,
                "confidence": "UNCERTAIN",
                "unknown_reason": "No clue",
            },
        })

        action = orch.step("user", {"action_choice": "restart"})
        assert action["action"] == "error"
        assert orch.current_state_id == "error"


class TestVerificationStateIntegration:
    """Test VERIFICATION state gate via PlanOrchestrator API."""

    def test_high_stakes_possible_triggers_verification(self):
        """POSSIBLE confidence + high stakes → verifying state."""
        orch = PlanOrchestrator(
            session_id="integ-verify",
            goal="test",
            constraints={"stakes": "high", "verification_mode": "default"},
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
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        })

        assert orch.current_state_id == "verifying"

    def test_verification_confirm_advances_to_critiquing(self):
        """User confirms from verifying → critiquing."""
        orch = PlanOrchestrator(
            session_id="integ-verify-confirm",
            goal="test",
            constraints={"stakes": "high", "verification_mode": "default"},
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
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        })
        assert orch.current_state_id == "verifying"

        action = orch.step("verification", {"choice": "confirm"})
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "carren"
        assert orch.current_state_id == "critiquing"

    def test_verification_reject_returns_to_planning(self):
        """User rejects from verifying → revising."""
        orch = PlanOrchestrator(
            session_id="integ-verify-reject",
            goal="test",
            constraints={"stakes": "high", "verification_mode": "default"},
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
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        })

        action = orch.step("verification", {"choice": "reject"})
        assert action["action"] == "invoke_agent"
        assert action["agent"] == "piper"
        assert orch.current_state_id == "revising"

    def test_low_stakes_skips_verification(self):
        """LOW stakes skips verifying → goes straight to critiquing."""
        orch = PlanOrchestrator(
            session_id="integ-low-stakes",
            goal="test",
            constraints={"stakes": "low"},
        )
        orch.start()

        orch.step("echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "POSSIBLE"},
        })

        action = orch.step("piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "low",
            },
        })

        assert action["action"] == "invoke_agent"
        assert action["agent"] == "carren"
        assert orch.current_state_id == "critiquing"

    def test_verification_off_mode_never_triggers(self):
        """Verification mode 'off' never enters verifying."""
        orch = PlanOrchestrator(
            session_id="integ-verify-off",
            goal="test",
            constraints={"verification_mode": "off"},
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
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "high",
            },
        })
        # verify=off skips verification even with high stakes
        assert orch.current_state_id == "critiquing"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

class TestQuestionnaireSignalIntegration:
    """Test parent-process questionnaire signal pattern (Phase 2)."""

    def test_needs_clarification_signal_routes_to_unknown(self):
        """Piper sets needs_clarification=true → routes through unknown state."""
        orch = PlanOrchestrator(
            session_id="integ-signal",
            goal="test",
        )
        orch.start()

        orch.step("echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "CERTAIN"},
        })
        action = orch.step("piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "low",
                "needs_clarification": True,
                "clarifying_questions": ["What is the target platform?", "What is the budget?"],
            },
        })

        assert orch.current_state_id == "unknown"
        assert "needs clarification" in orch.context.unknown_reason.lower()
        assert action["action"] == "escalate_to_user"

    def test_no_clarification_signal_proceeds_normally(self):
        """Piper sets needs_clarification=false (default) → proceeds to plan_done."""
        orch = PlanOrchestrator(
            session_id="integ-no-signal",
            goal="test",
        )
        orch.start()

        orch.step("echo", {
            "exitCode": 0,
            "summary": {"explore_complete": True, "confidence": "CERTAIN"},
        })
        orch.step("piper", {
            "exitCode": 0,
            "summary": {
                "plan_complete": True,
                "plan_steps": [{"step": 1, "title": "A"}],
                "stakes": "low",
                "needs_clarification": False,
                "clarifying_questions": [],
            },
        })

        assert orch.current_state_id in ("critiquing", "verifying")
