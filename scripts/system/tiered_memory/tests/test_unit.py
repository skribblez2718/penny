import json
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

    def test_unknown_defaults_to_keep(self):
        # Unclassified rooms are kept by default (ttl < 0). Decay is opt-in per
        # room, so a new/mislabelled room can never be silently mass-archived.
        d = DrawerMeta("d1", "penny", "unknown_room", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T4"
        assert ttl == -1

    def test_session_scratch_prefix_is_t2_30d(self):
        d = DrawerMeta("d1", "penny", "plan-1780944624108-sast", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T2"
        assert ttl == 30

    def test_jsa_wing_session_scratch_is_t2_30d(self):
        # The 77%-accretion fix: dedicated-wing per-session scratch now decays.
        for room in ("plan-1782417115437-findings", "plan-1782321357342-cve-validate-CVE-2025-4690"):
            d = DrawerMeta("d1", "wing_jsa", room, "2026-04-01T00:00:00Z")
            tier, ttl = classify_drawer(d)
            assert tier == "T2", room
            assert ttl == 30, room

    def test_jsa_e2e_scratch_is_t2_30d(self):
        d = DrawerMeta("d1", "wing_jsa", "jsa-gj-2026-06-09-e2e-01-sast-validated", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T2"
        assert ttl == 30

    def test_jsa_curated_rooms_are_permanent(self):
        # Curated cross-session knowledge survives the scratch sweep (exact T3
        # match wins over the wing prefix).
        for room in ("jsa-learnings", "bug_bounty_methodology", "vulnerability_research"):
            d = DrawerMeta("d1", "wing_jsa", room, "2020-01-01T00:00:00Z")
            tier, ttl = classify_drawer(d)
            assert tier == "T3", room
            assert ttl == -1, room

    def test_sca_wing_scratch_decays_but_learnings_kept(self):
        scratch = DrawerMeta("d1", "wing_sca", "charter-abc", "2026-04-01T00:00:00Z")
        assert classify_drawer(scratch) == ("T2", 30)
        learnings = DrawerMeta("d2", "wing_sca", "sca-learnings", "2020-01-01T00:00:00Z")
        assert classify_drawer(learnings) == ("T3", -1)


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


class TestAmendmentArchival:
    """Status-aware archival for penny/system_amendments (fixes the keep-forever
    accumulation of resolved amendments)."""

    NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)

    def _days_ago(self, n):
        return (self.NOW - timedelta(days=n)).isoformat()

    def _amendment(self, did, status, applied_date="", reviewed_date="", filed="2026-01-01T00:00:00Z"):
        body = {"amendment_id": did, "status": status}
        if applied_date:
            body["applied_date"] = applied_date
        if reviewed_date:
            body["reviewed_date"] = reviewed_date
        content = f"amendment_id: {did}\n" + json.dumps(body, indent=2)
        return DrawerMeta(did, "penny", "system_amendments", filed, content=content)

    def test_pending_kept_even_when_ancient(self):
        d = self._amendment("a1", "PENDING", filed=self._days_ago(400))
        should, reason = should_archive(d, self.NOW)
        assert should is False and "PENDING" in reason

    def test_approved_kept(self):
        d = self._amendment("a1", "APPROVED", reviewed_date=self._days_ago(400))
        assert should_archive(d, self.NOW)[0] is False

    def test_applied_within_efficacy_window_kept(self):
        d = self._amendment("a1", "APPLIED", applied_date=self._days_ago(30))
        should, reason = should_archive(d, self.NOW)
        assert should is False and "efficacy window" in reason

    def test_applied_past_efficacy_window_archived(self):
        d = self._amendment("a1", "APPLIED", applied_date=self._days_ago(90))
        should, reason = should_archive(d, self.NOW)
        assert should is True and "efficacy window" in reason

    def test_applied_undated_kept(self):
        d = self._amendment("a1", "APPLIED")  # no applied_date
        assert should_archive(d, self.NOW)[0] is False

    def test_rejected_within_grace_kept(self):
        d = self._amendment("a1", "REJECTED", reviewed_date=self._days_ago(5))
        assert should_archive(d, self.NOW)[0] is False

    def test_rejected_past_grace_archived(self):
        d = self._amendment("a1", "REJECTED", reviewed_date=self._days_ago(30))
        should, reason = should_archive(d, self.NOW)
        assert should is True and "grace" in reason

    def test_unparseable_amendment_kept(self):
        d = DrawerMeta("a1", "penny", "system_amendments", "2026-01-01T00:00:00Z", content="not json")
        assert should_archive(d, self.NOW)[0] is False

    def test_sweep_routes_amendments_past_the_keep_forever_shortcircuit(self):
        # The whole point: an APPLIED-past-window amendment must be archived even
        # though the room classifies as permanent (T4/-1) — the old default that
        # let resolved amendments accumulate forever.
        old_applied = self._amendment("a1", "APPLIED", applied_date=self._days_ago(90))
        pending = self._amendment("a2", "PENDING")
        sweep = sweep_for_archival([old_applied, pending], self.NOW)
        assert {d.drawer_id for d in sweep["archive"]} == {"a1"}
        assert "a2" in {d.drawer_id for d in sweep["keep"]}


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
        # unknown room is now kept-by-default (decay is opt-in per room).
        assert len(result["archive"]) == 1  # signals (10d > 7d)
        assert len(result["keep"]) == 4  # outcomes + skills (permanent) + diary + unknown
        assert len(result["unknown"]) == 0

    def test_undated_drawer_is_unknown(self):
        # A drawer whose filed_at is missing/unparseable must be kept, never
        # silently aged to 0 (the old bug that stopped all archival).
        result = sweep_for_archival([DrawerMeta("x", "penny", "signals", "")])
        assert len(result["unknown"]) == 1
        assert len(result["archive"]) == 0

    def test_recall_extends_ttl(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        ts = (now - timedelta(days=20)).isoformat()  # 20d old signals (base TTL 7d)
        cold = DrawerMeta("c", "penny", "signals", ts, recall_count=0)
        hot = DrawerMeta("h", "penny", "signals", ts, recall_count=3)  # 7*4 = 28d TTL
        assert should_archive(cold, now=now)[0] is True
        assert should_archive(hot, now=now)[0] is False

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
def tool_list_drawers(params):
    from datetime import datetime, timezone, timedelta
    if params.get("offset", 0):
        return {"drawers": []}
    recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    return {
        "drawers": [
            {"id": "d1", "wing": "penny", "room": "signals", "filed_at": recent, "content": "x"},
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
def tool_list_drawers(params):
    from datetime import datetime, timezone, timedelta
    if params.get("offset", 0):
        return {"drawers": []}
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    return {
        "drawers": [
            {"id": "d1", "wing": "penny", "room": "signals", "filed_at": old, "content": "x"},
            {"id": "d2", "wing": "penny", "room": "skills", "filed_at": old, "content": "y"},
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
            env={"PI_MEMORY_BRIDGE": str(bridge), "MEMPALACE_PATH": str(tmp_path / ".mempalace")},
        )

        assert result.returncode == 0, result.stderr
        assert "# Weekly Archival Report" in result.stdout
        assert "Archiving 1 expired drawers" in result.stdout
        # Expired drawers are now written to T4 cold storage before deletion.
        assert "Deleted: 1, Archived: 1, Failed: 0" in result.stdout
