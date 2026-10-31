"""GPU-free tests; optional actual-source checks require an explicit backend root."""

import ast
import asyncio
import copy
import contextvars
import hashlib
import heapq
import json
import os
import socket
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import List, Literal, NamedTuple, Optional

import pytest

from penny_compute_gate import bootstrap
from penny_compute_gate.bundle import build, transform
from penny_compute_gate.gate import Denied, Gate, compute_decorator
from penny_compute_gate.ipc import Frames, Session, peer, process_identity

GRAPH = {"1": {"class_type": "Fake", "inputs": {"text": "approved"}}}
GRANT = {"operation_record_id": "hop_" + "a" * 64, "gate_sequence": 1}


def closed_gate(synchronize=lambda: None):
    gate = Gate(synchronize)
    gate.bind_owner(lambda window: None)
    gate.close()
    return gate


def open_gate(gate):
    gate.open(json.dumps(GRANT), json.dumps(GRAPH), "owned")


def test_unmanaged_is_never_reported_closed_and_manual_works():
    gate = Gate(lambda: None)
    assert gate.observation()["mode"] == "manual"
    compute_decorator(gate, lambda: 42)()
    assert gate.observation()["mode"] == "manual"


def test_closed_early_alternate_model_and_unbound_direct_entry_refuse():
    gate = closed_gate()
    calls = []
    fn = compute_decorator(gate, lambda: calls.append("bad"))
    for _ in range(3):
        with pytest.raises(Denied):
            fn()
    assert calls == []
    open_gate(gate)
    with pytest.raises(Denied, match="approved"):
        fn()


def test_exact_graph_one_execution_late_call_replay_sequence_and_owned_drain():
    gate = closed_gate()
    open_gate(gate)
    graph = copy.deepcopy(GRAPH)
    graph["1"]["inputs"]["text"] = "other"
    with pytest.raises(Denied):
        with gate.call(graph, "owned"):
            pytest.fail("wrong graph ran")
    with gate.call(GRAPH, "owned"):
        gate.check()
        with pytest.raises(Denied):
            gate.finish(False, False)
    with pytest.raises(Denied):
        with gate.call(GRAPH, "owned"):
            pytest.fail("replay ran")
    with pytest.raises(Denied):
        gate.finish(True, False)
    gate.finish(False, False)
    assert gate.observation()["sequence"] == 3
    with pytest.raises(Denied):
        open_gate(gate)
    assert gate.mode == "closed"


def test_close_drains_old_manual_work_and_refuses_new_roots():
    entered, release, drained = threading.Event(), threading.Event(), threading.Event()
    gate = Gate(lambda: None)
    gate.bind_owner(lambda window: None)

    def old_manual():
        with gate.call():
            entered.set()
            assert release.wait(3)
            with gate.call():
                pass  # Existing manual work can finish while new admission is closed.

    worker = threading.Thread(target=old_manual)
    worker.start()
    assert entered.wait(3)
    closer = threading.Thread(target=lambda: (gate.close(), drained.set()))
    closer.start()
    assert not drained.wait(0.05)
    with pytest.raises(Denied):
        with gate.call():
            pytest.fail("new manual work ran")
    release.set()
    worker.join(3)
    closer.join(3)
    assert drained.is_set() and gate.mode == "closed"


def test_disconnect_closes_only_owned_admission_and_requires_drain():
    gate = closed_gate()
    open_gate(gate)
    with gate.call(GRAPH, "owned"):
        gate.disconnect()
        assert not gate.dequeuable("unrelated")
        with pytest.raises(Denied):
            gate.check()
        with pytest.raises(Denied):
            gate.finish(False, True)
    gate.finish(False, False)
    assert gate.mode == "closed"


def test_failed_device_sync_never_exports_closed():
    calls = [0]

    def synchronize():
        calls[0] += 1
        if calls[0] > 1:
            raise OSError("device lost")

    gate = closed_gate(synchronize)
    open_gate(gate)
    with pytest.raises(OSError):
        with gate.call(GRAPH, "owned"):
            pass
    assert gate.active == 0 and gate.mode == "draining"
    with pytest.raises(OSError):
        gate.finish(False, False)


