from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from memory.common import ValidationError, atomic_write_json
from memory.hub_config import HubConfig, child_environment, load_hub_config
from memory.hub_service import (
    ProcessMetadata,
    _linux_process_stat,
    _linux_start_marker,
    _process_alive,
    build_hub_command,
    health,
    status,
    stop,
)

SYSTEM_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = SYSTEM_ROOT.parents[1]


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _make_config(
    root: Path,
    palace: Path,
    *,
    palace_id: str,
    port: int,
) -> Path:
    roots: dict[str, Path] = {
        "palace": palace,
        "kg": palace / "knowledge_graph.sqlite3",
        "logstream": palace / "logstream.sqlite3",
        "archive": root / "archive",
        "runtime": root / "runtime",
        "logs": root / "logs",
        "home": root / "home",
        "config": root / "xdg-config",
        "cache": root / "xdg-cache",
        "state": root / "xdg-state",
    }
    for name, path in roots.items():
        if name not in {"kg", "logstream"}:
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.chmod(0o700)
    token = root / "token"
    token.write_text("synthetic-test-token", encoding="utf-8")
    token.chmod(0o600)
    config = root / "hub.json"
    config.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "endpoint": f"http://127.0.0.1:{port}",
                "palace_id": palace_id,
                "backend": "chroma",
                "python_executable": sys.executable,
                "token_file": str(token),
                "data_roots": {name: str(path) for name, path in roots.items()},
                "health_timeout_seconds": 0.5,
                "stop_timeout_seconds": 5.0,
            }
        ),
        encoding="utf-8",
    )
    config.chmod(0o600)
    return config


def _write_fixture_server(path: Path) -> None:
    path.write_text(
        textwrap.dedent("""
            import argparse
            import fcntl
            import json
            import os
            import signal
            from http.server import BaseHTTPRequestHandler, HTTPServer
            from pathlib import Path

            parser = argparse.ArgumentParser()
            parser.add_argument("--host", required=True)
            parser.add_argument("--port", required=True, type=int)
            parser.add_argument("--palace", required=True)
            args = parser.parse_args()

            lock_path = Path(args.palace) / ".synthetic-writer-lease"
            lock_path.touch(mode=0o600, exist_ok=True)
            lock = lock_path.open("r+b")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit(2)

            stopping = False
            def request_stop(_signum, _frame):
                global stopping
                stopping = True

            signal.signal(signal.SIGTERM, request_stop)
            if hasattr(signal, "SIGHUP"):
                signal.signal(signal.SIGHUP, request_stop)

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, _format, *args):
                    return
                def do_GET(self):
                    if self.path == "/healthz":
                        self.send_response(200)
                        self.send_header("Content-Type", "text/plain")
                        self.end_headers()
                        self.wfile.write(b"ok\\n")
                        return
                    if self.path == "/statusz":
                        expected = "Bearer " + os.environ["MEMPALACE_MCP_HTTP_TOKEN"]
                        if self.headers.get("Authorization") != expected:
                            self.send_response(401)
                            self.end_headers()
                            return
                        payload = json.dumps({"synthetic": True}).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    self.send_response(404)
                    self.end_headers()

            server = HTTPServer((args.host, args.port), Handler)
            server.timeout = 0.1
            try:
                while not stopping:
                    server.handle_request()
            finally:
                server.server_close()
                lock.close()
            """),
        encoding="utf-8",
    )


def _write_launcher(path: Path) -> None:
    path.write_text(
        textwrap.dedent("""
            import os
            import sys
            from memory import hub_service

            fixture = os.environ["SYNTHETIC_HUB_SCRIPT"]
            def command(config):
                return [
                    sys.executable,
                    fixture,
                    "--host", config.host,
                    "--port", str(config.port),
                    "--palace", str(config.data_roots["palace"]),
                ]
            hub_service.build_hub_command = command
            raise SystemExit(hub_service.main())
            """),
        encoding="utf-8",
    )


