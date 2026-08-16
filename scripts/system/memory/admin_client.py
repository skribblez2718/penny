"""Authenticated, bounded HTTP JSON-RPC client for MemPalace administration.

This is the only normal online access path for Python audit, evaluation, and
retention callers.  It deliberately has no local-library, subprocess, or raw
store fallback.
"""

from __future__ import annotations

import json
import socket
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, NoReturn, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .hub_config import HubConfig, load_hub_config, read_token

DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


class AdminClientError(RuntimeError):
    """Base class for typed memory-hub client failures."""

    def __init__(self, message: str, *, request_id: str | None = None) -> None:
        super().__init__(message)
        self.request_id = request_id


class AdminTimeoutError(AdminClientError):
    """The hub did not respond within the configured timeout."""


class AdminAuthenticationError(AdminClientError):
    """The hub rejected the bearer credential."""


class AdminTransportError(AdminClientError):
    """The HTTP hub could not be reached or returned an unavailable status."""


class AdminProtocolError(AdminClientError):
    """The hub returned malformed or mismatched JSON-RPC/MCP data."""


class AdminRpcError(AdminClientError):
    """The hub returned a well-formed JSON-RPC error."""

    def __init__(self, code: int, message: str, *, request_id: str) -> None:
        super().__init__(message, request_id=request_id)
        self.code = code


class AdminOperationError(AdminClientError):
    """A tool returned a structured application-level error payload."""


@dataclass(frozen=True)
class AdminCallResult:
    """One authenticated tool result with its transport request identity."""

    request_id: str
    payload: dict[str, Any]


Opener = Callable[..., Any]