def test_catalog_revocation_stops_check_without_grant_expiry_timer():
    gate = closed_gate()
    open_gate(gate)
    gate._renew = lambda window: (_ for _ in ()).throw(Denied("stale fence"))
    with pytest.raises(Denied):
        with gate.call(GRAPH, "owned"):
            pytest.fail("revoked work ran")
    assert gate.mode == "draining"


def test_async_executor_drains_spawned_task_before_closed():
    gate = closed_gate()
    open_gate(gate)
    drained = []

    async def leftover():
        try:
            await asyncio.sleep(30)
        finally:
            drained.append(True)

    async def execute_async(prompt, prompt_id):
        asyncio.create_task(leftover())
        await asyncio.sleep(0)

    asyncio.run(compute_decorator(gate, execute_async, graph=True)(GRAPH, "owned"))
    assert drained == [True]
    gate.finish(False, False)


def test_async_drain_does_not_cancel_unrelated_loop_tasks():
    gate = closed_gate()
    open_gate(gate)
    survivor = []

    async def unrelated():
        await asyncio.sleep(0.02)
        survivor.append(True)

    async def execute_async(prompt, prompt_id):
        await asyncio.sleep(0)

    async def run():
        outside = asyncio.create_task(unrelated())
        await compute_decorator(gate, execute_async, graph=True)(GRAPH, "owned")
        await outside

    asyncio.run(run())
    assert survivor == [True]
    gate.finish(False, False)


def test_inherited_thread_work_remains_counted_after_root_exit():
    gate = closed_gate()
    open_gate(gate)
    entered, release = threading.Event(), threading.Event()

    def background():
        with gate.call():
            entered.set()
            assert release.wait(3)
            with pytest.raises(Denied, match="late inherited"):
                gate.check()

    with gate.call(GRAPH, "owned"):
        context = contextvars.copy_context()
        worker = threading.Thread(target=lambda: context.run(background))
        worker.start()
        assert entered.wait(3)
    assert gate.active == 1
    with pytest.raises(Denied):
        gate.finish(False, False)
    release.set()
    worker.join(3)
    assert not worker.is_alive()
    gate.finish(False, False)


def test_crash_cancellation_of_pending_owned_item_preserves_foreign_queue():
    gate = closed_gate()
    open_gate(gate)
    pending = ["foreign", "owned"]

    def state(prompt_id, cancel):
        if cancel and prompt_id in pending:
            pending.remove(prompt_id)
        return prompt_id in pending, False

    service, owner = socket.socketpair()
    session = Session(service, gate, os.getuid(), {}, "", lambda w: None, state)
    session.cancel_owned()
    assert pending == ["foreign"]
    session.finish_owned()
    assert gate.mode == "closed" and gate.sequence == 3
    service.close()
    owner.close()


