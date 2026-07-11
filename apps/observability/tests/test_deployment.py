"""Deployment/infra assertions for size-based rotation (C15, C16, C17).

These are repo-file checks, expressed as binary test assertions:
  * C15 — `make docker-up` includes `--restart unless-stopped`.
  * C16 — init-observability.sh installs no cleanup timer/service, and the
          systemd unit files are deleted.
  * C17 — .env.example documents the cap + floor and drops the retention-day vars.
"""

from pathlib import Path

PENNY_ROOT = Path(__file__).resolve().parents[3]

# Frozen HTTP route contract (C14: no route added/removed/changed). Handler
# bodies for /admin/cleanup and /admin/stats changed, but the route table did not.
_EXPECTED_HTTP_ROUTES = {
    (frozenset({"GET"}), "/admin/stats"),
    (frozenset({"GET"}), "/health"),
    (frozenset({"GET"}), "/logs"),
    (frozenset({"GET"}), "/logs/stats"),
    (frozenset({"GET"}), "/logs/{log_id}"),
    (frozenset({"GET"}), "/orchestration/runs"),
    (frozenset({"GET"}), "/orchestration/runs/{run_id}"),
    (frozenset({"GET"}), "/orchestration/runs/{run_id}/events"),
    (frozenset({"GET"}), "/sessions"),
    (frozenset({"GET"}), "/sessions/{session_id}"),
    (frozenset({"GET"}), "/sessions/{session_id}/compactions"),
    (frozenset({"GET"}), "/sessions/{session_id}/compactions/{compaction_seq}"),
    (frozenset({"GET"}), "/sessions/{session_id}/entries"),
    (frozenset({"GET"}), "/sessions/{session_id}/orchestration"),
    (frozenset({"GET"}), "/sessions/{session_id}/search"),
    (frozenset({"GET"}), "/watcher_logs"),
    (frozenset({"GET"}), "/watcher_logs/stats"),
    (frozenset({"GET"}), "/watcher_logs/{log_id}"),
    (frozenset({"POST"}), "/admin/cleanup"),
    (frozenset({"POST"}), "/compactions"),
    (frozenset({"POST"}), "/logs"),
    (frozenset({"POST"}), "/orchestration/events"),
    (frozenset({"POST"}), "/orchestration/runs"),
    (frozenset({"POST"}), "/watcher_logs"),
}


def test_c14_http_routes_unchanged():
    """C14: the business HTTP route table is unchanged (no add/remove/change)."""
    from observability.main import app

    actual = {
        (frozenset(r.methods), r.path)
        for r in app.routes
        if hasattr(r, "methods") and not r.path.startswith(("/docs", "/redoc", "/openapi"))
    }
    assert actual == _EXPECTED_HTTP_ROUTES


def test_c14_websocket_route_present():
    """C14: the /ws ingestion route is still registered."""
    from observability.main import app

    assert any(getattr(r, "path", None) == "/ws" for r in app.routes)


def test_c14_no_new_schema_migration():
    """C14: schema version is unchanged at 5 (no migration introduced)."""
    from observability.db import SCHEMA_VERSION

    assert SCHEMA_VERSION == 5


def test_c15_docker_up_has_restart_policy():
    """C15: the docker-up target adds --restart unless-stopped."""
    makefile = (PENNY_ROOT / "Makefile").read_text()
    body = makefile.split("docker-up:", 1)[1].split("docker-down:", 1)[0]
    assert "--restart unless-stopped" in body


def test_c16_systemd_unit_files_are_deleted():
    """C16: the cleanup .service/.timer unit files no longer exist."""
    unit_dir = PENNY_ROOT / "scripts" / "system" / "observability"
    assert not (unit_dir / "penny-observability-cleanup.service").exists()
    assert not (unit_dir / "penny-observability-cleanup.timer").exists()
    # cleanup_db.py is retained as the optional manual CLI.
    assert (unit_dir / "cleanup_db.py").exists()


def test_c16_init_script_installs_no_cleanup_timer():
    """C16: init-observability.sh no longer installs the systemd timer/service."""
    script = (PENNY_ROOT / "scripts" / "setup" / "init-observability.sh").read_text()
    assert "penny-observability-cleanup.timer" not in script
    assert "penny-observability-cleanup.service" not in script
    assert "systemctl --user enable" not in script


def test_c17_env_example_documents_cap_and_floor():
    """C17: .env.example documents cap + floor and drops retention-day vars."""
    env_example = (PENNY_ROOT / ".env.example").read_text()
    assert "PI_OBSERVABILITY_DB_SIZE_MAX_GB" in env_example
    assert "PI_OBSERVABILITY_DB_SIZE_FLOOR_GB" in env_example
    assert "PI_OBSERVABILITY_RETENTION_RAW_DAYS" not in env_example
    assert "PI_OBSERVABILITY_RETENTION_LOG_DAYS" not in env_example
    assert "PI_OBSERVABILITY_RETENTION_WATCHER_LOG_DAYS" not in env_example
    assert "PI_OBSERVABILITY_RETENTION_COMPACTION_DAYS" not in env_example
