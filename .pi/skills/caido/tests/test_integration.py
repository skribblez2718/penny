"""
Integration tests for caido skill orchestrator.

Tests full lifecycle progression through all 6 phases.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from orchestrate import CaidoContext, Orchestrator


class TestFullLifecycle:
    """Happy path: intake → explore → design → scaffold → implement → test → build → complete."""

    def test_intake_to_exploring(self):
        ctx = CaidoContext(session_id="int-001", goal="Create a header injector plugin")
        orch = Orchestrator(ctx)
        action = orch.next()

        assert orch.state_id == "exploring"
        assert action["action"] == "explore"
        assert action["agent"] == "echo"
        assert ctx.extension_type == "backend-only"
        assert ctx.extension_name == "create"

    def test_explore_to_design(self):
        ctx = CaidoContext(session_id="int-002", goal="Build a full-stack plugin")
        orch = Orchestrator(ctx)
        orch.next()  # intake → exploring

        # Apply explore summary
        orch._apply_summary({
            "explore_complete": True,
            "extension_type": "full-stack",
            "apis": ["onUpstream", "storage"],
            "unknowns_count": 0,
        })
        orch.workflow.explore_done()

        action = orch.next()
        assert orch.state_id == "designing"
        assert action["agent"] == "piper"

    def test_full_happy_path(self):
        """Complete lifecycle: all 6 phases without errors."""
        ctx = CaidoContext(session_id="int-003", goal="Create a backend plugin")
        orch = Orchestrator(ctx)
        actions = []

        # Intake → Exploring
        actions.append(orch.next())
        assert orch.state_id == "exploring"

        # Explore → Design
        orch._apply_summary({"explore_complete": True, "extension_type": "backend-only", "apis": ["onUpstream"], "unknowns_count": 0})
        orch.workflow.explore_done()
        actions.append(orch.next())
        assert orch.state_id == "designing"

        # Design → Scaffold
        orch._apply_summary({"design_complete": True, "files": ["backend/src/index.ts"]})
        orch.workflow.design_done()
        actions.append(orch.next())
        assert orch.state_id == "scaffolding"

        # Scaffold → Implement
        orch._apply_summary({"scaffold_complete": True, "files_created": ["backend/src/index.ts"]})
        orch.workflow.scaffold_done()
        actions.append(orch.next())
        assert orch.state_id == "implementing"

        # Implement → Test
        orch._apply_summary({"implement_complete": True})
        orch.workflow.implement_done()
        actions.append(orch.next())
        assert orch.state_id == "testing"

        # Test → Build
        orch._apply_summary({"test_complete": True, "tests_total": 10, "tests_passed": 10})
        orch.workflow.test_done()
        actions.append(orch.next())
        assert orch.state_id == "building"

        # Build → Complete
        orch._apply_summary({"build_complete": True, "build": "ok", "manifest_valid": True})
        orch.workflow.build_done()
        actions.append(orch.next())
        assert orch.state_id == "complete"

        # All 7 actions (intake→explore + 6 phase transitions)
        assert len(actions) == 7
        assert actions[0]["action"] == "explore"
        assert actions[1]["action"] == "design"
        assert actions[2]["action"] == "scaffold"
        assert actions[3]["action"] == "implement"
        assert actions[4]["action"] == "test"
        assert actions[5]["action"] == "build"
        assert actions[6]["action"] == "complete"


class TestErrorPaths:
    """Error handling: subagent failures at each phase."""

    def test_explore_error(self):
        ctx = CaidoContext(session_id="int-err-001", goal="Test")
        orch = Orchestrator(ctx)
        orch.next()  # intake → exploring
        orch.workflow.fail_explore()
        orch.next()
        assert orch.state_id == "error"

    def test_mid_phase_error(self):
        ctx = CaidoContext(session_id="int-err-002", goal="Test")
        orch = Orchestrator(ctx)
        orch.next()  # intake → exploring
        orch._apply_summary({"explore_complete": True, "extension_type": "backend-only", "apis": [], "unknowns_count": 0})
        orch.workflow.explore_done()
        orch.next()  # exploring → designing

        # Fail in design
        orch.workflow.fail_design()
        orch.next()
        assert orch.state_id == "error"
        assert len(ctx.errors) == 0  # errors would be set by orchestration logic


class TestProjectPath:
    """Verify project paths are correct for different extension types."""

    def test_backend_plugin_path(self):
        ctx = CaidoContext(session_id="int-path-001", goal="Create auth headers plugin")
        orch = Orchestrator(ctx)
        orch.handle_intake()
        assert ctx.extension_name == "create"
        assert orch.state_id == "exploring"

    def test_fullstack_plugin_path(self):
        ctx = CaidoContext(session_id="int-path-002", goal="Build a frontend and backend plugin for auth")
        orch = Orchestrator(ctx)
        orch.handle_intake()
        assert ctx.extension_type == "full-stack"
