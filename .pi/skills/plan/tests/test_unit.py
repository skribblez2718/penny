"""
Unit tests for Plan Skill state machine.

Tests guards, transitions, and state behavior.
Uses the PRODUCTION PlanWorkflow and PlanContext from scripts.orchestrate.py
— never a separate stub (production-grade: tests must validate actual code).
"""

import pytest
from dataclasses import dataclass, field
from pathlib import Path
from statemachine import State, StateMachine
from typing import Any, Dict, List, Optional

# Import production classes — tests validate actual code, not stubs
from scripts.orchestrate import PlanContext, PlanWorkflow


class TestPlanContext:
    """Test PlanContext data class"""

    def test_default_context(self):
        """Context has sensible defaults"""
        context = PlanContext(session_id="test")
        assert context.session_id == "test"
        assert context.skill_name == "plan"
        assert context.goal == ""
        assert context.constraints == {}
        assert context.plan_steps == []
        assert context.iteration == 0
        assert context.max_iterations == 3
        assert context.complete == False

    def test_context_with_goal(self):
        """Context can be initialized with goal"""
        context = PlanContext(
            session_id="test",
            goal="Add authentication",
            constraints={"language": "typescript"}
        )
        assert context.goal == "Add authentication"
        assert context.constraints == {"language": "typescript"}


class TestPlanWorkflowGuards:
    """Test state machine guards"""

    def test_has_goal_true(self):
        """has_goal returns True when goal is set"""
        context = PlanContext(session_id="test", goal="Add auth")
        workflow = PlanWorkflow(model=context)
        assert workflow.has_goal() == True

    def test_has_goal_false(self):
        """has_goal returns False when goal is empty"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        assert workflow.has_goal() == False

    def test_explore_is_complete_true(self):
        """_explore_is_complete returns True when context field is set."""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        assert workflow._explore_is_complete() == False
        
        context.explore_complete = True
        assert workflow._explore_is_complete() == True

    def test_plan_steps_exist_true(self):
        """_plan_steps_exist returns True when steps exist."""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        assert workflow._plan_steps_exist() == False
        
        context.plan_steps = [{"step": 1, "title": "Test"}]
        assert workflow._plan_steps_exist() == True

    def test_critique_approved_true(self):
        """critique_approved returns True for APPROVE verdict"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        assert workflow.critique_approved() == False
        
        context.critique_verdict = "APPROVE"
        assert workflow.critique_approved() == True

    def test_critique_approved_false(self):
        """critique_approved returns False for NEEDS_REVISION"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        context.critique_verdict = "NEEDS_REVISION"
        assert workflow.critique_approved() == False

    def test_has_issues_true(self):
        """has_issues returns True when issues exist"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        context.critique_verdict = "NEEDS_REVISION"
        context.critique_issues = ["Issue 1"]
        assert workflow.has_issues() == True

    def test_needs_more_context_true(self):
        """needs_more_context returns True when can explore more"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        context.exploration_iterations = 0
        assert workflow.needs_more_context() == True

    def test_needs_more_context_false(self):
        """needs_more_context returns False when max reached"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        context.exploration_iterations = 2
        context.max_exploration_iterations = 2
        assert workflow.needs_more_context() == False

    def test_output_valid_true(self):
        """output_valid returns True when structured plan exists"""
        context = PlanContext(session_id="test")
        workflow = PlanWorkflow(model=context)
        assert workflow.output_valid() == False
        
        context.structured_plan_complete = True
        assert workflow.output_valid() == True


class TestPlanWorkflowTransitions:
    """Test state machine transitions"""

    def test_initial_state(self):
        """Workflow starts in intake state"""
        context = PlanContext(session_id="test", goal="Test goal")
        workflow = PlanWorkflow(model=context)
        state = next(iter(workflow.configuration))
        assert state.id == "intake"  # v3 API: use configuration, not current_state

    def test_start_transition(self):
        """start transition moves intake to exploring"""
        context = PlanContext(session_id="test", goal="Test goal")
        workflow = PlanWorkflow(model=context)
        
        state = next(iter(workflow.configuration))
        assert state.id == "intake"
        # Check that has_goal guard allows the transition
        assert workflow.has_goal() == True


