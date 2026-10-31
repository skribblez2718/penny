"""Build a source-pinned diff into caller output. Never writes the backend."""

from __future__ import annotations

import argparse
import ast
import difflib
import hashlib
import json
import os
import tempfile
from pathlib import Path

QUEUE_GET = """        deadline = None if timeout is None else time.monotonic() + timeout
        with self.not_empty:
            while True:
                eligible = [x for x in self.queue if _penny_gate.GATE.dequeuable(x[1])]
                if eligible:
                    item = min(eligible)
                    self.queue.remove(item)
                    heapq.heapify(self.queue)
                    i = self.task_counter
                    self.currently_running[i] = copy.deepcopy(item)
                    self.task_counter += 1
                    self.server.queue_updated()
                    return item, i
                if deadline is not None and time.monotonic() >= deadline:
                    return None
                if _penny_gate.GATE.mode != "manual":
                    self.not_empty.wait(timeout=0.1)
                    return None
                self.not_empty.wait(timeout=None if deadline is None else max(0, deadline - time.monotonic()))
"""

START = """    def penny_synchronize():
        # Synchronize every visible device, not merely the current CUDA device.
        for device in comfy.model_management.get_all_torch_devices():
            if device.type == "cuda":
                comfy.model_management.torch.cuda.synchronize(device)
            elif device.type != "cpu":
                raise _penny_gate.Denied("unqualified device synchronization")

    def penny_queue_state(prompt_id, cancel_pending):
        q = prompt_server.prompt_queue
        with q.mutex:
            if cancel_pending:
                q.queue = [item for item in q.queue if item[1] != prompt_id]
                import heapq
                heapq.heapify(q.queue)
                q.not_empty.notify_all()
            return (any(item[1] == prompt_id for item in q.queue),
                    any(item[1] == prompt_id for item in q.currently_running.values()))

    def penny_submit(window):
        async def prepare():
            # Only the authenticated private connection calls this closure. Public
            # prompt handlers, replacements and client IDs cannot select the graph.
            import copy
            prompt = copy.deepcopy(window.graph)
            valid = await execution.validate_prompt(window.prompt_id, prompt, None)
            if not valid[0] or prompt != window.graph:
                raise _penny_gate.Denied("approved graph changed during validation")
            q = prompt_server.prompt_queue
            with q.mutex:
                if any(item[1] == window.prompt_id for item in q.queue) or any(
                    item[1] == window.prompt_id for item in q.currently_running.values()
                ) or window.prompt_id in q.history:
                    raise _penny_gate.Denied("duplicate owned job")
                q.put((prompt_server.number, window.prompt_id, prompt, {}, valid[2], {}))
                prompt_server.number += 1
        asyncio.run_coroutine_threadsafe(prepare(), asyncio_loop).result()

    _penny_gate.start(penny_synchronize, penny_submit, penny_queue_state)
"""


def atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".gate-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()


DEFINITION_TARGETS = {
    "execution.py": {"execute", "_async_map_node_over_list", "get_output_data", "validate_inputs"},
    "comfy/model_management.py": {
        "load_models_gpu",
        "load_model_gpu",
        "model_load",
        "model_use_more_vram",
        "use_more_memory",
        "throw_exception_if_processing_interrupted",
    },
    "comfy/model_prefetch.py": {
        "prefetch_queue_pop",
        "pin_modules",
        "malloc_graph_begin",
        "malloc_graph_end",
    },
    "comfy/model_patcher.py": {
        "load",
        "partially_load",
        "patch_model",
        "clone",
        "deepclone_multigpu",
        "apply_model",
        "pre_run",
    },
    "comfy/sample.py": {"sample", "sample_custom", "prepare_noise", "calc_cond_batch"},
    "comfy/samplers.py": {"sample", "sample_custom", "prepare_noise", "calc_cond_batch"},
}
SD_METHODS = {
    "__init__",
    "clone",
    "generate",
    "encode",
    "encode_from_tokens",
    "encode_from_tokens_scheduled",
    "decode",
    "encode_tiled",
    "decode_tiled",
    "prepare_decode",
}


