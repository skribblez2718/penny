"""End-to-end test for observability server pipeline.

Validates:
- Server health endpoint
- WebSocket log ingestion (event: "log")
- REST API: GET /logs with filters
- REST API: GET /logs/stats
- REST API: GET /sessions
- REST API: GET /sessions/{id}/entries
- REST API: GET /admin/stats
"""

import asyncio
import json
import time
import urllib.request

import pytest
import websockets

REST_BASE = "http://localhost:8765"
WS_URL = "ws://localhost:8765/ws"


@pytest.fixture(scope="module")
def server_url():
    """Return the REST base URL."""
    return REST_BASE


@pytest.mark.asyncio
async def test_server_health():
    """GET /health returns healthy status with counts."""
    req = urllib.request.Request(f"{REST_BASE}/health")
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    assert data["status"] == "healthy"
    assert isinstance(data["session_count"], int)
    assert isinstance(data["entry_count"], int)
    assert isinstance(data["log_count"], int)


@pytest.mark.asyncio
async def test_websocket_log_ingestion():
    """Sending event: 'log' over WebSocket inserts into logs table."""
    session_id = f"e2e-{int(time.time() * 1000)}"
    async with websockets.connect(WS_URL) as ws:
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
    req = urllib.request.Request(
        f"{REST_BASE}/logs?component=e2e_test&level=ERROR&limit=10"
    )
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    assert data["total"] >= 1
    found = any(
        item["event"] == "E2E test: bridge timeout" for item in data["items"]
    )
    assert found


@pytest.mark.asyncio
async def test_logs_endpoint_filtering():
    """GET /logs supports level and component filters."""
    # We know there are server logs from health checks
    req = urllib.request.Request(f"{REST_BASE}/logs?component=server&limit=1")
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    assert data["total"] >= 1
    assert data["items"][0]["component"] == "server"


@pytest.mark.asyncio
async def test_logs_stats_endpoint():
    """GET /logs/stats returns aggregated counts."""
    req = urllib.request.Request(f"{REST_BASE}/logs/stats")
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    assert isinstance(data["total"], int)
    assert isinstance(data["by_level"], list)
    assert isinstance(data["by_component"], list)
    assert isinstance(data["oldest_timestamp"], int) or data["oldest_timestamp"] is None


@pytest.mark.asyncio
async def test_sessions_endpoint():
    """GET /sessions returns paginated session list."""
    req = urllib.request.Request(f"{REST_BASE}/sessions?limit=5")
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    assert "items" in data
    assert "total" in data
    assert data["total"] >= 0


@pytest.mark.asyncio
async def test_session_entries_endpoint():
    """GET /sessions/{id}/entries returns entries for a session."""
    # First get a session ID
    req = urllib.request.Request(f"{REST_BASE}/sessions?limit=1")
    resp = urllib.request.urlopen(req)
    sessions = json.loads(resp.read())

    if sessions["items"]:
        sid = sessions["items"][0]["id"]
        req = urllib.request.Request(f"{REST_BASE}/sessions/{sid}/entries?limit=3")
        resp = urllib.request.urlopen(req)
        entries = json.loads(resp.read())
        assert "items" in entries
        assert isinstance(entries["items"], list)


@pytest.mark.asyncio
async def test_admin_stats_endpoint():
    """GET /admin/stats returns detailed server statistics."""
    req = urllib.request.Request(f"{REST_BASE}/admin/stats")
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    assert "db_size_mb" in data
    assert "session_count" in data
    assert "entry_count" in data
    assert "log_count" in data
    assert "retention_raw_days" in data
    assert "retention_log_days" in data