def test_real_kernel_peer_challenge_payload_and_self_counted_ipc():
    service, owner = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    owner.settimeout(3)
    gate = Gate(lambda: None)
    queue = []
    session = Session(
        service,
        gate,
        os.getuid(),
        {"worker_id": "fake"},
        "b" * 64,
        lambda window: queue.append(window.prompt_id),
        lambda prompt_id, cancel: (prompt_id in queue, False),
    )
    errors = []

    def run():
        try:
            session.run()
        except (OSError, ConnectionError) as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    frames = Frames(owner)
    hello = frames.receive()
    assert hello["peer"] == peer(service)
    frames.send({"type": "claim", "challenge": hello["challenge"], "owner_challenge": "c" * 64})
    assert frames.receive()["type"] == "claimed"

    def command(op, **fields):
        frames.send({"type": "command", "id": op, "op": op, **fields})
        while True:
            response = frames.receive()
            if response["type"] == "check":
                frames.send(
                    {
                        "type": "current",
                        "id": response["id"],
                        "grant_sha256": response["grant_sha256"],
                    }
                )
            else:
                assert response["ok"] is True
                return response["observation"]

    assert command("close")["mode"] == "closed"
    assert (
        command(
            "open",
            grant_json=json.dumps({**GRANT, "worker_id": "fake"}),
            graph_json=json.dumps(GRAPH),
            prompt_id="owned",
        )["mode"]
        == "executing"
    )
    assert command("submit")["prompt_id"] == "owned"
    assert queue == ["owned"]
    # Synchronous fake compute still consults the real IPC owner at entry/check.
    compute = threading.Thread(
        target=lambda: compute_decorator(gate, lambda prompt, prompt_id: None, graph=True)(
            GRAPH, "owned"
        )
    )
    compute.start()
    response = frames.receive()
    assert response["type"] == "check"
    frames.send({"type": "current", "id": response["id"], "grant_sha256": response["grant_sha256"]})
    compute.join(3)
    assert not compute.is_alive()
    queue.clear()  # Isolated fake queue, never a backend operation.
    final = command("finish")
    assert final["mode"] == "closed"
    # The peer can receive the frame before send returns and commits its byte
    # count. The public snapshot takes the same lock as result accounting.
    settled = gate.observation()
    assert final["ipc_tx_bytes"] == settled["ipc_tx_bytes"]
    assert final["ipc_rx_bytes"] == settled["ipc_rx_bytes"]
    assert final["ipc_tx_bytes"] > 0 and final["http_tx_bytes"] == 0
    owner.close()
    thread.join(3)
    service.close()
    assert not thread.is_alive()


def test_wrong_native_uid_and_challenge_reject_without_claiming_owner():
    service, owner = socket.socketpair()
    session = Session(
        service,
        Gate(lambda: None),
        os.getuid() + 1,
        {},
        "",
        lambda w: None,
        lambda p, c: (False, False),
    )
    with pytest.raises(Denied, match="UID"):
        session.run()
    service.close()
    owner.close()


def test_process_identity_matches_native_canonical_epoch():
    identity = process_identity(os.getpid())
    assert len(identity["process_epoch"]) == 64
    assert identity["pid"] == os.getpid()


def test_definition_time_patch_not_client_id_authority_and_no_backend_writes(tmp_path):
    source = "class PromptExecutor:\n    def execute(self, prompt, prompt_id):\n        return 1\n    async def execute_async(self, prompt, prompt_id):\n        return 2\n"
    patched, points = transform("execution.py", source)
    assert points == ["PromptExecutor.execute", "PromptExecutor.execute_async"]
    assert patched.count("@_penny_gate.graph") == 2
    assert any(
        isinstance(n, ast.Import)
        and any(
            a.name == "penny_compute_gate.bootstrap" and a.asname == "_penny_gate" for a in n.names
        )
        for n in ast.parse(patched).body
    )
    namespace = {}
    exec(compile(patched, "test", "exec"), namespace)
    gate = closed_gate()
    previous = bootstrap.GATE
    bootstrap.GATE = gate
    try:
        with pytest.raises(Denied):
            namespace["PromptExecutor"]().execute(GRAPH, "manual")
    finally:
        bootstrap.GATE = previous
    with pytest.raises(ValueError):
        transform("main.py", "print('unsupported source')\n")


