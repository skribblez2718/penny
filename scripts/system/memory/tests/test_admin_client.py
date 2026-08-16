from __future__ import annotations

import io
import json
import socket
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError

import pytest

from memory.admin_client import (
    MAX_RESPONSE_BYTES,
    AdminAuthenticationError,
    AdminOperationError,
    AdminProtocolError,
    AdminRpcError,
    AdminTimeoutError,
    AdminTransportError,
    MemoryAdminClient,
)

REQUEST_ID = "synthetic-request-id"
TOKEN = "synthetic-owner-only-token"


class FakeResponse:
    def __init__(
        self,
        payload: bytes,
        *,
        status: int = 200,
        content_type: str = "application/json",
    ) -> None:
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self._payload = payload

    def read(self, amount: int) -> bytes:
        return self._payload[:amount]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def _envelope(payload: object) -> bytes:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": REQUEST_ID,
            "result": {
                "content": [{"type": "text", "text": json.dumps(payload)}],
            },
        }
    ).encode("utf-8")


def _client(opener: Any) -> MemoryAdminClient:
    return MemoryAdminClient(
        endpoint="http://127.0.0.1:8766",
        bearer_token=TOKEN,
        timeout_seconds=0.25,
        opener=opener,
        request_id_factory=lambda: REQUEST_ID,
    )


def test_authenticated_json_rpc_call_has_no_local_fallback() -> None:
    observed: dict[str, object] = {}

    def opener(request: Any, *, timeout: float) -> FakeResponse:
        observed["url"] = request.full_url
        observed["authorization"] = request.get_header("Authorization")
        observed["timeout"] = timeout
        observed["body"] = json.loads(request.data)
        return FakeResponse(_envelope({"drawers": [], "count": 0}))

    result = _client(opener).call_tool("mempalace_list_drawers", {"limit": 20})

    assert result.request_id == REQUEST_ID
    assert result.payload == {"drawers": [], "count": 0}
    assert observed == {
        "url": "http://127.0.0.1:8766/mcp",
        "authorization": f"Bearer {TOKEN}",
        "timeout": 0.25,
        "body": {
            "jsonrpc": "2.0",
            "id": REQUEST_ID,
            "method": "tools/call",
            "params": {"name": "mempalace_list_drawers", "arguments": {"limit": 20}},
        },
    }


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (HTTPError("http://hub", 401, "no", Message(), io.BytesIO()), AdminAuthenticationError),
        (HTTPError("http://hub", 503, "down", Message(), io.BytesIO()), AdminTransportError),
        (URLError(socket.timeout()), AdminTimeoutError),
        (TimeoutError(), AdminTimeoutError),
    ],
)
def test_transport_failures_are_typed(error: Exception, expected: type[Exception]) -> None:
    def opener(*_args: object, **_kwargs: object) -> FakeResponse:
        raise error

    with pytest.raises(expected):
        _client(opener).call_tool("mempalace_status")


def test_rpc_error_is_typed_and_preserves_code() -> None:
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": REQUEST_ID,
            "error": {"code": -32602, "message": "bad arguments"},
        }
    ).encode("utf-8")

    with pytest.raises(AdminRpcError) as caught:
        _client(lambda *_args, **_kwargs: FakeResponse(payload)).call_tool("bad")

    assert caught.value.code == -32602
    assert caught.value.request_id == REQUEST_ID


def test_tool_error_is_typed() -> None:
    with pytest.raises(AdminOperationError, match="No palace found"):
        _client(
            lambda *_args, **_kwargs: FakeResponse(_envelope({"error": "No palace found"}))
        ).call_tool("mempalace_status")


def test_mcp_is_error_cannot_be_normalized_as_a_false_write_acknowledgement() -> None:
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": REQUEST_ID,
            "result": {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {
                                "success": True,
                                "drawer_id": "false-ack",
                                "error": "private upstream detail",
                            }
                        ),
                    }
                ],
            },
        }
    ).encode("utf-8")

    with pytest.raises(AdminOperationError, match="operation error") as caught:
        _client(lambda *_args, **_kwargs: FakeResponse(payload)).call_tool("mempalace_add_drawer")

    assert "false-ack" not in str(caught.value)
    assert "private upstream detail" not in str(caught.value)
    assert caught.value.request_id == REQUEST_ID


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"success": False, "drawer_id": "false-ack"}, AdminOperationError),
        ({"success": "true", "drawer_id": "false-ack"}, AdminProtocolError),
    ],
)
def test_application_success_flags_fail_closed(
    payload: dict[str, object], expected: type[Exception]
) -> None:
    with pytest.raises(expected) as caught:
        _client(lambda *_args, **_kwargs: FakeResponse(_envelope(payload))).call_tool(
            "mempalace_add_drawer"
        )
    assert "false-ack" not in str(caught.value)


def test_non_boolean_mcp_is_error_is_a_protocol_failure() -> None:
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": REQUEST_ID,
            "result": {
                "isError": "false",
                "content": [{"type": "text", "text": json.dumps({"success": True})}],
            },
        }
    ).encode("utf-8")
    with pytest.raises(AdminProtocolError, match="isError"):
        _client(lambda *_args, **_kwargs: FakeResponse(payload)).call_tool("mempalace_status")


@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(b"not-json"),
        FakeResponse(_envelope({}), content_type="text/plain"),
        FakeResponse(b"x" * (MAX_RESPONSE_BYTES + 1)),
        FakeResponse(json.dumps({"jsonrpc": "2.0", "id": "wrong", "result": {}}).encode()),
    ],
)
def test_malformed_or_oversized_results_fail_closed(response: FakeResponse) -> None:
    with pytest.raises(AdminProtocolError):
        _client(lambda *_args, **_kwargs: response).call_tool("mempalace_status")