def legacy_function_names(tree: ast.Module, owner_name: str) -> set[str]:
    functions = {"execute"}
    owners = (x for x in ast.walk(tree) if isinstance(x, ast.ClassDef) and x.name == owner_name)
    for owner in owners:
        for member in owner.body:
            if not isinstance(member, ast.Assign) or not isinstance(member.value, ast.Constant):
                continue
            if any(isinstance(t, ast.Name) and t.id == "FUNCTION" for t in member.targets):
                if isinstance(member.value.value, str):
                    functions.add(member.value.value)
    return functions


def definition_decorator(
    name: str,
    symbol: str,
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    parents: tuple[str, ...],
    tree: ast.Module,
) -> str | None:
    if name == "execution.py":
        special = {
            "PromptExecutor.execute": "graph",
            "PromptExecutor.execute_async": "graph",
            "validate_prompt": "validation",
            "PromptQueue.put": "queue_put",
        }
        if symbol in special:
            return special[symbol]
    if node.name in DEFINITION_TARGETS.get(name, set()):
        return "compute"
    if name == "comfy/sd.py":
        if node.name.startswith("load_") or sd_method(parents, node.name):
            return "compute"
    if (name == "nodes.py" or name.startswith("comfy_extras/")) and parents:
        if node.name in legacy_function_names(tree, parents[0]):
            return "compute"
    return None


def sd_method(parents: tuple[str, ...], name: str) -> bool:
    return bool(parents) and parents[0] in {"CLIP", "VAE"} and name in SD_METHODS


def startup_patch(name: str, source: str) -> tuple[str, list[str]]:
    coverage: list[str] = []
    if name == "main.py":
        anchor = "from comfy.cli_args import get_console_log_level, get_file_log_outputs\n"
        if source.count(anchor) != 1:
            raise ValueError("main startup anchor drift")
        source = source.replace(
            anchor,
            anchor
            + '_penny_gate.verify_install()\nif not args.disable_all_custom_nodes or args.whitelist_custom_nodes or not args.disable_api_nodes or args.enable_manager:\n    raise _penny_gate.Denied("managed build requires disabled custom/API nodes and manager")\n',
        )
        anchor = "    threading.Thread(target=prompt_worker, daemon=True, args=(prompt_server.prompt_queue, prompt_server, asset_manager)).start()\n"
        if source.count(anchor) != 1:
            raise ValueError("post-import worker startup anchor drift")
        # No private CLOSED observation is possible while built-in node imports
        # and normal startup initialization are still in progress.
        source = source.replace(anchor, START + anchor)
        anchor = "            e.execute(item[2], prompt_id, extra_data, item[4])\n"
        if source.count(anchor) != 1:
            raise ValueError("worker execute anchor drift")
        source = source.replace(
            anchor,
            """            try:
                e.execute(item[2], prompt_id, extra_data, item[4])
            except _penny_gate.Denied:
                e.history_result = {"outputs": {}}
                e.success = False
                e.status_messages = [("execution_error", {"prompt_id": prompt_id, "exception_message": "compute gate closed"})]
""",
        )
        source = source.replace(
            "        flags = q.get_flags()\n",
            '        if _penny_gate.GATE.mode != "manual":\n            continue\n        flags = q.get_flags()\n',
        )
        coverage.extend(
            ["startup-before-prestartup", "private-submit", "worker-denial", "park-maintenance"]
        )
    elif name == "server.py":
        anchor = "        middlewares = [cache_control, deprecation_warning]\n"
        if source.count(anchor) != 1:
            raise ValueError("middleware startup anchor drift")
        source = source.replace(
            anchor,
            """        @web.middleware
        async def penny_managed_http(request, handler):
            if _penny_gate.GATE.mode != "manual" and (request.method not in {"GET", "HEAD", "OPTIONS"} or request.path.endswith("/ws")):
                return web.json_response({"error": "native_compute_owned"}, status=423)
            return await handler(request)

        middlewares = [penny_managed_http, cache_control, deprecation_warning]
""",
        )
        coverage.append("all-public-mutations-and-ws")
    return source, coverage


