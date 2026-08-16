"""Hermetic HTTP-only fake for MEM-05/MEM-06 tests."""

from __future__ import annotations

import json
import threading
import time
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast


class FakeHubState:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}
        self.operations: dict[str, tuple[str, ...]] = {}
        self.search_results: list[dict[str, Any]] = []
        self.fault: str | None = None
        self.write_calls = 0
        self.read_calls = 0
        self.content_suffix = ""
        self.lock = threading.Lock()

    def apply(self, arguments: dict[str, Any]) -> tuple[str, ...]:
        operation_id = str(arguments["operation_id"])
        with self.lock:
            self.write_calls += 1
            prior = self.operations.get(operation_id)
            if prior is not None:
                return prior
            record_id = f"record-{sha256(operation_id.encode()).hexdigest()[:16]}"
            self.records[record_id] = {
                "id": record_id,
                "content": str(arguments["content"]) + self.content_suffix,
            }
            result = (record_id,)
            self.operations[operation_id] = result
            return result


class _Handler(BaseHTTPRequestHandler):
    server: "_FakeServer"

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        tool = request["params"]["name"]
        arguments = request["params"]["arguments"]
        if tool == "fixture_search":
            payload: dict[str, Any] = {"results": self.server.state.search_results}
        elif tool == "fixture_write":
            ids = self.server.state.apply(arguments)
            fault = self.server.state.fault
            self.server.state.fault = None
            if fault == "disconnect-after-apply":
                self.close_connection = True
                return
            if fault == "timeout-after-apply":
                time.sleep(0.1)
            payload = {"resulting_ids": list(ids)}
        elif tool == "fixture_read":
            with self.server.state.lock:
                self.server.state.read_calls += 1
                payload = {
                    "records": [self.server.state.records[item_id] for item_id in arguments["ids"]]
                }
        else:
            payload = {"error": f"unsupported fake tool: {tool}"}
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"content": [{"type": "text", "text": json.dumps(payload)}]},
            }
        ).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, _format: str, *args: object) -> None:
        return None


class _FakeServer(ThreadingHTTPServer):
    def __init__(self, state: FakeHubState) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.state = state


class FakeHub:
    def __init__(self) -> None:
        self.state = FakeHubState()
        self.server = _FakeServer(self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def endpoint(self) -> str:
        host, port = cast(tuple[str, int], self.server.server_address)
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeHub":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
