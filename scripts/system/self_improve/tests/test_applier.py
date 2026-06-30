# amendment_applier tests — TDD
"""Apply approved amendments to Domain Guidance files + git commit."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from amendment_applier import apply_amendment, _write_file_change, _build_commit_message  # noqa: E402


class TestBuildCommitMessage:
    """Commit messages cite evidence and rationale."""

    def test_commit_message_includes_id_and_rationale(self):
        amendment = {
            "amendment_id": "amend_2026-04-12_001",
            "target_file": ".pi/skills/plan/assets/prompts/piper.md",
            "changes": [{
                "rationale": "3 of last 5 coding MISMATCHes involved incorrect package manager assumptions",
                "action": "ADD",
            }],
            "evidence": ["outcome_abc (MISMATCH: wrong package manager)"],
        }
        msg = _build_commit_message(amendment)
        assert "amend_2026-04-12_001" in msg
        assert "piper.md" in msg
        assert "package manager" in msg
        assert "outcome_abc" in msg or "Evidence" in msg

    def test_commit_message_truncates_long_rationale(self):
        amendment = {
            "amendment_id": "amend_001",
            "target_file": "x.md",
            "changes": [{"rationale": "a" * 300, "action": "ADD"}],
            "evidence": [],
        }
        msg = _build_commit_message(amendment)
        assert len(msg) <= 500


class TestWriteFileChange:
    """File modification with ADD and MODIFY actions."""

    def test_add_appends_to_file(self, tmp_path):
        target = tmp_path / "test.md"
        target.write_text("# Header\n\nExisting content.\n")
        change = {"action": "ADD", "old_text": "", "new_text": "\n### New Section\n\nNew text.\n"}
        result = _write_file_change(str(target), change)
        assert result is True
        content = target.read_text()
        assert "Existing content." in content
        assert "New Section" in content

    def test_modify_replaces_old_text(self, tmp_path):
        target = tmp_path / "test.md"
        target.write_text("# Header\n\nOld line here.\n\nFooter.\n")
        change = {"action": "MODIFY", "old_text": "Old line here.", "new_text": "New line here."}
        result = _write_file_change(str(target), change)
        assert result is True
        content = target.read_text()
        assert "New line here." in content
        assert "Old line here." not in content
        assert "Footer." in content

    def test_modify_no_match_returns_false(self, tmp_path):
        target = tmp_path / "test.md"
        target.write_text("# Header\n\nContent.\n")
        change = {"action": "MODIFY", "old_text": "Nonexistent text.", "new_text": "Replacement."}
        result = _write_file_change(str(target), change)
        assert result is False

    def test_remove_deletes_section(self, tmp_path):
        target = tmp_path / "test.md"
        target.write_text("# Header\n\nRemove me.\n\nKeep me.\n")
        change = {"action": "REMOVE", "old_text": "Remove me.", "new_text": ""}
        result = _write_file_change(str(target), change)
        assert result is True
        content = target.read_text()
        assert "Remove me." not in content
        assert "Keep me." in content


class TestApplyAmendment:
    """End-to-end application with validation."""

    def test_rejects_invalid_status(self, tmp_path):
        amendment = {
            "amendment_id": "amend_001",
            "status": "PENDING",
            "target_layer": "DOMAIN_GUIDANCE",
            "target_file": str(tmp_path / "test.md"),
            "changes": [{"action": "ADD", "old_text": "", "new_text": "x", "rationale": "r"}],
        }
        result = apply_amendment(amendment)
        assert result["success"] is False
        assert "not approved" in result["error"].lower()

    def test_rejects_universal_target(self, tmp_path):
        amendment = {
            "amendment_id": "amend_001",
            "status": "APPROVED",
            "target_layer": "REJECTED_UNIVERSAL",
            "target_file": str(tmp_path / "test.md"),
            "changes": [{"action": "ADD", "old_text": "", "new_text": "x", "rationale": "r"}],
        }
        result = apply_amendment(amendment)
        assert result["success"] is False
        assert "universal" in result["error"].lower()

    def test_rejects_missing_target_file(self):
        amendment = {
            "amendment_id": "amend_001",
            "status": "APPROVED",
            "target_layer": "DOMAIN_GUIDANCE",
            "target_file": "/nonexistent/path/x.md",
            "changes": [{"action": "ADD", "old_text": "", "new_text": "x", "rationale": "r"}],
        }
        result = apply_amendment(amendment)
        assert result["success"] is False
        assert "file not found" in result["error"].lower()

    def test_successful_domain_guidance_apply_no_git(self, tmp_path):
        target = tmp_path / "piper.md"
        target.write_text("# Piper\n\nExisting.\n")
        amendment = {
            "amendment_id": "amend_001",
            "status": "APPROVED",
            "target_layer": "DOMAIN_GUIDANCE",
            "target_file": str(target),
            "changes": [{"action": "ADD", "old_text": "", "new_text": "\nNew line.\n", "rationale": "r"}],
            "evidence": ["outcome_x"],
        }
        result = apply_amendment(amendment, git_commit=False)
        assert result["success"] is True
        content = target.read_text()
        assert "New line." in content

    def test_applies_multiple_changes(self, tmp_path):
        target = tmp_path / "piper.md"
        target.write_text("AAA\nBBB\nCCC\n")
        amendment = {
            "amendment_id": "amend_002",
            "status": "APPROVED",
            "target_layer": "DOMAIN_GUIDANCE",
            "target_file": str(target),
            "changes": [
                {"action": "MODIFY", "old_text": "AAA", "new_text": "Alpha", "rationale": "r1"},
                {"action": "MODIFY", "old_text": "BBB", "new_text": "Beta", "rationale": "r2"},
            ],
            "evidence": ["outcome_x"],
        }
        result = apply_amendment(amendment, git_commit=False)
        assert result["success"] is True
        content = target.read_text()
        assert "Alpha" in content
        assert "Beta" in content
        assert "AAA\n" not in content
        assert "BBB\n" not in content