def transform(name: str, source: str) -> tuple[str, list[str]]:
    source = source.removeprefix("\ufeff")
    tree = ast.parse(source)
    lines = source.splitlines(keepends=True)
    insertions: list[tuple[int, int, str]] = []
    coverage: list[str] = []

    def visit(body: list[ast.stmt], parents: tuple[str, ...] = ()) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                visit(node.body, (*parents, node.name))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                symbol = ".".join((*parents, node.name))
                if name == "execution.py" and symbol == "PromptQueue.get":
                    insertions.append(
                        (node.body[0].lineno - 1, node.end_lineno or node.lineno, QUEUE_GET)
                    )
                    coverage.append(symbol)
                decorator = definition_decorator(name, symbol, node, parents, tree)
                if decorator:
                    insertions.append(
                        (
                            node.lineno - 1,
                            node.lineno - 1,
                            " " * node.col_offset + f"@_penny_gate.{decorator}\n",
                        )
                    )
                    coverage.append(symbol)

    visit(tree.body)
    source, startup_points = startup_patch(name, source)
    coverage.extend(startup_points)
    if startup_points:
        lines = source.splitlines(keepends=True)
    for start, end, value in sorted(insertions, reverse=True):
        lines[start:end] = [value]
    if not coverage:
        return source, coverage
    return add_import("".join(lines), name), coverage


def add_import(output: str, name: str) -> str:
    # Preserve future-import placement, if the selected upstream module uses it.
    parsed = ast.parse(output)
    at = 0
    for node in parsed.body:
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            at = node.end_lineno or node.lineno
        elif (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            at = node.end_lineno or node.lineno
        else:
            break
    lines = output.splitlines(keepends=True)
    lines.insert(at, "import penny_compute_gate.bootstrap as _penny_gate\n")
    output = "".join(lines)
    compile(output, name, "exec")
    return output


def build(root: Path, output: Path) -> None:
    root = root.resolve(strict=True)
    output = output.absolute()
    if output == root or root in output.parents or output.exists():
        raise ValueError("output must be new and outside backend")
    candidates = [
        "main.py",
        "server.py",
        "execution.py",
        "nodes.py",
        "comfy/model_management.py",
        "comfy/model_patcher.py",
        "comfy/model_prefetch.py",
        "comfy/sd.py",
        "comfy/sample.py",
        "comfy/samplers.py",
    ]
    candidates.extend(
        str(p.relative_to(root)) for p in sorted(root.joinpath("comfy_extras").glob("*.py"))
    )
    changed: dict[str, bytes] = {}
    before: dict[str, str] = {}
    coverage: dict[str, list[str]] = {}
    diff: list[str] = []
    for name in candidates:
        original_bytes = root.joinpath(name).read_bytes()
        original = original_bytes.decode("utf-8")
        patched, points = transform(name, original)
        if not points:
            continue
        before[name] = hashlib.sha256(original_bytes).hexdigest()
        coverage[name] = points
        changed[name] = patched.encode()
        diff.extend(
            difflib.unified_diff(
                original.splitlines(True),
                patched.splitlines(True),
                fromfile="a/" + name,
                tofile="b/" + name,
            )
        )
    package = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(Path(__file__).parent.glob("*.py"))
    }
    manifest = {
        "schema_id": "penny.compute-gate-build.v1",
        "schema_version": 1,
        "sources": {k: hashlib.sha256(v).hexdigest() for k, v in changed.items()},
        "package": package,
        "original_sources": before,
        "entrypoints": coverage,
    }
    # Validate every generated Python module and the complete manifest before publication.
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    json.loads(encoded)
    for name, content in changed.items():
        compile(content, name, "exec")
    for name, content in changed.items():
        atomic(output / "patched" / name, content)
    atomic(output / "backend.patch", "".join(diff).encode())
    atomic(output / "build.json", encoded)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.source_root, args.output)


if __name__ == "__main__":
    main()
