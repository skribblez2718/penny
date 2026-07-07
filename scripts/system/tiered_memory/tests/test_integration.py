import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from tiered_memory import (  # noqa: E402
    archive_drawers,
    sweep_for_archival,
    weekly_archival_report,
    DrawerMeta,
)


class TestArchiveOperation:
    def test_delete_only(self):
        deleted_ids = []

        def deleter(drawer_id):
            deleted_ids.append(drawer_id)
            return True

        drawers = [
            DrawerMeta(
                "s1",
                "penny",
                "signals",
                (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(),
            ),
            DrawerMeta(
                "s2",
                "penny",
                "signals",
                (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(),
            ),
        ]

        stats = archive_drawers(drawers, deleter=deleter)
        assert stats["deleted"] == 2
        assert stats["archived"] == 0
        assert stats["failed"] == 0
        assert set(deleted_ids) == {"s1", "s2"}

    def test_delete_with_archiver(self):
        archived_drawers = []

        def archiver(drawer):
            archived_drawers.append(drawer)
            return f"archive_{drawer.drawer_id}"

        deleted_ids = []

        def deleter(drawer_id):
            deleted_ids.append(drawer_id)
            return True

        drawers = [
            DrawerMeta(
                "o1",
                "penny",
                "outcomes",
                (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(),
            )
        ]

        stats = archive_drawers(drawers, deleter=deleter, archiver=archiver)
        assert stats["deleted"] == 1
        assert stats["archived"] == 1
        assert len(archived_drawers) == 1
        assert archived_drawers[0].drawer_id == "o1"

    def test_delete_failure(self):
        def deleter(drawer_id):
            return False  # simulate backend failure

        drawers = [
            DrawerMeta(
                "x1",
                "penny",
                "signals",
                (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(),
            )
        ]
        stats = archive_drawers(drawers, deleter=deleter)
        assert stats["deleted"] == 0
        assert stats["failed"] == 1


class TestSweepArchival:
    def test_full_lifecycle(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("s1", "penny", "signals", (now - timedelta(days=10)).isoformat()),
            DrawerMeta("s2", "penny", "signals", (now - timedelta(days=5)).isoformat()),
            DrawerMeta("o1", "penny", "outcomes", (now - timedelta(days=31)).isoformat()),
        ]

        # First, sweep to identify what to archive
        sweep = sweep_for_archival(drawers, now=now)
        assert len(sweep["archive"]) == 2  # s1 + o1
        assert len(sweep["keep"]) == 1  # s2

        # Then archive them
        deleted_ids = []

        def deleter(drawer_id):
            deleted_ids.append(drawer_id)
            return True

        stats = archive_drawers(sweep["archive"], deleter=deleter)
        assert stats["deleted"] == 2
        assert set(deleted_ids) == {"s1", "o1"}

        # Verify report
        report = weekly_archival_report(drawers, now=now)
        assert "2 drawers" in report or "Archive: 2" in report
