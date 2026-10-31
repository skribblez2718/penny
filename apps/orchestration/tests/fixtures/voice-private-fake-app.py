"""Isolated actual Voice ASGI app/IPC fixture. No real engine or operator database.

The caller supplies the source checkout through cwd and all private test paths.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _prepare_runtime(root: Path) -> None:
    os.environ.update(
        VOICE_STUDIO_FAKE="1",
        VOICE_STUDIO_DB=str(root / "test.sqlite"),
        VOICE_STUDIO_DATA=str(root / "data"),
        VOICE_STUDIO_AUDIO_SCRATCH=str(root / "audio"),
        VOICE_STUDIO_CONTROL_CONFIG=str(root / "control.json"),
    )
    from api.services.voice_control_files import CANONICAL_SCRIPT, hash_file

    def pin(path: Path) -> dict[str, str]:
        source = str(path.resolve())
        return {"path": source, "sha256": hash_file(source)}

    for name in ("design", "base"):
        directory = root / name
        directory.mkdir()
        (directory / "weights.safetensors").write_text("NOT REAL MODEL WEIGHTS")
        (directory / "config.json").write_text("{}")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("installed Node canonicalizer required")
    config = {
        "schema_version": 1,
        "backend_binding_id": "fixture-service",
        "observation_path": str(root / "observation.json"),
        "socket_path": str(root / "voice.sock"),
        "lock_path": str(root / "voice.lock"),
        "canonicalizer": pin(Path(node)),
        "source_files": [pin(p) for p in sorted(Path("api").resolve().rglob("*.py"))]
        + [pin(CANONICAL_SCRIPT)],
        "runtime_files": [pin(Path(sys.executable)), pin(Path(node))],
        "model_files": [pin(p) for n in ("design", "base") for p in sorted((root / n).iterdir())],
        "voice_design_root": str(root / "design"),
        "base_root": str(root / "base"),
        "lease_idle_ms": 10000,
        "refresh_ms": 100,
    }
    (root / "control.json").write_text(json.dumps(config))
    (root / "control.json").chmod(0o600)


def _wait_for_release(root: Path) -> None:
    (root / "retained").touch()
    end = time.monotonic() + 8
    while not (root / "release-compute").exists():
        if time.monotonic() > end:
            raise RuntimeError("isolated fake release inactivity")
        time.sleep(0.01)


def _wait_for_stop() -> None:
    for line in sys.stdin:
        if line.strip() == "stop":
            break


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    _prepare_runtime(root)
    from fastapi.testclient import TestClient
    from api.main import app
    from api.db.database import SessionLocal
    from api.db.models import VoiceProfile
    import numpy as np
    import soundfile as sf

    from api.services.tts_engine import FakeTTSEngine
    from api.services.model_worker import set_engine
    from api.services.voice_control import get_controller

    mode = sys.argv[2] if len(sys.argv) > 2 else "normal"

    class SlowFake(FakeTTSEngine):
        def generate_voice_clone(self, text: str, language: str, voice_clone_prompt: object):
            _wait_for_release(root)
            return super().generate_voice_clone(text, language, voice_clone_prompt)

    class TrackingFake(FakeTTSEngine):
        def load(self) -> None:
            (root / "preload-called").write_text("actual fake engine.load invocation")
            super().load()

    with TestClient(app) as client:
        if mode == "preload":
            set_engine(TrackingFake())
        if mode == "slow":
            set_engine(SlowFake())
            # Real threaded queue scheduling with an explicitly installed FAKE engine.
            os.environ["VOICE_STUDIO_FAKE"] = "0"
        retained = get_controller().reserve() if mode == "unmanaged" else None
        voice_root = root / "voice"
        voice_root.mkdir()
        sf.write(
            str(voice_root / "ref.wav"),
            np.sin(np.arange(24000) * 0.1).astype(np.float32) * 0.1,
            24000,
        )
        (voice_root / "ref.txt").write_text("Synthetic test reference.")
        with SessionLocal() as db:
            db.add(
                VoiceProfile(
                    id="abcdef123456",
                    name="Synthetic isolated test",
                    source="cloned",
                    storage_path=str(voice_root),
                    meta_json='{"ref_text":"Synthetic test reference."}',
                )
            )
            db.commit()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if not self.path.startswith("/api/"):
                    self.send_error(404)
                    return
                response = client.get(self.path)
                self.send_response(response.status_code)
                self.send_header(
                    "Content-Type", response.headers.get("content-type", "application/json")
                )
                self.send_header("Content-Length", str(len(response.content)))
                self.end_headers()
                self.wfile.write(response.content)

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain(str(root / "cert.pem"), str(root / "key.pem"))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        sys.stdout.write(json.dumps({"pid": os.getpid(), "port": server.server_address[1]}) + "\n")
        sys.stdout.flush()
        _wait_for_stop()
        (root / "release-compute").touch()
        if retained:
            get_controller().finish(retained)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
