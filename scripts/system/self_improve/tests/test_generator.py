# amendment_generator tests — TDD
"""Build structured amendment JSON from classified learnings."""

import sys
from pathlib import Path
from datetime import date

sys.path.insert(0, str(Path(__file__).parent.parent))

from amendment_generator import generate_amendment  # noqa: E402


class TestGenerateAmendmentBasic:
    """Core amendment structure generation."""

    def test_basic_domain_guidance_amendment(self):
        result = generate_amendment(
            learning="Penny assumes uv without checking",
            evidence=["outcome_abc (MISMATCH: wrong package manager)"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=".pi/skills/plan/assets/prompts/piper.md",
            proposed_text=(
                "### Package Manager Awareness\n\n"
                "Before proposing package operations, verify the package manager used.\n"
                "- Check for `uv.lock` → uv\n"
                "- Check for `package-lock.json` → npm"
            ),
        )
        assert result["target_layer"] == "DOMAIN_GUIDANCE"
        assert result["target_file"] == ".pi/skills/plan/assets/prompts/piper.md"
        assert result["trigger"] == "Penny assumes uv without checking"
        assert len(result["evidence"]) == 1
        assert result["evidence"][0] == "outcome_abc (MISMATCH: wrong package manager)"
        assert result["status"] == "PENDING"
        assert result["risk"] == "HIGH"
        assert "amendment_id" in result
        assert "proposed_date" in result

    def test_amendment_id_format(self):
        result = generate_amendment(
            learning="test",
            evidence=[],
            target_layer="DOMAIN_GUIDANCE",
            target_file="x.md",
            proposed_text="new text",
        )
        import re

        assert re.match(r"amend_\d{4}-\d{2}-\d{2}_\d+", result["amendment_id"])

    def test_proposed_date_is_today(self):
        result = generate_amendment(
            learning="test",
            evidence=[],
            target_layer="DOMAIN_GUIDANCE",
            target_file="x.md",
            proposed_text="new text",
        )
        assert result["proposed_date"] == date.today().isoformat()


class TestGenerateAmendmentActionTypes:
    """ADD vs MODIFY vs REMOVE action types."""

    def test_add_action_for_new_section(self):
        result = generate_amendment(
            learning="Missing package manager check",
            evidence=["outcome_1"],
            target_layer="DOMAIN_GUIDANCE",
            target_file="piper.md",
            proposed_text="### New Section\n\nNew content.\n",
        )
        changes = result["changes"]
        assert len(changes) == 1
        assert changes[0]["action"] == "ADD"
        assert changes[0]["old_text"] == ""
        assert "### New Section" in changes[0]["new_text"]

    def test_modify_action_for_existing_section(self):
        result = generate_amendment(
            learning="CREST table missing auth domain",
            evidence=["outcome_2"],
            target_layer="DOMAIN_GUIDANCE",
            target_file="echo.md",
            old_text="| Code | Breaking changes | Libraries | Tests pass |",
            proposed_text="| Code | Breaking changes | Libraries | Tests pass |\n| Auth | Permissions | Identity providers | Authz checks |",
        )
        changes = result["changes"]
        assert len(changes) == 1
        assert changes[0]["action"] == "MODIFY"
        assert "Breaking changes" in changes[0]["old_text"]
        assert "Auth" in changes[0]["new_text"]

    def test_multiple_changes(self):
        result = generate_amendment(
            learning="Several missing checks",
            evidence=["outcome_3", "outcome_4"],
            target_layer="DOMAIN_GUIDANCE",
            target_file="carren.md",
            changes=[
                {"action": "ADD", "old_text": "", "new_text": "Check A", "rationale": "r1"},
                {"action": "ADD", "old_text": "", "new_text": "Check B", "rationale": "r2"},
            ],
        )
        assert len(result["changes"]) == 2
        assert result["changes"][0]["new_text"] == "Check A"
        assert result["changes"][1]["new_text"] == "Check B"


class TestGenerateAmendmentRiskLevels:
    """Risk assessment based on target and scope."""

    def test_plan_skill_high_risk(self):
        result = generate_amendment(
            learning="test",
            evidence=["outcome_x"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=".pi/skills/plan/assets/prompts/piper.md",
            proposed_text="x",
        )
        assert result["risk"] == "HIGH"

    def test_generic_domain_guidance_medium_risk(self):
        result = generate_amendment(
            learning="test",
            evidence=["outcome_y"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=".pi/skills/plan/assets/prompts/echo.md",
            proposed_text="x",
        )
        assert result["risk"] == "MEDIUM"

    def test_mempalace_pref_low_risk(self):
        result = generate_amendment(
            learning="test",
            evidence=["session_1"],
            target_layer="MEMPALACE_PREF",
            target_file="penny/preferences",
            proposed_text="x",
        )
        assert result["risk"] == "LOW"

    def test_config_low_risk(self):
        result = generate_amendment(
            learning="test",
            evidence=["outcome_z"],
            target_layer="CONFIG",
            target_file=".env",
            proposed_text="TIMEOUT=900000",
        )
        assert result["risk"] == "LOW"


class TestGenerateAmendmentRationale:
    """Every change must include rationale."""

    def test_rationale_derived_from_learning(self):
        result = generate_amendment(
            learning="User prefers terse summaries",
            evidence=["session_1", "session_2"],
            target_layer="MEMPALACE_PREF",
            target_file="penny/preferences",
            proposed_text=" terse",
        )
        changes = result["changes"]
        assert changes[0]["rationale"] == "User prefers terse summaries"

    def test_rationale_from_explicit_changes(self):
        result = generate_amendment(
            learning="Missing check",
            evidence=["outcome_x"],
            target_layer="DOMAIN_GUIDANCE",
            target_file="piper.md",
            changes=[
                {
                    "action": "ADD",
                    "old_text": "",
                    "new_text": "Check X",
                    "rationale": "Prevents regression Y in 3 of last 5 outcomes",
                }
            ],
        )
        assert result["changes"][0]["rationale"] == "Prevents regression Y in 3 of last 5 outcomes"


class TestGenerateAmendmentValidation:
    """Invalid inputs are caught."""

    def test_no_evidence_rejected(self):
        result = generate_amendment(
            learning="test",
            evidence=[],
            target_layer="DOMAIN_GUIDANCE",
            target_file="x.md",
            proposed_text="text",
        )
        assert result["status"] == "INVALID"
        assert "evidence" in result.get("errors", [""])[0].lower()

    def test_no_proposed_text_no_changes_rejected(self):
        result = generate_amendment(
            learning="test",
            evidence=["outcome_1"],
            target_layer="DOMAIN_GUIDANCE",
            target_file="x.md",
        )
        assert result["status"] == "INVALID"
        assert "changes" in result.get("errors", [""])[0].lower()
