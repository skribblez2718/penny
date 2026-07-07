"""Tests for orchestration.obs_client — best-effort, fail-silent emission."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from orchestration import obs_client as obs_mod
from orchestration.context import RunContext
from orchestration.obs_client import ObsClient, reset_circuit_breaker


@pytest.fixture(autouse=True)
def _reset_breaker():
    reset_circuit_breaker()
    yield
    reset_circuit_breaker()


def _ctx() -> RunContext:
    return RunContext(session_id="s1", run_id="r1", playbook="reference-cycle", goal="prove it")


# --- Base URL resolution (the ws:// regression) -----------------------------


class TestResolveBaseUrl:
    """PI_OBSERVABILITY_URL is the WebSocket URL; REST must come from
    PI_OBSERVABILITY_REST_URL. Reading the ws:// value made every POST die on
    'unknown url type: ws' and permanently tripped the circuit breaker."""

    def test_rest_url_preferred(self, monkeypatch):
        monkeypatch.setenv("PI_OBSERVABILITY_REST_URL", "http://rest:1111")
        monkeypatch.setenv("PI_OBSERVABILITY_URL", "ws://ws:2222/ws")
        assert ObsClient().base_url == "http://rest:1111"

    def test_ws_scheme_never_used(self, monkeypatch):
        monkeypatch.delenv("PI_OBSERVABILITY_REST_URL", raising=False)
        monkeypatch.setenv("PI_OBSERVABILITY_URL", "ws://localhost:8765/ws")
        assert ObsClient().base_url == obs_mod._DEFAULT_URL

    def test_legacy_http_url_accepted_as_fallback(self, monkeypatch):
        monkeypatch.delenv("PI_OBSERVABILITY_REST_URL", raising=False)
        monkeypatch.setenv("PI_OBSERVABILITY_URL", "http://legacy:8765")
        assert ObsClient().base_url == "http://legacy:8765"

    def test_explicit_ws_arg_rejected(self, monkeypatch):
        monkeypatch.delenv("PI_OBSERVABILITY_REST_URL", raising=False)
        monkeypatch.delenv("PI_OBSERVABILITY_URL", raising=False)
        assert ObsClient(base_url="ws://nope/ws").base_url == obs_mod._DEFAULT_URL

    def test_trailing_slash_stripped(self, monkeypatch):
        monkeypatch.setenv("PI_OBSERVABILITY_REST_URL", "http://rest:1111/")
        assert ObsClient().base_url == "http://rest:1111"


# --- Fail-silent (no server) ----------------------------------------------


def test_emission_never_raises_when_server_down():
    # Port 1 is reserved/closed -> connection refused (fast, no timeout wait).
    client = ObsClient(base_url="http://localhost:1")
    ctx = _ctx()
    # None of these may raise, even though nothing is listening.
    client.run_start(ctx)
    client.step_start(ctx, "FRAME", "annie", "framing")
    client.step_end(ctx, "FRAME", {"verdict": "PASS", "gaps_count": 0}, "CERTAIN")
    client.transition(ctx, "framing", "planning", "frame_done")
    client.escalation(ctx, "ambiguous", questions_count=1)
    client.run_end(ctx, "complete", True, 1)
    # No assertion on delivery — the contract is "never raises / never blocks".


def test_step_end_none_digest_never_raises():
    # A None digest must not raise (fail-silent invariant), even server-down.
    client = ObsClient(base_url="http://localhost:1")
    client.step_end(_ctx(), "ACT", None, "PROBABLE")


def test_circuit_breaker_trips_after_first_failure():
    client = ObsClient(base_url="http://localhost:1")
    ctx = _ctx()
    assert obs_mod._CIRCUIT_OPEN is False
    client.run_start(ctx)
    assert obs_mod._CIRCUIT_OPEN is True  # tripped, subsequent posts are no-ops


# --- Happy path against a tiny in-process stub -----------------------------


class _Collector(BaseHTTPRequestHandler):
    posts: list[tuple[str, dict]] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        type(self).posts.append((self.path, body))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, *args):  # silence
        pass


@pytest.fixture
def stub_server():
    _Collector.posts = []
    server = HTTPServer(("localhost", 0), _Collector)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield f"http://{host}:{port}", _Collector
    server.shutdown()


def test_run_start_posts_run_and_event(stub_server):
    base_url, collector = stub_server
    client = ObsClient(base_url=base_url, api_key="")
    ctx = _ctx()
    client.run_start(ctx)
    paths = [p for p, _ in collector.posts]
    assert "/orchestration/runs" in paths
    assert "/orchestration/events" in paths
    # The run digest carries playbook + goal + running status.
    run_body = next(b for p, b in collector.posts if p == "/orchestration/runs")
    assert run_body["playbook"] == "reference-cycle"
    assert run_body["status"] == "running"


def test_seq_is_monotonic_across_events(stub_server):
    base_url, collector = stub_server
    client = ObsClient(base_url=base_url, api_key="")
    ctx = _ctx()
    client.run_start(ctx)  # seq 1
    client.step_start(ctx, "FRAME", "annie", "framing")  # seq 2
    client.step_end(ctx, "FRAME", {}, "CERTAIN")  # seq 3
    seqs = [b["events"][0]["seq"] for p, b in collector.posts if p == "/orchestration/events"]
    assert seqs == [1, 2, 3]
    assert ctx.last_seq == 3  # persisted on the context, survives subprocess boundary


def test_step_end_digest_includes_verdict_and_gaps(stub_server):
    base_url, collector = stub_server
    client = ObsClient(base_url=base_url)
    ctx = _ctx()
    client.step_end(ctx, "VERIFY", {"verdict": "FAIL", "gaps_count": 2}, "PROBABLE")
    ev = next(b["events"][0] for p, b in collector.posts if p == "/orchestration/events")
    assert ev["event_type"] == "step_end"
    assert ev["data"]["verdict"] == "FAIL"
    assert ev["data"]["gaps_count"] == 2
    assert ev["data"]["confidence"] == "PROBABLE"


def test_auth_header_sent_when_api_key_set(stub_server):
    base_url, collector = stub_server

    captured = {}

    class _AuthCollector(_Collector):
        def do_POST(self):  # noqa: N802
            captured["auth"] = self.headers.get("Authorization")
            super().do_POST()

    # Re-point the running server's handler is awkward; instead just verify the
    # Request carries the header by inspecting a fresh client's behavior via a
    # dedicated server.
    import threading as _t
    from http.server import HTTPServer as _H

    srv = _H(("localhost", 0), _AuthCollector)
    _t.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        host, port = srv.server_address
        client = ObsClient(base_url=f"http://{host}:{port}", api_key="secret-42")
        client.run_start(_ctx())
        assert captured.get("auth") == "Bearer secret-42"
    finally:
        srv.shutdown()