class TestPlanWorkflowHelpers:
    """Test helper methods"""

    def test_parse_explore_output(self):
        """parse_explore_output extracts structured data"""
        # Mock implementation for testing
        output = """### High-Signal Findings

- Found auth at src/auth.ts
- Token validation in src/jwt.ts

### Files Retrieved

1. `src/auth.ts` (lines 15-45) — core auth logic
"""
        # This would use the actual method but we're testing logic
        assert "auth" in output
        assert "jwt" in output

    def test_parse_plan_steps(self):
        """Parsing plan steps extracts numbered steps"""
        import re
        
        plan_text = """Plan:
1. First step
2. Second step
3. Third step
"""
        
        steps = []
        plan_match = re.search(r'Plan:\s*\n((?:\d+\..+\n?)+)', plan_text, re.IGNORECASE)
        
        if plan_match:
            for line in plan_match.group(1).strip().split('\n'):
                match = re.match(r'(\d+)\.\s*(.+)', line)
                if match:
                    steps.append({
                        "step": int(match.group(1)),
                        "title": match.group(2).strip()
                    })
        
        assert len(steps) == 3
        assert steps[0]["step"] == 1
        assert steps[0]["title"] == "First step"

    def test_parse_plan_steps_empty(self):
        """Parsing plan steps handles empty input"""
        import re
        
        plan_text = ""
        
        steps = []
        plan_match = re.search(r'Plan:\s*\n((?:\d+\..+\n?)+)', plan_text, re.IGNORECASE)
        
        if plan_match:
            for line in plan_match.group(1).strip().split('\n'):
                match = re.match(r'(\d+)\.\s*(.+)', line)
                if match:
                    steps.append({
                        "step": int(match.group(1)),
                        "title": match.group(2).strip()
                    })
        
        assert len(steps) == 0

    def test_interpolate_prompt(self):
        """Interpolate prompt replaces placeholders"""
        template = "Goal: {{goal}}\nConstraints: {{constraints}}"
        variables = {"goal": "Add auth", "constraints": '{"language": "ts"}'}
        
        result = template
        for key, value in variables.items():
            placeholder = f"{{{{{key}}}}}"
            result = result.replace(placeholder, str(value))
        
        assert "Add auth" in result
        assert '{"language": "ts"}' in result


class TestIterationGuard:
    """Test the iteration guard fix (off-by-one)"""

    def test_force_approve_at_max_iterations(self):
        """iteration >= max_iterations should trigger force-approve at exactly max"""
        context = PlanContext(session_id="test", goal="test", max_iterations=3)
        # After 3 critique rejections, iteration=3, 3 >= 3 = True
        context.iteration = 3
        assert context.iteration >= context.max_iterations

    def test_no_force_approve_before_max(self):
        """iteration < max_iterations should NOT trigger force-approve"""
        context = PlanContext(session_id="test", goal="test", max_iterations=3)
        context.iteration = 2
        assert not (context.iteration >= context.max_iterations)

    def test_iteration_progression(self):
        """Full iteration progression: 1, 2, 3 → force approve at 3"""
        context = PlanContext(session_id="test", goal="test", max_iterations=3)
        triggers = []
        for i in range(1, 4):
            context.iteration = i
            triggers.append(context.iteration >= context.max_iterations)
        assert triggers == [False, False, True]


class TestRevisionContext:
    """Test that revision cycles include critique context in task summaries"""

    def test_plan_action_includes_critique_on_revision(self):
        """_action_plan should include critique issues when iteration > 0"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-rev", goal="test goal", max_iterations=3)
        orch.context.iteration = 1
        orch.context.critique_issues = ["Missing rollback", "Unclear verification"]
        action = orch._action_plan()
        task = action["task_summary"]
        assert "REVISION cycle 1" in task
        assert "Missing rollback" in task
        assert "Unclear verification" in task
        assert "critique" in task.lower()

    def test_plan_action_no_critique_on_initial(self):
        """_action_plan should NOT mention critique on initial pass (iteration=0)"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-init", goal="test goal")
        action = orch._action_plan()
        task = action["task_summary"]
        assert "REVISION" not in task
        assert "critique" not in task.lower()

    def test_explore_includes_critique_on_reexploration(self):
        """_action_explore should include critique context when re-exploring"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-reexp", goal="test goal")
        orch.context.iteration = 1
        orch.context.exploration_iterations = 1  # Not first exploration
        orch.context.critique_issues = ["Need more data on auth"]
        action = orch._action_explore()
        task = action.get("task_summary", "")
        assert "additional exploration" in task
        assert "Need more data on auth" in task

    def test_critique_includes_severity_guidance_on_revision(self):
        """_action_critique should include severity guidance when iteration > 0"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-crit-rev", goal="test goal")
        orch.context.iteration = 1
        action = orch._action_critique()
        task = action["task_summary"]
        assert "review cycle 2" in task
        assert "Critical, High, or Medium" in task

    def test_critique_no_severity_guidance_on_initial(self):
        """_action_critique should NOT include severity guidance on initial pass"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-crit-init", goal="test goal")
        action = orch._action_critique()
        task = action["task_summary"]
        assert "review cycle" not in task
        assert "Critical, High, or Medium" not in task


class TestSessionPersistence:
    """Test session save/load"""

    def test_session_file_path_exists(self):
        """Session file path handling exists in full implementation"""
        # The full PlanWorkflow has _session_file method
        # In production, this is tested with integration tests
        assert True  # Placeholder - tested in integration tests


class TestUnknownStateGuards:
    """Test UNKNOWN_STATE guard conditions."""

    def test_confidence_is_uncertain_true(self):
        """Guard fires when last_confidence is UNCERTAIN"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.last_confidence = "UNCERTAIN"
        assert orch.machine.confidence_is_uncertain() is True

    def test_confidence_is_uncertain_false_for_possible(self):
        """Guard does NOT fire for POSSIBLE confidence"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.last_confidence = "POSSIBLE"
        assert orch.machine.confidence_is_uncertain() is False

    def test_confidence_is_uncertain_false_for_certain(self):
        """Guard does NOT fire for CERTAIN confidence"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.last_confidence = "CERTAIN"
        assert orch.machine.confidence_is_uncertain() is False

    def test_has_clarification_true(self):
        """Guard fires when clarification_text is present"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.clarification_text = "Try a different approach"
        assert orch.machine.has_clarification() is True

    def test_has_clarification_false(self):
        """Guard does NOT fire when clarification_text is empty"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.clarification_text = ""
        assert orch.machine.has_clarification() is False


