"""End-to-end test for observability server pipeline.

Validates:
- Server health endpoint
- WebSocket log ingestion (event: "log")
- REST API: GET /logs with filters
- REST API: GET /logs/stats
- REST API: GET /sessions
- REST API: GET /sessions/{id}/entries
- REST API: GET /admin/stats

NOTE: this suite is non-hermetic — it exercises a REAL server already running at
localhost:8765. Requests are auth-aware: the API key is read from the project
.env (the same source the server uses via python-dotenv), so the suite passes
whether or not auth is enabled. The key is read from the .env FILE rather than
os.environ because the test conftest neutralizes the ambient env var.
"""

import asyncio
import json
import time
import urllib.request
from pathlib import Path

import pytest
import websockets

# Non-hermetic: this suite hits a REAL running server at :8765 (and writes test
# rows into its DB). Marked `integration` so the default `make test` deselects it;
# `make test-integration` runs it.
pytestmark = pytest.mark.integration

REST_BASE = "http://localhost:8765"
WS_URL = "ws://localhost:8765/ws"


def _api_key() -> str:
    """Read PI_OBSERVABILITY_API_KEY from the project .env (authoritative)."""
    env_path = Path(__file__).resolve().parents[3] / ".env"
    try:
        for line in env_path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("PI_OBSERVABILITY_API_KEY="):
                val = stripped.split("=", 1)[1].strip()
                if (val.startswith('"') and val.endswith('"')) or (
                    val.startswith("'") and val.endswith("'")
                ):
                    val = val[1:-1]
                return val
    except OSError:
        pass
    return ""


def _auth_headers() -> dict[str, str]:
    key = _api_key()
    return {"Authorization": f"Bearer {key}"} if key else {}


def _get_json(path: str) -> dict:
    req = urllib.request.Request(f"{REST_BASE}{path}", headers=_auth_headers())
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


@pytest.fixture(scope="module")
def server_url():
    """Return the REST base URL."""
    return REST_BASE


@pytest.mark.asyncio
async def test_server_health():
    """GET /health returns healthy status with counts (open endpoint)."""
    data = _get_json("/health")
    assert data["status"] == "healthy"
    assert isinstance(data["session_count"], int)
    assert isinstance(data["entry_count"], int)
    assert isinstance(data["log_count"], int)


@pytest.mark.asyncio
async def test_websocket_log_ingestion():
    """Sending event: 'log' over WebSocket inserts into logs table."""
    session_id = f"e2e-{int(time.time() * 1000)}"
    async with websockets.connect(WS_URL, additional_headers=_auth_headers()) as ws:
        msg = {
            "event": "log",
            "sessionId": session_id,
            "timestamp": int(time.time() * 1000),
            "data": {
                "level": 3,  # ERROR
                "extension": "e2e_test",
                "message": "E2E test: bridge timeout",
                "context": {"tool": "mempalace_search", "duration_ms": 31000},
                "error": {
                    "name": "Error",
                    "message": "Bridge timeout",
                    "code": "BRIDGE_TIMEOUT",
                },
            },
        }
        await ws.send(json.dumps(msg))
        await asyncio.sleep(0.3)

    # Verify via REST
    await asyncio.sleep(0.2)
    data = _get_json("/logs?component=e2e_test&level=ERROR&limit=10")
    assert data["total"] >= 1
    found = any(
        item["event"] == "E2E test: bridge timeout" for item in data["items"]
    )
    assert found


@pytest.mark.asyncio
async def test_logs_endpoint_filtering():
    """GET /logs supports level and component filters."""
    # We know there are server logs from health checks
    data = _get_json("/logs?component=server&limit=1")
    assert data["total"] >= 1
    assert data["items"][0]["component"] == "server"


@pytest.mark.asyncio
async def test_logs_stats_endpoint():
    """GET /logs/stats returns aggregated counts."""
    data = _get_json("/logs/stats")
    assert isinstance(data["total"], int)
    assert isinstance(data["by_level"], list)
    assert isinstance(data["by_component"], list)
    assert isinstance(data["oldest_timestamp"], int) or data["oldest_timestamp"] is None


@pytest.mark.asyncio
async def test_sessions_endpoint():
    """GET /sessions returns paginated session list."""
    data = _get_json("/sessions?limit=5")
    assert "items" in data
    assert "total" in data
    assert data["total"] >= 0


@pytest.mark.asyncio
async def test_session_entries_endpoint():
    """GET /sessions/{id}/entries returns entries for a session."""
    sessions = _get_json("/sessions?limit=1")
    if sessions["items"]:
        sid = sessions["items"][0]["id"]
        entries = _get_json(f"/sessions/{sid}/entries?limit=3")
        assert "items" in entries
        assert isinstance(entries["items"], list)


@pytest.mark.asyncio
async def test_admin_stats_endpoint():
    """GET /admin/stats returns detailed server statistics."""
    data = _get_json("/admin/stats")
    assert "db_size_mb" in data
    assert "session_count" in data
    assert "entry_count" in data
    assert "log_count" in data
    # Size-based rotation replaces age retention: /admin/stats exposes the cap.
    # (Non-hermetic suite: db_size_mb + db_size_max_gb are present regardless of
    # which server build is live.)
    assert "db_size_mb" in data
    assert "db_size_max_gb" in data
