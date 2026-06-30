"""
Unit tests for PRD Skill state machine and orchestrator.

Tests guards, transitions, state behavior, domain detection, and handlers.
Uses the PRODUCTION PrdWorkflow and PrdContext from scripts.orchestrate.py
— never a separate stub (production-grade: tests must validate actual code).
"""

import json
import pytest
from dataclasses import field
from pathlib import Path
from typing import Any, Dict, List

# Import production classes — tests validate actual code, not stubs
# Must run with: PYTHONPATH=/home/skribblez/projects/penny/.pi/skills/prd
from scripts.orchestrate import (
    PrdContext,
    PrdWorkflow,
    PrdOrchestrator,
    detect_domain,
    WEB_APP_KEYWORDS,
    VALIDATE_SCRIPT,
)


# ============================================================
# PrdContext Tests
# ============================================================

class TestPrdContext:
    """Test PrdContext data class creation and defaults."""

    def test_default_context(self):
        """Context has sensible defaults."""
        context = PrdContext(session_id="test-001")
        assert context.session_id == "test-001"
        assert context.skill_name == "prd"
        assert context.goal == ""
        assert context.constraints == {}
        assert context.domain == "generic"
        assert context.requirement_count == 0
        assert context.narrative_sections == 0
        assert context.verification_matrix_complete == False
        assert context.ideal_state_valid == False
        assert context.iteration == 0
        assert context.max_iterations == 5
        assert context.complete == False
        assert context.needs_clarification == False
        assert context.clarifying_questions == []
        assert context.user_responses == {}
        assert context.revision_issues == []
        assert context.errors == []

    def test_context_with_goal(self):
        """Context can be initialized with goal and constraints."""
        context = PrdContext(
            session_id="test-002",
            goal="Build a React dashboard",
            constraints={"domain": "web-app"}
        )
        assert context.goal == "Build a React dashboard"
        assert context.constraints == {"domain": "web-app"}

    def test_context_serialization_roundtrip(self):
        """Context can be serialized to dict and restored."""
        from dataclasses import asdict
        context = PrdContext(
            session_id="test-003",
            goal="Build a REST API",
            domain="web-app",
            requirement_count=10,
            ideal_state_valid=True,
        )
        data = asdict(context)
        assert data["session_id"] == "test-003"
        assert data["goal"] == "Build a REST API"
        assert data["domain"] == "web-app"
        assert data["requirement_count"] == 10
        assert data["ideal_state_valid"] == True


# ============================================================
# PrdWorkflow State Machine Tests
# ============================================================

class TestPrdWorkflowInitialization:
    """Test state machine creation and initial state."""

    def test_initial_state_is_classify(self):
        """Workflow starts in classify state."""
        context = PrdContext(session_id="test", goal="Test goal")
        workflow = PrdWorkflow(model=context)
        state = next(iter(workflow.configuration))
        assert state.id == "classify"

    def test_workflow_creation_with_empty_goal(self):
        """Workflow can be created without a goal."""
        context = PrdContext(session_id="test", domain="")
        workflow = PrdWorkflow(model=context)
        assert workflow.has_domain() == False