def _object(value: object, field: str, request_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdminProtocolError(f"{field} must be a JSON object", request_id=request_id)
    return cast(dict[str, Any], value)


def _raise_http_error(status: int, request_id: str, cause: Exception | None = None) -> NoReturn:
    if status in {401, 403}:
        error: AdminClientError = AdminAuthenticationError(
            "memory hub rejected the bearer credential", request_id=request_id
        )
    else:
        error = AdminTransportError(f"memory hub returned HTTP {status}", request_id=request_id)
    if cause is None:
        raise error
    raise error from cause


def _validate_http_response(status: int, content_type: str, raw: bytes, request_id: str) -> None:
    if status != 200:
        _raise_http_error(status, request_id)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise AdminProtocolError(
            "memory hub response exceeds its hard bound", request_id=request_id
        )
    if not content_type.startswith("application/json"):
        raise AdminProtocolError(
            "memory hub returned an unexpected content type", request_id=request_id
        )


def _parse_rpc_error(value: object, request_id: str) -> NoReturn:
    error = _object(value, "JSON-RPC error", request_id)
    code = error.get("code")
    message = error.get("message")
    if not isinstance(code, int) or isinstance(code, bool) or not isinstance(message, str):
        raise AdminProtocolError(
            "memory hub returned a malformed JSON-RPC error", request_id=request_id
        )
    raise AdminRpcError(code, message, request_id=request_id)


def _parse_tool_result(value: object, request_id: str) -> dict[str, Any]:
    result = _object(value, "JSON-RPC result", request_id)
    is_error = result.get("isError", False)
    if not isinstance(is_error, bool):
        raise AdminProtocolError(
            "memory hub returned an invalid MCP isError flag", request_id=request_id
        )
    content = result.get("content")
    if not isinstance(content, list) or len(content) != 1:
        raise AdminProtocolError(
            "memory hub returned a malformed MCP tool result", request_id=request_id
        )
    part = _object(content[0], "MCP content part", request_id)
    if part.get("type") != "text" or not isinstance(part.get("text"), str):
        raise AdminProtocolError(
            "memory hub returned a non-text MCP tool result", request_id=request_id
        )
    try:
        payload: object = json.loads(cast(str, part["text"]))
    except json.JSONDecodeError as exc:
        raise AdminProtocolError(
            "memory hub returned malformed tool JSON", request_id=request_id
        ) from exc
    parsed = _object(payload, "tool payload", request_id)
    if is_error:
        # MCP tool errors travel in an HTTP-200/JSON-RPC success envelope. Never
        # normalize fields from that payload as an acknowledged operation. Keep
        # the surfaced message content-free; the request ID is enough to
        # correlate private hub logs.
        raise AdminOperationError(
            "memory hub tool reported an operation error", request_id=request_id
        )
    success = parsed.get("success")
    if success is not None and not isinstance(success, bool):
        raise AdminProtocolError(
            "memory hub returned an invalid operation success flag", request_id=request_id
        )
    if success is False:
        raise AdminOperationError("memory hub operation reported failure", request_id=request_id)
    if isinstance(parsed.get("error"), str):
        raise AdminOperationError(cast(str, parsed["error"]), request_id=request_id)
    return parsed


class MemoryAdminClient:
    """Call MemPalace MCP tools through one authenticated HTTP hub."""

    def __init__(
        self,
        *,
        endpoint: str,
        bearer_token: str,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        opener: Opener = urlopen,
        request_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if not endpoint.startswith(("http://", "https://")):
            raise ValueError("endpoint must be an absolute HTTP(S) URL")
        if not bearer_token or "\n" in bearer_token or "\r" in bearer_token:
            raise ValueError("bearer_token must be non-empty and line-free")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.endpoint = endpoint.rstrip("/") + "/mcp"
        self._bearer_token = bearer_token
        self.timeout_seconds = timeout_seconds
        self._opener = opener
        self._request_id_factory = request_id_factory or (
            lambda: f"penny-memory-admin-{uuid.uuid4()}"
        )

    @classmethod
    def from_config(
        cls,
        config_path: Path,
        *,
        timeout_seconds: float | None = None,
        opener: Opener = urlopen,
        request_id_factory: Callable[[], str] | None = None,
    ) -> "MemoryAdminClient":
        """Build a client from one strict caller-supplied hub config."""

        config = load_hub_config(config_path)
        return cls.from_hub_config(
            config,
            timeout_seconds=timeout_seconds,
            opener=opener,
            request_id_factory=request_id_factory,
        )

    @classmethod
    def from_hub_config(
        cls,
        config: HubConfig,
        *,
        timeout_seconds: float | None = None,
        opener: Opener = urlopen,
        request_id_factory: Callable[[], str] | None = None,
    ) -> "MemoryAdminClient":
        """Build a client from an already validated hub configuration."""

        return cls(
            endpoint=config.endpoint,
            bearer_token=read_token(config),
            timeout_seconds=(
                timeout_seconds if timeout_seconds is not None else DEFAULT_TIMEOUT_SECONDS
            ),
            opener=opener,
            request_id_factory=request_id_factory,
        )

    def call_tool(
        self, tool: str, arguments: Mapping[str, object] | None = None
    ) -> AdminCallResult:
        """Call one MCP tool and return its decoded JSON object payload.

        Writes are attempted exactly once.  This client performs no retries and
        has no alternate transport or local-store fallback, so callers retain
        explicit control over operation journaling and idempotency.
        """

        if not tool or not isinstance(tool, str):
            raise ValueError("tool must be a non-empty string")
        request_id = self._request_id_factory()
        envelope = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": tool, "arguments": dict(arguments or {})},
        }
        body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
        if len(body) > MAX_REQUEST_BYTES:
            raise AdminProtocolError(
                "memory admin request exceeds its hard bound", request_id=request_id
            )
        request = Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._bearer_token}",
                "Content-Type": "application/json",
                "User-Agent": "penny-memory-admin/1",
            },
        )

        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
                status = int(response.status)
                content_type = response.headers.get("Content-Type", "").lower()
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            _raise_http_error(exc.code, request_id, exc)
        except (TimeoutError, socket.timeout) as exc:
            raise AdminTimeoutError("memory hub request timed out", request_id=request_id) from exc
        except URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise AdminTimeoutError(
                    "memory hub request timed out", request_id=request_id
                ) from exc
            raise AdminTransportError("memory hub is unavailable", request_id=request_id) from exc
        except OSError as exc:
            raise AdminTransportError("memory hub is unavailable", request_id=request_id) from exc

        _validate_http_response(status, content_type, raw, request_id)
        return AdminCallResult(request_id=request_id, payload=self._parse(raw, request_id))

    @staticmethod
    def _parse(raw: bytes, request_id: str) -> dict[str, Any]:
        try:
            decoded: object = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdminProtocolError(
                "memory hub returned malformed JSON", request_id=request_id
            ) from exc
        envelope = _object(decoded, "JSON-RPC envelope", request_id)
        if envelope.get("jsonrpc") != "2.0" or envelope.get("id") != request_id:
            raise AdminProtocolError(
                "memory hub returned a mismatched JSON-RPC envelope", request_id=request_id
            )
        if "error" in envelope:
            _parse_rpc_error(envelope["error"], request_id)
        return _parse_tool_result(envelope.get("result"), request_id)
