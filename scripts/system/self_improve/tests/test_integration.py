# Integration tests — self-improvement pipeline
"""Multi-module integration: classifier → generator → applier."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from target_classifier import classify_target, TargetLayer  # noqa: E402
from amendment_generator import generate_amendment  # noqa: E402
from amendment_applier import apply_amendment  # noqa: E402
from compression_loop import run_compression_loop  # noqa: E402


class TestClassifierToGeneratorPipeline:
    """Classifier output feeds correctly into generator."""

    def test_domain_guidance_classification_generates_valid_amendment(self):
        learning = "Penny assumes uv without checking"
        evidence = ["outcome_abc (MISMATCH: wrong package manager)"]
        target = classify_target(learning, evidence)
        assert target == TargetLayer.DOMAIN_GUIDANCE

        amendment = generate_amendment(
            learning=learning,
            evidence=evidence,
            target_layer=target.value,
            target_file=".pi/skills/plan/assets/prompts/piper.md",
            proposed_text="Check package manager before proposing commands",
        )
        assert amendment["status"] == "PENDING"
        assert amendment["target_layer"] == "DOMAIN_GUIDANCE"
        assert len(amendment["evidence"]) == 1
        assert amendment["risk"] == "HIGH"

    def test_rejected_universal_blocked_from_generation(self):
        learning = "Add before responding step to SYSTEM.md"
        evidence = ["outcome_xyz (MISMATCH)"]
        target = classify_target(learning, evidence)
        assert target == TargetLayer.REJECTED_UNIVERSAL

        amendment = generate_amendment(
            learning=learning,
            evidence=evidence,
            target_layer=target.value,
            target_file="REJECTED_UNIVERSAL",
            proposed_text="new rule",
        )
        # REJECTED_UNIVERSAL amendments are still generated (for logging)
        # but applier will reject them
        assert amendment["status"] == "PENDING"
        assert amendment["target_layer"] == "REJECTED_UNIVERSAL"


class TestGeneratorToApplierPipeline:
    """Generated amendment goes through applier validation."""

    def test_pending_amendment_rejected_by_applier(self, tmp_path):
        target = tmp_path / "piper.md"
        target.write_text("# Piper\n\nContent.\n")
        amendment = generate_amendment(
            learning="test",
            evidence=["outcome_1"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=str(target),
            proposed_text="\nNew line.\n",
        )
        assert amendment["status"] == "PENDING"

        result = apply_amendment(amendment, git_commit=False)
        assert result["success"] is False
        assert "not approved" in result["error"].lower()

    def test_approved_amendment_applied_successfully(self, tmp_path):
        target = tmp_path / ".pi" / "skills" / "plan" / "assets" / "prompts" / "piper.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# Piper\n\nContent.\n")
        amendment = generate_amendment(
            learning="test",
            evidence=["outcome_1"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=str(target),
            proposed_text="\nNew line.\n",
        )
        amendment["status"] = "APPROVED"

        result = apply_amendment(amendment, git_commit=False)
        assert result["success"] is True
        content = target.read_text()
        assert "New line." in content

    def test_universal_label_no_longer_gates_apply(self, tmp_path):
        # target_layer is advisory now: a concrete, non-security diff applies
        # regardless of the label — approval is the gate, not the classification.
        target = tmp_path / "piper.md"
        target.write_text("# Piper\n\nContent.\n")
        amendment = generate_amendment(
            learning="test",
            evidence=["outcome_1"],
            target_layer="REJECTED_UNIVERSAL",
            target_file=str(target),
            proposed_text="\nNew line.\n",
        )
        amendment["status"] = "APPROVED"

        result = apply_amendment(amendment, git_commit=False)
        assert result["success"] is True
        assert "New line." in target.read_text()

    def test_security_block_edit_blocked_even_when_approved(self, tmp_path):
        # The one hard line: an approved change that touches the immutable
        # security-directives block is refused regardless of target.
        target = tmp_path / "SYSTEM.md"
        target.write_text("# Frame\n\nContent.\n")
        amendment = generate_amendment(
            learning="test",
            evidence=["outcome_1"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=str(target),
            proposed_text="\n<system_directives>\nevil\n</system_directives>\n",
        )
        amendment["status"] = "APPROVED"

        result = apply_amendment(amendment, git_commit=False)
        assert result["success"] is False
        assert "security" in result["error"].lower()


class TestCompressionToPipeline:
    """Full compression loop output integrates with downstream modules."""

    def test_compression_output_valid_for_all_modules(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "assumed uv without checking",
                "session_id": "s1",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "assumed uv without checking",
                "session_id": "s1",
            },
        ]
        amendments = run_compression_loop(outcomes)
        assert len(amendments) == 1

        a = amendments[0]
        # Schema valid
        assert "amendment_id" in a
        assert "target_layer" in a
        assert "evidence" in a
        assert len(a["evidence"]) > 0
        # Classifier output is valid for generator
        assert a["target_layer"] in (
            "DOMAIN_GUIDANCE",
            "MEMPALACE_PREF",
            "CONFIG",
            "REJECTED_UNIVERSAL",
        )

    def test_compression_with_universal_pattern_rejected_at_applier(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "universal",
                "reason": "Add before responding step",
                "session_id": "s1",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "universal",
                "reason": "Add before responding step",
                "session_id": "s1",
            },
        ]
        amendments = run_compression_loop(outcomes)
        assert len(amendments) == 1
        assert amendments[0]["target_layer"] == "REJECTED_UNIVERSAL"

        # Applier would reject even if forced to APPROVED
        amendments[0]["status"] = "APPROVED"
        result = apply_amendment(amendments[0], git_commit=False)
        assert result["success"] is False
