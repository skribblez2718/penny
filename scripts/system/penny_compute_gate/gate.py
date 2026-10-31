"""In-process admission; CLOSED is a drained managed interval, never an idle guess."""

from __future__ import annotations

import asyncio
import contextvars
import functools
import hashlib
import inspect
import json
import threading
import time
from collections.abc import Awaitable, Callable, Coroutine, Generator, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
R = TypeVar("R")
T = TypeVar("T")


class Denied(RuntimeError):
    """No current compute admission. Public callers must not retry as manual work."""


@dataclass(frozen=True)
class Window:
    grant: Mapping[str, object]
    grant_sha256: str
    graph: object
    graph_sha256: str
    prompt_id: str


@dataclass(frozen=True)
class Call:
    window: Window | None
    ended: threading.Event = field(default_factory=threading.Event)


class Gate:
    def __init__(self, synchronize: Callable[[], None]) -> None:
        self._condition = threading.Condition(threading.RLock())
        self._context: contextvars.ContextVar[Call | None] = contextvars.ContextVar(
            "penny_compute_call", default=None
        )
        self._synchronize = synchronize
        self.mode = "manual"
        self.sequence = 1
        self.active = 0
        self.window: Window | None = None
        self.cancelled = False
        self._used: set[str] = set()
        self._claimed = False
        self._renew: Callable[[Window], None] | None = None
        self._terminal = False
        self._uncertain = False
        self._metering = False
        self.ipc_tx = 0
        self.ipc_rx = 0
        self.http_tx = 0
        self.http_rx = 0

    def bind_owner(self, renew: Callable[[Window], None]) -> None:
        with self._condition:
            if self._renew is not None:
                raise Denied("owner already connected")
            self._renew = renew

    def disconnect(self) -> None:
        with self._condition:
            self._renew = None
            if self.mode != "manual":
                self.mode = "draining"
                self.cancelled = True
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            if self.window is not None:
                raise Denied("finish owned window before close")
            self.mode = "draining"
            while self.active:
                if self._renew is None:
                    raise Denied("owner lost while draining")
                self._condition.wait(0.1)
            # No new root admission can race synchronization while mode is draining.
            try:
                self._synchronize()
            except BaseException:
                self._uncertain = True
                raise
            if self._uncertain:
                raise Denied("uncertain work requires process replacement")
            self.mode = "closed"

    def manual(self) -> None:
        with self._condition:
            if self.mode != "closed" or self.active or self.window:
                raise Denied("manual reopen requires closed drained gate")
            self.mode = "manual"

    def open(self, grant_text: str, graph_text: str, prompt_id: str) -> None:
        grant = json.loads(grant_text)
        if not isinstance(grant, dict) or not isinstance(json.loads(graph_text), dict):
            raise Denied("invalid window payload")
        operation = grant.get("operation_record_id")
        with self._condition:
            if (
                self.mode != "closed"
                or self.active
                or self.window is not None
                or self._renew is None
                or self._uncertain
                or grant.get("gate_sequence") != self.sequence
                or not isinstance(operation, str)
                or operation in self._used
                or len(self._used) >= 10000
            ):
                raise Denied("window sequence/replay/state conflict")
            self.window = Window(
                grant,
                hashlib.sha256(grant_text.encode()).hexdigest(),
                json.loads(graph_text),
                hashlib.sha256(graph_text.encode()).hexdigest(),
                prompt_id,
            )
            self._used.add(operation)
            self.sequence += 1
            self._claimed = False
            self._terminal = False
            self.cancelled = False
            self.ipc_tx = self.ipc_rx = self.http_tx = self.http_rx = 0
            self._metering = True
            self.mode = "executing"
        self.check()

    def check(self) -> None:
        with self._condition:
            call = self._context.get()
            if call is not None and call.ended.is_set():
                raise Denied("late inherited compute")
            if self.window is None:
                if self.mode == "manual" or call is not None and call.window is None:
                    return
                raise Denied("compute gate closed")
            if self.cancelled or self.mode != "executing" or self._renew is None:
                raise Denied("owned compute cancelled")
            window, renew = self.window, self._renew
        try:
            renew(window)
        except BaseException:
            with self._condition:
                self.cancelled = True
                self.mode = "draining"
            raise Denied("current catalog check unavailable") from None

    @contextmanager
    def call(
        self, prompt: object = None, prompt_id: object = None, validation: bool = False
    ) -> Iterator[None]:
        nested = self._context.get()
        if nested is not None:
            # A detached inherited task must not reopen an ended call.
            with self._condition:
                if self.active == 0 or nested.ended.is_set():
                    raise Denied("late inherited compute")
                self.active += 1
            try:
                self.check()
                yield
            finally:
                with self._condition:
                    self.active -= 1
                    self._condition.notify_all()
            return
        with self._condition:
            if self.mode == "manual":
                window = None
            elif self.mode == "executing" and self.window is not None:
                window = self.window
                if (
                    (self._claimed and not validation)
                    or prompt_id != window.prompt_id
                    or prompt != window.graph
                ):
                    raise Denied("not the owner-approved graph/job")
                self._claimed = not validation
            else:
                raise Denied("compute gate closed")
            # Comfy's executor and global interrupt state are single-worker APIs.
            if self.active:
                raise Denied("concurrent root compute")
            self.active += 1
            current_call = Call(window)
            token = self._context.set(current_call)
        try:
            self.check()
            yield
        finally:
            with self._condition:
                current_call.ended.set()
                try:
                    self._synchronize()
                except BaseException:
                    self._uncertain = True
                    self.mode = "draining"
                    raise
                finally:
                    self.active -= 1
                    self._context.reset(token)
                    if window is not None and not validation:
                        self._terminal = True
                    self._condition.notify_all()

    def cancel(self) -> None:
        # Never calls Comfy's global interrupt flag or clears any queue.
        with self._condition:
            if self.window is None:
                raise Denied("no owned job")
            self.cancelled = True
            self.mode = "draining"
            self._condition.notify_all()

    def finish(self, queued: bool, running: bool) -> Window:
        with self._condition:
            window = self.window
            if window is None or self.active or queued or running or not self._terminal:
                raise Denied("owned job has no terminal drain proof")
            self._synchronize()
            if self._uncertain:
                raise Denied("device drain uncertain")
            self.window = None
            self.sequence += 1
            self.mode = "closed"
            return window

    def dequeuable(self, prompt_id: object) -> bool:
        with self._condition:
            return self.mode == "manual" or (
                self.mode == "executing"
                and self.window is not None
                and not self.cancelled
                and prompt_id == self.window.prompt_id
            )

    def admission(self, prompt: object, prompt_id: object) -> None:
        with self._condition:
            if self.mode == "manual":
                return
            if (
                self.mode != "executing"
                or self.window is None
                or self.cancelled
                or prompt_id != self.window.prompt_id
                or prompt != self.window.graph
            ):
                raise Denied("manual queue blocked during managed interval")

    def transport(self, kind: str, sent: int, received: int) -> None:
        with self._condition:
            if self._metering:
                if min(sent, received) < 0:
                    raise Denied("negative transport counter")
                if kind == "ipc":
                    self.ipc_tx += sent
                    self.ipc_rx += received
                elif kind == "http":
                    self.http_tx += sent
                    self.http_rx += received
                else:
                    raise Denied("unknown transport")

    def observation(self) -> dict[str, object]:
        with self._condition:
            return {
                "mode": self.mode,
                "sequence": self.sequence,
                "active_calls": self.active,
                "grant_sha256": self.window.grant_sha256 if self.window else None,
                "prompt_id": self.window.prompt_id if self.window else None,
                "graph_sha256": self.window.graph_sha256 if self.window else None,
                "terminal": self._terminal,
                "uncertain": self._uncertain,
                "ipc_tx_bytes": self.ipc_tx,
                "ipc_rx_bytes": self.ipc_rx,
                "http_tx_bytes": self.http_tx,
                "http_rx_bytes": self.http_rx,
                "observed_at_ms": time.time_ns() // 1000000,
            }


