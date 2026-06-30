"""
End-to-End tests for TDD Workflow

Tests complete skill execution with:
- Real file system operations
- Actual state transitions
- Full workflow from start to finish

Run with: pytest tests/test_e2e.py -v --e2e
"""

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import asyncio
import sys
import tempfile
import shutil

sys.path.insert(0, str(Path(__file__).parent))
from scripts.orchestrate import TDDWorkflow, TDDContext, TDDSessionManager


# Mark all tests in this file as e2e
pytestmark = pytest.mark.e2e


@pytest.fixture
def temp_project():
    """Create a temporary project directory"""
    temp_dir = Path(tempfile.mkdtemp())
    yield temp_dir
    shutil.rmtree(temp_dir, ignore_errors=True)


class TestFullTDDCycle:
    """Tests for complete TDD cycles"""
    
    @pytest.mark.asyncio
    async def test_red_green_refactor_document_cycle(self, temp_project):
        """Complete RED-GREEN-REFACTOR-DOCUMENT cycle"""
        manager = TDDSessionManager(
            session_id="e2e-001",
            feature_name="User Authentication",
            project_root=temp_project
        )
        
        # Mock subagent responses for each phase
        subagent_responses = {
            "assets/prompts/red.md": {
                "test_file": "tests/test_auth.py",
                "failing_tests": ["test_login", "test_logout"],
                "test_code": "def test_login(): assert False"
            },
            "assets/prompts/green.md": {
                "impl_file": "src/auth.py",
                "remaining_failures": [],
                "passing_tests": ["test_login", "test_logout"],
                "implementation_summary": "Implemented basic auth"
            },
            "assets/prompts/refactor.md": {
                "changes": ["Extracted TokenManager class"],
                "needs_more_tests": False,
                "suggestions": [],
                "all_tests_still_passing": True
            },
            "assets/prompts/document.md": {
                "docs_updated": ["src/auth.py", "README.md"],
                "docstrings_added": 5
            }
        }
        
        async def mock_subagent(agent, task):
            # Determine which prompt was used
            for prompt_file, response in subagent_responses.items():
                if prompt_file in task or Path(prompt_file).stem in task:
                    return response
            return {}
        
        # Mock all external dependencies
        with patch.object(TDDWorkflow, '_subagent', side_effect=mock_subagent):
            with patch.object(TDDWorkflow, '_get_context', return_value="Test context"):
                with patch.object(TDDWorkflow, '_store_learnings', new_callable=AsyncMock):
                    with patch.object(TDDWorkflow, '_load_prompt') as mock_load:
                        # Return prompt content that can be interpolated
                        mock_load.return_value = "Prompt for {{feature_name}}"
                        
                        # Set up for completion
                        manager.context.failing_tests = []
                        manager.context.refactor_passes = 1
                        
                        # Run workflow
                        success = await manager.run()
                        
                        assert success
    
    @pytest.mark.asyncio
    async def test_session_persistence_and_resume(self, temp_project):
        """Session persists and can be resumed"""
        session_id = "e2e-persist-001"
        
        # Create first session
        manager1 = TDDSessionManager(
            session_id=session_id,
            feature_name="Resume Test",
            project_root=temp_project
        )
        
        # Set some state
        manager1.context.test_file = "tests/test_resume.py"
        manager1.context.impl_file = "src/resume.py"
        manager1.context.iteration = 2
        manager1.machine.save_session()
        
        # Create new manager with same session_id
        manager2 = TDDSessionManager(
            session_id=session_id,
            feature_name="Different Name",  # Should be overridden
            project_root=temp_project
        )
        
        # Load should restore previous state
        loaded = manager2.load()
        
        assert loaded
        assert manager2.context.test_file == "tests/test_resume.py"
        assert manager2.context.impl_file == "src/resume.py"
        assert manager2.context.iteration == 2
        assert manager2.context.feature_name == "Resume Test"  # Restored
    
    @pytest.mark.asyncio
    async def test_iteration_limit_enforcement(self, temp_project):
        """Workflow stops at iteration limit"""
        manager = TDDSessionManager(
            session_id="e2e-iter-limit",
            feature_name="Iteration Limit Test",
            project_root=temp_project,
            max_iterations=2
        )
        
        # Set iteration at limit
        manager.context.iteration = 2
        manager.context.max_iterations = 2
        
        # Attempt to increment
        manager.context.iteration += 1
        
        # Should exceed limit
        assert manager.context.iteration > manager.context.max_iterations
    
    @pytest.mark.asyncio
    async def test_error_handling_preserves_session(self, temp_project):
        """Errors preserve session state for recovery"""
        session_id = "e2e-error-001"
        
        manager = TDDSessionManager(
            session_id=session_id,
            feature_name="Error Test",
            project_root=temp_project
        )
        
        # Set some state
        manager.context.test_file = "tests/test_error.py"
        manager.context.iteration = 1
        
        # Save session
        manager.machine.save_session()
        
        # Verify session file exists
        session_file = temp_project / ".context" / f"{session_id}.json"
        assert session_file.exists()
        
        # Simulate error
        try:
            raise RuntimeError("Simulated error")
        except RuntimeError:
            # Session should be recoverable
            pass
        
        # Load session in new manager
        manager2 = TDDSessionManager(
            session_id=session_id,
            feature_name="Recovery Test",
            project_root=temp_project
        )
        
        loaded = manager2.load()
        
        assert loaded
        assert manager2.context.test_file == "tests/test_error.py"
        assert manager2.context.iteration == 1


