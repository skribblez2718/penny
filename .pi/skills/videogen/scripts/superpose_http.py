#!/usr/bin/env python3
"""Typed, stdlib-only HTTP adapter for the frozen Superpose operations.

The client performs one request per public operation, refuses redirects, and
returns network/protocol failures in a uniform ``ServiceResult`` envelope.
Only local argument and constructor errors raise ``SuperposeClientError``.
"""

from __future__ import annotations

import http.client
import json
import math
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

JSONScalar: TypeAlias = None | bool | int | float | str
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
SuperposeOperation: TypeAlias = Literal[
    "health",
    "primitive_schema",
    "themes",
    "import_bundle",
    "validate_project",
    "render_project",
    "project_jobs",
    "video_file",
    "video_captions",
]


class ServiceResult(TypedDict):
    ok: bool
    status: int
    operation: str
    url: str
    data: NotRequired[JSONValue | bytes]
    error: NotRequired[str]
    elapsed_ms: int


class SuperposeClientError(ValueError):
    """A local constructor or operation argument is invalid."""


# OPEN (skill spec §15: service constants). Changes require a spec/test update.
SUPERPOSE_REQUEST_TIMEOUT_SECONDS: float = 30.0
SUPERPOSE_DOWNLOAD_TIMEOUT_SECONDS: float = 120.0
SUPERPOSE_POLL_INTERVAL_SECONDS: float = 2.0
SUPERPOSE_POLL_TIMEOUT_SECONDS: float = 900.0
SUPERPOSE_MAX_RETRIES: int = 0
SUPERPOSE_RETRY_BACKOFF_SECONDS: float = 0.0
SUPERPOSE_SUBMIT_CONCURRENCY: int = 1