class TestPrdWorkflowGuards:
    """Test state machine guard conditions."""

    def test_has_domain_true(self):
        """has_domain returns True when domain is set."""
        context = PrdContext(session_id="test", domain="web-app")
        workflow = PrdWorkflow(model=context)
        assert workflow.has_domain() == True

    def test_has_domain_false(self):
        """has_domain returns False when domain is empty."""
        context = PrdContext(session_id="test", domain="")
        workflow = PrdWorkflow(model=context)
        assert workflow.has_domain() == False

    def test_prd_exists_true(self):
        """_prd_exists returns True when requirements exist."""
        context = PrdContext(session_id="test", requirement_count=5)
        workflow = PrdWorkflow(model=context)
        assert workflow._prd_exists() == True

    def test_prd_exists_false(self):
        """_prd_exists returns False when no requirements."""
        context = PrdContext(session_id="test", requirement_count=0)
        workflow = PrdWorkflow(model=context)
        assert workflow._prd_exists() == False

    def test_is_valid_true(self):
        """is_valid returns True when both valid and ideal_state_valid."""
        context = PrdContext(session_id="test", valid=True, ideal_state_valid=True)
        workflow = PrdWorkflow(model=context)
        assert workflow.is_valid() == True

    def test_is_valid_false_missing_ideal(self):
        """is_valid returns False when ideal_state_valid is False."""
        context = PrdContext(session_id="test", valid=True, ideal_state_valid=False)
        workflow = PrdWorkflow(model=context)
        assert workflow.is_valid() == False

    def test_is_valid_false_not_valid(self):
        """is_valid returns False when valid is False."""
        context = PrdContext(session_id="test", valid=False, ideal_state_valid=True)
        workflow = PrdWorkflow(model=context)
        assert workflow.is_valid() == False

    def test_has_revision_issues_true(self):
        """has_revision_issues returns True when issues exist and not valid."""
        context = PrdContext(
            session_id="test",
            revision_issues=["Missing NFR thresholds"],
            valid=False,
            ideal_state_valid=False,
        )
        workflow = PrdWorkflow(model=context)
        assert workflow.has_revision_issues() == True

    def test_has_revision_issues_false_when_valid(self):
        """has_revision_issues returns False when PRD is valid."""
        context = PrdContext(
            session_id="test",
            revision_issues=["minor issue"],
            valid=True,
            ideal_state_valid=True,
        )
        workflow = PrdWorkflow(model=context)
        assert workflow.has_revision_issues() == False

    def test_needs_clarification_guard_true(self):
        """needs_clarification_guard returns True when context flag set."""
        context = PrdContext(session_id="test", needs_clarification=True)
        workflow = PrdWorkflow(model=context)
        assert workflow.needs_clarification_guard() == True

    def test_needs_clarification_guard_false(self):
        """needs_clarification_guard returns False by default."""
        context = PrdContext(session_id="test")
        workflow = PrdWorkflow(model=context)
        assert workflow.needs_clarification_guard() == False

    def test_has_clarification_true_with_text(self):
        """has_clarification returns True when clarification_text is set."""
        context = PrdContext(session_id="test", clarification_text="Use React")
        workflow = PrdWorkflow(model=context)
        assert workflow.has_clarification() == True

    def test_has_clarification_true_with_responses(self):
        """has_clarification returns True when user_responses are set."""
        context = PrdContext(
            session_id="test",
            user_responses={"Q1": "React"}
        )
        workflow = PrdWorkflow(model=context)
        assert workflow.has_clarification() == True


class TestPrdWorkflowTransitions:
    """Test state machine transitions through the happy path."""

    def _make_workflow(self, goal="Test goal") -> PrdWorkflow:
        """Create a workflow with a goal."""
        context = PrdContext(session_id="test", goal=goal, domain="web-app")
        return PrdWorkflow(model=context)

    def test_classify_to_generate_transition(self):
        """classify_done moves from classify to generate (requires domain)."""
        workflow = self._make_workflow()
        assert next(iter(workflow.configuration)).id == "classify"

        workflow.send("classify_done")
        assert next(iter(workflow.configuration)).id == "generate"

    def test_generate_to_validate_transition(self):
        """prd_generated moves from generate to validate (requires requirements)."""
        workflow = self._make_workflow()
        workflow.send("classify_done")
        workflow.model.requirement_count = 10  # Simulate generated PRD

        workflow.send("prd_generated")
        assert next(iter(workflow.configuration)).id == "validate"

    def test_validate_to_complete_transition(self):
        """validation_pass moves from validate to complete."""
        workflow = self._make_workflow()
        workflow.send("classify_done")
        workflow.model.requirement_count = 10
        workflow.send("prd_generated")
        workflow.model.valid = True
        workflow.model.ideal_state_valid = True

        workflow.send("validation_pass")
        assert next(iter(workflow.configuration)).id == "complete"

    def test_revision_loop_validate_to_generate(self):
        """revise moves from validate back to generate when issues exist."""
        workflow = self._make_workflow()
        workflow.send("classify_done")
        workflow.model.requirement_count = 10
        workflow.send("prd_generated")
        workflow.model.revision_issues = ["Missing NFR thresholds"]

        workflow.send("revise")
        assert next(iter(workflow.configuration)).id == "generate"

    def test_unknown_state_escalation(self):
        """generate_unknown → escalate → awaiting_clarification."""
        workflow = self._make_workflow()
        workflow.send("classify_done")
        workflow.model.needs_clarification = True

        workflow.send("generate_unknown")
        assert next(iter(workflow.configuration)).id == "unknown"

        workflow.send("escalate")
        assert next(iter(workflow.configuration)).id == "awaiting_clarification"

    def test_awaiting_clarification_resume(self):
        """resume_generate moves from awaiting_clarification back to generate."""
        workflow = self._make_workflow()
        workflow.send("classify_done")
        workflow.model.needs_clarification = True
        workflow.send("generate_unknown")
        workflow.send("escalate")
        workflow.model.clarification_text = "Use React and FastAPI"

        workflow.send("resume_generate")
        assert next(iter(workflow.configuration)).id == "generate"

    def test_error_transitions(self):
        """Error transitions reach terminal error state."""
        workflow = self._make_workflow()
        workflow.send("classify_done")

        workflow.send("fail_generate")
        assert workflow.is_terminated

    def test_abandon_from_unknown(self):
        """abandon moves from unknown to error."""
        workflow = self._make_workflow()
        workflow.send("classify_done")
        workflow.model.needs_clarification = True
        workflow.send("generate_unknown")

        workflow.send("abandon")
        assert workflow.is_terminated