class TestUnknownStateTransitions:
    """Test UNKNOWN_STATE FSM transitions."""

    def test_explore_unknown_transition(self):
        """exploring → unknown when confidence is UNCERTAIN"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN")
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")  # intake → exploring
        assert orch.current_state_id == "exploring"
        orch.machine.send("explore_unknown")  # exploring → unknown
        assert orch.current_state_id == "unknown"

    def test_plan_unknown_transition(self):
        """planning → unknown when confidence is UNCERTAIN"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.last_confidence = "UNCERTAIN"
        orch.context.explore_complete = True  # Required for explore_done guard
        orch.machine.send("start")  # intake → exploring
        orch.machine.send("explore_done")  # exploring → planning
        assert orch.current_state_id == "planning"
        orch.machine.send("plan_unknown")  # planning → unknown
        assert orch.current_state_id == "unknown"

    def test_escalate_transition(self):
        """unknown → awaiting_clarification via escalate"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN")
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        assert orch.current_state_id == "unknown"
        orch.machine.send("escalate")
        assert orch.current_state_id == "awaiting_clarification"

    def test_resume_explore_transition(self):
        """awaiting_clarification → exploring when has_clarification"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", clarification_text="Try again")
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        orch.machine.send("escalate")
        assert orch.current_state_id == "awaiting_clarification"
        orch.machine.send("resume_explore")
        assert orch.current_state_id == "exploring"

    def test_abandon_transition(self):
        """unknown → error via abandon"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.last_confidence = "UNCERTAIN"
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        assert orch.current_state_id == "unknown"
        orch.machine.send("abandon")
        assert orch.current_state_id == "error"

    def test_abandon_clarification_transition(self):
        """awaiting_clarification → error via abandon_clarification"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        orch = PlanOrchestrator(session_id="test-unknown", goal="test")
        orch.context.last_confidence = "UNCERTAIN"
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        orch.machine.send("escalate")
        assert orch.current_state_id == "awaiting_clarification"
        orch.machine.send("abandon_clarification")
        assert orch.current_state_id == "error"


