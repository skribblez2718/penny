"""Bounded Linux SO_PEERCRED transport for the compiled Node voice owner.

No policy, grants, transcripts on disk, shell, service control or model imports.
The parent owns authorization; this helper only authenticates and moves frames.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import socket
import select
import stat
import struct
import sys

LIMIT = 16_777_216


def private_parent(source: str) -> Path:
    path = Path(source)
    parent = path.parent
    info = parent.lstat()
    if (
        not path.is_absolute()
        or parent.resolve() != parent
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ValueError("unsafe private socket parent")
    return path


def peer(connection: socket.socket, pid: int) -> None:
    actual_pid, uid, _ = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    if actual_pid != pid or uid != os.getuid():
        raise ValueError("private peer PID/UID mismatch")


def frame(stream: object) -> bytes:
    # Both callers supply binary buffered streams. Keep the boundary explicit.
    if not hasattr(stream, "readline"):
        raise ValueError("binary stream required")
    data = stream.readline(LIMIT + 1)
    if not isinstance(data, bytes) or not data or len(data) > LIMIT or not data.endswith(b"\n"):
        raise ValueError("private frame limit/EOF")
    return data


def emit(data: bytes, sent: int = 0) -> None:
    sys.stdout.write(
        json.dumps(
            {"frame": base64.b64encode(data).decode("ascii"), "received": len(data), "sent": sent}
        )
        + "\n"
    )
    sys.stdout.flush()


def main() -> None:
    mode, source, expected = sys.argv[1:]
    pid = int(expected)
    path = private_parent(source)
    if mode == "connect":
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("unsafe private socket")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(30)
            connection.connect(str(path))
            peer(connection, pid)
            with connection.makefile("rb") as stream:
                emit(frame(stream))
                while True:
                    data = sys.stdin.buffer.readline(2_097_153)
                    if not data:
                        return
                    if len(data) > 2_097_152 or not data.endswith(b"\n"):
                        raise ValueError("request limit")
                    connection.sendall(data)
                    emit(frame(stream), len(data))
    elif mode == "listen":
        # Never remove another listener or stale pathname on startup.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))
            os.chmod(path, 0o600)
            listener.listen(4)
            emit(b'{"ready":true}\n')
            try:
                while True:
                    readable, _, _ = select.select([listener, sys.stdin.buffer], [], [])
                    if sys.stdin.buffer in readable:
                        break  # parent EOF; no orphan checker listener
                    connection, _ = listener.accept()
                    with connection:
                        connection.settimeout(10)
                        peer(connection, pid)
                        with connection.makefile("rb") as stream:
                            data = frame(stream)
                        emit(data)
                        answer = frame(sys.stdin.buffer)
                        connection.sendall(answer)
                        emit(b"", len(answer))
            finally:
                path.unlink(missing_ok=True)
    else:
        raise ValueError("invalid transport mode")


if __name__ == "__main__":
    main()
