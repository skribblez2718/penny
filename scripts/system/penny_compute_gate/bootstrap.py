"""Definition-time hooks for a caller-pinned Comfy source installation."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import threading
from collections.abc import Callable
from pathlib import Path
from typing import ParamSpec, TypeVar

from .gate import Denied, Gate, Window, compute_decorator
from .ipc import Session, private_listener, process_identity, record, serve, text

P = ParamSpec("P")
R = TypeVar("R")


def _not_started() -> None:
    raise Denied("gate startup not complete")


GATE = Gate(_not_started)
_CONFIG: dict[str, object] | None = None
_BUILD = ""


def verify_install() -> None:
    global _CONFIG, _BUILD
    config_path = Path(os.environ["PENNY_COMPUTE_GATE_CONFIG"])
    if not config_path.is_absolute():
        raise Denied("absolute configuration path required")
    metadata = config_path.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise Denied("configuration must be service-owner private")
    config = record(json.loads(config_path.read_bytes()))
    if set(config) != {
        "source_root",
        "build_file",
        "socket_path",
        "socket_fd",
        "permitted_uid",
        "worker_id",
    }:
        raise Denied("configuration fields")
    manifest_path = Path(text(config["build_file"]))
    manifest_bytes = manifest_path.read_bytes()
    manifest = record(json.loads(manifest_bytes))
    root = Path(text(config["source_root"])).resolve(strict=True)
    sources = record(manifest["sources"])
    package = record(manifest["package"])
    for base, entries in ((root, sources), (Path(__file__).parent, package)):
        for name, digest in entries.items():
            path = base / name
            if (
                path.resolve(strict=True).parent != base
                and base not in path.resolve(strict=True).parents
            ):
                raise Denied("build source escapes root")
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise Denied("installed gate source drift")
    _CONFIG = config
    _BUILD = hashlib.sha256(manifest_bytes).hexdigest()


def compute(function: Callable[P, R]) -> Callable[P, object]:
    return compute_decorator(GATE, function)


def graph(function: Callable[P, R]) -> Callable[P, object]:
    return compute_decorator(GATE, function, graph=True)


def validation(function: Callable[P, R]) -> Callable[P, object]:
    return compute_decorator(GATE, function, graph=True, validation=True)


def queue_put(function: Callable[P, R]) -> Callable[P, R]:
    def guarded(*args: P.args, **kwargs: P.kwargs) -> R:
        if len(args) != 2 or not isinstance(args[1], tuple) or len(args[1]) < 3:
            raise Denied("queue item shape")
        GATE.admission(args[1][2], args[1][1])
        return function(*args, **kwargs)

    return guarded


def start(
    synchronize: Callable[[], None],
    submit: Callable[[Window], None],
    queue_state: Callable[[str, bool], tuple[bool, bool]],
) -> None:
    if _CONFIG is None:
        raise Denied("source verification missing")
    GATE._synchronize = synchronize
    permitted = _CONFIG["permitted_uid"]
    if not isinstance(permitted, int) or isinstance(permitted, bool) or permitted < 0:
        raise Denied("invalid peer UID")
    descriptor = _CONFIG["socket_fd"]
    if descriptor is None:
        listener = private_listener(Path(text(_CONFIG["socket_path"])), permitted)
    elif isinstance(descriptor, int) and descriptor >= 3:
        listener = socket.socket(fileno=descriptor)
        if listener.family != socket.AF_UNIX or not listener.getsockopt(
            socket.SOL_SOCKET, socket.SO_ACCEPTCONN
        ):
            raise Denied("provisioned FD is not listening AF_UNIX")
    else:
        raise Denied("invalid provisioned socket FD")
    identity = process_identity(os.getpid())
    identity["worker_id"] = _CONFIG["worker_id"]
    threading.Thread(
        target=serve,
        args=(
            listener,
            lambda connection: Session(
                connection, GATE, permitted, identity, _BUILD, submit, queue_state
            ),
        ),
        daemon=True,
    ).start()