def _launch(config: Path, launcher: Path, fixture: Path) -> subprocess.Popen[bytes]:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(SYSTEM_ROOT)
    environment["SYNTHETIC_HUB_SCRIPT"] = str(fixture)
    return subprocess.Popen(
        [sys.executable, str(launcher), "foreground", "--config", str(config)],
        cwd=PROJECT_ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _launch_actual(config: Path) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "scripts.system.memory.hub_service",
            "foreground",
            "--config",
            str(config),
        ],
        cwd=PROJECT_ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _wait_healthy(config: HubConfig, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            pytest.fail(f"synthetic hub exited early: {process.returncode}; {stdout!r}; {stderr!r}")
        if health(config)["healthy"]:
            return
        time.sleep(0.05)
    pytest.fail("synthetic hub did not become healthy")


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


@pytest.mark.skipif(os.name != "posix", reason="synthetic lease fixture uses POSIX flock/signals")
def test_second_owner_refusal_and_sigterm_sighup_release_restart(tmp_path: Path) -> None:
    fixture = tmp_path / "synthetic_hub.py"
    launcher = tmp_path / "launcher.py"
    _write_fixture_server(fixture)
    _write_launcher(launcher)
    original = tmp_path / "original-palace-fixture"
    original.mkdir(mode=0o700)
    (original / "fixture.txt").write_text("synthetic only", encoding="utf-8")
    palace = tmp_path / "copied-palace"
    palace.mkdir(mode=0o700)
    (palace / "fixture.txt").write_bytes((original / "fixture.txt").read_bytes())
    palace.chmod(0o700)

    config_one_path = _make_config(
        tmp_path / "owner-one",
        palace,
        palace_id="synthetic-one",
        port=_free_port(),
    )
    config_two_path = _make_config(
        tmp_path / "owner-two",
        palace,
        palace_id="synthetic-two",
        port=_free_port(),
    )
    config_one = load_hub_config(config_one_path)
    config_two = load_hub_config(config_two_path)
    first = _launch(config_one_path, launcher, fixture)
    second: subprocess.Popen[bytes] | None = None
    restarted: subprocess.Popen[bytes] | None = None
    try:
        _wait_healthy(config_one, first)
        service_status = status(config_one)
        assert service_status["running"] is True
        assert service_status["healthy"] is True
        assert service_status["upstream"] == {"synthetic": True}

        second = _launch(config_two_path, launcher, fixture)
        assert second.wait(timeout=10) == 2
        assert health(config_one)["healthy"] is True

        first.send_signal(signal.SIGTERM)
        assert first.wait(timeout=10) == 0
        restarted = _launch(config_two_path, launcher, fixture)
        _wait_healthy(config_two, restarted)

        if hasattr(signal, "SIGHUP"):
            restarted.send_signal(signal.SIGHUP)
            assert restarted.wait(timeout=10) == 0
            restarted = _launch(config_two_path, launcher, fixture)
            _wait_healthy(config_two, restarted)
    finally:
        _terminate(first)
        if second is not None:
            _terminate(second)
        if restarted is not None:
            _terminate(restarted)


@pytest.mark.skipif(os.name != "posix", reason="synthetic lifecycle fixture uses POSIX signals")
def test_stale_pid_recovery_and_portable_stop(tmp_path: Path) -> None:
    fixture = tmp_path / "synthetic_hub.py"
    launcher = tmp_path / "launcher.py"
    _write_fixture_server(fixture)
    _write_launcher(launcher)
    palace = tmp_path / "copied-palace"
    palace.mkdir(mode=0o700)
    config_path = _make_config(
        tmp_path / "owner",
        palace,
        palace_id="synthetic-stale",
        port=_free_port(),
    )
    config = load_hub_config(config_path)
    atomic_write_json(
        config.pid_file,
        {
            "schema_version": 1,
            "file_type": "mempalace-hub-supervisor",
            "pid": 2147483647,
            "start_marker": "0",
            "config_sha256": config.config_sha256,
            "palace_id": config.palace_id,
            "endpoint": config.endpoint,
            "started_at": "2026-08-15T12:00:00Z",
        },
    )

    process = _launch(config_path, launcher, fixture)
    try:
        _wait_healthy(config, process)
        wait_thread = threading.Thread(target=process.wait, daemon=True)
        wait_thread.start()
        stop_result = stop(config)
        wait_thread.join(timeout=10)
        assert stop_result == {
            "stopped": True,
            "already_stopped": False,
            "stale_recovered": False,
        }
        assert process.returncode == 0
        assert not config.pid_file.exists()
    finally:
        _terminate(process)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="requires Linux /proc state")
def test_unreaped_zombie_is_not_reported_as_a_live_supervisor() -> None:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    marker = _linux_start_marker(process.pid)
    assert marker is not None
    try:
        deadline = time.monotonic() + 5
        state: str | None = None
        while time.monotonic() < deadline:
            process_stat = _linux_process_stat(process.pid)
            state = process_stat[0] if process_stat is not None else None
            if state == "Z":
                break
            time.sleep(0.01)
        assert state == "Z"
        metadata = ProcessMetadata(
            pid=process.pid,
            start_marker=marker,
            config_sha256="0" * 64,
            palace_id="zombie-test",
            endpoint="http://127.0.0.1:1",
            started_at="2026-08-16T00:00:00Z",
        )
        assert _process_alive(metadata) is False
    finally:
        process.wait(timeout=5)


