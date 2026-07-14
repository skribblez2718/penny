#!/usr/bin/env python3
"""Generate one or more images via the ComfyUI API with full provenance.

An enhanced descendant of the blog-folder ``comfy-generate.py``: same "every knob
is a node input, override with ``--set NODE.field=value``" ergonomics, now with a
bounded ``--count`` (candidates, clamped to 10), a random seed when none is given,
a reproducibility ``--manifest``, and validated override parsing — all routed
through the hardened ``comfy_http`` client (loopback allow-list + /view traversal
guards + dict-built payloads).

Entry-point robustness: this script adds its OWN directory to ``sys.path`` at load
time so ``import comfy_http`` resolves no matter what cwd a runner uses (the
recurring "runner changed cwd, sibling import broke" bug class).

Examples
--------
# Three candidates from the hero preset, random seeds, with a manifest:
python3 comfy-generate.py hero-flux \\
    --set 3.text="a glowing abstract data construct" --count 3 \\
    --out /tmp/imagegen_run --manifest /tmp/imagegen_run/manifest.json

# Reproduce an exact prior render (fixed seed):
python3 comfy-generate.py blog-flux-steampunk \\
    --set 3.text="steampunk owl professor" --seed 777
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

# --- entry-point robustness: put our own dir on sys.path BEFORE the import -----
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import comfy_http as ch  # noqa: E402 - must follow the sys.path insert above

_SEED_MAX = 2**32 - 1


def random_seed() -> int:
    """A fresh random seed in ComfyUI's accepted range."""
    return random.randint(0, _SEED_MAX)


def plan_seeds(base_seed: int | None, count: int) -> list[int]:
    """Deterministic per-candidate seed plan: ``[base, base+1, ...]``. A ``None``
    base draws one random seed so the batch is still internally reproducible (each
    candidate's seed is recorded in the manifest)."""
    base = random_seed() if base_seed is None else int(base_seed)
    return [(base + i) % (_SEED_MAX + 1) for i in range(max(1, count))]


def resolve_graph(graph_arg: str, base_dir: str | Path | None = None) -> tuple[dict, str | None]:
    """Resolve the graph argument to ``(graph_dict, preset_name_or_None)``.

    A known preset name loads the shipped preset (validated, no filesystem
    traversal); anything else is treated as a path to an ``*.api.json`` file.
    """
    if graph_arg in ch.PRESET_FIELDS:
        return ch.load_preset(graph_arg, base_dir), graph_arg
    with open(graph_arg, encoding="utf-8") as handle:
        return json.load(handle), None


def build_manifest(
    *,
    preset: str | None,
    graph_arg: str,
    seeds: list[int],
    overrides: list[str],
    host: str,
    outputs: list[dict],
    comfy_version: str = "",
) -> dict:
    """Assemble a provenance manifest that enables byte-identical reproduction.

    Records the preset, the exact ``--set`` overrides, the per-candidate seed +
    constructed-graph hash, and the produced file paths (paths + metadata only —
    never image bytes)."""
    return {
        "schema": "imagegen/manifest@1",
        "preset": preset,
        "graph_arg": graph_arg,
        "host": host,
        "comfy_version": comfy_version,
        "overrides": list(overrides),
        "candidates": outputs,
        "seeds": seeds,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _wait_for_outputs(client: "ch.ComfyClient", prompt_id: str, timeout: int) -> list[dict]:
    """Poll /history until the prompt's outputs appear (or the deadline lapses)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        history = client.history(prompt_id)
        record = history.get(prompt_id)
        if not record:
            continue
        images: list[dict] = []
        for out in (record.get("outputs") or {}).values():
            for img in out.get("images", []) or []:
                images.append(img)
        if images:
            return images
    raise ch.ComfyError(f"timed out waiting for prompt {prompt_id}")


def generate_candidates(
    *,
    graph_arg: str,
    overrides: list[str],
    seeds: list[int],
    host: str,
    out_dir: str,
    timeout: int,
    base_dir: str | Path | None = None,
) -> tuple[list[dict], list[str]]:
    """Submit each candidate ONE AT A TIME (never concurrent), poll, and download.

    Returns ``(candidate_records, errors)``. A per-candidate failure is captured
    (partial-batch honesty) rather than aborting the whole run — any candidates
    that already succeeded stay on disk.
    """
    client = ch.ComfyClient(host, allowed_hosts={host} if host != ch.DEFAULT_COMFY_HOST else None)
    os.makedirs(out_dir, exist_ok=True)
    records: list[dict] = []
    errors: list[str] = []
    for index, seed in enumerate(seeds):
        try:
            base_graph, preset = resolve_graph(graph_arg, base_dir)
            ch.apply_set_overrides(base_graph, list(overrides) + [f"7.seed={seed}"])
            prompt_id = client.submit(base_graph)
            images = _wait_for_outputs(client, prompt_id, timeout)
            saved: list[str] = []
            for img in images:
                dest = os.path.join(out_dir, f"cand{index}_{img['filename']}")
                saved.append(
                    client.download_image(
                        filename=img["filename"],
                        subfolder=img.get("subfolder", ""),
                        type=img.get("type", "output"),
                        dest=dest,
                    )
                )
            records.append(
                {
                    "index": index,
                    "seed": seed,
                    "prompt_id": prompt_id,
                    "graph_sha256": ch.graph_hash(base_graph),
                    "files": saved,
                }
            )
        except ch.ComfyError as exc:
            errors.append(f"candidate {index} (seed {seed}) failed: {exc}")
    return records, errors


def _probe_comfy_version(host: str) -> str:
    """Best-effort ComfyUI version for the manifest (empty on any failure)."""
    try:
        client = ch.ComfyClient(
            host, allowed_hosts={host} if host != ch.DEFAULT_COMFY_HOST else None
        )
        return str((client.system_stats().get("system") or {}).get("comfyui_version", ""))
    except ch.ComfyError:
        return ""


def _write_manifest(path: str, manifest: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(f"manifest: {path}")


def _report(records: list[dict], errors: list[str]) -> None:
    for record in records:
        print(f"candidate {record['index']} seed={record['seed']} -> {', '.join(record['files'])}")
    for err in errors:
        print(f"error: {err}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate ComfyUI images with provenance.")
    ap.add_argument("graph", help="a preset name (e.g. hero-flux) or a path to an *.api.json")
    ap.add_argument("--set", action="append", default=[], metavar="NODE.field=value")
    ap.add_argument("--host", default=ch.DEFAULT_COMFY_HOST)
    ap.add_argument("--out", default="/tmp/imagegen_out")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--manifest", default=None, help="path to write the provenance manifest.json")
    args = ap.parse_args(argv)

    # Validate overrides up front so a bad --set fails before any network call.
    try:
        for item in args.set:
            ch.parse_set_override(item)
    except ch.ComfyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    count, warning = ch.clamp_candidate_count(args.count, default=1)
    if warning:
        print(f"warning: {warning}", file=sys.stderr)
    seeds = plan_seeds(args.seed, count)

    _, preset = resolve_graph(args.graph, None)
    records, errors = generate_candidates(
        graph_arg=args.graph,
        overrides=args.set,
        seeds=seeds,
        host=args.host,
        out_dir=args.out,
        timeout=args.timeout,
    )

    manifest = build_manifest(
        preset=preset,
        graph_arg=args.graph,
        seeds=seeds,
        overrides=args.set,
        host=args.host,
        outputs=records,
        comfy_version=_probe_comfy_version(args.host),
    )
    if args.manifest:
        _write_manifest(args.manifest, manifest)
    _report(records, errors)

    if not records:
        print("error: no candidates produced", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
