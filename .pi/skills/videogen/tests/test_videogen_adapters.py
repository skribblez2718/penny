from __future__ import annotations

import io
import json
import os
import socket
import sys
import threading
import time
import wave
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from superpose_http import (  # noqa: E402
    SUPERPOSE_DOWNLOAD_TIMEOUT_SECONDS,
    SUPERPOSE_MAX_RETRIES,
    SuperposeClient,
    SuperposeClientError,
)
from voice_studio_http import (  # noqa: E402
    TTS_MAX_RETRIES,
    TTS_REQUEST_TIMEOUT_SECONDS,
    TTS_RESULT_TIMEOUT_SECONDS,
    VoiceStudioClient,
    VoiceStudioClientError,
)


@dataclass
class FakeHTTPState:
    requests: list[dict[str, Any]] = field(default_factory=list)
    responses: dict[tuple[str, str], tuple[int, dict[str, str], bytes, float]] = field(
        default_factory=dict
    )


class FakeServiceHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _handle(self) -> None:
        state: FakeHTTPState = self.server.state  # type: ignore[attr-defined]
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body.decode("utf-8")) if body else None
        except json.JSONDecodeError:
            payload = "<malformed>"
        state.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "body": body,
                "json": payload,
                "content_type": self.headers.get("Content-Type"),
            }
        )
        configured = state.responses.get((self.command, self.path))
        if configured is None:
            if self.command == "DELETE":
                configured = (204, {}, b"", 0.0)
            elif self.path.endswith("/file"):
                configured = (200, {"Content-Type": "video/mp4"}, b"mp4-bytes", 0.0)
            elif self.path.endswith("/captions"):
                configured = (200, {"Content-Type": "text/vtt"}, b"WEBVTT\n", 0.0)
            elif self.path.endswith(".wav"):
                configured = (200, {"Content-Type": "audio/wav"}, b"wav-bytes", 0.0)
            elif "/api/tts/jobs/" in self.path:
                configured = (
                    200,
                    {"Content-Type": "application/json"},
                    json.dumps(
                        {
                            "status": "completed",
                            "errored": 0,
                            "completed": 1,
                            "total_chunks": 1,
                        }
                    ).encode(),
                    0.0,
                )
            else:
                configured = (
                    200,
                    {"Content-Type": "application/json"},
                    json.dumps({"accepted": True}).encode(),
                    0.0,
                )
        status, headers, response_body, delay = configured
        if delay:
            time.sleep(delay)
        try:
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            if response_body:
                self.wfile.write(response_body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = _handle
    do_POST = _handle
    do_DELETE = _handle

    def log_message(self, format: str, *args: Any) -> None:
        return


@pytest.fixture
def fake_service() -> tuple[str, FakeHTTPState]:
    state = FakeHTTPState()
    loopback = ".".join(("127", "0", "0", "1"))
    server = ThreadingHTTPServer((loopback, 0), FakeServiceHandler)
    server.daemon_threads = True
    server.state = state  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield f"http://{host}:{port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _json_response(value: Any) -> tuple[int, dict[str, str], bytes, float]:
    return 200, {"Content-Type": "application/json"}, json.dumps(value).encode(), 0.0


def _wav_bytes() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(8000)
        wav_file.writeframes(b"\x00\x00" * 80)
    return buffer.getvalue()


def test_superpose_operations_use_frozen_verbs_paths_and_payloads(fake_service) -> None:
    base_url, state = fake_service
    client = SuperposeClient(base_url)

    results = [
        client.health(timeout_seconds=1.0),
        client.primitive_schema(timeout_seconds=1.0),
        client.themes(timeout_seconds=1.0),
        client.import_bundle("/caller/work/bundle", timeout_seconds=1.0),
        client.validate_project(7, timeout_seconds=1.0),
        client.render_project(
            7,
            quality="4k",
            scene_ids=["scene-a", "scene_b"],
            assemble=False,
            timeout_seconds=1.0,
        ),
        client.project_jobs(7, limit=23, timeout_seconds=1.0),
        client.video_file(9, timeout_seconds=1.0),
        client.video_captions(9, timeout_seconds=1.0),
    ]

    assert all(result["ok"] for result in results)
    assert [(row["method"], row["path"]) for row in state.requests] == [
        ("GET", "/api/health"),
        ("GET", "/api/primitives/schema"),
        ("GET", "/api/themes"),
        ("POST", "/api/bundles/import"),
        ("POST", "/api/projects/7/validate"),
        ("POST", "/api/projects/7/render"),
        ("GET", "/api/projects/7/jobs?limit=23"),
        ("GET", "/api/videos/9/file"),
        ("GET", "/api/videos/9/captions"),
    ]
    assert state.requests[3]["json"] == {"path": "/caller/work/bundle"}
    assert state.requests[4]["body"] == b""
    assert state.requests[5]["json"] == {
        "quality": "4k",
        "scene_ids": ["scene-a", "scene_b"],
        "assemble": False,
    }
    assert results[-2]["data"] == b"mp4-bytes"
    assert results[-1]["data"] == b"WEBVTT\n"
    # Freeze §15.9 deliberately excludes the broader storyboard/preview surface.
    assert not hasattr(client, "get_storyboard")
    assert not hasattr(client, "scene_preview")


def test_superpose_refuses_redirect_without_following_or_retrying(fake_service) -> None:
    base_url, state = fake_service
    state.responses[("GET", "/api/health")] = (
        302,
        {"Location": f"{base_url}/redirect-target"},
        b"",
        0.0,
    )

    result = SuperposeClient(base_url).health(timeout_seconds=1.0)

    assert result["ok"] is False
    assert result["status"] == 302
    assert result["error"] == "redirect_refused"
    assert [(request["method"], request["path"]) for request in state.requests] == [
        ("GET", "/api/health")
    ]
    assert SUPERPOSE_MAX_RETRIES == 0


def test_superpose_classifies_malformed_and_timeout_once_each(fake_service) -> None:
    base_url, state = fake_service
    state.responses[("GET", "/api/themes")] = (
        200,
        {"Content-Type": "application/json"},
        b"not-json",
        0.0,
    )
    state.responses[("GET", "/api/primitives/schema")] = (
        200,
        {"Content-Type": "application/json"},
        b"{}",
        0.15,
    )
    client = SuperposeClient(base_url)

    malformed = client.themes(timeout_seconds=1.0)
    timed_out = client.primitive_schema(timeout_seconds=0.02)

    assert malformed["ok"] is False
    assert malformed["error"].startswith("malformed_response:")
    assert timed_out["ok"] is False
    assert timed_out["status"] == 0
    assert timed_out["error"].startswith("timeout:")
    assert [request["path"] for request in state.requests].count("/api/themes") == 1
    assert [request["path"] for request in state.requests].count(
        "/api/primitives/schema"
    ) == 1


class _Response:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def getcode(self) -> int:
        return 200

    def read(self) -> bytes:
        return self.data


class _RecordingOpener:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.calls: list[tuple[Any, float]] = []

    def open(self, request: Any, *, timeout: float) -> _Response:
        self.calls.append((request, timeout))
        return _Response(self.data)


def test_custom_timeout_is_forwarded_and_download_default_is_frozen() -> None:
    opener = _RecordingOpener(b"binary")
    client = SuperposeClient("https://caller.invalid/service", opener=opener)

    result = client.video_file(1, timeout_seconds=4.25)

    assert result["ok"] is True
    assert opener.calls[0][1] == 4.25
    assert SUPERPOSE_DOWNLOAD_TIMEOUT_SECONDS == 120.0


@pytest.mark.parametrize(
    "call",
    [
        lambda client: client.validate_project(True),
        lambda client: client.video_file(0),
        lambda client: client.render_project(1, quality="unknown"),
        lambda client: client.render_project(1, quality="draft", scene_ids=["bad/id"]),
        lambda client: client.project_jobs(1, limit=False),
    ],
)
def test_superpose_local_argument_failures_make_no_request(fake_service, call) -> None:
    base_url, state = fake_service
    with pytest.raises(SuperposeClientError):
        call(SuperposeClient(base_url))
    assert state.requests == []


def test_voice_operations_use_frozen_verbs_paths_and_payloads(fake_service) -> None:
    base_url, state = fake_service
    client = VoiceStudioClient(base_url)

    results = [
        client.create_narration(
            title="Caller title",
            source_text="Caller narration text.",
            voice_profile_id="caller-voice-A",
            timeout_seconds=1.0,
        ),
        client.list_pronunciation_rules("item-A", timeout_seconds=1.0),
        client.create_pronunciation_rule(
            "item-A", pattern="token", replacement="spoken token", timeout_seconds=1.0
        ),
        client.spoken_preview(
            text="token", narration_item_id="item-A", timeout_seconds=1.0
        ),
        client.submit_tts(
            narration_item_id="item-A",
            voice_profile_id="caller-voice-A",
            timeout_seconds=1.0,
        ),
        client.tts_job("job-A", timeout_seconds=1.0),
        client.tts_result_wav("item-A", timeout_seconds=1.0),
        client.delete_narration("item-A", timeout_seconds=1.0),
    ]

    assert all(result["ok"] for result in results)
    assert [(row["method"], row["path"]) for row in state.requests] == [
        ("POST", "/api/narrations"),
        ("GET", "/api/narrations/item-A/pronunciation"),
        ("POST", "/api/narrations/item-A/pronunciation"),
        ("POST", "/api/pronunciation/spoken-preview"),
        ("POST", "/api/tts/generate"),
        ("GET", "/api/tts/jobs/job-A"),
        ("GET", "/api/tts/result/item-A.wav"),
        ("DELETE", "/api/narrations/item-A"),
    ]
    assert state.requests[0]["json"] == {
        "title": "Caller title",
        "source_text": "Caller narration text.",
        "voice_profile_id": "caller-voice-A",
    }
    assert state.requests[2]["json"] == {
        "pattern": "token",
        "replacement": "spoken token",
    }
    assert state.requests[3]["json"] == {
        "text": "token",
        "narration_item_id": "item-A",
    }
    assert state.requests[4]["json"] == {
        "narration_item_id": "item-A",
        "voice_profile_id": "caller-voice-A",
    }


def test_exact_caller_voice_is_sent_in_both_voice_payloads(fake_service) -> None:
    base_url, state = fake_service
    client = VoiceStudioClient(base_url)
    caller_voice = "voice-value-supplied-by-test"

    client.create_narration(
        title="Title", source_text="Text", voice_profile_id=caller_voice
    )
    client.submit_tts(narration_item_id="item-1", voice_profile_id=caller_voice)

    assert [request["json"]["voice_profile_id"] for request in state.requests] == [
        caller_voice,
        caller_voice,
    ]


@pytest.mark.parametrize(
    ("payload", "error_prefix"),
    [
        (
            {"status": "completed", "errored": 1, "completed": 1, "total_chunks": 2},
            "tts_scene_failure:",
        ),
        (
            {
                "status": "completed_with_errors",
                "errored": 0,
                "completed": 1,
                "total_chunks": 2,
            },
            "tts_terminal_failure:",
        ),
        (
            {"status": "cancelled", "errored": 0, "completed": 0, "total_chunks": 2},
            "tts_terminal_failure:",
        ),
    ],
)
def test_terminal_or_errored_tts_job_is_typed_failure_once(
    fake_service, payload, error_prefix
) -> None:
    base_url, state = fake_service
    state.responses[("GET", "/api/tts/jobs/job-1")] = _json_response(payload)

    result = VoiceStudioClient(base_url).tts_job("job-1")

    assert result["ok"] is False
    assert result["error"].startswith(error_prefix)
    assert "data" not in result
    assert len(state.requests) == 1
    assert TTS_MAX_RETRIES == 0


def test_cleanup_failure_is_warning_and_already_stored_wav_is_retained(
    fake_service, tmp_path: Path
) -> None:
    base_url, state = fake_service
    wav_data = _wav_bytes()
    state.responses[("GET", "/api/tts/result/item-2.wav")] = (
        200,
        {"Content-Type": "audio/wav"},
        wav_data,
        0.0,
    )
    state.responses[("DELETE", "/api/narrations/item-2")] = (
        503,
        {"Content-Type": "application/json"},
        b'{"error":"cleanup unavailable"}',
        0.0,
    )
    client = VoiceStudioClient(base_url)

    download = client.tts_result_wav("item-2")
    temporary = tmp_path / ".scene.wav.tmp"
    retained = tmp_path / "scene.wav"
    temporary.write_bytes(download["data"])
    os.replace(temporary, retained)
    cleanup = client.delete_narration("item-2")
    warnings = [] if cleanup["ok"] else [cleanup["error"]]

    assert cleanup["ok"] is False
    assert cleanup["status"] == 503
    assert warnings and warnings[0].startswith("http_error:503")
    assert retained.read_bytes() == wav_data
    assert [request["path"] for request in state.requests] == [
        "/api/tts/result/item-2.wav",
        "/api/narrations/item-2",
    ]


def test_voice_malformed_response_and_timeout_are_enveloped_once(fake_service) -> None:
    base_url, state = fake_service
    state.responses[("POST", "/api/narrations")] = (
        200,
        {"Content-Type": "application/json"},
        b"null",
        0.0,
    )
    state.responses[("POST", "/api/pronunciation/spoken-preview")] = (
        200,
        {"Content-Type": "application/json"},
        b"{}",
        0.15,
    )
    client = VoiceStudioClient(base_url)

    malformed = client.create_narration(
        title="Title", source_text="Text", voice_profile_id="caller-voice"
    )
    timed_out = client.spoken_preview(
        text="Text", narration_item_id=None, timeout_seconds=0.02
    )

    assert malformed["ok"] is False
    assert malformed["error"].startswith("malformed_response:")
    assert timed_out["ok"] is False
    assert timed_out["error"].startswith("timeout:")
    assert len(state.requests) == 2


def test_voice_defaults_and_local_validation_are_frozen(fake_service) -> None:
    base_url, state = fake_service
    assert TTS_REQUEST_TIMEOUT_SECONDS == 30.0
    assert TTS_RESULT_TIMEOUT_SECONDS == 120.0
    with pytest.raises(VoiceStudioClientError):
        VoiceStudioClient(base_url).submit_tts(
            narration_item_id="bad/id", voice_profile_id="caller-voice"
        )
    with pytest.raises(VoiceStudioClientError):
        VoiceStudioClient(base_url).create_narration(
            title="Title", source_text="Text", voice_profile_id=""
        )
    with pytest.raises(VoiceStudioClientError):
        VoiceStudioClient("file:///tmp/not-http")
    assert state.requests == []


def test_injected_network_timeout_is_one_enveloped_call() -> None:
    class TimeoutOpener:
        def __init__(self) -> None:
            self.calls = 0

        def open(self, request: Any, *, timeout: float) -> Any:
            self.calls += 1
            raise socket.timeout("injected timeout")

    opener = TimeoutOpener()
    result = VoiceStudioClient("https://caller.invalid", opener=opener).tts_result_wav(
        "item-3", timeout_seconds=0.5
    )
    assert result["ok"] is False
    assert result["error"].startswith("timeout:")
    assert opener.calls == 1
