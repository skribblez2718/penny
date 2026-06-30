"""End-to-end integration test: full observability pipeline.

Simulates the complete flow:
  1. Pi observability extension connects via WebSocket and streams events
  2. Compaction extension POSTs an artifact after compaction
  3. REST endpoints return correct, queryable data
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest
import time
from fastapi.testclient import TestClient

from observability.config import Config


@pytest.fixture
def client(monkeypatch, tmp_path):
    """FastAPI TestClient with in-memory DB and scheduler disabled."""
    db_path = tmp_path / "obs_test.db"
    data_dir = tmp_path / "obs_data"
    monkeypatch.setattr(Config, "API_KEY", "")
    monkeypatch.setattr(Config, "DB_PATH", db_path)
    monkeypatch.setattr(Config, "DATA_DIR", data_dir)

    from observability.main import app

    # Disable APScheduler in tests to avoid background noise
    monkeypatch.setattr("observability.scheduler.start_scheduler", lambda db: None)
    monkeypatch.setattr("observability.scheduler.stop_scheduler", lambda: None)

    with TestClient(app) as client:
        yield client

    # DB closed by lifespan shutdown; no manual cleanup needed


# ---------------------------------------------------------------------------
# 1. Full WebSocket ingestion stream
# ---------------------------------------------------------------------------


def test_websocket_stream_stores_entries(client):
    """Send a realistic event stream over WS and verify REST reads."""
    session_id = "sess-e2e-001"

    with client.websocket_connect("/ws") as ws:
        # 1. session_start
        ws.send_json({
            "event": "session_start",
            "sessionId": session_id,
            "timestamp": 1700000000000,
            "data": {
                "cwd": str(Path(__file__).resolve().parents[4]),
                "model": {"provider": "openai", "model": "gpt-4o"},
            },
        })
        # 2. user message_end
        ws.send_json({
            "event": "message_end",
            "sessionId": session_id,
            "timestamp": 1700000001000,
            "data": {"role": "user", "content": "hello from integration test"},
        })
        # 3. assistant message_end
        ws.send_json({
            "event": "message_end",
            "sessionId": session_id,
            "timestamp": 1700000002000,
            "data": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "The user said hello."},
                    {"type": "text", "text": "Hello! How can I help?"},
                ],
            },
        })
        # 4. tool execution_start
        ws.send_json({
            "event": "tool_execution_start",
            "sessionId": session_id,
            "timestamp": 1700000003000,
            "data": {"toolCallId": "tc-1", "toolName": "read", "args": {"path": "README.md"}},
        })
        # 5. tool_result
        ws.send_json({
            "event": "tool_result",
            "sessionId": session_id,
            "timestamp": 1700000004000,
            "data": {
                "toolCallId": "tc-1",
                "toolName": "read",
                "isError": False,
                "hasContent": True,
            },
        })
        # 6. session_shutdown
        ws.send_json({
            "event": "session_shutdown",
            "sessionId": session_id,
            "timestamp": 1700000009000,
            "data": {"duration": 90000},
        })

        # Allow the server event loop to process queued messages before disconnect
        time.sleep(0.15)

    # --- Verify REST reads ---

    # /sessions should contain our session
    r = client.get("/sessions")
    assert r.status_code == 200
    sess_list = r.json()
    assert any(s["id"] == session_id for s in sess_list["items"])

    # /sessions/{id}
    r = client.get(f"/sessions/{session_id}")
    assert r.status_code == 200
    sess = r.json()
    assert sess["cwd"] == str(Path(__file__).resolve().parents[4])
    assert sess["model_provider"] == "openai"
    assert sess["ended_at"] == 1700000009000

    # /sessions/{id}/entries
    r = client.get(f"/sessions/{session_id}/entries")
    assert r.status_code == 200
    entries = r.json()
    assert entries["total"] == 4  # message_end user, message_end assistant, tool_start, tool_result

    # Check entry_idx ordering
    idxs = [e["entry_idx"] for e in entries["items"]]
    assert idxs == [0, 1, 2, 3]

    # /health reflects the state
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["entry_count"] == 4


# ---------------------------------------------------------------------------
# 2. Compaction artifact round-trip
# ---------------------------------------------------------------------------


def test_compaction_post_and_retrieve(client):
    """POST a compaction artifact and read it back via REST."""
    session_id = "sess-e2e-compact-001"
    artifact = {
        "schema_version": "1.0.0",
        "session_id": session_id,
        "compaction_seq": 0,
        "compaction_timestamp": "2026-05-05T12:00:00Z",
        "goal": "Integration test compaction",
        "constraints": ["Do not lose data"],
        "preferences": [],
        "pending": None,
        "decisions": [],
        "errors": [],
        "agents_invoked": [],
        "orchestrator_state": None,
        "mempalace_rooms": [],
        "kg_entities": [],
        "files": {"read": [], "modified": []},
        "metadata": {
            "eviction_log": [],
            "pi_boundary": {
                "first_kept_entry_id": "fk-1",
                "tokens_before": 15000,
            },
        },
    }

    r = client.post("/compactions", json={
        "session_id": session_id,
        "compaction_seq": 0,
        "compaction_timestamp": "2026-05-05T12:00:00Z",
        "artifact": artifact,
        "first_kept_entry_id": "fk-1",
        "tokens_before": 15000,
    })
    assert r.status_code == 200
    assert r.json()["compaction_seq"] == 0

    # GET /sessions/{id}/compactions
    r = client.get(f"/sessions/{session_id}/compactions")
    assert r.status_code == 200
    compactions = r.json()
    assert compactions["total"] == 1
    assert compactions["items"][0]["artifact"]["goal"] == "Integration test compaction"

    # GET specific compaction
    r = client.get(f"/sessions/{session_id}/compactions/0")
    assert r.status_code == 200
    single = r.json()
    assert single["compaction_seq"] == 0
    assert single["first_kept_entry_id"] == "fk-1"
    assert single["tokens_before"] == 15000


# ---------------------------------------------------------------------------
# 3. Full pipeline: WS events + compaction + search
# ---------------------------------------------------------------------------


def test_full_pipeline_with_search(client):
    """WebSocket events are searchable after ingestion."""
    session_id = "sess-e2e-search-001"

    with client.websocket_connect("/ws") as ws:
        ws.send_json({
            "event": "session_start",
            "sessionId": session_id,
            "timestamp": 1700000000000,
            "data": {"cwd": "/tmp"},
        })
        ws.send_json({
            "event": "message_end",
            "sessionId": session_id,
            "timestamp": 1700000001000,
            "data": {"role": "user", "content": "searchable keyword: elephant"},
        })
        ws.send_json({
            "event": "message_end",
            "sessionId": session_id,
            "timestamp": 1700000002000,
            "data": {"role": "assistant", "content": "I found the giraffe you mentioned"},
        })

        # Allow the server event loop to process queued messages before disconnect
        time.sleep(0.15)

    # Search for "elephant" should return only the user message
    r = client.get(f"/sessions/{session_id}/search?q=elephant")
    assert r.status_code == 200
    results = r.json()
    assert results["query"] == "elephant"
    assert len(results["items"]) == 1
    assert results["items"][0]["data"]["content"] == "searchable keyword: elephant"

    # Search for "giraffe" should return the assistant message
    r = client.get(f"/sessions/{session_id}/search?q=giraffe")
    assert r.status_code == 200
    results = r.json()
    assert len(results["items"]) == 1
    assert results["items"][0]["data"]["content"] == "I found the giraffe you mentioned"


# ---------------------------------------------------------------------------
# 4. Admin / cleanup triggers without error
# ---------------------------------------------------------------------------


def test_admin_endpoints(client):
    """Admin endpoints return correct structure."""
    r = client.post("/admin/cleanup")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    r = client.get("/admin/stats")
    assert r.status_code == 200
    stats = r.json()
    assert "db_size_mb" in stats
    assert "active_connections" in stats
    assert stats["retention_raw_days"] == Config.RETENTION_RAW_DAYS
    assert stats["retention_compaction_days"] == Config.RETENTION_COMPACTION_DAYS




def test_websocket_log_event(client, tmp_path):
    """Sending a 'log' event over WebSocket inserts into the logs table."""
    import observability.main as main_module
    import time
    import asyncio

    session_id = f"log-session-{int(time.time() * 1000)}"
    with client.websocket_connect("/ws") as ws:
        ws.send_json({
            "event": "log",
            "sessionId": session_id,
            "timestamp": int(time.time() * 1000),
            "data": {
                "level": 2,
                "extension": "test",
                "message": "integration log test",
                "context": {"foo": "bar"},
            },
        })
        time.sleep(0.15)

    db = main_module.db
    assert db is not None
    items, total = asyncio.run(db.get_logs(limit=10, offset=0))
    assert total >= 1
    assert any(item["event"] == "integration log test" for item in items)


def test_entries_event_type_filter(client):
    """GET /sessions/{id}/entries?event_type= filters entries correctly via REST."""
    session_id = "sess-filter-001"
    with client.websocket_connect("/ws") as ws:
        ws.send_json({
            "event": "session_start",
            "sessionId": session_id,
            "timestamp": 1700000000000,
            "data": {"cwd": "/tmp"},
        })
        ws.send_json({
            "event": "agent_start",
            "sessionId": session_id,
            "timestamp": 1700000001000,
            "data": {"agent": "echo"},
        })
        ws.send_json({
            "event": "tool_execution_start",
            "sessionId": session_id,
            "timestamp": 1700000002000,
            "data": {"toolName": "read"},
        })
        ws.send_json({
            "event": "agent_start",
            "sessionId": session_id,
            "timestamp": 1700000003000,
            "data": {"agent": "piper"},
        })
        ws.send_json({
            "event": "session_shutdown",
            "sessionId": session_id,
            "timestamp": 1700000009000,
            "data": {"duration": 1000},
        })
        time.sleep(0.15)

    # No filter — should return 4 entries (agent_start, tool_execution_start, agent_start, session_shutdown)
    # Actually session_shutdown is handled by close_session, NOT insert_entry
    # So: session_start auto-creates, agent_start inserts, tool_execution_start inserts, agent_start inserts
    # session_shutdown just closes the session
    r = client.get(f"/sessions/{session_id}/entries")
    assert r.status_code == 200
    all_entries = r.json()
    assert all_entries["total"] == 3

    # Filter by agent_start
    r = client.get(f"/sessions/{session_id}/entries?event_type=agent_start")
    assert r.status_code == 200
    filtered = r.json()
    assert filtered["total"] == 2
    assert all(e["event_type"] == "agent_start" for e in filtered["items"])

    # Filter by tool_execution_start
    r = client.get(f"/sessions/{session_id}/entries?event_type=tool_execution_start")
    assert r.status_code == 200
    filtered = r.json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["data"]["toolName"] == "read"

    # Filter by nonexistent
    r = client.get(f"/sessions/{session_id}/entries?event_type=nonexistent")
    assert r.status_code == 200
    filtered = r.json()
    assert filtered["total"] == 0
    assert filtered["items"] == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