@pytest.mark.integration
@pytest.mark.skipif(
    not os.environ.get("MEMPALACE_371_PYTHON"),
    reason="set MEMPALACE_371_PYTHON to an isolated 3.7.1 interpreter",
)
def test_real_371_hub_lease_and_signal_release_on_copied_palace(tmp_path: Path) -> None:
    candidate_python = Path(os.environ["MEMPALACE_371_PYTHON"]).absolute()
    assert candidate_python.exists()
    palace = tmp_path / "copied-palace"
    palace.mkdir(mode=0o700)
    config_one_path = _make_config(
        tmp_path / "owner",
        palace,
        palace_id="candidate-one",
        port=_free_port(),
    )
    document = json.loads(config_one_path.read_text(encoding="utf-8"))
    document["python_executable"] = str(candidate_python)
    config_one_path.write_text(json.dumps(document), encoding="utf-8")
    config_one_path.chmod(0o600)
    config_one = load_hub_config(config_one_path)

    direct_port = _free_port()
    direct_command = build_hub_command(config_one)
    direct_command[direct_command.index("--port") + 1] = str(direct_port)
    direct_config_path = tmp_path / "direct.json"
    direct_document = dict(document)
    direct_document["endpoint"] = f"http://127.0.0.1:{direct_port}"
    direct_document["palace_id"] = "candidate-direct"
    direct_config_path.write_text(json.dumps(direct_document), encoding="utf-8")
    direct_config_path.chmod(0o600)
    direct_config = load_hub_config(direct_config_path)

    first = _launch_actual(config_one_path)
    direct: subprocess.Popen[bytes] | None = None
    restarted: subprocess.Popen[bytes] | None = None
    try:
        _wait_healthy(config_one, first)
        refused = subprocess.run(
            direct_command,
            env=child_environment(config_one),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=20,
            check=False,
        )
        assert refused.returncode == 2

        first.send_signal(signal.SIGTERM)
        assert first.wait(timeout=20) == 0
        direct = subprocess.Popen(
            direct_command,
            env=child_environment(config_one),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        _wait_healthy(direct_config, direct)
        if hasattr(signal, "SIGHUP"):
            direct.send_signal(signal.SIGHUP)
            assert direct.wait(timeout=20) == 0
        else:
            direct.send_signal(signal.SIGTERM)
            assert direct.wait(timeout=20) == 0

        restarted = _launch_actual(config_one_path)
        _wait_healthy(config_one, restarted)
    finally:
        _terminate(first)
        if direct is not None:
            _terminate(direct)
        if restarted is not None:
            _terminate(restarted)


def test_command_contract_keeps_token_out_of_argv(tmp_path: Path) -> None:
    palace = tmp_path / "palace"
    palace.mkdir(mode=0o700)
    config = load_hub_config(
        _make_config(tmp_path / "owner", palace, palace_id="synthetic", port=_free_port())
    )

    command = build_hub_command(config)

    assert command[:3] == [str(Path(sys.executable).absolute()), "-m", "mempalace.mcp_server"]
    assert "--transport" in command
    assert "--palace" in command
    assert "synthetic-test-token" not in " ".join(command)


def test_config_rejects_non_owner_token_permissions(tmp_path: Path) -> None:
    palace = tmp_path / "palace"
    palace.mkdir(mode=0o700)
    config_path = _make_config(
        tmp_path / "owner",
        palace,
        palace_id="synthetic",
        port=_free_port(),
    )
    document: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    token = Path(document["token_file"])
    token.chmod(0o644)

    with pytest.raises(ValidationError, match="group or other"):
        load_hub_config(config_path)


def test_linux_user_service_is_template_only_and_uses_portable_foreground() -> None:
    template = (PROJECT_ROOT / "scripts/setup/mempalace-hub@.service.in").read_text(
        encoding="utf-8"
    )
    memory_extension = (PROJECT_ROOT / ".pi/extensions/memory/index.ts").read_text(encoding="utf-8")

    assert "hub_service foreground --config" in template
    assert "hub_service stop --config" in template
    assert "UMask=0077" in template
    assert "Restart=always" in template
    assert "@PROJECT_ROOT@" in template
    assert "hub_service" not in memory_extension
    assert "systemctl" not in memory_extension