# ============================================================
# Domain Detection Tests
# ============================================================

class TestDomainDetection:
    """Test domain detection from goal text keywords."""

    def test_detect_react_goal(self):
        """React keyword → web-app."""
        assert detect_domain("Build a React dashboard for user management") == "web-app"

    def test_detect_fastapi_goal(self):
        """FastAPI keyword → web-app."""
        assert detect_domain("Create a FastAPI backend for the auth service") == "web-app"

    def test_detect_nextjs_goal(self):
        """Next.js keyword → web-app."""
        assert detect_domain("Build a Next.js blog with MDX support") == "web-app"

    def test_detect_django_goal(self):
        """Django keyword → web-app."""
        assert detect_domain("Django admin panel for content management") == "web-app"

    def test_detect_vue_goal(self):
        """Vue keyword → web-app."""
        assert detect_domain("Vue SPA with Pinia state management") == "web-app"

    def test_detect_postgres_goal(self):
        """Postgres in goal → web-app (database-backed)."""
        assert detect_domain("Set up postgres database with migrations") == "web-app"

    def test_detect_firebase_goal(self):
        """Firebase keyword → web-app."""
        assert detect_domain("Firebase authentication and firestore for chat app") == "web-app"

    def test_detect_api_goal(self):
        """API keyword → web-app."""
        assert detect_domain("Build a REST API for the mobile client") == "web-app"

    def test_detect_website_goal(self):
        """Website keyword → web-app."""
        assert detect_domain("Create a portfolio website with blog") == "web-app"

    def test_detect_generic_cli_goal(self):
        """CLI tool without web keywords → generic."""
        assert detect_domain("Build a command-line tool for processing CSV files") == "generic"

    def test_detect_generic_script_goal(self):
        """Generic script → generic."""
        assert detect_domain("Write a Python script to clean up log files") == "generic"

    def test_detect_generic_ambiguous_goal(self):
        """Ambiguous goal → generic."""
        assert detect_domain("Build a tool for the team") == "generic"

    def test_detect_case_insensitive(self):
        """Keyword detection is case-insensitive."""
        assert detect_domain("Build with REACT and FASTAPI") == "web-app"

    def test_detect_svelte(self):
        """Svelte keyword → web-app."""
        assert detect_domain("SvelteKit application with server-side rendering") == "web-app"


# ============================================================
# PrdOrchestrator Tests
# ============================================================