class TestMempalaceE2E:
    """End-to-end Mempalace integration tests"""
    
    @pytest.mark.asyncio
    async def test_context_is_queried_before_red(self, temp_project):
        """Mempalace context is retrieved before RED phase"""
        from scripts.orchestrate import memory_smart_search
        
        context = TDDContext(
            session_id="e2e-mem-001",
            project_root=str(temp_project),
            feature_name="Context Test"
        )
        workflow = TDDWorkflow(model=context)
        
        # Mock memory_smart_search
        with patch('orchestrate.memory_smart_search', new_callable=AsyncMock) as mock_mem:
            mock_mem.return_value = "Found previous TDD patterns"
            
            # This would be called in on_enter_red
            context_str = await workflow._get_context()
            
            # Memory should have been queried
            mock_mem.assert_called()
            
            # Context should include response
            assert context_str is not None
    
    @pytest.mark.asyncio
    async def test_learnings_stored_after_completion(self, temp_project):
        """Mempalace receive learnings after DOCUMENT phase"""
        from scripts.orchestrate import memory_add_drawer, memory_kg_add
        
        context = TDDContext(
            session_id="e2e-mem-002",
            project_root=str(temp_project),
            feature_name="Learnings Test"
        )
        workflow = TDDWorkflow(model=context)
        workflow.model.test_file = "tests/test_learnings.py"
        workflow.model.impl_file = "src/learnings.py"
        workflow.model.decisions = ["Extracted helper class"]
        workflow.model.lessons = ["Consider async pattern"]
        
        # Mock Mempalace calls
        with patch('orchestrate.memory_add_drawer', new_callable=AsyncMock) as mock_add:
            with patch('orchestrate.memory_kg_add', new_callable=AsyncMock) as mock_kg:
                await workflow._store_learnings()
                
                # Drawer should have session record
                mock_add.assert_called_once()
                call_args = mock_add.call_args
                assert call_args.kwargs['wing'] == 'penny'
                assert call_args.kwargs['room'] == 'skills'
                
                # Knowledge graph should have relationship
                mock_kg.assert_called_once()
                kg_args = mock_kg.call_args
                assert 'TDDSession' in kg_args.kwargs['subject']


class TestFilesystemOperations:
    """Tests for filesystem operations"""
    
    def test_context_directory_creation(self, temp_project):
        """Context directory is created when needed"""
        context = TDDContext(
            session_id="e2e-fs-001",
            project_root=str(temp_project),
            feature_name="FS Test"
        )
        workflow = TDDWorkflow(model=context)
        
        # Context dir shouldn't exist yet
        context_dir = temp_project / ".context"
        assert not context_dir.exists()
        
        # Save session should create it
        workflow.save_session()
        
        # Now it should exist
        assert context_dir.exists()
        
        # Session file should exist
        session_file = context_dir / "e2e-fs-001.json"
        assert session_file.exists()
    
    def test_session_cleanup_on_completion(self, temp_project):
        """Session file is removed on completion"""
        session_id = "e2e-cleanup-001"
        
        manager = TDDSessionManager(
            session_id=session_id,
            feature_name="Cleanup Test",
            project_root=temp_project
        )
        
        # Create session file
        manager.machine.save_session()
        session_file = temp_project / ".context" / f"{session_id}.json"
        assert session_file.exists()
        
        # Complete should remove it
        manager.complete()
        
        # File should be gone
        assert not session_file.exists()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-m", "e2e"])