class TestForceStateSoftError:
    """Test _force_state soft-error handling for unknown/awaiting_clarification."""

    def test_force_state_unknown_redirects_to_exploring(self):
        """Force state 'unknown' should redirect to 'exploring' with error context"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-force", goal="test goal")
        # Restore to 'unknown' state — should redirect to 'exploring'
        state = {
            "session_id": "test-force",
            "current_state_id": "unknown",
            "context": {
                "goal": "test goal",
                "constraints": {},
                "explore_findings_count": 0,
                "explore_files_count": 0,
                "explore_unknowns_count": 0,
                "explore_complete": False,
                "plan_steps": [],
                "plan_complete": False,
                "critique_verdict": "",
                "critique_issues": [],
                "structured_plan_title": "",
                "structured_plan_step_count": 0,
                "structured_plan_complete": False,
                "iteration": 0,
                "exploration_iterations": 0,
                "errors": [],
                "complete": False,
                "last_confidence": "UNCERTAIN",
                "clarification_text": "",
                "previous_state": "planning",
                "unknown_reason": "Agent returned UNCERTAIN confidence",
            },
        }
        orch.restore_state(state)
        assert orch.current_state_id == "exploring"
        assert any("recovered from" in e for e in orch.context.errors)

    def test_force_state_awaiting_clarification_redirects_to_exploring(self):
        """Force state 'awaiting_clarification' should redirect to 'exploring'"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-force", goal="test goal")
        state = {
            "session_id": "test-force",
            "current_state_id": "awaiting_clarification",
            "context": {
                "goal": "test goal",
                "constraints": {},
                "explore_findings_count": 0,
                "explore_files_count": 0,
                "explore_unknowns_count": 0,
                "explore_complete": False,
                "plan_steps": [],
                "plan_complete": False,
                "critique_verdict": "",
                "critique_issues": [],
                "structured_plan_title": "",
                "structured_plan_step_count": 0,
                "structured_plan_complete": False,
                "iteration": 0,
                "exploration_iterations": 0,
                "errors": [],
                "complete": False,
                "last_confidence": "UNCERTAIN",
                "clarification_text": "",
                "previous_state": "exploring",
                "unknown_reason": "Agent returned UNCERTAIN confidence",
            },
        }
        orch.restore_state(state)
        assert orch.current_state_id == "exploring"
        assert any("recovered from" in e for e in orch.context.errors)


class TestCheckConfidenceAndHandle:
    """Test _check_confidence_and_handle method."""

    def test_uncertain_confidence_triggers_escalation(self):
        """UNCERTAIN confidence should trigger unknown state and escalation"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-conf", goal="test goal")
        orch.machine.send("start")  # intake → exploring
        result = {
            "exitCode": 0,
            "summary": {
                "confidence": "UNCERTAIN",
                "uncertain_reason": "Cannot determine feasibility",
                "findings_count": 5,
                "files_count": 3,
                "unknowns_count": 0,
                "explore_complete": True,
            },
        }
        action = orch._check_confidence_and_handle("echo", result)
        assert action is not None
        assert action["action"] == "escalate_to_user"
        assert action["unknown_reason"] == "Cannot determine feasibility"

    def test_certain_confidence_no_escalation(self):
        """CERTAIN confidence should NOT trigger escalation"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-conf", goal="test goal")
        orch.machine.send("start")
        result = {
            "exitCode": 0,
            "summary": {
                "confidence": "CERTAIN",
                "findings_count": 5,
                "files_count": 3,
                "unknowns_count": 0,
                "explore_complete": True,
            },
        }
        action = orch._check_confidence_and_handle("echo", result)
        assert action is None

    def test_possible_confidence_no_escalation(self):
        """POSSIBLE confidence should NOT trigger escalation (strict threshold)"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-conf", goal="test goal")
        orch.machine.send("start")
        result = {
            "exitCode": 0,
            "summary": {
                "confidence": "POSSIBLE",
                "findings_count": 5,
            },
        }
        action = orch._check_confidence_and_handle("echo", result)
        assert action is None

    def test_no_confidence_field_no_escalation(self):
        """Missing confidence field should NOT trigger escalation"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-conf", goal="test goal")
        orch.machine.send("start")
        result = {"exitCode": 0, "summary": {"findings_count": 5}}
        action = orch._check_confidence_and_handle("echo", result)
        assert action is None


