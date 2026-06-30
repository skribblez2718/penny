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

    def test_weekly_cleanup_of_old_signals_and_outcomes(self):
        now = datetime(2026, 5, 15, tzinfo=timezone.utc)

        # Simulate drawers accumulated over time
        drawers = [
            # Week 1 (May 1) — all expired by May 15
            DrawerMeta("sig_1_001", "penny", "signals", (now - timedelta(days=14)).isoformat()),
            DrawerMeta("out_1_001", "penny", "outcomes", (now - timedelta(days=14)).isoformat()),
            # Week 2 (May 8) — signals expired, outcomes still alive
            DrawerMeta("sig_2_001", "penny", "signals", (now - timedelta(days=7)).isoformat()),
            DrawerMeta("out_2_001", "penny", "outcomes", (now - timedelta(days=7)).isoformat()),
            # Week 3 (May 15) — all alive
            DrawerMeta("sig_3_001", "penny", "signals", (now - timedelta(days=2)).isoformat()),
            DrawerMeta("out_3_001", "penny", "outcomes", (now - timedelta(days=2)).isoformat()),
            # Permanent items — never expire
            DrawerMeta("skill_001", "penny", "skills", (now - timedelta(days=200)).isoformat()),
            DrawerMeta("arch_001", "penny", "architecture", (now - timedelta(days=200)).isoformat()),
        ]

        # Run sweep
        sweep = sweep_for_archival(drawers, now=now)

        # Verify classification
        assert len(sweep["archive"]) == 1  # Only sig_1_001 (14d > 7d TTL)
        assert sweep["archive"][0].drawer_id == "sig_1_001"

        assert len(sweep["keep"]) == 7  # Everything else (including out_1_001 at 14d < 30d)

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
            DrawerMeta("sig_1", "penny", "signals", (now - timedelta(days=2)).isoformat()),
            DrawerMeta("out_1", "penny", "outcomes", (now - timedelta(days=5)).isoformat()),
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
            DrawerMeta("s1", "penny", "signals", (now - timedelta(days=30)).isoformat()),
            DrawerMeta("s2", "penny", "signals", (now - timedelta(days=20)).isoformat()),
            DrawerMeta("o1", "penny", "outcomes", (now - timedelta(days=60)).isoformat()),
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
