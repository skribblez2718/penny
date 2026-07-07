"""Integration tests for FastAPI auth layer (Phase 5)."""

from pathlib import Path


import pytest
from fastapi.testclient import TestClient

import observability.main as main_module
from observability.config import Config
from observability.db import Database


@pytest.fixture(autouse=True)
def reset_db():
    """Replace the global db with an in-memory instance before each test."""
    old_db = main_module.db
    db = Database(db_path=Path(":memory:"))
    # We can't call await db.connect() in a sync fixture, so we
    # rely on the lifespan manager to connect the DB.
    main_module.db = db
    yield
    main_module.db = old_db


@pytest.fixture
def client_with_auth_disabled(monkeypatch):
    """FastAPI TestClient with auth disabled."""
    monkeypatch.setattr(Config, "API_KEY", "")
    monkeypatch.setattr(Config, "DB_PATH", Path(":memory:"))
    monkeypatch.setattr(Config, "DATA_DIR", Path("/tmp") / "test_obs")
    from observability.main import app

    # lifespan=on triggers the startup/shutdown events
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def client_with_auth_enabled(monkeypatch):
    """FastAPI TestClient with auth enabled (API_KEY set)."""
    monkeypatch.setattr(Config, "API_KEY", "secret-test-key-42")
    monkeypatch.setattr(Config, "DB_PATH", Path(":memory:"))
    monkeypatch.setattr(Config, "DATA_DIR", Path("/tmp") / "test_obs")
    from observability.main import app

    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


# ---------------------------------------------------------------------------
# Auth disabled (backward compatibility)
# ---------------------------------------------------------------------------


def test_health_open_without_auth(client_with_auth_disabled):
    resp = client_with_auth_disabled.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


def test_sessions_open_without_auth(client_with_auth_disabled):
    resp = client_with_auth_disabled.get("/sessions")
    assert resp.status_code == 200
    assert "items" in resp.json()


def test_admin_cleanup_open_without_auth(client_with_auth_disabled):
    resp = client_with_auth_disabled.post("/admin/cleanup")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# Auth enabled
# ---------------------------------------------------------------------------


def test_health_still_open_with_auth(client_with_auth_enabled):
    """/health must remain unauthenticated for health-check probes."""
    resp = client_with_auth_enabled.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


def test_sessions_rejected_without_token(client_with_auth_enabled):
    resp = client_with_auth_enabled.get("/sessions")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Missing Authorization header"


def test_sessions_accepted_with_valid_bearer(client_with_auth_enabled):
    resp = client_with_auth_enabled.get(
        "/sessions",
        headers={"Authorization": "Bearer secret-test-key-42"},
    )
    assert resp.status_code == 200
    assert "items" in resp.json()


def test_sessions_rejected_with_invalid_bearer(client_with_auth_enabled):
    resp = client_with_auth_enabled.get(
        "/sessions",
        headers={"Authorization": "Bearer wrong-key"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid token"


def test_entries_rejected_without_token(client_with_auth_enabled):
    resp = client_with_auth_enabled.get("/sessions/ignored/entries")
    assert resp.status_code == 401


def test_entries_accepted_with_valid_bearer(client_with_auth_enabled):
    resp = client_with_auth_enabled.get(
        "/sessions/ignored/entries",
        headers={"Authorization": "Bearer secret-test-key-42"},
    )
    assert resp.status_code == 200


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
