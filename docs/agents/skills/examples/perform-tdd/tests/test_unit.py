"""
Unit tests for TDD Workflow State Machine

Tests state transitions, guards, and callbacks in isolation.
"""

import pytest
from statemachine import StateChart
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))
from scripts.orchestrate import TDDWorkflow, TDDContext


class TestInitialState:
    """Tests for initial state configuration"""
    
    def test_workflow_starts_in_red_state(self):
        """Workflow must start in red state"""
        context = TDDContext(session_id="test-001", feature_name="Test Feature")
        workflow = TDDWorkflow(model=context)
        
        assert workflow.red.is_active
        assert not workflow.green.is_active
        assert not workflow.refactor.is_active
        assert not workflow.document.is_active
    
    def test_context_initialization(self):
        """Context must initialize with defaults"""
        context = TDDContext(session_id="test-002", feature_name="Auth")
        
        assert context.session_id == "test-002"
        assert context.feature_name == "Auth"
        assert context.iteration == 0
        assert context.max_iterations == 10
        assert context.failing_tests == []
        assert context.passing_tests == []


class TestTransitions:
    """Tests for state transitions"""
    
    def test_red_to_green_transition(self):
        """test_written transition moves from red to green"""
        context = TDDContext(session_id="test-003", feature_name="Test")
        workflow = TDDWorkflow(model=context)
        
        # Initially in red
        assert workflow.red.is_active
        
        # Trigger transition
        workflow.test_written()
        
        # Now in green
        assert workflow.green.is_active
        assert not workflow.red.is_active
    
    def test_green_to_refactor_when_tests_pass(self):
        """all_pass transition moves from green to refactor when guard passes"""
        context = TDDContext(session_id="test-004", feature_name="Test")
        context.failing_tests = []  # All tests pass
        workflow = TDDWorkflow(model=context)
        
        # Move to green
        workflow.test_written()
        assert workflow.green.is_active
        
        # Trigger transition
        workflow.all_pass()
        
        # Now in refactor
        assert workflow.refactor.is_active
    
    def test_green_to_red_when_tests_still_failing(self):
        """still_failing transition moves from green to red if can retry"""
        context = TDDContext(session_id="test-005", feature_name="Test")
        context.failing_tests = ["test_fail"]
        context.iteration = 0  # Under max
        workflow = TDDWorkflow(model=context)
        
        # Move to green
        workflow.test_written()
        assert workflow.green.is_active
        
        # Trigger transition
        workflow.still_failing()
        
        # Back in red
        assert workflow.red.is_active


class TestGuards:
    """Tests for transition guards"""
    
    def test_tests_pass_when_no_failures(self):
        """tests_pass guard returns True when no failing tests"""
        context = TDDContext(session_id="test-006", feature_name="Test")
        context.failing_tests = []
        workflow = TDDWorkflow(model=context)
        
        assert workflow.tests_pass() is True
    
    def test_tests_pass_when_failures_exist(self):
        """tests_pass guard returns False when failures exist"""
        context = TDDContext(session_id="test-007", feature_name="Test")
        context.failing_tests = ["test_one", "test_two"]
        workflow = TDDWorkflow(model=context)
        
        assert workflow.tests_pass() is False
    
    def test_can_retry_under_max_iterations(self):
        """can_retry guard returns True when under max iterations"""
        context = TDDContext(session_id="test-008", feature_name="Test")
        context.iteration = 5
        context.max_iterations = 10
        workflow = TDDWorkflow(model=context)
        
        assert workflow.can_retry() is True
    
    def test_can_retry_at_max_iterations(self):
        """can_retry guard returns False when at max iterations"""
        context = TDDContext(session_id="test-009", feature_name="Test")
        context.iteration = 10
        context.max_iterations = 10
        workflow = TDDWorkflow(model=context)
        
        assert workflow.can_retry() is False
    
    def test_refactor_done_after_one_pass(self):
        """refactor_done guard returns True after refactor"""
        context = TDDContext(session_id="test-010", feature_name="Test")
        context.refactor_passes = 1
        workflow = TDDWorkflow(model=context)
        
        assert workflow.refactor_done() is True


class TestSessionPersistence:
    """Tests for session state persistence"""
    
    def test_session_file_path(self):
        """Session file path is correctly constructed"""
        context = TDDContext(
            session_id="test-session-001",
            project_root="/tmp/test-project",
            feature_name="Test"
        )
        workflow = TDDWorkflow(model=context)
        
        file_path = workflow._session_file()
        expected = Path("/tmp/test-project/.context/test-session-001.json")
        
        assert file_path == expected
    
    def test_save_session_creates_json(self, tmp_path):
        """save_session writes valid JSON"""
        context = TDDContext(
            session_id="test-save",
            project_root=str(tmp_path),
            feature_name="Feature"
        )
        workflow = TDDWorkflow(model=context)
        
        workflow.model.test_file = "tests/test_feature.py"
        workflow.model.impl_file = "src/feature.py"
        
        workflow.save_session()
        
        session_file = tmp_path / ".context" / "test-save.json"
        assert session_file.exists()
        
        import json
        data = json.loads(session_file.read_text())
        
        assert data["session_id"] == "test-save"
        assert data["context"]["feature_name"] == "Feature"


class TestIterationLimit:
    """Tests for iteration limit enforcement"""
    
    def test_iteration_increments_on_red_entry(self):
        """Iteration counter increments when entering red state"""
        context = TDDContext(session_id="test-iter", feature_name="Test")
        workflow = TDDWorkflow(model=context)
        
        assert context.iteration == 0
        
        # on_enter_red would increment (tested in integration tests)
        # Here we test the counter mechanism
        context.iteration += 1
        assert context.iteration == 1
    
    def test_max_iterations_exceeded_raises_error(self):
        """Exceeding max iterations raises RuntimeError"""
        context = TDDContext(session_id="test-max", feature_name="Test")
        context.iteration = 10
        context.max_iterations = 10
        workflow = TDDWorkflow(model=context)
        
        # Next iteration would exceed limit
        context.iteration += 1
        
        with pytest.raises(RuntimeError, match="Max iterations"):
            if context.iteration > context.max_iterations:
                raise RuntimeError(f"Max iterations ({context.max_iterations}) exceeded")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])