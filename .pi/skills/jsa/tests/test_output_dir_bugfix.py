"""Regression tests for the output_dir bug fix (Phase E+, 2026-06-10).

Bug: _process_intake_questionnaire() was overriding the user's explicit
output_dir setting with a default of /tmp/jsa-{hostname}. This caused
files to be written to an unexpected location when users specified
their own output_dir.
"""

import sys
import shutil
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from orchestrate import JSAPipelineOrchestrator


class TestOutputDirRespect:
    """Tests that the user's output_dir is respected."""

    def setup_method(self):
        """Create a temp output dir for testing."""
        self.test_dir = Path("/tmp/jsa-test-output-dir-respect")
        self.test_dir.mkdir(parents=True, exist_ok=True)

    def teardown_method(self):
        """Clean up."""
        if self.test_dir.exists():
            shutil.rmtree(self.test_dir)

    def test_explicit_output_dir_preserved(self):
        """User's explicit output_dir should be preserved through questionnaire."""
        constraints = {
            "output_dir": str(self.test_dir),
            "intake": {
                "target_url": "https://example.com",
                "authenticated_testing": "both",
                "auth_instructions": "test",
                "session_management": "cookie",
            },
        }
        orch = JSAPipelineOrchestrator(
            session_id="test-1",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        action = orch.start()
        assert orch.output_dir == str(self.test_dir), (
            f"output_dir was changed to {orch.output_dir}, expected {self.test_dir}"
        )
        assert orch.state.output_dir == str(self.test_dir)

    def test_default_output_dir_when_not_specified(self):
        """When no output_dir, default to /tmp/jsa-{hostname}."""
        constraints = {
            "intake": {
                "target_url": "https://example.com",
                "authenticated_testing": "both",
                "auth_instructions": "test",
                "session_management": "cookie",
            },
        }
        orch = JSAPipelineOrchestrator(
            session_id="test-2",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        action = orch.start()
        assert "example-com" in orch.output_dir
        assert orch.output_dir.startswith("/tmp/jsa-")

    def test_output_dir_preserved_after_restore(self):
        """output_dir should be preserved across restore_state calls."""
        constraints = {
            "output_dir": str(self.test_dir),
            "intake": {
                "target_url": "https://example.com",
                "authenticated_testing": "both",
                "auth_instructions": "test",
                "session_management": "cookie",
            },
        }
        # First orchestrator
        orch1 = JSAPipelineOrchestrator(
            session_id="test-3",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        orch1.start()
        state = orch1.extract_state()

        # Second orchestrator (simulates new CLI process)
        orch2 = JSAPipelineOrchestrator(
            session_id="test-3",
            goal=state["context"]["goal"],
            project_root="/tmp",
            constraints=state["context"]["constraints"],
        )
        orch2.restore_state(state)
        assert orch2.output_dir == str(self.test_dir)

    def test_files_actually_written_to_user_dir(self):
        """Files should be written to the user's specified dir, not elsewhere."""
        constraints = {
            "output_dir": str(self.test_dir),
            "intake": {
                "target_url": "https://example.com",
                "authenticated_testing": "both",
                "auth_instructions": "test",
                "session_management": "cookie",
            },
        }
        orch = JSAPipelineOrchestrator(
            session_id="test-4",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        action = orch.start()
        # The start() should create the session.json in the user-specified dir
        session_path = self.test_dir / "session.json"
        # Note: session.json is written on _save_state, which may not run
        # during start(). The key assertion is the output_dir is correct.
        assert orch.output_dir == str(self.test_dir)
        assert orch.state.output_dir == str(self.test_dir)
        # ensure_dirs should have created the subdirectories
        assert (self.test_dir / "assets" / "js").exists()
        assert (self.test_dir / "sast").exists()
        assert (self.test_dir / "findings").exists()
        assert (self.test_dir / "evidence").exists()


class TestOutputDirConsistency:
    """Tests for consistent output_dir across all phases."""

    def test_output_dir_does_not_change_during_intake(self):
        """Output dir should not be modified during intake questionnaire."""
        constraints = {
            "output_dir": "/tmp/gin-and-juice-test",
            "intake": {
                "target_url": "https://ginandjuice.shop",
                "authenticated_testing": "both",
                "auth_instructions": "login at /login as carlos/hunter2",
                "session_management": "cookie",
            },
        }
        orch = JSAPipelineOrchestrator(
            session_id="consistency-test",
            goal="https://ginandjuice.shop",
            project_root="/tmp",
            constraints=constraints,
        )
        # Before start
        before = orch.output_dir
        assert before == "/tmp/gin-and-juice-test"
        # After start (which processes intake)
        orch.start()
        # Should be unchanged after intake processing
        assert orch.output_dir == "/tmp/gin-and-juice-test"
        assert orch.state.output_dir == "/tmp/gin-and-juice-test"