_SERVER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Make urllib surface every redirect as an HTTPError without following it."""

    def redirect_request(
        self,
        req: Any,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


def _success(
    *, status: int, operation: str, url: str, data: JSONValue | bytes, started: float
) -> ServiceResult:
    return {
        "ok": True,
        "status": status,
        "operation": operation,
        "url": url,
        "data": data,
        "elapsed_ms": _elapsed_ms(started),
    }


def _failure(*, status: int, operation: str, url: str, error: str, started: float) -> ServiceResult:
    return {
        "ok": False,
        "status": status,
        "operation": operation,
        "url": url,
        "error": error,
        "elapsed_ms": _elapsed_ms(started),
    }


def _normalize_base_url(value: str, *, error_type: type[ValueError]) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise error_type("base_url must be a nonempty URL without surrounding whitespace")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise error_type("base_url contains a control character")
    try:
        parsed = urllib.parse.urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise error_type(f"base_url is invalid: {exc}") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise error_type("base_url must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise error_type("base_url must not contain credentials")
    if parsed.query or parsed.fragment:
        raise error_type("base_url must not contain a query or fragment")
    if parsed.hostname is None:
        raise error_type("base_url must include a host")
    return value.rstrip("/")


def _validate_timeout(value: float, *, error_type: type[ValueError]) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise error_type("timeout_seconds must be a positive finite number")
    timeout = float(value)
    if not math.isfinite(timeout) or timeout <= 0:
        raise error_type("timeout_seconds must be a positive finite number")
    return timeout


def _validate_positive_id(value: int, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SuperposeClientError(f"{field} must be a positive non-bool integer")
    return value


def _validate_server_id(value: str, *, field: str, error_type: type[ValueError]) -> str:
    if not isinstance(value, str) or _SERVER_ID_RE.fullmatch(value) is None:
        raise error_type(f"{field} must match {_SERVER_ID_RE.pattern}")
    return value


def _read_http_error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        body = exc.read(500)
    except Exception:  # noqa: BLE001 - error detail is intentionally best effort
        return ""
    return body.decode("utf-8", "replace").strip()


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError(f"nonstandard JSON constant {value}")


class _ServiceHTTPClient:
    """Internal one-shot urllib transport shared with the Voice Studio client."""

    def __init__(
        self,
        base_url: str,
        *,
        opener: Any | None,
        error_type: type[ValueError],
    ) -> None:
        self.base_url = _normalize_base_url(base_url, error_type=error_type)
        if opener is not None and not callable(getattr(opener, "open", None)):
            raise error_type("opener must expose a callable open(request, timeout=...) method")
        self._opener = opener if opener is not None else urllib.request.build_opener(_NoRedirect)
        self._error_type = error_type

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            raise self._error_type("internal request path must start with '/'")
        return f"{self.base_url}{path}"

    def _request(
        self,
        operation: str,
        method: Literal["GET", "POST", "DELETE"],
        path: str,
        *,
        timeout_seconds: float,
        payload: Mapping[str, Any] | None = None,
        response_kind: Literal["json", "bytes", "empty"] = "json",
    ) -> ServiceResult:
        timeout = _validate_timeout(timeout_seconds, error_type=self._error_type)
        url = self._url(path)
        body: bytes | None = None
        headers: dict[str, str] = {"Accept": "application/json"}
        if payload is not None:
            try:
                body = json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":")).encode(
                    "utf-8"
                )
            except (TypeError, ValueError) as exc:
                raise self._error_type(
                    f"{operation} payload is not JSON-serializable: {exc}"
                ) from exc
            headers["Content-Type"] = "application/json"
        if response_kind == "bytes":
            headers["Accept"] = "application/octet-stream"

        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        started = time.monotonic()
        try:
            # Exactly one open() call. There is deliberately no retry loop here.
            with self._opener.open(request, timeout=timeout) as response:
                status = int(response.getcode() or 0)
                if 300 <= status < 400:
                    return _failure(
                        status=status,
                        operation=operation,
                        url=url,
                        error="redirect_refused",
                        started=started,
                    )
                raw = response.read()
                if not 200 <= status < 300:
                    detail = raw.decode("utf-8", "replace").strip()[:500]
                    suffix = f": {detail}" if detail else ""
                    return _failure(
                        status=status,
                        operation=operation,
                        url=url,
                        error=f"http_error:{status}{suffix}",
                        started=started,
                    )
                if response_kind == "bytes":
                    if not raw:
                        return _failure(
                            status=status,
                            operation=operation,
                            url=url,
                            error="malformed_response: empty binary body",
                            started=started,
                        )
                    return _success(
                        status=status,
                        operation=operation,
                        url=url,
                        data=raw,
                        started=started,
                    )
                if response_kind == "empty" and not raw:
                    return _success(
                        status=status,
                        operation=operation,
                        url=url,
                        data=None,
                        started=started,
                    )
                try:
                    decoded = json.loads(
                        raw.decode("utf-8"),
                        parse_constant=_reject_nonstandard_json_constant,
                    )
                except (UnicodeDecodeError, ValueError) as exc:
                    return _failure(
                        status=status,
                        operation=operation,
                        url=url,
                        error=f"malformed_response: invalid JSON ({exc})",
                        started=started,
                    )
                if not isinstance(decoded, (dict, list)):
                    return _failure(
                        status=status,
                        operation=operation,
                        url=url,
                        error="malformed_response: expected JSON object or array",
                        started=started,
                    )
                return _success(
                    status=status,
                    operation=operation,
                    url=url,
                    data=decoded,
                    started=started,
                )
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                error = "redirect_refused"
            else:
                detail = _read_http_error_detail(exc)
                suffix = f": {detail}" if detail else ""
                error = f"http_error:{exc.code}{suffix}"
            return _failure(
                status=int(exc.code),
                operation=operation,
                url=url,
                error=error,
                started=started,
            )
        except (TimeoutError, socket.timeout) as exc:
            return _failure(
                status=0,
                operation=operation,
                url=url,
                error=f"timeout: {exc}",
                started=started,
            )
        except urllib.error.URLError as exc:
            reason = exc.reason
            label = (
                "timeout" if isinstance(reason, (TimeoutError, socket.timeout)) else "network_error"
            )
            return _failure(
                status=0,
                operation=operation,
                url=url,
                error=f"{label}: {reason}",
                started=started,
            )
        except (http.client.HTTPException, OSError) as exc:
            return _failure(
                status=0,
                operation=operation,
                url=url,
                error=f"network_error: {exc}",
                started=started,
            )


class SuperposeClient(_ServiceHTTPClient):
    """Caller-configured adapter for the M1-frozen Superpose API surface."""

    def __init__(self, base_url: str, *, opener: Any | None = None) -> None:
        super().__init__(base_url, opener=opener, error_type=SuperposeClientError)

    def health(
        self, *, timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS
    ) -> ServiceResult:
        return self._request("health", "GET", "/api/health", timeout_seconds=timeout_seconds)

    def primitive_schema(
        self, *, timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS
    ) -> ServiceResult:
        return self._request(
            "primitive_schema",
            "GET",
            "/api/primitives/schema",
            timeout_seconds=timeout_seconds,
        )

    def themes(
        self, *, timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS
    ) -> ServiceResult:
        return self._request("themes", "GET", "/api/themes", timeout_seconds=timeout_seconds)

    def import_bundle(
        self,
        bundle_path: str,
        *,
        timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        if not isinstance(bundle_path, str) or not bundle_path.strip():
            raise SuperposeClientError("bundle_path must be a nonempty string")
        return self._request(
            "import_bundle",
            "POST",
            "/api/bundles/import",
            timeout_seconds=timeout_seconds,
            payload={"path": bundle_path},
        )

    def validate_project(
        self,
        project_id: int,
        *,
        timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_project_id = _validate_positive_id(project_id, field="project_id")
        return self._request(
            "validate_project",
            "POST",
            f"/api/projects/{safe_project_id}/validate",
            timeout_seconds=timeout_seconds,
        )

    def render_project(
        self,
        project_id: int,
        *,
        quality: Literal["draft", "final", "4k"],
        scene_ids: Sequence[str] | None = None,
        assemble: bool = True,
        timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_project_id = _validate_positive_id(project_id, field="project_id")
        if quality not in {"draft", "final", "4k"}:
            raise SuperposeClientError("quality must be one of: draft, final, 4k")
        if not isinstance(assemble, bool):
            raise SuperposeClientError("assemble must be a bool")
        normalized_scene_ids: list[str] | None
        if scene_ids is None:
            normalized_scene_ids = None
        else:
            if isinstance(scene_ids, (str, bytes)) or not isinstance(scene_ids, Sequence):
                raise SuperposeClientError("scene_ids must be a sequence of safe IDs or None")
            normalized_scene_ids = [
                _validate_server_id(
                    scene_id,
                    field=f"scene_ids[{index}]",
                    error_type=SuperposeClientError,
                )
                for index, scene_id in enumerate(scene_ids)
            ]
            if len(set(normalized_scene_ids)) != len(normalized_scene_ids):
                raise SuperposeClientError("scene_ids must not contain duplicates")
        return self._request(
            "render_project",
            "POST",
            f"/api/projects/{safe_project_id}/render",
            timeout_seconds=timeout_seconds,
            payload={
                "quality": quality,
                "scene_ids": normalized_scene_ids,
                "assemble": assemble,
            },
        )

    def project_jobs(
        self,
        project_id: int,
        *,
        limit: int = 100,
        timeout_seconds: float = SUPERPOSE_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_project_id = _validate_positive_id(project_id, field="project_id")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise SuperposeClientError("limit must be a positive non-bool integer")
        query = urllib.parse.urlencode({"limit": limit})
        return self._request(
            "project_jobs",
            "GET",
            f"/api/projects/{safe_project_id}/jobs?{query}",
            timeout_seconds=timeout_seconds,
        )

    def video_file(
        self,
        video_id: int,
        *,
        timeout_seconds: float = SUPERPOSE_DOWNLOAD_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_video_id = _validate_positive_id(video_id, field="video_id")
        return self._request(
            "video_file",
            "GET",
            f"/api/videos/{safe_video_id}/file",
            timeout_seconds=timeout_seconds,
            response_kind="bytes",
        )

    def video_captions(
        self,
        video_id: int,
        *,
        timeout_seconds: float = SUPERPOSE_DOWNLOAD_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_video_id = _validate_positive_id(video_id, field="video_id")
        return self._request(
            "video_captions",
            "GET",
            f"/api/videos/{safe_video_id}/captions",
            timeout_seconds=timeout_seconds,
            response_kind="bytes",
        )