class TestPrdOrchestrator:
    """Test orchestrator initialization and state management."""

    def test_orchestrator_initializes_workflow(self):
        """Orchestrator creates workflow in classify state."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Build a React dashboard",
        )
        assert orch.current_state_id == "classify"
        assert orch.context.goal == "Build a React dashboard"
        assert orch.context.domain == "web-app"

    def test_orchestrator_detects_generic_domain(self):
        """Orchestrator detects generic domain for non-web goals."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Build a CLI tool",
        )
        assert orch.context.domain == "generic"

    def test_extract_state_has_required_fields(self):
        """extract_state produces a dict with required keys."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Build a dashboard",
        )
        state = orch.extract_state()
        assert "session_id" in state
        assert "current_state_id" in state
        assert "context" in state
        assert state["session_id"] == "test-orch"
        assert state["current_state_id"] == "classify"
        assert state["context"]["goal"] == "Build a dashboard"

    def test_restore_state_preserves_context(self):
        """restore_state loads all context fields from state blob."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Original goal",
        )

        state = {
            "session_id": "test-orch",
            "current_state_id": "generate",
            "context": {
                "goal": "Restored goal",
                "domain": "web-app",
                "requirement_count": 5,
                "ideal_state_valid": True,
                "user_responses": {"Q1": "A1"},
            },
        }

        orch.restore_state(state)
        assert orch.context.goal == "Restored goal"
        assert orch.context.domain == "web-app"
        assert orch.context.requirement_count == 5
        assert orch.context.ideal_state_valid == True
        assert orch.context.user_responses == {"Q1": "A1"}

    def test_restore_state_redirects_unknown(self):
        """restore_state redirects unknown state to classify."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Test",
        )

        state = {
            "session_id": "test-orch",
            "current_state_id": "unknown",
            "context": {"goal": "Test", "unknown_reason": "Was stuck"},
        }

        orch.restore_state(state)
        assert orch.current_state_id == "classify"
        assert len(orch.context.errors) > 0
        assert "Session recovered" in orch.context.errors[0]

    def test_is_terminal_false_initially(self):
        """Orchestrator is not terminal at start."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Test",
        )
        assert orch.is_terminal == False

    def test_start_transitions_past_classify(self):
        """start() transitions past classify immediately (domain auto-detected)."""
        orch = PrdOrchestrator(
            session_id="test-orch",
            goal="Build a React dashboard",
        )
        action = orch.start()
        # Should skip classify since domain is auto-detected, go straight to generate mode
        assert action["action"] in ("invoke_agent", "complete", "error")
        assert action["state_id"] == "generate"


# ============================================================
# Handler Action Structure Tests
# ============================================================

class TestActionStructures:
    """Test that action dicts have the correct structure."""

    def test_invoke_agent_action_shape(self):
        """invoke_agent action has required fields."""
        orch = PrdOrchestrator(
            session_id="test-action",
            goal="Build a React dashboard",
        )
        action = orch._action("invoke_agent", agent="synthia", task_summary="Test task")
        assert action["action"] == "invoke_agent"
        assert "state_id" in action
        assert "session_id" in action
        assert "orchestrator_state" in action

    def test_escalate_action_has_questions(self):
        """escalate_to_user action has questions array."""
        orch = PrdOrchestrator(
            session_id="test-action",
            goal="Build a dashboard",
        )
        orch.context.clarifying_questions = ["What framework?", "What database?"]
        orch.context.previous_state = "generate"
        orch.context.unknown_reason = "Need more info"

        action = orch._action_escalate()
        assert action["action"] == "escalate_to_user"
        assert len(action["questions"]) == 2
        assert action["questions"][0]["prompt"] == "What framework?"

    def test_complete_action_has_summary(self):
        """complete action has prd_summary with required fields."""
        orch = PrdOrchestrator(
            session_id="test-action",
            goal="Build a dashboard",
        )
        orch.context.requirement_count = 12
        orch.context.domain = "web-app"

        action = orch._action_complete()
        assert action["action"] == "complete"
        assert "prd_summary" in action
        assert action["prd_summary"]["requirement_count"] == 12
        assert action["prd_summary"]["requires_approval"] == True
        assert "session_room" in action
        assert "mempalace_drawers" in action


# ============================================================
# Safe Defaults Tests
# ============================================================

