"""Owner-child transport: SO_PEERCRED checked locally; no lease or PASS authority."""

from __future__ import annotations

import argparse
import json
import os
import selectors
import socket
import sys
from pathlib import Path

from .ipc import MAX_FRAME, peer, process_identity


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--peer-uid", required=True, type=int)
    parser.add_argument("--peer-pid", required=True, type=int)
    parser.add_argument("--peer-start-ticks", required=True)
    args = parser.parse_args()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(args.socket))
        credentials = peer(connection)
        if credentials["uid"] != args.peer_uid or credentials["pid"] != args.peer_pid:
            raise PermissionError("backend kernel peer mismatch")
        identity = process_identity(credentials["pid"])
        if identity["start_ticks"] != args.peer_start_ticks:
            raise PermissionError("backend process epoch mismatch")
        sys.stdout.buffer.write(
            json.dumps(
                {"type": "native_peer", "credentials": credentials, "identity": identity}
            ).encode()
            + b"\n"
        )
        sys.stdout.buffer.flush()
        forward(connection)


def forward(connection: socket.socket) -> None:
    selector = selectors.DefaultSelector()
    selector.register(connection, selectors.EVENT_READ)
    selector.register(sys.stdin.buffer, selectors.EVENT_READ)
    buffers: dict[object, bytearray] = {connection: bytearray(), sys.stdin.buffer: bytearray()}
    while True:
        for key, _ in selector.select():
            if key.fileobj is connection:
                data = connection.recv(65536)
            else:
                data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                return
            buffer = buffers[key.fileobj]
            buffer.extend(data)
            while b"\n" in buffer:
                line, _, rest = buffer.partition(b"\n")
                if len(line) > MAX_FRAME:
                    raise ValueError("frame limit")
                buffer[:] = rest
                if key.fileobj is connection:
                    sys.stdout.buffer.write(line + b"\n")
                    sys.stdout.buffer.flush()
                else:
                    connection.sendall(line + b"\n")
            if len(buffer) > MAX_FRAME:
                raise ValueError("frame limit")


if __name__ == "__main__":
    main()
