"""End-to-end: simulate a week's worth of drawers, sweep, archive, report."""

import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from tiered_memory import (  # noqa: E402
    sweep_for_archival,
    archive_drawers,
    weekly_archival_report,
    DrawerMeta,
)


class TestWeeklyArchivalLifecycle:
    """Full lifecycle: populate → sweep → archive → report."""

    def test_weekly_cleanup_of_expired_scratch(self):
        now = datetime(2026, 5, 15, tzinfo=timezone.utc)

        # Simulate drawers accumulated over time
        drawers = [
            # Oldest — audit expired (40d > 30d), diary still alive (40d < 90d)
            DrawerMeta("aud_1_001", "penny", "audit", (now - timedelta(days=40)).isoformat()),
            DrawerMeta("dia_1_001", "penny", "diary", (now - timedelta(days=40)).isoformat()),
            # At the audit TTL boundary — kept (30d <= 30d)
            DrawerMeta("aud_2_001", "penny", "audit", (now - timedelta(days=30)).isoformat()),
            DrawerMeta("dia_2_001", "penny", "diary", (now - timedelta(days=30)).isoformat()),
            # Recent — all alive
            DrawerMeta("aud_3_001", "penny", "audit", (now - timedelta(days=5)).isoformat()),
            DrawerMeta("dia_3_001", "penny", "diary", (now - timedelta(days=5)).isoformat()),
            # Permanent items — never expire
            DrawerMeta("skill_001", "penny", "skills", (now - timedelta(days=200)).isoformat()),
            DrawerMeta(
                "arch_001", "penny", "architecture", (now - timedelta(days=200)).isoformat()
            ),
        ]

        # Run sweep
        sweep = sweep_for_archival(drawers, now=now)

        # Verify classification
        assert len(sweep["archive"]) == 1  # Only aud_1_001 (40d > 30d TTL)
        assert sweep["archive"][0].drawer_id == "aud_1_001"

        assert len(sweep["keep"]) == 7  # Everything else (including dia_1_001 at 40d < 90d)

        assert len(sweep["unknown"]) == 0

        # Archive
        deleted_ids = []
        archived_drawers = []

        def archiver(drawer):
            archived_drawers.append(drawer)
            return f"archived_{drawer.drawer_id}"

        def deleter(drawer_id):
            deleted_ids.append(drawer_id)
            return True

        stats = archive_drawers(sweep["archive"], deleter=deleter, archiver=archiver)
        assert stats["deleted"] == 1
        assert stats["archived"] == 1
        assert stats["failed"] == 0
        assert len(archived_drawers) == 1

        # Generate report
        report = weekly_archival_report(drawers, now=now)
        assert "# Weekly Archival Report" in report
        assert "Archive:** 1" in report
        assert "Keep:** 7" in report

    def test_no_expired_items(self):
        now = datetime(2026, 5, 15, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("aud_1", "penny", "audit", (now - timedelta(days=2)).isoformat()),
            DrawerMeta("dia_1", "penny", "diary", (now - timedelta(days=5)).isoformat()),
        ]

        sweep = sweep_for_archival(drawers, now=now)
        assert len(sweep["archive"]) == 0
        assert len(sweep["keep"]) == 2

        stats = archive_drawers(sweep["archive"], deleter=lambda x: True)
        assert stats["deleted"] == 0
        assert stats["archived"] == 0

    def test_all_items_expired(self):
        now = datetime(2026, 5, 15, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("s1", "penny", "audit", (now - timedelta(days=120)).isoformat()),
            DrawerMeta("s2", "penny", "audit", (now - timedelta(days=90)).isoformat()),
            DrawerMeta("o1", "penny", "diary", (now - timedelta(days=180)).isoformat()),
        ]

        sweep = sweep_for_archival(drawers, now=now)
        assert len(sweep["archive"]) == 3
        assert len(sweep["keep"]) == 0

        deleted = []
        archive_drawers(
            sweep["archive"],
            deleter=lambda d: deleted.append(d) or True,
        )
        assert len(deleted) == 3