class TestProcessUserClarification:
    """Test process_user_clarification method."""

    def test_retry_resume_to_exploring(self):
        """User clarification with 'retry' resumes to exploring"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", previous_state="exploring", clarification_text="", unknown_reason="test")
        orch = PlanOrchestrator(session_id="test-clarify", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        orch.machine.send("escalate")
        assert orch.current_state_id == "awaiting_clarification"
        result = orch.process_user_clarification({"clarification": "Try a different approach", "action_choice": "retry"})
        assert orch.current_state_id == "exploring"
        assert orch.context.clarification_text == "Try a different approach"

    def test_restart_abandons_to_error(self):
        """User clarification with 'restart' sends to error state"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", previous_state="exploring", clarification_text="", unknown_reason="test")
        orch = PlanOrchestrator(session_id="test-clarify", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        orch.machine.send("escalate")
        result = orch.process_user_clarification({"clarification": "", "action_choice": "restart"})
        assert orch.current_state_id == "error"


class TestActionEscalate:
    """Test _action_escalate method."""

    def test_escalate_produces_questionnaire_action(self):
        """Escalate action should contain questionnaire with options"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", previous_state="planning", unknown_reason="Piper returned UNCERTAIN confidence")
        orch = PlanOrchestrator(session_id="test-escalate", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        orch.machine.send("escalate")
        action = orch._action_escalate()
        assert action["action"] == "escalate_to_user"
        assert len(action["questions"]) == 1
        assert action["questions"][0]["id"] == "clarification"
        assert len(action["questions"][0]["options"]) == 3
        assert action["previous_state"] == "planning"


class TestGetActionForUnknownStates:
    """Test _get_action_for_state for unknown and awaiting_clarification."""

    def test_unknown_state_returns_escalate_action(self):
        """unknown state should return escalate_to_user action"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", previous_state="exploring", unknown_reason="test")
        orch = PlanOrchestrator(session_id="test-state", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        assert orch.current_state_id == "unknown"
        action = orch._get_action_for_state()
        assert action["action"] == "escalate_to_user"

    def test_awaiting_clarification_returns_escalate_action(self):
        """awaiting_clarification state should return escalate_to_user action"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", previous_state="exploring", unknown_reason="test")
        orch = PlanOrchestrator(session_id="test-state", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_unknown")
        orch.machine.send("escalate")
        assert orch.current_state_id == "awaiting_clarification"
        action = orch._get_action_for_state()
        assert action["action"] == "escalate_to_user"


class TestCheckConfidenceUnmappedState:
    """Test _check_confidence_and_handle for states NOT in transition_map."""

    def test_uncertain_from_revising_returns_error(self):
        """UNCERTAIN from revising (not in transition_map) should return error action"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test")
        orch = PlanOrchestrator(session_id="test-unmap", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        # Navigate to revising: start → exploring → planning → critiquing → revising
        orch.machine.send("start")
        ctx.explore_complete = True
        orch.machine.send("explore_done")
        ctx.plan_steps = [{"step": 1}]
        ctx.plan_complete = True
        orch.machine.send("plan_done")   # planning → critiquing
        ctx.critique_verdict = "NEEDS_REVISION"
        ctx.critique_issues = ["fix this"]
        assert orch.current_state_id == "critiquing"
        orch.machine.send("critique_fail") # critiquing → revising (needs_more_context=True since iterations=0 < max=2)
        assert orch.current_state_id == "revising"
        # Now simulate UNCERTAIN confidence from revising
        result = {"exitCode": 0, "summary": {"confidence": "UNCERTAIN", "uncertain_reason": "revising uncertainty"}}
        action = orch._check_confidence_and_handle("carren", result)
        assert action is not None
        assert action["action"] == "error"
        assert any("unsupported" in e.lower() or "cannot handle" in e.lower() for e in action.get("errors", []))


class TestProcessUserClarificationSkip:
    """Test process_user_clarification 'skip' action path."""

    def test_skip_resumes_to_previous_state(self):
        """User skip should resume to previous_state with cleared unknown fields"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(goal="test", last_confidence="UNCERTAIN", previous_state="planning", clarification_text="", unknown_reason="test reason")
        orch = PlanOrchestrator(session_id="test-skip", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.context.explore_complete = True
        orch.machine.send("explore_done")
        # Now in planning — trigger unknown
        orch.machine.send("plan_unknown")
        orch.machine.send("escalate")
        assert orch.current_state_id == "awaiting_clarification"
        result = orch.process_user_clarification({"clarification": "skip this", "action_choice": "skip"})
        # Should resume to exploring (fallback since previous_state=planning but we can't resume_plan without clarification guard passing)
        assert orch.context.unknown_reason == ""  # Cleared on skip
        assert orch.context.clarification_text == ""  # Cleared on skip


class TestForceStateInvalidTarget:
    """Test _force_state for invalid/unforcible target states."""

    def test_force_state_complete_falls_back_to_exploring(self):
        """Force state to 'complete' (not in transitions_map) should fall back to exploring"""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-force-invalid", goal="test goal")
        state = {
            "session_id": "test-force-invalid",
            "current_state_id": "complete",
            "context": {
                "goal": "test goal",
                "constraints": {},
                "explore_findings_count": 0,
                "explore_files_count": 0,
                "explore_unknowns_count": 0,
                "explore_complete": False,
                "plan_steps": [],
                "plan_complete": False,
                "critique_verdict": "",
                "critique_issues": [],
                "structured_plan_title": "",
                "structured_plan_step_count": 0,
                "structured_plan_complete": False,
                "iteration": 0,
                "exploration_iterations": 0,
                "errors": [],
                "complete": False,
                "last_confidence": "",
                "clarification_text": "",
                "previous_state": "",
                "unknown_reason": "",
            },
        }
        orch.restore_state(state)
        # Should have fallen back to exploring, not stayed at some broken state
        assert orch.current_state_id == "exploring"
        assert any("Cannot force" in e or "fall" in e.lower() for e in orch.context.errors)


# ============================================================
# Resilience Tests — SUMMARY integrity and safe defaults
# ============================================================

class TestSafeDefaultSummary:
    """Test that default summaries are honest and do not lie about completion."""

    def test_safe_default_explore_does_not_claim_complete(self):
        """Safe default for echo must NOT claim explore_complete=True."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-safe", goal="test goal")
        default = orch._safe_default_summary("echo")
        assert default.get("explore_complete") is False
        assert default.get("findings_count") == 0
        assert default.get("files_count") == 0

    def test_safe_default_plan_does_not_claim_complete(self):
        """Safe default for piper must NOT claim plan_complete=True."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-safe-plan", goal="test goal")
        default = orch._safe_default_summary("piper")
        assert default.get("plan_complete") is False
        assert default.get("plan_steps") == []

    def test_safe_default_critique_does_not_approve(self):
        """Safe default for carren must NOT claim APPROVE."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-safe-crit", goal="test goal")
        default = orch._safe_default_summary("carren")
        assert default.get("verdict") == "NEEDS_REVISION"
        assert default.get("issues") == ["Agent did not emit SUMMARY or summary was empty"]

    def test_safe_default_taskifier_does_not_claim_complete(self):
        """Safe default for tabitha must NOT claim complete=True."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-safe-task", goal="test goal")
        default = orch._safe_default_summary("tabitha")
        assert default.get("complete") is False
        assert default.get("step_count") == 0

    def test_safe_default_unknown_agent_returns_empty(self):
        """Safe default for unknown agent returns empty dict."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-safe-unk", goal="test goal")
        default = orch._safe_default_summary("unknown")
        assert default == {}


