import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memory.admin_client import AdminCallResult  # noqa: E402
from memory.common import atomic_write_json  # noqa: E402
from memory.hub_config import HubConfig  # noqa: E402
from tiered_memory import (  # noqa: E402
    DrawerMeta,
    age_days,
    apply_retention_manifest,
    build_retention_manifest,
    classify_drawer,
    should_archive,
    sweep_for_archival,
    weekly_archival_report,
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
    def test_audit_is_t2_30d(self):
        d = DrawerMeta("d1", "penny", "audit", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T2"
        assert ttl == 30

    def test_diary_is_t2_90d(self):
        d = DrawerMeta("d1", "penny", "diary", "2026-04-01T00:00:00Z")
        tier, ttl = classify_drawer(d)
        assert tier == "T2"
        assert ttl == 90

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
        for room in (
            "plan-1782417115437-findings",
            "plan-1782321357342-cve-validate-CVE-2025-4690",
        ):
            d = DrawerMeta("d1", "wing_jsa", room, "2026-04-01T00:00:00Z")
            tier, ttl = classify_drawer(d)
            assert tier == "T2", room
            assert ttl == 30, room

    def test_jsa_e2e_scratch_is_t2_30d(self):
        d = DrawerMeta(
            "d1", "wing_jsa", "jsa-gj-2026-06-09-e2e-01-sast-validated", "2026-04-01T00:00:00Z"
        )
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
    def test_diary_older_than_90_days(self):
        old = (datetime.now(timezone.utc) - timedelta(days=91)).isoformat()
        d = DrawerMeta("d1", "penny", "diary", old)
        should, reason = should_archive(d)
        assert should is True
        assert "90" in reason

    def test_diary_younger_than_90_days(self):
        recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        d = DrawerMeta("d1", "penny", "diary", recent)
        should, reason = should_archive(d)
        assert should is False
        assert "T2" in reason

    def test_permanent_never_archives(self):
        old = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        d = DrawerMeta("d1", "penny", "skills", old)
        should, reason = should_archive(d)
        assert should is False
        assert "permanent" in reason

    def test_audit_at_exactly_30_days(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        ts = (now - timedelta(days=30)).isoformat()
        d = DrawerMeta("d1", "penny", "audit", ts)
        # At exactly 30 days, should NOT archive (30d <= 30d TTL)
        should, _ = should_archive(d, now=now)
        assert should is False

    def test_audit_at_31_days(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        ts = (now - timedelta(days=31)).isoformat()
        d = DrawerMeta("d1", "penny", "audit", ts)
        should, _ = should_archive(d, now=now)
        assert should is True


class TestSweepForArchival:
    def test_mixed_drawers(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("a1", "penny", "audit", (now - timedelta(days=31)).isoformat()),
            DrawerMeta("a2", "penny", "audit", (now - timedelta(days=25)).isoformat()),
            DrawerMeta("sk1", "penny", "skills", (now - timedelta(days=100)).isoformat()),
            DrawerMeta("d1", "penny", "diary", (now - timedelta(days=80)).isoformat()),
            DrawerMeta("uk1", "penny", "unknown", (now - timedelta(days=95)).isoformat()),
        ]
        result = sweep_for_archival(drawers, now=now)
        # unknown room is now kept-by-default (decay is opt-in per room).
        assert len(result["archive"]) == 1  # audit (31d > 30d)
        assert len(result["keep"]) == 4  # audit(25d) + skills (permanent) + diary + unknown
        assert len(result["unknown"]) == 0

    def test_undated_drawer_is_unknown(self):
        # A drawer whose filed_at is missing/unparseable must be kept, never
        # silently aged to 0 (the old bug that stopped all archival).
        result = sweep_for_archival([DrawerMeta("x", "penny", "audit", "")])
        assert len(result["unknown"]) == 1
        assert len(result["archive"]) == 0

    def test_recall_extends_ttl(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        ts = (now - timedelta(days=40)).isoformat()  # 40d old audit (base TTL 30d)
        cold = DrawerMeta("c", "penny", "audit", ts, recall_count=0)
        hot = DrawerMeta("h", "penny", "audit", ts, recall_count=3)  # 30*4 = 120d TTL
        assert should_archive(cold, now=now)[0] is True
        assert should_archive(hot, now=now)[0] is False

    def test_empty_drawer_list(self):
        result = sweep_for_archival([])
        assert result == {"keep": [], "archive": [], "unknown": []}


class TestWeeklyReport:
    def test_produces_markdown(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        drawers = [
            DrawerMeta("s1", "penny", "audit", (now - timedelta(days=40)).isoformat()),
            DrawerMeta("sk1", "penny", "skills", (now - timedelta(days=100)).isoformat()),
        ]
        report = weekly_archival_report(drawers, now=now)
        assert "# Weekly Archival Report" in report
        assert "**Archive:** 1 drawers" in report
        assert "**Keep:** 1 drawers" in report
        assert "audit" in report.lower() or "s1" in report


def _hub_config(tmp_path: Path) -> HubConfig:
    roots = {
        name: tmp_path / name
        for name in ("palace", "archive", "runtime", "logs", "home", "config", "cache", "state")
    }
    for path in roots.values():
        path.mkdir()
    roots["kg"] = roots["palace"] / "knowledge_graph.sqlite3"
    roots["logstream"] = roots["palace"] / "logstream.sqlite3"
    return HubConfig(
        config_path=tmp_path / "hub.json",
        endpoint="http://127.0.0.1:8766",
        host="127.0.0.1",
        port=8766,
        palace_id="synthetic-palace",
        backend="chroma",
        python_executable=Path(sys.executable),
        token_file=tmp_path / "token",
        data_roots=roots,
        health_timeout_seconds=1.0,
        stop_timeout_seconds=1.0,
        config_sha256="a" * 64,
    )


class _FakeAdminClient:
    def __init__(self, drawers):
        self.drawers = drawers
        self.deleted = []

    def call_tool(self, tool, arguments=None):
        if tool == "mempalace_list_drawers":
            offset = (arguments or {}).get("offset", 0)
            batch = self.drawers if offset == 0 else []
            payload = {"drawers": batch, "total": len(self.drawers)}
            return AdminCallResult("list-request", payload)
        if tool == "mempalace_get_drawer":
            drawer_id = arguments["drawer_id"]
            payload = next(
                drawer
                for drawer in self.drawers
                if drawer.get("drawer_id", drawer.get("id")) == drawer_id
            )
            return AdminCallResult("get-request", payload)
        assert tool == "mempalace_delete_drawer"
        self.deleted.append(arguments["drawer_id"])
        return AdminCallResult("delete-request", {"success": True})


class TestRetentionManifest:
    def test_apply_requires_reviewed_manifest_and_writes_journal(self, tmp_path):
        config = _hub_config(tmp_path)
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        old = (now - timedelta(days=31)).isoformat()
        drawers = [DrawerMeta("d1", "penny", "audit", old, content="recoverable")]
        manifest_path = tmp_path / "retention.json"
        atomic_write_json(
            manifest_path,
            build_retention_manifest(drawers, config, now=now),
        )
        client = _FakeAdminClient(
            [
                {
                    "drawer_id": "d1",
                    "wing": "penny",
                    "room": "audit",
                    "filed_at": old,
                    "content": "recoverable",
                }
            ]
        )
        journal = tmp_path / "operation.jsonl"

        stats = apply_retention_manifest(manifest_path, journal, config, client)

        assert stats == {"archived": 1, "deleted": 1, "failed": 0, "stale": 0}
        assert client.deleted == ["d1"]
        events = [
            __import__("json").loads(line)["event"] for line in journal.read_text().splitlines()
        ]
        assert events == [
            "apply-started",
            "cold-archived",
            "delete-requested",
            "delete-result",
            "apply-finished",
        ]
        archives = list(config.data_roots["archive"].rglob("*.jsonl"))
        assert len(archives) == 1
        assert "recoverable" in archives[0].read_text()

    def test_stale_content_is_never_deleted(self, tmp_path):
        config = _hub_config(tmp_path)
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        old = (now - timedelta(days=31)).isoformat()
        manifest_path = tmp_path / "retention.json"
        atomic_write_json(
            manifest_path,
            build_retention_manifest(
                [DrawerMeta("d1", "penny", "audit", old, content="reviewed")],
                config,
                now=now,
            ),
        )
        client = _FakeAdminClient(
            [
                {
                    "drawer_id": "d1",
                    "wing": "penny",
                    "room": "audit",
                    "filed_at": old,
                    "content": "changed after review",
                }
            ]
        )

        stats = apply_retention_manifest(
            manifest_path,
            tmp_path / "operation.jsonl",
            config,
            client,
        )

        assert stats == {"archived": 0, "deleted": 0, "failed": 1, "stale": 1}
        assert client.deleted == []
