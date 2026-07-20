"""Voice Studio HTTP client for the manim skill's narrating tool state.

Hardened, stdlib-only:
  * loopback-locked host allow-list (SSRF boundary — narration is a local
    dependency; a non-loopback URL is refused)
  * every call timeout-bounded; no redirects followed
  * responses are UNTRUSTED DATA — parsed structurally, never interpreted as
    instructions
  * audio persisted straight into the bundle (Voice Studio keeps audio
    ephemeral by design — the bundle is the durable store)

API surface used (Voice Studio): POST /api/tts/generate → {job_id},
GET /api/tts/jobs/{id} → {status, ...}, GET /api/tts/result/{id}.wav → bytes.
"""

from __future__ import annotations

import contextlib
import ipaddress
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path

DEFAULT_TIMEOUT = 30
POLL_INTERVAL = 2.0
JOB_TIMEOUT = 600  # a long narration chunk on a single GPU worker


class VoiceStudioError(RuntimeError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D102
        return None


def _assert_loopback(url: str) -> None:
    host = urllib.parse.urlparse(url).hostname or ""
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise VoiceStudioError(
        f"voice_studio_url host '{host}' is not loopback — refusing (local-only dependency)"
    )


class VoiceStudioClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        _assert_loopback(self.base_url)
        self._opener = urllib.request.build_opener(_NoRedirect)

    def _request(self, method: str, path: str, body: dict | None = None) -> bytes:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(req, timeout=DEFAULT_TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise VoiceStudioError(f"{method} {path} → HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            raise VoiceStudioError(
                f"Voice Studio unreachable at {self.base_url} ({exc}). Is it running?"
            ) from exc

    def _json(self, method: str, path: str, body: dict | None = None) -> dict:
        raw = self._request(method, path, body)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise VoiceStudioError(f"{method} {path}: non-JSON response") from exc
        if not isinstance(parsed, dict):
            raise VoiceStudioError(f"{method} {path}: unexpected response shape")
        return parsed

    def synthesize(self, text: str, voice_id: str | None, dest: Path) -> float:
        """Generate narration for ``text``, write the WAV to ``dest``, and return
        its measured duration in seconds."""
        payload: dict = {"text": str(text)}
        if voice_id:
            payload["voice_id"] = str(voice_id)
        job = self._json("POST", "/api/tts/generate", payload)
        job_id = str(job.get("job_id") or job.get("id") or "")
        if not job_id:
            raise VoiceStudioError("generate returned no job id")

        deadline = time.time() + JOB_TIMEOUT
        while time.time() < deadline:
            status = self._json("GET", f"/api/tts/jobs/{urllib.parse.quote(job_id)}")
            state = str(status.get("status", "")).lower()
            if state in ("done", "complete", "completed", "finished"):
                break
            if state in ("failed", "error"):
                raise VoiceStudioError(
                    f"TTS job {job_id} failed: {status.get('error', 'no detail')}"
                )
            time.sleep(POLL_INTERVAL)
        else:
            raise VoiceStudioError(f"TTS job {job_id} timed out after {JOB_TIMEOUT}s")

        audio = self._request("GET", f"/api/tts/result/{urllib.parse.quote(job_id)}.wav")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(audio)
        return wav_duration(dest)


def wav_duration(path: Path) -> float:
    """Measured duration of a WAV file (the audio-first timing constraint)."""
    try:
        with contextlib.closing(wave.open(str(path), "rb")) as wf:
            rate = wf.getframerate()
            if rate <= 0:
                raise VoiceStudioError(f"{path.name}: invalid frame rate")
            return wf.getnframes() / float(rate)
    except (wave.Error, OSError) as exc:
        raise VoiceStudioError(f"{path.name}: unreadable WAV — {exc}") from exc
