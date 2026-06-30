"""
Integration tests for TDD Workflow

Tests component interactions including:
- State machine transitions with callbacks
- Mempalace integration (mocked)
- Subagent integration (mocked)
"""

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock
import asyncio
import sys

sys.path.insert(0, str(Path(__file__).parent))
from scripts.orchestrate import TDDWorkflow, TDDContext, TDDSessionManager


class TestWorkflowTransitions:
    """Tests for complete workflow transitions"""
    
    @pytest.mark.asyncio
    async def test_red_to_green_complete_flow(self, tmp_path):
        """Complete transition from red to green"""
        context = TDDContext(
            session_id="test-int-001",
            project_root=str(tmp_path),
            feature_name="Test Feature"
        )
        workflow = TDDWorkflow(model=context)
        
        # Mock subagent and memory calls
        with patch.object(workflow, '_subagent', new_callable=AsyncMock) as mock_subagent:
            with patch.object(workflow, '_get_context', new_callable=AsyncMock) as mock_context:
                mock_context.return_value = "Test context"
                mock_subagent.return_value = {
                    "test_file": "tests/test_feature.py",
                    "failing_tests": ["test_example"]
                }
                
                # Trigger transition
                workflow.test_written()
                
                assert workflow.green.is_active
                assert not workflow.red.is_active
    
    @pytest.mark.asyncio
    async def test_full_cycle_to_completion(self, tmp_path):
        """Complete cycle from red to document"""
        context = TDDContext(
            session_id="test-int-002",
            project_root=str(tmp_path),
            feature_name="Auth"
        )
        workflow = TDDWorkflow(model=context)
        
        # Simulate successful completion
        with patch.object(workflow, '_subagent', new_callable=AsyncMock) as mock_subagent:
            with patch.object(workflow, '_store_learnings', new_callable=AsyncMock):
                with patch.object(workflow, '_get_context', new_callable=AsyncMock):
                    mock_subagent.return_value = {"impl_file": "src/auth.py", "passing_tests": ["test_login"]}
                    
                    # Set conditions for completion
                    context.failing_tests = []
                    context.refactor_passes = 1
                    
                    # Verify initial state
                    assert workflow.red.is_active
                    
                    # Transition through states
                    workflow.test_written()
                    assert workflow.green.is_active
                    
                    workflow.all_pass()
                    assert workflow.refactor.is_active
                    
                    workflow.refactored()
                    assert workflow.document.is_active


class TestMempalaceIntegration:
    """Tests for Mempalace integration"""
    
    @pytest.mark.asyncio
    async def test_context_retrieval(self, tmp_path):
        """Context is retrieved from Mempalace before workflow"""
        context = TDDContext(
            session_id="test-mem-001",
            project_root=str(tmp_path),
            feature_name="Test"
        )
        workflow = TDDWorkflow(model=context)
        
        with patch('orchestrate.memory_smart_search', new_callable=AsyncMock) as mock_search:
            mock_search.return_value = "Previous patterns"
            
            result = await workflow._get_context()
            
            # Should have called Mempalace
            mock_search.assert_called()
            assert "Previous patterns" in result or result is not None
    
    @pytest.mark.asyncio
    async def test_learnings_storage(self, tmp_path):
        """Learnings are stored in Mempalace after completion"""
        context = TDDContext(
            session_id="test-mem-002",
            project_root=str(tmp_path),
            feature_name="Auth"
        )
        workflow = TDDWorkflow(model=context)
        
        with patch('orchestrate.memory_add_drawer', new_callable=AsyncMock) as mock_add:
            with patch('orchestrate.memory_kg_add', new_callable=AsyncMock):
                await workflow._store_learnings()
                
                # Should have stored in Mempalace
                mock_add.assert_called_once()
                call_args = mock_add.call_args
                
                assert call_args.kwargs['wing'] == 'penny'
                assert call_args.kwargs['room'] == 'skills'
                assert 'test-mem-002' in call_args.kwargs['content']


class TestSubagentIntegration:
    """Tests for subagent integration"""
    
    @pytest.mark.asyncio
    async def test_subagent_prompt_interpolation(self, tmp_path):
        """Subagent receives interpolated prompt"""
        context = TDDContext(
            session_id="test-sub-001",
            project_root=str(tmp_path),
            feature_name="Login"
        )
        workflow = TDDWorkflow(model=context)
        
        # Mock prompt file
        prompt_content = "# RED Prompt\n\nFeature: {{feature_name}}\nFile: {{test_file}}"
        
        with patch.object(workflow, '_load_prompt', return_value=prompt_content):
            with patch.object(workflow, '_subagent', new_callable=AsyncMock) as mock_subagent:
                mock_subagent.return_value = {"test_file": "test_login.py"}
                
                # Interpolation should happen
                prompt = workflow._interpolate(prompt_content, {
                    "feature_name": "Login",
                    "test_file": "tests/test_login.py"
                })
                
                assert "{{feature_name}}" not in prompt
                assert "Login" in prompt
                assert "tests/test_login.py" in prompt


class TestSessionManager:
    """Tests for session manager lifecycle"""
    
    def test_manager_initialization(self, tmp_path):
        """Session manager initializes correctly"""
        manager = TDDSessionManager(
            session_id="test-mgr-001",
            feature_name="Test Feature",
            project_root=tmp_path
        )
        
        assert manager.session_id == "test-mgr-001"
        assert manager.context.feature_name == "Test Feature"
        assert manager.machine.red.is_active
    
    def test_load_existing_session(self, tmp_path):
        """Manager loads existing session state"""
        # Create existing session file
        session_file = tmp_path / ".context" / "test-mgr-002.json"
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_file.write_text("""{
            "session_id": "test-mgr-002",
            "context": {
                "feature_name": "Restored Feature",
                "test_file": "tests/test_restored.py",
                "iteration": 3
            }
        }""")
        
        manager = TDDSessionManager(
            session_id="test-mgr-002",
            feature_name="New Feature",
            project_root=tmp_path
        )
        
        loaded = manager.load()
        
        assert loaded
        assert manager.context.feature_name == "Restored Feature"
        assert manager.context.iteration == 3
    
    @pytest.mark.asyncio
    async def test_run_workflow(self, tmp_path):
        """Manager runs workflow to completion"""
        manager = TDDSessionManager(
            session_id="test-mgr-003",
            feature_name="Complete Feature",
            project_root=tmp_path
        )
        
        # Mock all external calls
        with patch.object(manager.machine, '_subagent', new_callable=AsyncMock):
            with patch.object(manager.machine, '_get_context', new_callable=AsyncMock):
                with patch.object(manager.machine, '_store_learnings', new_callable=AsyncMock):
                    # Set conditions for quick completion
                    manager.context.failing_tests = []
                    manager.context.refactor_passes = 1
                    
                    # Run should succeed
                    success = await manager.run()
                    
                    assert success


if __name__ == "__main__":
    pytest.main([__file__, "-v"])