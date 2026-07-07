"""Tests for the amendment-loop closure: real guidance text, collision-proof
ids, repo-root git commits, and the review CLI's drawer-rewrite mechanics."""

import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

from amendment_generator import _next_id, generate_amendment  # noqa: E402
from amendment_applier import apply_amendment  # noqa: E402
from compression_loop import build_guidance_text, run_compression_loop  # noqa: E402


class TestGuidanceText:
    def test_no_todo_placeholder(self):
        text = build_guidance_text("Timeout in tests", ["d1 (MISMATCH): timeout"], 2)
        assert "TODO" not in text
        assert "<!--" not in text

    def test_append_safe_prefix_and_heading(self):
        text = build_guidance_text("Timeout in tests", ["d1 (MISMATCH): timeout"], 2)
        # ADD is a raw EOF append with no separator — leading blank lines keep
        # the heading intact when appended to a file ending mid-line.
        assert text.startswith("\n\n### Learned:")
        assert text.endswith("\n")

    def test_contains_pattern_evidence_and_count(self):
        text = build_guidance_text("Flaky auth", ["d1 (MISMATCH): flaky auth", "d2"], 3)
        assert "Flaky auth" in text
        assert "3x" in text
        assert "d1 (MISMATCH)" in text

    def test_bounded_size(self):
        huge = ["x" * 5000] * 10
        text = build_guidance_text("p" * 5000, huge, 10)
        assert len(text) < 1500  # amendment drawer must stay far below 4000 chars

    def test_compression_loop_emits_real_text_and_domain(self):
        outcomes = [
            {"decision_id": "d1", "outcome": "MISMATCH", "reason": "timeout", "domain": "coding"},
            {"decision_id": "d2", "outcome": "MISMATCH", "reason": "timeout", "domain": "coding"},
        ]
        amendments = run_compression_loop(outcomes)
        assert len(amendments) == 1
        amendment = amendments[0]
        new_text = amendment["changes"][0]["new_text"]
        assert "TODO" not in new_text
        assert "### Learned:" in new_text
        assert amendment["domain"] == "coding"