async def drain_tasks(
    tasks: list[tuple[Callable[[], bool], Callable[[], bool], Callable[[], Awaitable[object]]]],
) -> None:
    # A cancellation handler may itself spawn another owned task.
    while pending := [t for t in tasks if not t[0]()]:
        for _, cancel, _ in pending:
            cancel()
        await asyncio.gather(*(wait() for _, _, wait in pending), return_exceptions=True)


async def await_result(result: object) -> object:
    if not inspect.isawaitable(result):
        raise Denied("async callable changed")
    return await result


def asynchronous_decorator(
    gate: Gate,
    function: Callable[P, R],
    graph: bool,
    validation: bool,
    parameters: Callable[[tuple[object, ...], dict[str, object]], tuple[object, object]],
) -> Callable[P, object]:
    @functools.wraps(function)
    async def asynchronous(*args: P.args, **kwargs: P.kwargs) -> object:
        prompt, prompt_id = parameters(args, kwargs)
        loop = asyncio.get_running_loop()
        prior = loop.get_task_factory()
        owning_call: Call | None = None
        tasks: list[
            tuple[Callable[[], bool], Callable[[], bool], Callable[[], Awaitable[object]]]
        ] = []

        def factory(
            loop: asyncio.AbstractEventLoop,
            coro: Coroutine[object, object, T] | Generator[object, None, T],
            /,
            context: contextvars.Context | None = None,
        ) -> asyncio.Task[T]:
            if not isinstance(coro, Coroutine):
                raise Denied("generator-based task unsupported")
            task: asyncio.Task[T] = asyncio.Task(coro, loop=loop, context=context)

            async def wait() -> object:
                return await task

            inherited = gate._context.get() if context is None else context.get(gate._context)
            if owning_call is not None and inherited is owning_call:
                tasks.append((task.done, task.cancel, wait))
            return task

        # Only the graph executor owns task lifetime; nested map calls must not
        # await pending-node tasks before Comfy has resolved their dependencies.
        if graph:
            if prior is not None:
                raise Denied("unqualified event-loop task factory")
            loop.set_task_factory(factory)
        try:
            with gate.call(prompt, prompt_id, validation):
                owning_call = gate._context.get()
                try:
                    return await await_result(function(*args, **kwargs))
                finally:
                    if graph:
                        await drain_tasks(tasks)
        finally:
            if graph:
                loop.set_task_factory(prior)

    return asynchronous


def compute_decorator(
    gate: Gate, function: Callable[P, R], graph: bool = False, validation: bool = False
) -> Callable[P, object]:
    signature = inspect.signature(function)

    def parameters(args: tuple[object, ...], kwargs: dict[str, object]) -> tuple[object, object]:
        if not graph:
            return None, None
        bound = signature.bind(*args, **kwargs)
        return bound.arguments.get("prompt"), bound.arguments.get("prompt_id")

    if inspect.iscoroutinefunction(function):
        return asynchronous_decorator(gate, function, graph, validation, parameters)

    @functools.wraps(function)
    def synchronous(*args: P.args, **kwargs: P.kwargs) -> R:
        prompt, prompt_id = parameters(args, kwargs)
        with gate.call(prompt, prompt_id, validation):
            return function(*args, **kwargs)

    return synchronous