def test_actual_available_comfy_executor_queue_model_load_no_gpu(tmp_path, monkeypatch):
    # Explicit caller path only; portable tests do not discover a backend.
    selected = os.environ.get("PENNY_COMFY_SOURCE_TEST_ROOT")
    if selected is None:
        pytest.skip(
            "explicit backend source root not supplied; actual-source qualification NOT RUN"
        )
    root = Path(selected)
    output = tmp_path / "bundle"
    original = root.joinpath("execution.py").read_bytes()
    build(root, output)
    assert root.joinpath("execution.py").read_bytes() == original
    manifest = json.loads(output.joinpath("build.json").read_bytes())
    assert "PromptExecutor.execute_async" in manifest["entrypoints"]["execution.py"]
    assert "load_models_gpu" in manifest["entrypoints"]["comfy/model_management.py"]
    for name, digest in manifest["original_sources"].items():
        assert hashlib.sha256(root.joinpath(name).read_bytes()).hexdigest() == digest
    for name in manifest["sources"]:
        assert (
            "import penny_compute_gate.bootstrap as _penny_gate"
            in output.joinpath("patched", name).read_text()
        )
    startup = output.joinpath("patched/main.py").read_text()
    assert startup.index("nodes.init_extra_nodes(") < startup.index("_penny_gate.start(")
    assert "prefetch_queue_pop" in manifest["entrypoints"]["comfy/model_prefetch.py"]
    tree = ast.parse(output.joinpath("patched/execution.py").read_text())
    classes = [
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name in {"PromptExecutor", "PromptQueue"}
    ]
    namespace = dict(
        _penny_gate=bootstrap,
        asyncio=asyncio,
        threading=threading,
        heapq=heapq,
        copy=copy,
        time=time,
        NamedTuple=NamedTuple,
        Optional=Optional,
        Literal=Literal,
        List=List,
        MAXIMUM_HISTORY_SIZE=10000,
    )
    # Deferred annotations preserve upstream class code without importing Torch.
    module = ast.Module(
        body=[
            ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
            *classes,
        ],
        type_ignores=[],
    )
    gate = closed_gate()
    monkeypatch.setattr(bootstrap, "GATE", gate)
    exec(compile(ast.fix_missing_locations(module), "actual-execution-classes", "exec"), namespace)
    executor_class = namespace["PromptExecutor"]
    executor = executor_class.__new__(executor_class)
    with pytest.raises(Denied):
        executor.execute(GRAPH, "unrelated")
    with pytest.raises(Denied):
        asyncio.run(executor.execute_async(GRAPH, "unrelated"))
    queue = namespace["PromptQueue"](SimpleNamespace(queue_updated=lambda: None))
    with pytest.raises(Denied):
        queue.put((1, "manual", GRAPH, {}, [], {}))
    gate.manual()
    queue.put((1, "manual", GRAPH, {}, [], {}))
    gate.close()
    assert queue.get(0.01) is None
    assert len(queue.queue) == 1
    open_gate(gate)
    queue.put((2, "owned", GRAPH, {}, [], {}))
    item, task = queue.get(0.01)
    assert item[1] == "owned" and queue.queue[0][1] == "manual"

    async def fake_execute(prompt, prompt_id, extra_data, execute_outputs):
        assert prompt == GRAPH and prompt_id == "owned"

    executor.execute_async = fake_execute
    executor.execute(item[2], item[1], {}, [])
    queue.task_done(task, {"outputs": {}}, None)
    gate.finish(False, False)
    assert len(queue.queue) == 1
    load_tree = ast.parse(output.joinpath("patched/comfy/model_management.py").read_text())
    load = next(
        n for n in load_tree.body if isinstance(n, ast.FunctionDef) and n.name == "load_models_gpu"
    )
    exec(
        compile(
            ast.fix_missing_locations(ast.Module(body=[load], type_ignores=[])),
            "actual-model-loader",
            "exec",
        ),
        namespace,
    )
    with pytest.raises(Denied):
        namespace["load_models_gpu"]([])
    replay_tree = ast.parse(output.joinpath("patched/comfy/model_prefetch.py").read_text())
    replay = next(
        n
        for n in replay_tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "prefetch_queue_pop"
    )
    exec(
        compile(
            ast.fix_missing_locations(ast.Module(body=[replay], type_ignores=[])),
            "actual-cached-replay",
            "exec",
        ),
        namespace,
    )
    with pytest.raises(Denied):
        namespace["prefetch_queue_pop"](None, None, None)
