import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from tiered_memory import (  # noqa: E402
    age_days,
    classify_drawer,
    should_archive,
    sweep_for_archival,
    weekly_archival_report,
    DrawerMeta,
)


class TestAgeDays:
    def test_yesterday_is_1_day(self):
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        assert round(age_days(yesterday), 1) == 1.0

    def test_now_is_0_days(self):
        now = datetime.now(timezone.utc).isoformat()
        assert age_days(now) < 0.01

    def test_z_suffix(self):
        ts = "2026-04-01T00:00:00Z"
        age = age_days(ts, now=datetime(2026, 4, 2, tzinfo=timezone.utc))
        assert round(age) == 1

    def test_future_is_negative(self):
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        assert age_days(future) < 0


class TestClassifyDrawer:
    def test_signals_is_t2_7d(self):
        d = DrawerMeta("d1", "penny", "signals", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T2"
        assert ttl == 7

    def test_outcomes_is_t2_30d(self):
        d = DrawerMeta("d1", "penny", "outcomes", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T2"
        assert ttl == 30

    def test_skills_is_t3_permanent(self):
        d = DrawerMeta("d1", "penny", "skills", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T3"
        assert ttl == -1

    def test_unknown_defaults_to_t4_90d(self):
        d = DrawerMeta("d1", "penny", "unknown_room", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T4"
        assert ttl == 90


class TestShouldArchive:
    def test_signal_older_than_7_days(self):
        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        d = DrawerMeta("d1", "penny", "signals", old)
        should, reason = should_archive(d)
        assert should is True
        assert "7" in reason

    def test_signal_younger_than_7_days(self):
        recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        d = DrawerMeta("d1", "penny", "signals", recent)
        should, reason = should_archive(d)
        assert should is False
        assert "T2" in reason

    def test_permanent_never_archives(self):
        old = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        d = DrawerMeta("d1", "penny", "skills", old)
        should, reason = should_archive(d)
        assert should is False
        assert "permanent" in reason

    def test_outcome_at_exactly_30_days(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        ts = (now - timedelta(days=30)).isoformat()
        d = DrawerMeta("d1", "penny", "outcomes", ts)
        # At exactly 30 days, should NOT archive (30d <= 30d TTL)
        should, _ = should_archive(d, now=now)
        assert should is False

    def test_outcome_at_31_days(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        ts = (now - timedelta(days=31)).isoformat()
        d = DrawerMeta("d1", "penny", "outcomes", ts)
        should, _ = should_archive(d, now=now)
        assert should is True


class TestSweepForArchival:
    def test_mixed_drawers(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("s1", "penny", "signals", (now - timedelta(days=10)).isoformat()),
            DrawerMeta("o1", "penny", "outcomes", (now - timedelta(days=25)).isoformat()),
            DrawerMeta("sk1", "penny", "skills", (now - timedelta(days=100)).isoformat()),
            DrawerMeta("d1", "penny", "diary", (now - timedelta(days=80)).isoformat()),
            DrawerMeta("uk1", "penny", "unknown", (now - timedelta(days=95)).isoformat()),
        ]
        result = sweep_for_archival(drawers, now=now)
        assert len(result["archive"]) == 2  # signals (10d > 7d) + unknown (95d > 90d)
        assert len(result["keep"]) == 3   # outcomes (25d <= 30d) + skills (permanent) + diary (80d <= 90d)
        assert len(result["unknown"]) == 0

    def test_empty_drawer_list(self):
        result = sweep_for_archival([])
        assert result == {"keep": [], "archive": [], "unknown": []}


class TestWeeklyReport:
    def test_produces_markdown(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("s1", "penny", "signals", (now - timedelta(days=10)).isoformat()),
            DrawerMeta("sk1", "penny", "skills", (now - timedelta(days=100)).isoformat()),
        ]
        report = weekly_archival_report(drawers, now=now)
        assert "# Weekly Archival Report" in report
        assert "**Archive:** 1 drawers" in report
        assert "**Keep:** 1 drawers" in report
        assert "signal" in report.lower() or "s1" in report


class TestMainCLI:
    def test_cli_no_expired_drawers(self, tmp_path):
        import subprocess
        import sys

        venv_site = tmp_path / "scripts" / "system" / "bridge"
        venv_site.mkdir(parents=True)
        bridge = venv_site / "memory_bridge.py"
        bridge.write_text("""
def tool_list_drawers(_params):
    from datetime import datetime, timezone, timedelta
    recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    return {
        "drawers": [
            {"id": "d1", "wing": "penny", "room": "signals", "timestamp": recent, "content": "x"},
        ]
    }

def tool_delete_drawer(params):
    return {"success": True}

def tool_add_drawer(params):
    return {"success": True}
""")

        archiver = Path(__file__).parent.parent / "archiver.py"
        result = subprocess.run(
            [sys.executable, str(archiver)],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            env={"PI_MEMORY_BRIDGE": str(bridge)},
        )

        assert result.returncode == 0, result.stderr
        assert "# Weekly Archival Report" in result.stdout
        assert "No expired drawers to archive." in result.stdout

    def test_cli_with_pi_memory_bridge_env(self, tmp_path):
        import subprocess
        import sys

        venv_site = tmp_path / "scripts" / "system" / "bridge"
        venv_site.mkdir(parents=True)
        bridge = venv_site / "memory_bridge.py"
        bridge.write_text("""
def tool_list_drawers(_params):
    from datetime import datetime, timezone, timedelta
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    return {
        "drawers": [
            {"id": "d1", "wing": "penny", "room": "signals", "timestamp": old, "content": "x"},
            {"id": "d2", "wing": "penny", "room": "skills", "timestamp": old, "content": "y"},
        ]
    }

def tool_delete_drawer(params):
    return {"success": True, "deleted": params["drawer_id"]}

def tool_add_drawer(params):
    return {"success": True}
""")

        archiver = Path(__file__).parent.parent / "archiver.py"
        result = subprocess.run(
            [sys.executable, str(archiver)],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            env={"PI_MEMORY_BRIDGE": str(bridge)},
        )

        assert result.returncode == 0, result.stderr
        assert "# Weekly Archival Report" in result.stdout
        assert "Archiving 1 expired drawers" in result.stdout
        assert "Deleted: 1, Archived: 0, Failed: 0" in result.stdout