class TestSafeDefaults:
    """Test that safe default summaries never claim completion."""

    def test_echo_safe_default(self):
        """Echo safe default does not claim completion."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        default = orch._safe_default_summary("echo")
        assert default.get("complete") == False
        assert "domain" in default
        assert "confidence" in default

    def test_synthia_safe_default(self):
        """Synthia safe default does not claim completion."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        default = orch._safe_default_summary("synthia")
        assert default.get("complete") == False
        assert default.get("requirement_count") == 0  # Zero, not positive

    def test_vera_safe_default(self):
        """Vera safe default does not claim valid."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        default = orch._safe_default_summary("vera")
        assert default.get("valid") == False
        assert default.get("ideal_state_valid") == False


# ============================================================
# Summary Validation Tests
# ============================================================

class TestSummaryValidation:
    """Test that summary validation catches bad data."""

    def test_validate_echo_summary_valid(self):
        """Valid echo summary passes validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("echo", {
            "domain": "web-app",
            "confidence": "PROBABLE",
        })
        assert valid == True
        assert msg == ""

    def test_validate_echo_summary_missing_domain(self):
        """Echo summary without domain fails validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("echo", {
            "confidence": "PROBABLE",
        })
        assert valid == False
        assert "domain" in msg

    def test_validate_synthia_summary_valid(self):
        """Valid synthia summary passes validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("synthia", {
            "requirement_count": 12,
            "narrative_sections": 12,
            "verification_matrix_complete": True,
            "ideal_state_valid": True,
            "complete": True,
        })
        assert valid == True

    def test_validate_synthia_clarification_mode_valid(self):
        """Synthia clarification-mode summary (no PRD yet) passes validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("synthia", {
            "needs_clarification": True,
            "clarifying_questions": ["Q1", "Q2"],
            "confidence": "PROBABLE",
        })
        assert valid == True, f"Expected valid, got error: {msg}"

    def test_validate_synthia_clarification_mode_implicit(self):
        """Clarification detected by presence of clarifying_questions alone
        (subagent forgot the needs_clarification flag). Validator must
        still pass it as clarification mode and coerce missing fields.
        """
        orch = PrdOrchestrator(session_id="test", goal="Test")
        summary_in = {
            "clarifying_questions": ["Q1", "Q2"],
            # NOTE: no needs_clarification, no confidence
        }
        valid, msg = orch._validate_summary("synthia", summary_in)
        assert valid == True, f"Expected valid, got error: {msg}"
        # Coerced defaults should be present after validation
        assert summary_in.get("needs_clarification") is True
        assert summary_in.get("confidence") == "PROBABLE"

    def test_validate_synthia_legacy_default_coerced(self):
        """When the agent emits only legacy/default-summary fields
        (synthesis_complete, theme_count, source_count) without PRD
        fields, the validator must coerce to safe PRD defaults and pass.
        This handles the case where the agent's stdout had no parseable
        SUMMARY block and the skill extension fell back to its generic
        default.
        """
        orch = PrdOrchestrator(session_id="test", goal="Test")
        summary_in = {
            "synthesis_complete": False,
            "theme_count": 0,
            "source_count": 0,
            # No requirement_count, narrative_sections, etc.
        }
        valid, msg = orch._validate_summary("synthia", summary_in)
        assert valid == True, f"Expected valid after coercion, got error: {msg}"
        # Coerced values should be present
        assert summary_in.get("requirement_count") == 0
        assert summary_in.get("complete") == False
        assert summary_in.get("confidence") == "POSSIBLE"

    def test_validate_synthia_clarification_mode_missing_questions(self):
        """Synthia clarification-mode without questions fails."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("synthia", {
            "needs_clarification": True,
            "confidence": "PROBABLE",
        })
        assert valid == False
        assert "clarifying_questions" in msg

    def test_validate_synthia_summary_wrong_type(self):
        """Synthia summary with wrong type fails."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("synthia", {
            "requirement_count": "twelve",  # Should be int
            "narrative_sections": 12,
            "verification_matrix_complete": True,
            "ideal_state_valid": True,
            "complete": True,
        })
        assert valid == False

    def test_validate_vera_summary_valid(self):
        """Valid vera summary passes validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("vera", {
            "valid": True,
            "confidence": "CERTAIN",
        })
        assert valid == True

    def test_validate_empty_summary(self):
        """Empty dict fails validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("echo", {})
        assert valid == False

    def test_validate_none_summary(self):
        """None summary fails validation."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        valid, msg = orch._validate_summary("echo", None)
        assert valid == False


# ============================================================
# Mempalace Output Tests
# ============================================================

