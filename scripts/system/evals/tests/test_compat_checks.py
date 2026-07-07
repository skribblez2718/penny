"""Unit tests for the deterministic compat checks (pure logic, no live stores)."""

from pathlib import Path

from eval_compat import find_dead_tests, missing_consumed_fields


class TestMissingConsumedFields:
    def test_complete_record_passes(self):
        record = {
            "decision_id": "r1",
            "outcome": "MISMATCH",
            "domain": "coding",
            "reason": "timeout",
            "session_id": "s1",
            "confidence_at_action": "PROBABLE",
            "timestamp": "2026-07-05T00:00:00+00:00",
        }
        assert missing_consumed_fields(record) == []

    def test_missing_and_blank_fields_reported(self):
        record = {
            "decision_id": "r1",
            "outcome": "MISMATCH",
            "domain": "coding",
            "reason": "",
            "session_id": "s1",
            "timestamp": "2026-07-05T00:00:00+00:00",
        }
        missing = missing_consumed_fields(record)
        assert "reason" in missing
        assert "confidence_at_action" in missing


class TestFindDeadTests:
    def _make(self, root: Path, rel: str) -> None:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("def test_x():\n    assert True\n")

    def test_collected_and_dead_split(self, tmp_path):
        self._make(tmp_path, "scripts/system/foo/tests/test_collected.py")
        self._make(tmp_path, "scripts/system/foo/test_dead.py")
        self._make(tmp_path, "apps/orchestration/tests/test_engine_ok.py")
        self._make(tmp_path, "apps/orchestration/src/test_loose.py")
        dead = find_dead_tests(tmp_path)
        assert "scripts/system/foo/test_dead.py" in dead
        assert "apps/orchestration/src/test_loose.py" in dead
        assert not any("test_collected" in d for d in dead)
        assert not any("test_engine_ok" in d for d in dead)

    def test_nested_under_collected_dir_is_fine(self, tmp_path):
        self._make(tmp_path, "scripts/system/foo/tests/unit/deep/test_nested.py")
        assert find_dead_tests(tmp_path) == []

    def test_excluded_dirs_ignored(self, tmp_path):
        self._make(tmp_path, "scripts/system/foo/__pycache__/test_cache.py")
        self._make(tmp_path, "apps/thing/node_modules/pkg/test_dep.py")
        assert find_dead_tests(tmp_path) == []
