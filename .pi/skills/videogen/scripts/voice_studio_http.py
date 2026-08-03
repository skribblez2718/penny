#!/usr/bin/env python3
"""Typed, stdlib-only HTTP adapter for the frozen Voice Studio operations."""

from __future__ import annotations

from typing import Any, Literal, TypeAlias

from superpose_http import (
    ServiceResult,
    _ServiceHTTPClient,
    _validate_server_id,
)

VoiceOperation: TypeAlias = Literal[
    "create_narration",
    "list_pronunciation_rules",
    "create_pronunciation_rule",
    "spoken_preview",
    "submit_tts",
    "tts_job",
    "tts_result_wav",
    "delete_narration",
]


class VoiceStudioClientError(ValueError):
    """A local constructor or operation argument is invalid."""


# OPEN (skill spec §15: service polling/timeout/retry/concurrency).
# Changes require a spec/test update.
TTS_REQUEST_TIMEOUT_SECONDS: float = 30.0
TTS_RESULT_TIMEOUT_SECONDS: float = 120.0
TTS_POLL_INTERVAL_SECONDS: float = 2.0
TTS_POLL_TIMEOUT_SECONDS: float = 900.0
TTS_MAX_RETRIES: int = 0
TTS_RETRY_BACKOFF_SECONDS: float = 0.0
TTS_MAX_CONCURRENCY: int = 1

_TERMINAL_TTS_STATUSES = frozenset({"completed", "completed_with_errors", "cancelled"})


def _nonblank(value: str, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise VoiceStudioClientError(f"{field} must be a nonempty string")
    return value


def _safe_id(value: str, *, field: str) -> str:
    return _validate_server_id(value, field=field, error_type=VoiceStudioClientError)


def _failure_from_result(result: ServiceResult, error: str) -> ServiceResult:
    return {
        "ok": False,
        "status": result["status"],
        "operation": result["operation"],
        "url": result["url"],
        "error": error,
        "elapsed_ms": result["elapsed_ms"],
    }


def _job_count(data: dict[str, Any], field: str) -> int | None:
    value = data.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


class VoiceStudioClient(_ServiceHTTPClient):
    """Caller-configured adapter for the M1-frozen Voice Studio API surface."""

    def __init__(self, base_url: str, *, opener: Any | None = None) -> None:
        super().__init__(base_url, opener=opener, error_type=VoiceStudioClientError)

    def create_narration(
        self,
        *,
        title: str,
        source_text: str,
        voice_profile_id: str,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        return self._request(
            "create_narration",
            "POST",
            "/api/narrations",
            timeout_seconds=timeout_seconds,
            payload={
                "title": _nonblank(title, field="title"),
                "source_text": _nonblank(source_text, field="source_text"),
                "voice_profile_id": _nonblank(voice_profile_id, field="voice_profile_id"),
            },
        )

    def list_pronunciation_rules(
        self,
        item_id: str,
        *,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_item_id = _safe_id(item_id, field="item_id")
        return self._request(
            "list_pronunciation_rules",
            "GET",
            f"/api/narrations/{safe_item_id}/pronunciation",
            timeout_seconds=timeout_seconds,
        )

    def create_pronunciation_rule(
        self,
        item_id: str,
        *,
        pattern: str,
        replacement: str,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_item_id = _safe_id(item_id, field="item_id")
        return self._request(
            "create_pronunciation_rule",
            "POST",
            f"/api/narrations/{safe_item_id}/pronunciation",
            timeout_seconds=timeout_seconds,
            payload={
                "pattern": _nonblank(pattern, field="pattern"),
                "replacement": _nonblank(replacement, field="replacement"),
            },
        )

    def spoken_preview(
        self,
        *,
        text: str,
        narration_item_id: str | None,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_item_id = (
            None
            if narration_item_id is None
            else _safe_id(narration_item_id, field="narration_item_id")
        )
        return self._request(
            "spoken_preview",
            "POST",
            "/api/pronunciation/spoken-preview",
            timeout_seconds=timeout_seconds,
            payload={
                "text": _nonblank(text, field="text"),
                "narration_item_id": safe_item_id,
            },
        )

    def submit_tts(
        self,
        *,
        narration_item_id: str,
        voice_profile_id: str,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        return self._request(
            "submit_tts",
            "POST",
            "/api/tts/generate",
            timeout_seconds=timeout_seconds,
            payload={
                "narration_item_id": _safe_id(narration_item_id, field="narration_item_id"),
                "voice_profile_id": _nonblank(voice_profile_id, field="voice_profile_id"),
            },
        )

    def tts_job(
        self,
        job_id: str,
        *,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_job_id = _safe_id(job_id, field="job_id")
        result = self._request(
            "tts_job",
            "GET",
            f"/api/tts/jobs/{safe_job_id}",
            timeout_seconds=timeout_seconds,
        )
        if not result["ok"]:
            return result
        data = result.get("data")
        if not isinstance(data, dict):
            return _failure_from_result(result, "malformed_response: TTS job must be a JSON object")
        status = data.get("status")
        if not isinstance(status, str) or not status:
            return _failure_from_result(
                result, "malformed_response: TTS job status must be a nonempty string"
            )

        if "errored" in data:
            errored = _job_count(data, "errored")
            if errored is None:
                return _failure_from_result(
                    result, "malformed_response: TTS job errored must be a nonnegative integer"
                )
            if errored > 0:
                return _failure_from_result(
                    result,
                    f"tts_scene_failure: status={status}, errored={errored}",
                )

        if status in {"completed_with_errors", "cancelled"}:
            return _failure_from_result(result, f"tts_terminal_failure: status={status}")
        if status == "completed":
            errored = _job_count(data, "errored")
            completed = _job_count(data, "completed")
            total_chunks = _job_count(data, "total_chunks")
            if errored is None or completed is None or total_chunks is None:
                return _failure_from_result(
                    result,
                    "malformed_response: completed TTS job requires nonnegative "
                    "errored/completed/total_chunks counts",
                )
            if total_chunks <= 0 or errored != 0 or completed != total_chunks:
                return _failure_from_result(
                    result,
                    "tts_terminal_failure: completed job has inconsistent chunk counts",
                )
        elif status in _TERMINAL_TTS_STATUSES:
            # Kept as a defensive exhaustiveness guard if the frozen set changes.
            return _failure_from_result(result, f"tts_terminal_failure: status={status}")
        return result

    def tts_result_wav(
        self,
        item_id: str,
        *,
        timeout_seconds: float = TTS_RESULT_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_item_id = _safe_id(item_id, field="item_id")
        return self._request(
            "tts_result_wav",
            "GET",
            f"/api/tts/result/{safe_item_id}.wav",
            timeout_seconds=timeout_seconds,
            response_kind="bytes",
        )

    def delete_narration(
        self,
        item_id: str,
        *,
        timeout_seconds: float = TTS_REQUEST_TIMEOUT_SECONDS,
    ) -> ServiceResult:
        safe_item_id = _safe_id(item_id, field="item_id")
        return self._request(
            "delete_narration",
            "DELETE",
            f"/api/narrations/{safe_item_id}",
            timeout_seconds=timeout_seconds,
            response_kind="empty",
        )