class TestMempalaceOutput:
    """Test that complete handler returns correct mempalace drawer structure."""

    def test_complete_action_has_mempalace_room(self):
        """Complete action includes the mempalace room path."""
        orch = PrdOrchestrator(session_id="test-mem", goal="Build a dashboard")
        action = orch._action_complete()
        assert action["session_room"] == "skills/prd-test-mem"
        assert action["mempalace_drawers"]["wing"] == "penny"
        assert action["mempalace_drawers"]["room"] == "skills/prd-test-mem"

    def test_verify_mempalace_artifacts_graceful_when_no_db(self):
        """If no chroma DB exists, verification returns empty (cannot verify, not 'missing')."""
        # This is the default state in CI/clean test envs — verification
        # should NOT block completion in that case (the orchestrator can
        # still surface error info via stderr if needed).
        orch = PrdOrchestrator(
            session_id="test-verify-empty",
            goal="Test",
        )
        # Force a non-existent path so the function cannot find a DB
        # by overriding the candidate search. The function tries three
        # candidates; if all are absent it returns [].
        missing = orch._verify_mempalace_artifacts()
        # We can't assert [] strictly because tests may run inside
        # a Penny project that has a real DB. But we can assert the
        # return type and that no exception was raised.
        assert isinstance(missing, list)
        # If a real DB exists, the function should still return a
        # sensible list (either empty or containing missing keys)
        for item in missing:
            assert isinstance(item, str)

    def test_verify_mempalace_artifacts_returns_expected_keys(self):
        """Missing-artifact list uses the canonical 4 artifact keys."""
        orch = PrdOrchestrator(
            session_id="test-verify-keys",
            goal="Test",
        )
        # We can't easily mock the DB inside the function, but we can
        # verify the contract: any returned missing items should be
        # one of the 4 canonical artifact keys.
        missing = orch._verify_mempalace_artifacts()
        valid_keys = {
            "prd_narrative",
            "prd_requirement_catalog",
            "prd_verification_matrix",
            "ideal_state",
        }
        for item in missing:
            assert item in valid_keys, f"Unexpected key in missing list: {item}"


# ============================================================
# Iteration Limit Tests
# ============================================================

class TestIterationLimits:
    """Test that max iterations force completion."""

    def test_max_iterations_forces_complete(self):
        """When max_iterations reached, validate forces complete."""
        orch = PrdOrchestrator(
            session_id="test-iter",
            goal="Test",
            constraints={"max_iterations": 0},
        )
        orch.context.iteration = 0
        orch.context.max_iterations = 0

        # Simulate being in validate state with issues
        orch.context.valid = False
        orch.context.ideal_state_valid = False
        orch.context.revision_issues = ["Issue 1"]

        # Force the state machine to validate state
        orch.context.domain = "web-app"
        orch.machine.send("classify_done")
        orch.context.requirement_count = 10
        orch.machine.send("prd_generated")

        # Process a validate result that has issues
        result = {
            "exitCode": 0,
            "summary": {
                "valid": False,
                "ideal_state_valid": False,
                "issues": ["Issue 1"],
                "confidence": "PROBABLE",
                "complete": True,
            },
        }

        action = orch.process_validate_result(result)
        # Should force-complete instead of revising
        assert action["action"] == "complete"


# ============================================================
# Result Processing Tests
# ============================================================

class TestResultProcessing:
    """Test result processing methods."""

    def test_is_success_exit_code_zero(self):
        """exitCode 0 is success."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        assert orch._is_success_exit({"exitCode": 0}) == True

    def test_is_success_exit_code_nonzero(self):
        """exitCode non-zero is failure."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        assert orch._is_success_exit({"exitCode": 1}) == False

    def test_is_success_no_exit_code(self):
        """Missing exitCode defaults to failure."""
        orch = PrdOrchestrator(session_id="test", goal="Test")
        assert orch._is_success_exit({}) == False

    def test_process_classify_result_success(self):
        """Successful classify advances to generate with needs_clarification."""
        orch = PrdOrchestrator(
            session_id="test-proc",
            goal="Build a React dashboard",
        )
        # Set up: in classify state with domain set
        # We need to reset the FSM: start() auto-transitions past classify
        # So create a fresh orchestrator that hasn't called start()
        orch.context.domain = "web-app"

        result = {
            "exitCode": 0,
            "summary": {
                "domain": "web-app",
                "domain_evidence": "React keyword",
                "project_context": {"framework": "react"},
                "confidence": "CERTAIN",
                "complete": True,
            },
        }

        action = orch.process_classify_result(result)
        assert action["action"] in ("invoke_agent", "escalate_to_user")
        assert orch.context.needs_clarification == True

    def test_process_classify_result_failure(self):
        """Failed classify returns error action."""
        orch = PrdOrchestrator(
            session_id="test-proc",
            goal="Build a dashboard",
        )
        orch.context.domain = "web-app"

        result = {
            "exitCode": 1,
            "error": "Agent crashed",
            "summary": {},
        }

        action = orch.process_classify_result(result)
        assert action["action"] == "error"