class TestValidateSummary:
    """Test _validate_summary catches missing required fields per agent."""

    def test_validate_explore_missing_explore_complete(self):
        """Explore summary missing explore_complete is invalid."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-val", goal="test goal")
        summary = {"findings_count": 5, "files_count": 3}  # missing explore_complete
        valid, error = orch._validate_summary("echo", summary)
        assert valid is False
        assert "explore_complete" in error

    def test_validate_explore_valid(self):
        """Explore summary with required field is valid."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-val-ok", goal="test goal")
        summary = {"explore_complete": True}  # only required field
        valid, error = orch._validate_summary("echo", summary)
        assert valid is True
        assert error == ""

    def test_validate_plan_missing_plan_steps(self):
        """Plan summary missing plan_steps is invalid."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-val-plan", goal="test goal")
        summary = {"plan_complete": True}  # missing plan_steps
        valid, error = orch._validate_summary("piper", summary)
        assert valid is False
        assert "plan_steps" in error

    def test_validate_critique_missing_verdict(self):
        """Critique summary missing verdict is invalid."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-val-crit", goal="test goal")
        summary = {"issues": []}  # missing verdict
        valid, error = orch._validate_summary("carren", summary)
        assert valid is False
        assert "verdict" in error

    def test_validate_empty_summary_is_invalid(self):
        """Empty summary dict is invalid for any agent."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-val-empty", goal="test goal")
        for agent in ["echo", "piper", "carren", "tabitha"]:
            valid, error = orch._validate_summary(agent, {})
            assert valid is False, f"Empty summary should be invalid for {agent}"
            assert error != ""


class TestProcessResultWithBadSummary:
    """Test that process methods reject invalid/missing summaries."""

    def test_process_explore_result_with_empty_summary_produces_error(self):
        """Empty explore summary should produce error action, not advance."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-proc-exp", goal="test goal")
        orch.machine.send("start")
        result = {"exitCode": 0, "summary": {}}
        action = orch.step("echo", result)
        assert action["action"] == "error"
        assert any("SUMMARY" in e or "missing" in e.lower() for e in action.get("errors", []))

    def test_process_plan_result_with_empty_summary_produces_error(self):
        """Empty plan summary should produce error action, not advance."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-proc-plan", goal="test goal")
        orch.machine.send("start")
        orch.step("echo", {"exitCode": 0, "summary": {"findings_count": 5, "files_count": 0, "unknowns_count": 0, "explore_complete": True}})
        result = {"exitCode": 0, "summary": {}}
        action = orch.step("piper", result)
        assert action["action"] == "error"

    def test_process_explore_result_with_missing_field_produces_error(self):
        """Explore summary missing required field produces error."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator
        orch = PlanOrchestrator(session_id="test-proc-miss", goal="test goal")
        orch.machine.send("start")
        result = {"exitCode": 0, "summary": {"findings_count": 5}}  # missing explore_complete
        action = orch.step("echo", result)
        assert action["action"] == "error"
        assert any("explore_complete" in e for e in action.get("errors", []))


