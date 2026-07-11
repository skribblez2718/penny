"""Integration tests for the v5 orchestration REST endpoints."""

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import observability.main as main_module
from observability.db import Database


@pytest.fixture
def client(tmp_path: Path):
    original_db = getattr(main_module, "db", None)
    main_module.db = Database(tmp_path / "orch-integration.db")
    asyncio.run(main_module.db.connect())
    yield TestClient(main_module.app)
    asyncio.run(main_module.db.close())
    main_module.db = original_db


def _run_payload(**over):
    base = {"run_id": "r1", "session_id": "s1", "playbook": "reference-cycle", "goal": "prove it"}
    base.update(over)
    return base


def _event(seq, event_type, **over):
    base = {"run_id": "r1", "session_id": "s1", "seq": seq, "event_type": event_type}
    base.update(over)
    return base


class TestOrchestrationRuns:
    def test_create_and_get_run(self, client: TestClient):
        r = client.post("/orchestration/runs", json=_run_payload(status="running"))
        assert r.status_code == 200
        assert r.json()["run_id"] == "r1"

        g = client.get("/orchestration/runs/r1")
        assert g.status_code == 200
        run = g.json()
        assert run["playbook"] == "reference-cycle"
        assert run["status"] == "running"
        assert run["goal"] == "prove it"

    def test_run_upsert_updates_terminal_fields(self, client: TestClient):
        client.post("/orchestration/runs", json=_run_payload(status="running"))
        # run_end update
        client.post(
            "/orchestration/runs",
            json={"run_id": "r1", "session_id": "s1", "status": "complete",
                  "met": True, "iterations": 2, "ended_at": "2026-07-03T00:00:00+00:00"},
        )
        run = client.get("/orchestration/runs/r1").json()
        assert run["status"] == "complete"
        assert run["met"] is True
        assert run["iterations"] == 2
        # playbook/goal preserved via COALESCE
        assert run["playbook"] == "reference-cycle"
        assert run["goal"] == "prove it"

    def test_get_missing_run_404(self, client: TestClient):
        assert client.get("/orchestration/runs/nope").status_code == 404

    def test_list_runs_filter_by_session_and_status(self, client: TestClient):
        client.post("/orchestration/runs", json=_run_payload(run_id="r1", status="running"))
        client.post("/orchestration/runs", json=_run_payload(run_id="r2", session_id="s2", status="complete"))
        all_s1 = client.get("/orchestration/runs?session_id=s1").json()
        assert {r["run_id"] for r in all_s1["items"]} == {"r1"}
        complete = client.get("/orchestration/runs?status=complete").json()
        assert {r["run_id"] for r in complete["items"]} == {"r2"}


class TestOrchestrationEvents:
    def test_post_events_batch_and_get(self, client: TestClient):
        client.post("/orchestration/runs", json=_run_payload(status="running"))
        r = client.post(
            "/orchestration/events",
            json={"events": [
                _event(1, "run_start", data={"playbook": "reference-cycle"}),
                _event(2, "step_start", primitive="FRAME", agent="annie", state_id="framing"),
                _event(3, "step_end", primitive="FRAME", data={"confidence": "CERTAIN"}),
            ]},
        )
        assert r.status_code == 200
        assert r.json()["count"] == 3

        events = client.get("/orchestration/runs/r1/events").json()
        assert events["total"] == 3
        # Ordered by seq.
        assert [e["seq"] for e in events["items"]] == [1, 2, 3]
        assert events["items"][1]["agent"] == "annie"
        assert events["items"][2]["data"]["confidence"] == "CERTAIN"

    def test_post_events_requires_nonempty(self, client: TestClient):
        r = client.post("/orchestration/events", json={"events": []})
        assert r.status_code == 422  # pydantic min_length=1


class TestCorrelationView:
    def test_session_orchestration_view(self, client: TestClient):
        client.post("/orchestration/runs", json=_run_payload(run_id="r1", status="complete"))
        client.post("/orchestration/events", json={"events": [
            _event(1, "run_start"), _event(2, "run_end", data={"met": True}),
        ]})
        view = client.get("/sessions/s1/orchestration").json()
        assert view["session_id"] == "s1"
        assert len(view["runs"]) == 1
        assert view["runs"][0]["run_id"] == "r1"
        assert len(view["runs"][0]["events"]) == 2


class TestOrchestrationCleanup:
    def test_admin_cleanup_includes_orchestration_counts(self, client: TestClient):
        client.post("/orchestration/runs", json=_run_payload(status="complete"))
        client.post("/orchestration/events", json={"events": [_event(1, "run_start")]})
        resp = client.post("/admin/cleanup").json()
        # /admin/cleanup now runs size-based rotation across ALL tables
        # (orchestration included, not exempt). Under cap it's a no-op, but the
        # per-table rotation keys must be present.
        assert resp["status"] == "ok"
        assert "orchestration_runs" in resp["deleted"]
        assert "orchestration_events" in resp["deleted"]