class TestAmendmentIds:
    def test_unique_within_burst(self):
        ids = {_next_id() for _ in range(50)}
        assert len(ids) == 50

    def test_format_date_time_suffix(self):
        aid = _next_id()
        parts = aid.split("_")
        assert parts[0] == "amend"
        assert len(parts) == 4  # amend, date, HHMMSS, hex4

    def test_generate_amendment_carries_domain(self):
        record = generate_amendment(
            learning="l",
            evidence=["e"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=".pi/skills/plan/assets/prompts/echo.md",
            proposed_text="\n\n### Learned: l\n",
            domain="research",
        )
        assert record["domain"] == "research"
        assert record["status"] == "PENDING"


class TestAmendmentRecordBounded:
    def test_verbose_reasons_stay_under_chunk_threshold(self):
        """Model-written outcome reasons run 500+ chars and land in the record
        7+ times (trigger, evidence x5, rationale, inside new_text). Uncapped,
        a few recurrences render past the bridge's 4,000-char chunking
        threshold and the stored drawer becomes unparseable fragments."""
        reason = "the integration test timed out because " + "x" * 550
        evidence = [f"run_{i} (MISMATCH): {reason}" for i in range(5)]
        record = generate_amendment(
            learning=reason,
            evidence=evidence,
            target_layer="DOMAIN_GUIDANCE",
            target_file=".pi/skills/plan/assets/prompts/piper.md",
            proposed_text=build_guidance_text(reason, evidence, 5),
            domain="coding",
        )
        rendered = f"amendment_id: {record['amendment_id']}\n" + json.dumps(record, indent=2)
        assert len(rendered) < 4_000, len(rendered)

    def test_old_and_new_text_never_clipped(self):
        """The applier matches old_text/new_text verbatim — clipping them
        would break MODIFY forever."""
        old = "o" * 1000
        record = generate_amendment(
            learning="l",
            evidence=["e"],
            target_layer="DOMAIN_GUIDANCE",
            target_file=".pi/skills/plan/assets/prompts/piper.md",
            proposed_text="n" * 1000,
            old_text=old,
        )
        assert record["changes"][0]["old_text"] == old
        assert record["changes"][0]["new_text"] == "n" * 1000

    def test_compression_domain_fallback_is_other_not_general(self):
        """'general' is not in the outcome writer's domain enum, so a
        'general' amendment could never have its efficacy measured."""
        outcomes = [
            {"decision_id": "d1", "outcome": "MISMATCH", "reason": "timeout"},
            {"decision_id": "d2", "outcome": "MISMATCH", "reason": "timeout"},
        ]
        amendments = run_compression_loop(outcomes)
        assert amendments[0]["domain"] == "other"


class TestApplierGitFromRepoRoot:
    def test_relative_target_commits_from_nested_cwd(self, tmp_path, monkeypatch):
        """The old code ran git from the prompts dir with a repo-relative
        pathspec — 'pathspec did not match' AFTER editing the file."""
        repo = tmp_path / "repo"
        prompts = repo / ".pi" / "skills" / "plan" / "assets" / "prompts"
        prompts.mkdir(parents=True)
        target = prompts / "piper.md"
        target.write_text("# Piper\n")
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)

        monkeypatch.chdir(repo)
        amendment = {
            "amendment_id": "amend_test_001",
            "status": "APPROVED",
            "target_layer": "DOMAIN_GUIDANCE",
            "target_file": ".pi/skills/plan/assets/prompts/piper.md",
            "trigger": "test",
            "evidence": ["e1"],
            "changes": [
                {
                    "action": "ADD",
                    "old_text": "",
                    "new_text": "\n\n### Learned: test\n",
                    "rationale": "test",
                }
            ],
        }
        result = apply_amendment(amendment, git_commit=True)
        assert result["success"] is True, result
        assert result["committed"] is True
        log = subprocess.run(
            ["git", "log", "-1", "--pretty=%s"], cwd=repo, capture_output=True, text=True
        ).stdout
        assert "self-improve(amend_test_001)" in log
        assert "### Learned: test" in target.read_text()

    def test_modify_rerun_is_idempotent(self, tmp_path, monkeypatch):
        """Re-running apply (after a successful apply whose drawer status-flip
        failed) must not splice new_text into a second old_text occurrence,
        must not fail on the vanished old_text, and must not error on the
        empty git commit — the wedge/corruption pair from the review."""
        repo = tmp_path / "repo"
        prompts = repo / ".pi" / "skills" / "plan" / "assets" / "prompts"
        prompts.mkdir(parents=True)
        target = prompts / "piper.md"
        target.write_text("# Piper\nplan carefully\n\n## Later\nplan carefully\n")
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)

        monkeypatch.chdir(repo)
        amendment = {
            "amendment_id": "amend_test_002",
            "status": "APPROVED",
            "target_layer": "DOMAIN_GUIDANCE",
            "target_file": ".pi/skills/plan/assets/prompts/piper.md",
            "trigger": "t",
            "evidence": ["e1"],
            "changes": [
                {
                    "action": "MODIFY",
                    "old_text": "plan carefully",
                    "new_text": "plan carefully, checking timeouts",
                    "rationale": "test",
                }
            ],
        }
        first = apply_amendment(amendment, git_commit=True)
        assert first["success"] is True and first["committed"] is True
        after_first = target.read_text()
        assert after_first.count("checking timeouts") == 1

        second = apply_amendment(amendment, git_commit=True)
        assert second["success"] is True, second
        assert second["committed"] is False  # nothing new to commit
        assert target.read_text() == after_first  # no second splice


def _import_review_cli_with_stub_bridge(stub: ModuleType):
    """Import review_amendments against a stubbed memory_bridge module."""
    for name in ("review_amendments", "memory_bridge"):
        sys.modules.pop(name, None)
    sys.modules["memory_bridge"] = stub
    import importlib

    return importlib.import_module("review_amendments")


def _stub_bridge(drawers):
    stub = ModuleType("memory_bridge")
    stub._CHUNK_THRESHOLD = 4_000
    stub.tool_list_drawers = MagicMock(
        return_value={"success": True, "drawers": drawers, "count": len(drawers)}
    )
    stub.tool_delete_drawer = MagicMock(return_value={"success": True})
    stub.tool_add_drawer = MagicMock(return_value={"success": True, "drawer_id": "new"})
    return stub