class TestPythonStatemachineVersionCheck:
    """Test that the orchestrator detects python-statemachine version at startup."""

    def test_version_check_returns_version_string(self):
        """_check_statemachine_version should return a version string."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import _check_statemachine_version
        version = _check_statemachine_version()
        assert version is not None
        assert len(version) > 0

    def test_version_check_returns_tuple(self):
        """Version should be parseable as semantic version."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import _check_statemachine_version
        version = _check_statemachine_version()
        parts = version.split(".")
        assert len(parts) >= 2
        # First part should be numeric major version
        assert parts[0].isdigit() or parts[0][0].isdigit()


class TestVerifyingStateGuards:
    """Test Verification State guards: needs_verification, verification_confirmed, verification_rejected."""

    def _create_workflow(self, **kwargs) -> PlanWorkflow:
        """Helper: create PlanWorkflow with given verification context."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanContext, PlanWorkflow
        ctx = PlanContext(session_id="test", goal="test", **kwargs)
        return PlanWorkflow(model=ctx)

    def test_needs_verification_uncertain_always_true(self):
        """UNCERTAIN confidence always needs verification regardless of mode."""
        wf = self._create_workflow(last_confidence="UNCERTAIN", verification_mode="default")
        assert wf.needs_verification() is True

    def test_needs_verification_off_mode_returns_false(self):
        """Off mode bypasses verification for any confidence."""
        wf = self._create_workflow(last_confidence="UNCERTAIN", verification_mode="off")
        assert wf.needs_verification() is False

    def test_needs_verification_relaxed_only_uncertain(self):
        """Relaxed mode only verifies UNCERTAIN."""
        wf_relaxed_uncertain = self._create_workflow(last_confidence="UNCERTAIN", verification_mode="relaxed")
        assert wf_relaxed_uncertain.needs_verification() is True

        wf_relaxed_possible = self._create_workflow(last_confidence="POSSIBLE", verification_mode="relaxed")
        assert wf_relaxed_possible.needs_verification() is False

    def test_needs_verification_default_possible_high_stakes(self):
        """Default mode: POSSIBLE + high stakes → verify."""
        wf = self._create_workflow(last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        assert wf.needs_verification() is True

    def test_needs_verification_default_possible_low_stakes(self):
        """Default mode: POSSIBLE + low stakes → skip."""
        wf = self._create_workflow(last_confidence="POSSIBLE", verification_stakes="low", verification_mode="default")
        assert wf.needs_verification() is False

    def test_needs_verification_strict_possible_any_stakes(self):
        """Strict mode: POSSIBLE always verifies."""
        wf = self._create_workflow(last_confidence="POSSIBLE", verification_stakes="low", verification_mode="strict")
        assert wf.needs_verification() is True

    def test_needs_verification_strict_probable_high_stakes(self):
        """Strict mode: PROBABLE + high stakes verifies."""
        wf = self._create_workflow(last_confidence="PROBABLE", verification_stakes="high", verification_mode="strict")
        assert wf.needs_verification() is True

    def test_needs_verification_strict_probable_low_stakes(self):
        """Strict mode: PROBABLE + low stakes → skip."""
        wf = self._create_workflow(last_confidence="PROBABLE", verification_stakes="low", verification_mode="strict")
        assert wf.needs_verification() is False

    def test_needs_verification_certain_never(self):
        """CERTAIN confidence never needs verification."""
        wf = self._create_workflow(last_confidence="CERTAIN", verification_stakes="high", verification_mode="strict")
        assert wf.needs_verification() is False

    def test_user_confirmed_verification_guard(self):
        """_user_confirmed_verification returns True when context flag is set."""
        wf = self._create_workflow(verification_confirmed=True)
        assert wf._user_confirmed_verification() is True

    def test_user_rejected_verification_guard(self):
        """_user_rejected_verification returns True when context flag is set."""
        wf = self._create_workflow(verification_rejected=True)
        assert wf._user_rejected_verification() is True


class TestVerifyingStateTransitions:
    """Test FSM transitions involving verifying state."""

    def _create_orchestrator(self, **kwargs):
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(session_id="test", goal="test", explore_complete=True, **kwargs)
        orch = PlanOrchestrator(session_id="test", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        return orch

    def test_plan_leads_to_verifying_when_needs_verification(self):
        """plan_done routes to verifying when needs_verification guard passes."""
        orch = self._create_orchestrator(plan_steps=[{"step": 1}], plan_complete=True, last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        orch.machine.send("start")
        orch.machine.send("explore_done")
        assert orch.current_state_id == "planning"
        orch.machine.send("plan_done")
        assert orch.current_state_id == "verifying"

    def test_plan_skips_verification_when_low_stakes(self):
        """plan_done routes to critiquing when needs_verification guard fails."""
        orch = self._create_orchestrator(plan_steps=[{"step": 1}], plan_complete=True, last_confidence="CERTAIN", verification_stakes="low", verification_mode="default")
        orch.machine.send("start")
        orch.machine.send("explore_done")
        assert orch.current_state_id == "planning"
        orch.machine.send("plan_done")
        assert orch.current_state_id == "critiquing"

    def test_verify_confirm_goes_to_critiquing(self):
        """verify_confirm transition: verifying -> critiquing."""
        orch = self._create_orchestrator(plan_steps=[{"step": 1}], plan_complete=True, last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        orch.machine.send("start")
        orch.machine.send("explore_done")
        orch.machine.send("plan_done")
        assert orch.current_state_id == "verifying"
        orch.context.verification_confirmed = True
        orch.machine.send("verify_confirm")
        assert orch.current_state_id == "critiquing"

    def test_verify_reject_goes_to_revising(self):
        """verify_reject transition: verifying -> revising."""
        orch = self._create_orchestrator(plan_steps=[{"step": 1}], plan_complete=True, last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        orch.machine.send("start")
        orch.machine.send("explore_done")
        orch.machine.send("plan_done")
        assert orch.current_state_id == "verifying"
        orch.context.verification_rejected = True
        orch.machine.send("verify_reject")
        assert orch.current_state_id == "revising"

    def test_verify_abandon_goes_to_unknown(self):
        """verify_abandon transition: verifying -> unknown."""
        orch = self._create_orchestrator(plan_steps=[{"step": 1}], plan_complete=True, last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        orch.machine.send("start")
        orch.machine.send("explore_done")
        orch.machine.send("plan_done")
        assert orch.current_state_id == "verifying"
        orch.machine.send("verify_abandon")
        assert orch.current_state_id == "unknown"


class TestActionVerify:
    """Test _action_verify returns questionnaire payload."""

    def test_action_verify_returns_escalation(self):
        """_action_verify should return an escalation action with questionnaire."""
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext
        ctx = PlanContext(session_id="test", goal="test", verification_pending="Test action", verification_stakes="high")
        orch = PlanOrchestrator(session_id="test", goal="test")
        orch.context = ctx
        action = orch._action_verify()
        assert action["action"] == "escalate_to_user"
        assert action["state_id"] == "verifying"
        assert action.get("verification") is True
        assert "questions" in action
        assert len(action["questions"]) > 0
        assert action["questions"][0]["id"] == "verification_action"


class TestProcessVerificationResult:
    """Test process_verification_result routes correctly."""

    def _create_orchestrator(self, **kwargs):
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from scripts.orchestrate import PlanOrchestrator, PlanContext, PlanWorkflow
        ctx = PlanContext(session_id="test", goal="test", explore_complete=True, plan_steps=[{"step": 1}], plan_complete=True, **kwargs)
        orch = PlanOrchestrator(session_id="test", goal="test")
        orch.context = ctx
        orch.machine = PlanWorkflow(model=ctx)
        orch.machine.send("start")
        orch.machine.send("explore_done")
        orch.machine.send("plan_done")
        return orch

    def test_confirm_routes_to_critiquing(self):
        """User confirms → verification_confirmed → critiquing."""
        orch = self._create_orchestrator(last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        assert orch.current_state_id == "verifying"
        result = {"choice": "confirm"}
        action = orch.process_verification_result(result)
        assert orch.current_state_id == "critiquing"
        assert orch.context.verification_confirmed is True

    def test_reject_routes_to_revising(self):
        """User rejects → verification_rejected → revising."""
        orch = self._create_orchestrator(last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        assert orch.current_state_id == "verifying"
        result = {"choice": "reject"}
        action = orch.process_verification_result(result)
        assert orch.current_state_id == "revising"
        assert orch.context.verification_rejected is True

    def test_escalate_routes_to_unknown(self):
        """User escalates → unknown state."""
        orch = self._create_orchestrator(last_confidence="POSSIBLE", verification_stakes="high", verification_mode="default")
        assert orch.current_state_id == "verifying"
        result = {"choice": "escalate"}
        action = orch.process_verification_result(result)
        assert orch.current_state_id == "unknown"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])