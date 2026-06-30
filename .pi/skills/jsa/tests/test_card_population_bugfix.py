"""Regression test: STRUCTURE, SLICE, INVESTIGATE must execute locally.

Bug: The orchestrator's _execute_local_phase method was missing
branches for STRUCTURE, SLICE, and INVESTIGATE. As a result, the
typed analysis store (ModuleCard, PageCard, FlowCard) was never
populated when the skill ran these phases.
"""

import sys
import json
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from orchestrate import JSAPipelineOrchestrator, Directive


class TestLocalPhaseExecution:
    """Test that STRUCTURE, SLICE, INVESTIGATE execute locally."""

    def setup_method(self):
        """Use the gin-and-juice-test data as fixtures if available."""
        self.test_dir = "/tmp/gin-and-juice-test"
        self.has_real_data = Path(self.test_dir).exists() and (
            Path(self.test_dir) / "assets" / "js"
        ).exists() and any((Path(self.test_dir) / "assets" / "js").glob("*.js"))

    def test_structure_phase_populates_module_cards(self):
        """STRUCTURE local execution should populate module_cards."""
        if not self.has_real_data:
            pytest.skip("No real data available in /tmp/gin-and-juice-test")

        constraints = {
            "output_dir": self.test_dir,
            "intake": {"target_url": "https://example.com"},
        }
        orch = JSAPipelineOrchestrator(
            session_id="regression-test",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        # Restore from existing session
        with open(f"{self.test_dir}/session.json") as f:
            state_data = json.load(f)
        orch.restore_state({"context": state_data.get("metadata", {})})

        # Before: no module cards
        assert len(orch.state.module_cards) == 0

        # Execute STRUCTURE locally
        directive = Directive(
            type="local",
            phase="STRUCTURE",
            session_id="regression-test",
            description="STRUCTURE test",
        )
        orch._execute_local_phase(directive)

        # After: should have module cards
        assert len(orch.state.module_cards) > 0, (
            f"STRUCTURE did not populate module_cards. "
            f"Got {len(orch.state.module_cards)} cards."
        )

    def test_slice_phase_populates_flow_cards(self):
        """SLICE local execution should populate flow_cards."""
        if not self.has_real_data:
            pytest.skip("No real data available in /tmp/gin-and-juice-test")

        constraints = {
            "output_dir": self.test_dir,
            "intake": {"target_url": "https://example.com"},
        }
        orch = JSAPipelineOrchestrator(
            session_id="regression-test-2",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        with open(f"{self.test_dir}/session.json") as f:
            state_data = json.load(f)
        orch.restore_state({"context": state_data.get("metadata", {})})

        # First, populate module cards via STRUCTURE
        directive = Directive(
            type="local",
            phase="STRUCTURE",
            session_id="regression-test-2",
            description="STRUCTURE test",
        )
        orch._execute_local_phase(directive)

        # Before: no flow cards
        assert len(orch.state.flow_cards) == 0

        # Execute SLICE locally
        directive = Directive(
            type="local",
            phase="SLICE",
            session_id="regression-test-2",
            description="SLICE test",
        )
        orch._execute_local_phase(directive)

        # After: should have flow cards
        assert len(orch.state.flow_cards) > 0, (
            f"SLICE did not populate flow_cards. "
            f"Got {len(orch.state.flow_cards)} cards."
        )

    def test_investigate_phase_runs_python_verification(self):
        """INVESTIGATE directive should run Python verification internally."""
        if not self.has_real_data:
            pytest.skip("No real data available in /tmp/gin-and-juice-test")

        constraints = {
            "output_dir": self.test_dir,
            "intake": {"target_url": "https://example.com"},
        }
        orch = JSAPipelineOrchestrator(
            session_id="regression-test-3",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        with open(f"{self.test_dir}/session.json") as f:
            state_data = json.load(f)
        orch.restore_state({"context": state_data.get("metadata", {})})

        # First, populate cards via STRUCTURE + SLICE
        orch._execute_local_phase(Directive(
            type="local",
            phase="STRUCTURE",
            session_id="regression-test-3",
            description="STRUCTURE test",
        ))
        orch._execute_local_phase(Directive(
            type="local",
            phase="SLICE",
            session_id="regression-test-3",
            description="SLICE test",
        ))

        # INVESTIGATE runs inside _investigate_directive() - call it directly
        directive = orch._investigate_directive()
        assert directive is not None
        assert directive.type == "agent"
        assert directive.phase == "INVESTIGATE"

        # After directive, state should have python_verification metadata
        pv = orch.state.metadata.get("python_verification", {})
        assert pv, "INVESTIGATE did not produce python_verification metadata"
        assert pv.get("findings_produced", 0) > 0, (
            f"Python verification produced no findings. "
            f"Got {pv.get('findings_produced', 0)}."
        )
        assert pv.get("confidence_distribution"), (
            "Python verification did not record confidence distribution"
        )

    def test_full_pipeline_produces_all_card_types(self):
        """Full pipeline STRUCTURE -> SLICE -> INVESTIGATE should populate all cards."""
        if not self.has_real_data:
            pytest.skip("No real data available in /tmp/gin-and-juice-test")

        constraints = {
            "output_dir": self.test_dir,
            "intake": {"target_url": "https://example.com"},
        }
        orch = JSAPipelineOrchestrator(
            session_id="full-pipeline-test",
            goal="https://example.com",
            project_root="/tmp",
            constraints=constraints,
        )
        with open(f"{self.test_dir}/session.json") as f:
            state_data = json.load(f)
        orch.restore_state({"context": state_data.get("metadata", {})})

        # Run STRUCTURE + SLICE locally, then INVESTIGATE via directive
        for phase in ["STRUCTURE", "SLICE"]:
            orch._execute_local_phase(Directive(
                type="local",
                phase=phase,
                session_id="full-pipeline-test",
                description=f"{phase} test",
            ))

        # INVESTIGATE runs inside _investigate_directive()
        directive = orch._investigate_directive()
        assert directive is not None
        assert directive.type == "agent"
        assert directive.phase == "INVESTIGATE"

        # Verify all card types populated
        assert len(orch.state.module_cards) > 0, "module_cards not populated"
        assert len(orch.state.flow_cards) > 0, "flow_cards not populated"
        # python_verification should have findings
        pv = orch.state.metadata.get("python_verification", {})
        assert pv.get("findings_produced", 0) > 0, "no findings produced"

        # Verify saved state has all card counts
        saved = orch.state.to_dict()
        assert saved.get("module_card_count", 0) > 0
        assert saved.get("flow_card_count", 0) > 0
