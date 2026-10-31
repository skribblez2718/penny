"""Bounded local protocol. Kernel credentials, not a public token, establish the peer."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import stat
import struct
import threading
from collections.abc import Callable, Mapping
from pathlib import Path

from .gate import Denied, Gate, Window

MAX_FRAME = 4 * 1024 * 1024


def record(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
        raise Denied("expected protocol object")
    return dict(value)


def text(value: object) -> str:
    if not isinstance(value, str):
        raise Denied("expected protocol string")
    return value


def peer(connection: socket.socket) -> dict[str, int]:
    pid, uid, gid = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    return {"pid": pid, "uid": uid, "gid": gid}


def process_identity(pid: int) -> dict[str, object]:
    root = Path(f"/proc/{pid}")
    ticks = root.joinpath("stat").read_text().rsplit(") ", 1)[1].split()[19]
    executable = root.joinpath("exe").resolve(strict=True)
    with executable.open("rb") as stream:
        executable_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    identity = {
        "pid": pid,
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "start_ticks": ticks,
        "executable_sha256": executable_sha256,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return {**identity, "process_epoch": hashlib.sha256(encoded).hexdigest()}


class Frames:
    def __init__(self, connection: socket.socket, gate: Gate | None = None) -> None:
        self.connection = connection
        self.gate = gate
        self.lock = threading.RLock()
        self.last_frame_bytes = 0
        self.buffer = bytearray()

    def send(self, value: Mapping[str, object]) -> None:
        data = json.dumps(value, separators=(",", ":"), allow_nan=False).encode() + b"\n"
        if len(data) > MAX_FRAME:
            raise Denied("frame size limit")
        with self.lock:
            # Count bytes accepted by send, including partial writes on disconnect.
            while data:
                count = self.connection.send(data)
                if count == 0:
                    raise ConnectionError("peer closed")
                if self.gate:
                    self.gate.transport("ipc", count, 0)
                data = data[count:]

    def receive(self) -> dict[str, object]:
        while b"\n" not in self.buffer:
            part = self.connection.recv(min(65536, MAX_FRAME + 1 - len(self.buffer)))
            if not part:
                raise ConnectionError("peer closed")
            self.buffer.extend(part)
            if len(self.buffer) > MAX_FRAME:
                raise Denied("frame size limit")
        line, _, rest = self.buffer.partition(b"\n")
        self.buffer = bytearray(rest)
        self.last_frame_bytes = len(line) + 1
        if self.gate:
            self.gate.transport("ipc", 0, self.last_frame_bytes)
        return record(json.loads(line))


class Session:
    def __init__(
        self,
        connection: socket.socket,
        gate: Gate,
        permitted_uid: int,
        identity: Mapping[str, object],
        build_sha256: str,
        submit: Callable[[Window], None],
        queue_state: Callable[[str, bool], tuple[bool, bool]],
    ) -> None:
        self.frames = Frames(connection, gate)
        self.gate = gate
        self.permitted_uid = permitted_uid
        self.identity = identity
        self.build_sha256 = build_sha256
        self.submit = submit
        self.queue_state = queue_state
        self.pending: dict[str, tuple[threading.Event, list[object]]] = {}
        self.lock = threading.Lock()
        self.control = threading.Lock()
        self.stopped = threading.Event()

    def renew(self, window: Window) -> None:
        check_id = secrets.token_hex(24)
        ready = threading.Event()
        result: list[object] = []
        with self.lock:
            if len(self.pending) >= 64:
                raise Denied("check concurrency limit")
            self.pending[check_id] = ready, result
        try:
            self.frames.send({"type": "check", "id": check_id, "grant_sha256": window.grant_sha256})
            if not ready.wait(5) or result != [window.grant_sha256]:
                raise Denied("catalog check missing/denied")
        finally:
            with self.lock:
                self.pending.pop(check_id, None)

    def watchdog(self) -> None:
        while not self.stopped.wait(0.5):
            if self.gate.window is not None:
                try:
                    self.gate.check()
                except (Denied, OSError):
                    self.gate.cancel()
                    return

    def result(self, identifier: str) -> None:
        # The response contains its own exact encoded AF_UNIX byte count. The
        # fixed point only changes the decimal counter's representation length.
        with self.frames.lock, self.gate._condition:
            observation = self.gate.observation()
            original = self.gate.ipc_tx
            response: dict[str, object] = {
                "type": "result",
                "id": identifier,
                "ok": True,
                "observation": observation,
            }
            if self.gate._metering:
                for _ in range(8):
                    length = (
                        len(json.dumps(response, separators=(",", ":"), allow_nan=False).encode())
                        + 1
                    )
                    projected = original + length
                    if observation["ipc_tx_bytes"] == projected:
                        break
                    observation["ipc_tx_bytes"] = projected
                else:
                    raise Denied("counter frame size did not converge")
            self.frames.send(response)

    def open_window(self, message: Mapping[str, object], frame_bytes: int) -> None:
        grant = record(json.loads(text(message.get("grant_json"))))
        if grant.get("process_epoch") != self.identity.get("process_epoch") or grant.get(
            "worker_id"
        ) != self.identity.get("worker_id"):
            raise Denied("grant/service identity mismatch")
        self.gate.open(
            text(message.get("grant_json")),
            text(message.get("graph_json")),
            text(message.get("prompt_id")),
        )
        self.gate.transport("ipc", 0, frame_bytes)

    def submit_owned(self) -> None:
        window = self.gate.window
        if window is None:
            raise Denied("no approved window")
        self.gate.check()
        self.submit(window)

    def cancel_owned(self) -> None:
        self.gate.cancel()
        window = self.gate.window
        if window is not None:
            queued, running = self.queue_state(window.prompt_id, True)
            if not queued and not running and self.gate.active == 0:
                self.gate._terminal = True

    def finish_owned(self) -> None:
        window = self.gate.window
        if window is None:
            raise Denied("no owned window")
        queued, running = self.queue_state(window.prompt_id, False)
        self.gate.finish(queued, running)

    def command(self, message: Mapping[str, object], frame_bytes: int) -> None:
        identifier = text(message.get("id"))
        commands: dict[str, Callable[[], None]] = {
            "close": self.gate.close,
            "manual": self.gate.manual,
            "open": lambda: self.open_window(message, frame_bytes),
            "submit": self.submit_owned,
            "cancel": self.cancel_owned,
            "finish": self.finish_owned,
            "status": lambda: None,
        }
        try:
            operation = text(message.get("op"))
            allowed = {"type", "op", "id"}
            if operation == "open":
                allowed.update({"grant_json", "graph_json", "prompt_id"})
            if set(message) != allowed or operation not in commands:
                raise Denied("unknown control operation/fields")
            commands[operation]()
            self.result(identifier)
        except (Denied, ValueError, OSError):
            self.frames.send(
                {"type": "result", "id": identifier, "ok": False, "error": "gate_refused"}
            )
        finally:
            self.control.release()

    def run(self) -> None:
        credentials = peer(self.frames.connection)
        if credentials["uid"] != self.permitted_uid:
            raise Denied("peer UID denied")
        challenge = secrets.token_hex(32)
        self.frames.send(
            {
                "type": "hello",
                "protocol": "penny.compute-gate.v1",
                "challenge": challenge,
                "peer": credentials,
                "service": self.identity,
                "gate_build_sha256": self.build_sha256,
            }
        )
        claim = self.frames.receive()
        if (
            set(claim) != {"type", "challenge", "owner_challenge"}
            or claim.get("type") != "claim"
            or claim.get("challenge") != challenge
        ):
            raise Denied("connection challenge failed")
        owner_challenge = text(claim.get("owner_challenge"))
        if len(owner_challenge) != 64:
            raise Denied("owner challenge length")
        self.gate.bind_owner(self.renew)
        self.frames.send({"type": "claimed", "owner_challenge": owner_challenge})
        threading.Thread(target=self.watchdog, daemon=True).start()
        try:
            while True:
                message = self.frames.receive()
                if message.get("type") == "current":
                    identifier = text(message.get("id"))
                    with self.lock:
                        pending = self.pending.get(identifier)
                        if pending is None:
                            raise Denied("late/replayed check response")
                        pending[1].append(message.get("grant_sha256"))
                        pending[0].set()
                elif message.get("type") == "command":
                    if not self.control.acquire(blocking=False):
                        raise Denied("concurrent control operation")
                    threading.Thread(
                        target=self.command,
                        args=(message, self.frames.last_frame_bytes),
                        daemon=True,
                    ).start()
                else:
                    raise Denied("unknown protocol message")
        finally:
            self.stopped.set()
            self.gate.disconnect()
            window = self.gate.window
            if window is not None:
                queued, running = self.queue_state(window.prompt_id, True)
                if not queued and not running and self.gate.active == 0:
                    self.gate._terminal = True
            with self.lock:
                for event, _ in self.pending.values():
                    event.set()


def serve(listener: socket.socket, create_session: Callable[[socket.socket], Session]) -> None:
    while True:
        connection, _ = listener.accept()
        connection.settimeout(10)
        try:
            create_session(connection).run()
        except (Denied, ValueError, OSError, ConnectionError):
            pass
        finally:
            connection.close()


def private_listener(path: Path, permitted_uid: int) -> socket.socket:
    # Cross-UID deployments must pass an administrator-provisioned listening FD
    # to bootstrap. This function neither changes ACLs nor makes shared files.
    directory = path.parent.stat()
    if (
        permitted_uid != os.getuid()
        or directory.st_uid != os.getuid()
        or stat.S_IMODE(directory.st_mode) != 0o700
    ):
        raise Denied("private same-UID socket directory required; use provisioned FD for cross-UID")
    if path.exists() or path.is_symlink():
        raise Denied("socket path already exists; inspected stale cleanup required")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)
    return listener