def _amendment_drawer(amendment_id="amend_2026-07-05_120000_ab12", status="PENDING"):
    record = {
        "amendment_id": amendment_id,
        "proposed_date": "2026-07-05",
        "target_layer": "DOMAIN_GUIDANCE",
        "target_file": ".pi/skills/plan/assets/prompts/piper.md",
        "trigger": "t",
        "evidence": ["e"],
        "changes": [{"action": "ADD", "old_text": "", "new_text": "n", "rationale": "r"}],
        "risk": "MEDIUM",
        "status": status,
    }
    return {
        "id": "drawer_penny_system_amendments_x",
        "wing": "penny",
        "room": "system_amendments",
        "content": f"amendment_id: {amendment_id}\n" + json.dumps(record, indent=2),
    }


class TestReviewCli:
    def teardown_method(self):
        sys.modules.pop("review_amendments", None)
        sys.modules.pop("memory_bridge", None)

    def test_approve_rewrites_drawer_with_skip_flag(self, capsys):
        stub = _stub_bridge([_amendment_drawer()])
        cli = _import_review_cli_with_stub_bridge(stub)
        rc = cli.cmd_approve("amend_2026-07-05_120000_ab12")
        assert rc == 0
        stub.tool_delete_drawer.assert_called_once()
        add_params = stub.tool_add_drawer.call_args[0][0]
        assert add_params["skip_duplicate_check"] is True
        content = add_params["content"]
        assert content.startswith("amendment_id: amend_2026-07-05_120000_ab12\n")
        rewritten = json.loads(content.split("\n", 1)[1])
        assert rewritten["status"] == "APPROVED"
        assert rewritten["reviewed_date"]

    def test_approve_refuses_non_pending(self):
        stub = _stub_bridge([_amendment_drawer(status="REJECTED")])
        cli = _import_review_cli_with_stub_bridge(stub)
        try:
            cli.cmd_approve("amend_2026-07-05_120000_ab12")
            assert False, "should have refused"
        except SystemExit as exc:
            assert "PENDING" in str(exc)

    def test_add_failure_leaves_original_untouched(self):
        """Add-first ordering: if the new drawer can't be written, the old
        drawer must never have been deleted — no loss window."""
        stub = _stub_bridge([_amendment_drawer()])
        stub.tool_add_drawer = MagicMock(return_value={"success": False, "reason": "boom"})
        cli = _import_review_cli_with_stub_bridge(stub)
        try:
            cli.cmd_approve("amend_2026-07-05_120000_ab12")
            assert False, "should have raised"
        except SystemExit as exc:
            assert "untouched" in str(exc)
        stub.tool_delete_drawer.assert_not_called()

    def test_delete_failure_after_add_reports_duplicate(self):
        """If the old drawer can't be deleted after the new one is written,
        the failure names the survivor so the operator can resolve it —
        a transient duplicate, never a lost record."""
        stub = _stub_bridge([_amendment_drawer()])
        stub.tool_delete_drawer = MagicMock(return_value={"success": False, "error": "locked"})
        cli = _import_review_cli_with_stub_bridge(stub)
        try:
            cli.cmd_approve("amend_2026-07-05_120000_ab12")
            assert False, "should have raised"
        except SystemExit as exc:
            assert "manually" in str(exc)
        stub.tool_add_drawer.assert_called_once()

    def test_rewrite_refuses_record_over_chunk_threshold(self):
        """A rendered record past the chunking threshold would be stored as
        unparseable fragments AFTER the original was deleted — refuse up front."""
        drawer = _amendment_drawer()
        cli = _import_review_cli_with_stub_bridge(_stub_bridge([drawer]))
        record = cli._parse(drawer["content"])
        record["evidence"] = ["x" * 5000]
        try:
            cli._rewrite(drawer["id"], record, record)
            assert False, "should have refused"
        except SystemExit as exc:
            assert "chunking threshold" in str(exc)
