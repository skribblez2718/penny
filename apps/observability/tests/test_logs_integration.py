"""Integration tests for observability /logs REST endpoints."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from observability.db import Database
from observability.main import app, _safe_insert_log
import observability.main as main_module


@pytest.fixture
def client(tmp_path: Path):
    """Yield a FastAPI TestClient with an in-memory DB."""
    import observability.main as main
    original_db = getattr(main, 'db', None)
    db_path = tmp_path / "test-integration.db"
    main.db = Database(db_path)
    import asyncio
    asyncio.run(main.db.connect())
    yield TestClient(app)
    asyncio.run(main.db.close())
    main.db = original_db


class TestLogsEndpoints:
    """Integration tests for /logs REST endpoints."""

    def test_logs_endpoint_list(self, client: TestClient) -> None:
        """GET /logs returns paginated log entries."""
        import asyncio
        asyncio.run(main_module.db.insert_log("INFO", "server", "hello"))
        response = client.get("/logs")
        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "total" in data
        assert data["total"] == 1
        assert len(data["items"]) == 1
        assert data["items"][0]["level"] == "INFO"
        assert data["items"][0]["component"] == "server"
        assert data["items"][0]["event"] == "hello"

    def test_logs_endpoint_filter_level(self, client: TestClient) -> None:
        """GET /logs?level=ERROR filters correctly."""
        import asyncio
        asyncio.run(main_module.db.insert_log("INFO", "server", "info_evt"))
        asyncio.run(main_module.db.insert_log("ERROR", "server", "err_evt"))
        response = client.get("/logs?level=ERROR")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["event"] == "err_evt"

    def test_logs_endpoint_filter_component(self, client: TestClient) -> None:
        """GET /logs?component=scheduler filters correctly."""
        import asyncio
        asyncio.run(main_module.db.insert_log("INFO", "server", "srv"))
        asyncio.run(main_module.db.insert_log("INFO", "scheduler", "sch"))
        response = client.get("/logs?component=scheduler")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["event"] == "sch"

    def test_logs_endpoint_pagination(self, client: TestClient) -> None:
        """limit and offset query params work."""
        import asyncio
        for i in range(5):
            asyncio.run(main_module.db.insert_log("INFO", "server", f"evt-{i}"))
        response = client.get("/logs?limit=2&offset=0")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 2
        assert data["total"] == 5
        response = client.get("/logs?limit=2&offset=2")
        data = response.json()
        assert len(data["items"]) == 2
        response = client.get("/logs?limit=2&offset=4")
        data = response.json()
        assert len(data["items"]) == 1

    def test_logs_endpoint_stats(self, client: TestClient) -> None:
        """GET /logs/stats returns grouped counts."""
        import asyncio
        asyncio.run(main_module.db.insert_log("INFO", "server", "e1"))
        asyncio.run(main_module.db.insert_log("ERROR", "server", "e2"))
        asyncio.run(main_module.db.insert_log("INFO", "scheduler", "e3"))
        response = client.get("/logs/stats")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 3
        by_level = {r["level"]: r["count"] for r in data["by_level"]}
        assert by_level["INFO"] == 2
        assert by_level["ERROR"] == 1
        by_comp = {r["component"]: r["count"] for r in data["by_component"]}
        assert by_comp["server"] == 2
        assert by_comp["scheduler"] == 1

    def test_admin_cleanup_includes_logs(self, client: TestClient) -> None:
        """POST /admin/cleanup runs size rotation and reports the logs table."""
        response = client.post("/admin/cleanup")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "logs" in data["deleted"]
        assert isinstance(data["deleted"]["logs"], int)

    def test_admin_stats_includes_log_fields(self, client: TestClient) -> None:
        """GET /admin/stats includes log_count and oldest_log_unix."""
        import asyncio
        asyncio.run(main_module.db.insert_log("INFO", "server", "evt"))
        response = client.get("/admin/stats")
        assert response.status_code == 200
        data = response.json()
        assert "log_count" in data
        assert "oldest_log_unix" in data
        assert data["log_count"] >= 1
        # Age retention retired in favour of size rotation.
        assert "db_size_max_gb" in data
        assert "db_size_floor_gb" in data

    def test_safe_insert_log(self, client: TestClient) -> None:
        """_safe_insert_log should not raise even with bad data."""
        _safe_insert_log("INFO", "test", "safe_test", client_id="abc")
        response = client.get("/logs")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        assert any(item["event"] == "safe_test" for item in data["items"])

class TestWatcherLogsEndpoints:
    """Integration tests for /watcher_logs REST endpoints."""

    def test_watcher_logs_post(self, client: TestClient) -> None:
        """POST /watcher_logs ingests a new log entry."""
        response = client.post("/watcher_logs", json={
            "level": "INFO",
            "source": "mismatch_rate_watcher",
            "event": "test_post",
            "session_id": "sess-001",
            "data": {"foo": "bar"},
        })
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert isinstance(data["id"], int)

    def test_watcher_logs_post_missing_source(self, client: TestClient) -> None:
        """POST /watcher_logs requires source and event."""
        response = client.post("/watcher_logs", json={"event": "only_event"})
        assert response.status_code == 422

    def test_watcher_logs_list(self, client: TestClient) -> None:
        """GET /watcher_logs returns paginated entries."""
        import asyncio
        asyncio.run(main_module.db.insert_watcher_log("INFO", "mismatch_rate_watcher", "hello"))
        response = client.get("/watcher_logs")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert len(data["items"]) == 1
        assert data["items"][0]["level"] == "INFO"
        assert data["items"][0]["source"] == "mismatch_rate_watcher"
        assert data["items"][0]["event"] == "hello"

    def test_watcher_logs_filter_level(self, client: TestClient) -> None:
        """GET /watcher_logs?level=ERROR filters correctly."""
        import asyncio
        asyncio.run(main_module.db.insert_watcher_log("INFO", "mismatch_rate_watcher", "info_evt"))
        asyncio.run(main_module.db.insert_watcher_log("ERROR", "mismatch_rate_watcher", "err_evt"))
        response = client.get("/watcher_logs?level=ERROR")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["event"] == "err_evt"

    def test_watcher_logs_filter_source(self, client: TestClient) -> None:
        """GET /watcher_logs?source=confidence_trend_watcher filters correctly."""
        import asyncio
        asyncio.run(main_module.db.insert_watcher_log("INFO", "mismatch_rate_watcher", "srv"))
        asyncio.run(main_module.db.insert_watcher_log("INFO", "confidence_trend_watcher", "sch"))
        response = client.get("/watcher_logs?source=confidence_trend_watcher")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["event"] == "sch"

    def test_watcher_logs_pagination(self, client: TestClient) -> None:
        """limit and offset query params work for watcher logs."""
        import asyncio
        for i in range(5):
            asyncio.run(main_module.db.insert_watcher_log("INFO", "mismatch_rate_watcher", f"evt-{i}"))
        response = client.get("/watcher_logs?limit=2&offset=0")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 2
        assert data["total"] == 5

    def test_watcher_logs_stats(self, client: TestClient) -> None:
        """GET /watcher_logs/stats returns grouped counts."""
        import asyncio
        asyncio.run(main_module.db.insert_watcher_log("INFO", "mismatch_rate_watcher", "e1"))
        asyncio.run(main_module.db.insert_watcher_log("ERROR", "mismatch_rate_watcher", "e2"))
        asyncio.run(main_module.db.insert_watcher_log("INFO", "confidence_trend_watcher", "e3"))
        response = client.get("/watcher_logs/stats")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 3
        by_level = {r["level"]: r["count"] for r in data["by_level"]}
        assert by_level["INFO"] == 2
        assert by_level["ERROR"] == 1
        by_source = {r["source"]: r["count"] for r in data["by_source"]}
        assert by_source["mismatch_rate_watcher"] == 2
        assert by_source["confidence_trend_watcher"] == 1

    def test_admin_cleanup_includes_watcher_logs(self, client: TestClient) -> None:
        """POST /admin/cleanup runs size rotation and reports the watcher_logs table."""
        response = client.post("/admin/cleanup")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "watcher_logs" in data["deleted"]
        assert isinstance(data["deleted"]["watcher_logs"], int)

    def test_admin_stats_includes_watcher_log_fields(self, client: TestClient) -> None:
        """GET /admin/stats includes watcher_log_count and oldest_watcher_log_unix."""
        import asyncio
        asyncio.run(main_module.db.insert_watcher_log("INFO", "mismatch_rate_watcher", "evt"))
        response = client.get("/admin/stats")
        assert response.status_code == 200
        data = response.json()
        assert "watcher_log_count" in data
        assert "oldest_watcher_log_unix" in data
        assert data["watcher_log_count"] >= 1
        assert "db_size_floor_gb" in data
