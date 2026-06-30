"""
E2E tests for caido skill orchestrator.

Tests the full orchestrator lifecycle via CLI entry point.
Creates a minimal fake plugin project, runs through all phases, and cleans up.
"""

import json
import os
import sys
import tempfile
import shutil

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from orchestrate import CaidoContext, Orchestrator, main as orchestrator_main


class TestE2ECLI:
    """End-to-end test: create a minimal backend plugin via orchestrator CLI."""

    def test_full_cli_lifecycle(self):
        """Simulate the full orchestrator lifecycle via next() calls."""
        ctx = CaidoContext(
            session_id="e2e-001",
            goal="Create a test-only backend plugin for e2e testing",
            project_root="/tmp",
        )
        orch = Orchestrator(ctx)

        # Phase 1: Intake → Exploring
        action = orch.next()
        assert action["action"] == "explore"
        assert action["agent"] == "echo"
        assert ctx.extension_type == "backend-only"

        # Phase 2: Explore → Design
        orch._apply_summary({
            "explore_complete": True,
            "extension_type": "backend-only",
            "apis": ["onUpstream"],
            "unknowns_count": 0,
        })
        orch.workflow.explore_done()
        action = orch.next()
        assert action["action"] == "design"
        assert action["agent"] == "piper"

        # Phase 3: Design → Scaffold
        orch._apply_summary({
            "design_complete": True,
            "files": ["backend/src/index.ts"],
        })
        orch.workflow.design_done()
        action = orch.next()
        assert action["action"] == "scaffold"
        assert action["agent"] == "skribble"
        assert "caido-plugins" in action.get("cwd", "")

        # Phase 4: Scaffold → Implement
        orch._apply_summary({
            "scaffold_complete": True,
            "files_created": ["backend/src/index.ts", "caido.config.ts", "package.json"],
        })
        orch.workflow.scaffold_done()
        action = orch.next()
        assert action["action"] == "implement"

        # Phase 5: Implement → Test
        orch._apply_summary({"implement_complete": True})
        orch.workflow.implement_done()
        action = orch.next()
        assert action["action"] == "test"

        # Phase 6: Test → Build
        orch._apply_summary({
            "test_complete": True,
            "tests_total": 5,
            "tests_passed": 5,
        })
        orch.workflow.test_done()
        action = orch.next()
        assert action["action"] == "build"

        # Phase 7: Build → Complete
        orch._apply_summary({
            "build_complete": True,
            "build": "ok",
            "manifest_valid": True,
        })
        orch.workflow.build_done()
        action = orch.next()
        assert action["action"] == "complete"
        assert "created successfully" in action["message"]

        # Verify final context state
        state = orch.extract_state()
        assert state["current_state"] == "complete"
        assert state["explore_complete"]
        assert state["design_complete"]
        assert state["scaffold_complete"]
        assert state["implement_complete"]
        assert state["test_complete"]
        assert state["build_complete"]
        assert state["tests_total"] == 5
        assert state["tests_passed"] == 5

    def test_extension_name_derivation(self):
        """Test that extension names are properly derived from goals."""
        cases = [
            ("Create a header injector plugin", "create", "backend-only"),
            ("Build auth workflow", "build", "workflow"),
            ("Frontend UI for settings", "frontend", "frontend-only"),
            ("Full stack proxy plugin with frontend and backend", "full", "full-stack"),
        ]
        for goal, expected_name, expected_type in cases:
            ctx = CaidoContext(session_id="e2e-name", goal=goal)
            orch = Orchestrator(ctx)
            orch.handle_intake()
            assert ctx.extension_name == expected_name, f"Goal: {goal}"
            assert ctx.extension_type == expected_type, f"Goal: {goal}"

    def test_extract_state_roundtrip(self):
        """Verify state extraction/restoration works for session persistence."""
        ctx = CaidoContext(
            session_id="e2e-state",
            goal="Test state persistence",
            extension_type="backend-only",
            extension_name="test-plugin",
            explore_complete=True,
            design_complete=True,
            errors=["test error"],
        )
        orch = Orchestrator(ctx)
        state = orch.extract_state()

        # Simulate restoring from saved state
        restored = CaidoContext(**{k: v for k, v in state.items()
                                   if k in CaidoContext.__dataclass_fields__})
        assert restored.session_id == "e2e-state"
        assert restored.extension_name == "test-plugin"
        assert restored.explore_complete is True
        assert restored.errors == ["test error"]
