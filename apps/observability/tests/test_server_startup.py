"""Server-startup integration tests (mandatory for the FastAPI server).

These boot the REAL uvicorn server in a background thread against a temporary
SQLite DB (the only "heavy dep" here) and exercise it over real HTTP. They catch
issues unit tests with TestClient cannot: lifespan startup hooks (DB connect +
scheduler start), the entry-point import chain, and the full REST happy path.

Categories covered (per resources/server-startup-tests.md):
  1. Real server, real HTTP (health + business endpoints).
  2. Entry-point script from its own directory (import chain).
  4. End-to-end happy path through the live server.

Category 3 (CORS preflight) is intentionally absent: this server configures no
CORS middleware (its clients are the Node observability extension and server-side
callers, not browsers). ``test_no_cors_middleware_configured`` documents/guards
that so the omission is deliberate, not an accident.
"""

import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import urllib.request
import urllib.error
import json

PROJECT_SRC = Path(__file__).resolve().parents[1] / "src"
PACKAGE_DIR = PROJECT_SRC / "observability"
TEST_HOST = "127.0.0.1"
TEST_PORT = 18771
BASE_URL = f"http://{TEST_HOST}:{TEST_PORT}"

pytestmark = pytest.mark.integration


def _post(path: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def _get(path: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    """Boot the real uvicorn server in a background thread on a temp DB."""
    import uvicorn

    from observability.config import Config

    data_dir = tmp_path_factory.mktemp("obs_startup")
    # Point the server at an isolated DB and disable auth for the test.
    Config.DATA_DIR = Path(data_dir)
    Config.DB_PATH = Path(data_dir) / "observability.db"
    Config.API_KEY = ""

    from observability.main import app

    config = uvicorn.Config(
        app=app,
        host=TEST_HOST,
        port=TEST_PORT,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((TEST_HOST, TEST_PORT), timeout=0.2):
                status, _ = _get("/health")
                if status == 200:
                    break
        except OSError:
            pass
        time.sleep(0.2)
    else:
        server.should_exit = True
        thread.join(timeout=5)
        raise RuntimeError("observability server did not start within 15s")

    yield BASE_URL

    server.should_exit = True
    thread.join(timeout=5)


# ---------------------------------------------------------------------------
# Category 1 — real server, real HTTP
# ---------------------------------------------------------------------------


def test_health_endpoint_live(live_server):
    """/health responds 200 with size stats from the live server."""
    status, data = _get("/health")
    assert status == 200
    assert data["status"] == "healthy"
    # Rotation stats are surfaced by the running server (proves get_stats path).
    assert "live_bytes" in data
    assert "file_bytes" in data


def test_admin_stats_exposes_rotation_config_live(live_server):
    """/admin/stats exposes the cap + floor (not the retired retention days)."""
    status, data = _get("/admin/stats")
    assert status == 200
    assert "db_size_max_gb" in data
    assert "db_size_floor_gb" in data
    assert "retention_raw_days" not in data


# ---------------------------------------------------------------------------
# Category 2 — entry-point script from its own directory
# ---------------------------------------------------------------------------


def test_entrypoint_import_chain_from_package_dir():
    """`python -m observability` / the console script import chain must resolve
    even when cwd is the package's own directory (the classic sibling-import bug)."""
    driver = (
        "import sys; "
        f"sys.path.insert(0, {str(PROJECT_SRC)!r}); "
        "from observability.main import app, main; "
        "from observability.__main__ import main as pkg_main; "
        "assert app is not None and callable(main) and callable(pkg_main); "
        "print('OK')"
    )
    env = dict(os.environ)
    env["PYTHONPATH"] = str(PROJECT_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-c", driver],
        capture_output=True,
        text=True,
        cwd=str(PACKAGE_DIR),
        timeout=30,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


# ---------------------------------------------------------------------------
# Category 3 — CORS is intentionally not configured (documented guard)
# ---------------------------------------------------------------------------


def test_no_cors_middleware_configured():
    """This server ships no CORS middleware (no browser clients). Guard the
    intentional omission so a future accidental add is a conscious decision."""
    from starlette.middleware.cors import CORSMiddleware

    from observability.main import app

    assert not any(m.cls is CORSMiddleware for m in app.user_middleware)


# ---------------------------------------------------------------------------
# Category 4 — end-to-end happy path through the live server
# ---------------------------------------------------------------------------


def test_full_orchestration_flow_live(live_server):
    """Create a run, post an event, read them back through the running server."""
    run_id = f"startup-run-{int(time.time() * 1000)}"
    session_id = "startup-session"

    status, _ = _post(
        "/orchestration/runs",
        {"run_id": run_id, "session_id": session_id, "status": "running"},
    )
    assert status == 200

    status, body = _post(
        "/orchestration/events",
        {
            "events": [
                {
                    "run_id": run_id,
                    "session_id": session_id,
                    "seq": 0,
                    "event_type": "state_enter",
                }
            ]
        },
    )
    assert status == 200
    assert body["count"] == 1

    status, run = _get(f"/orchestration/runs/{run_id}")
    assert status == 200
    assert run["run_id"] == run_id

    status, events = _get(f"/orchestration/runs/{run_id}/events")
    assert status == 200
    assert events["total"] == 1


def test_admin_cleanup_runs_rotation_live(live_server):
    """POST /admin/cleanup triggers the rotation routine (no error, returns ok)."""
    status, data = _post("/admin/cleanup", {})
    assert status == 200
    assert data["status"] == "ok"
    # Under cap on a fresh temp DB -> rotation is a no-op.
    assert data["triggered"] is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
