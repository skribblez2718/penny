#!/usr/bin/env python3
"""
routing_probe.py — Measure which agent the model-visible catalog routes a task to.

This is the routing baseline required by universal-agents IMPLEMENTATION-PLAN §0.1.
Phase 2 rewrites every agent `description`, which IS the routing surface; without a
before-measurement a routing regression is undetectable.

What it measures: given the EXACT model-visible catalog string that
`formatModelVisibleAgentCatalog` (.pi/extensions/subagent/agents.ts) builds, which
option does a fixed judge model select for each probe task?

What it does NOT measure: Penny's live in-session routing, which also sees the
conversation, project context, and the three-tier routing policy. Holding the judge
model and probe set fixed is what makes before/after comparable; fidelity to a live
session is deliberately traded away for reproducibility.

Usage:
    python scripts/system/evals/routing_probe.py --out .penny/evals/baseline-<date>/routing
    python scripts/system/evals/routing_probe.py --trials 5 --workers 8
    python scripts/system/evals/routing_probe.py --compare OLD.json NEW.json
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
AGENTS_DIR = PROJECT_ROOT / ".pi" / "agents"
DEFAULT_FIXTURE = Path(__file__).resolve().parent / "routing_probes.json"

# Mirrors .pi/extensions/subagent/agents.ts exactly.
NAME_LIMIT = 80
DESCRIPTION_LIMIT = 512
CATALOG_LIMIT = 16_000
AGENT_LIMIT = 24
CATALOG_PREFIX = "Available agents (name: description): "

# Non-agent options. These exist so the probe can detect over-triggering: a router
# that never declines to delegate is as broken as one that picks the wrong agent.
EXTRA_OPTIONS = {
    "research-skill": (
        "A multi-phase research workflow (not a single agent). Use when the task needs "
        "structured investigation of an unfamiliar topic with authoritative external "
        "sources gathered and cited."
    ),
    "penny-direct": (
        "No delegation. Handle the task directly in the current session, because it is "
        "trivial, conversational, or too small to justify a subagent."
    ),
}

ROUTER_SYSTEM = """You are the routing layer of an AI assistant.

You are given a catalog of available specialist agents and one incoming task. Select \
the single best option to handle that task.

Rules:
- Choose exactly one option, by its exact name.
- Judge by the capability each option owns, not by the subject matter of the task.
- If no specialist agent fits, you may choose `penny-direct`.

Respond with strict JSON only, no prose, no code fence:
{"choice": "<exact option name>"}"""


def normalize_catalog_text(value: str, limit: int) -> str:
    """Port of normalizeCatalogText (agents.ts:39-43)."""
    normalized = re.sub(r"\s+", " ", value).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1] + "\u2026"


def load_agents() -> List[Tuple[str, str]]:
    """(name, description) for each agent, in discovery (sorted) order."""
    agents: List[Tuple[str, str]] = []
    for path in sorted(AGENTS_DIR.glob("*.md")):
        match = re.match(r"^---\n(.*?)\n---\n", path.read_text(encoding="utf-8"), re.S)
        if not match:
            continue
        block = match.group(1)
        name = re.search(r"^name:\s*(.*)$", block, re.M)
        desc = re.search(r"^description:\s*(.*?)(?=^[a-z_]+:|\Z)", block, re.M | re.S)
        if not name or not desc:
            continue
        agents.append((name.group(1).strip(), desc.group(1).strip()))
    return agents


def build_catalog(agents: List[Tuple[str, str]]) -> str:
    """Port of formatModelVisibleAgentCatalog (agents.ts:53-78)."""
    if not agents:
        return "Available agents: none discovered."
    entries: List[str] = []
    for name, description in agents[:AGENT_LIMIT]:
        entry = (
            f"{normalize_catalog_text(name, NAME_LIMIT)}: "
            f"{normalize_catalog_text(description, DESCRIPTION_LIMIT)}"
        )
        candidate = CATALOG_PREFIX + " | ".join([*entries, entry])
        if len(candidate) > CATALOG_LIMIT:
            break
        entries.append(entry)
    remaining = len(agents) - len(entries)
    suffix = (
        f" | {remaining} additional agent{' is' if remaining == 1 else 's are'} "
        "available by name in the tool schema."
        if remaining > 0
        else "."
    )
    return CATALOG_PREFIX + " | ".join(entries) + suffix


def build_prompt(catalog: str, task: str) -> str:
    extras = "\n".join(f"- {name}: {desc}" for name, desc in EXTRA_OPTIONS.items())
    return (
        f"{catalog}\n\nAlso available:\n{extras}\n\n"
        f'Incoming task:\n"""\n{task}\n"""\n\nSelect one option.'
    )


def parse_choice(stdout: str, valid: set) -> Optional[str]:
    """Extract the final assistant text from a --mode json stream and read its choice."""
    text = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "message_end":
            message = event.get("message", {})
            if message.get("role") == "assistant":
                text = "".join(
                    block.get("text", "")
                    for block in message.get("content", [])
                    if isinstance(block, dict) and block.get("type") == "text"
                )
    if not text:
        return None
    match = re.search(r'\{[^{}]*"choice"\s*:\s*"([^"]+)"[^{}]*\}', text)
    choice = match.group(1).strip() if match else text.strip().strip('"`')
    return choice if choice in valid else None


def call_router(prompt: str, provider: str, model: str, timeout_s: int) -> str:
    """One hermetic headless pi call. The router instruction is prepended to the
    user prompt rather than passed as --system-prompt, so the run needs no temp
    file and no global prompt can be interposed."""
    cmd = [
        "pi",
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        "low",
        prompt,
    ]
    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"
    proc = subprocess.run(
        cmd,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout_s,
    )
    return proc.stdout


def run_probe(probe: Dict, catalog: str, valid: set, args) -> Dict:
    prompt = f"{ROUTER_SYSTEM}\n\n{build_prompt(catalog, probe['prompt'])}"
    trials: List[Optional[str]] = []
    for _ in range(args.trials):
        try:
            trials.append(
                parse_choice(call_router(prompt, args.provider, args.model, args.timeout), valid)
            )
        except Exception:  # noqa: BLE001 — a failed trial is recorded, never inferred
            trials.append(None)
    resolved = [t for t in trials if t]
    counts = Counter(resolved)
    modal, modal_n = counts.most_common(1)[0] if counts else (None, 0)
    return {
        "id": probe["id"],
        "pair": probe["pair"],
        "leans": probe["leans"],
        "expected": probe["expected"],
        "trials": trials,
        "modal_choice": modal,
        "agreement": round(modal_n / len(trials), 3) if trials else 0.0,
        "matches_expected": (modal == probe["expected"]) if probe["expected"] else None,
    }


def summarize(results: List[Dict]) -> Dict:
    owned = [r for r in results if r["expected"] is not None]
    unowned = [r for r in results if r["expected"] is None]
    controls = [r for r in results if r["pair"] == "control"]
    pairs = [r for r in results if r["pair"] not in ("control",) and r["expected"] is not None]

    def hit(rows: List[Dict]) -> Optional[float]:
        if not rows:
            return None
        return round(sum(1 for r in rows if r["matches_expected"]) / len(rows), 3)

    return {
        "probes": len(results),
        "accuracy_all_owned": hit(owned),
        "accuracy_controls": hit(controls),
        "accuracy_confusion_pairs": hit(pairs),
        "mean_agreement": round(sum(r["agreement"] for r in results) / len(results), 3),
        "unowned_capability_landing": {
            r["id"]: {"leans": r["leans"], "lands_on": r["modal_choice"]} for r in unowned
        },
        "misroutes": [
            {
                "id": r["id"],
                "leans": r["leans"],
                "expected": r["expected"],
                "got": r["modal_choice"],
            }
            for r in owned
            if not r["matches_expected"]
        ],
    }


def compare(old_path: Path, new_path: Path) -> int:
    old = json.loads(old_path.read_text())
    new = json.loads(new_path.read_text())
    old_by_id = {r["id"]: r for r in old["results"]}
    print(f"catalog digest: {old['catalog_sha256'][:12]} -> {new['catalog_sha256'][:12]}")
    print(
        f"owned accuracy: {old['summary']['accuracy_all_owned']} -> "
        f"{new['summary']['accuracy_all_owned']}\n"
    )
    regressions = 0
    for row in new["results"]:
        prior = old_by_id.get(row["id"])
        if not prior or prior["modal_choice"] == row["modal_choice"]:
            continue
        flag = ""
        if prior["expected"] and prior["matches_expected"] and not row["matches_expected"]:
            flag = "  <-- REGRESSION"
            regressions += 1
        print(
            f"  {row['id']} ({row['leans']}): {prior['modal_choice']} -> {row['modal_choice']}{flag}"
        )
    print(f"\nregressions: {regressions}")
    return 1 if regressions else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="output directory")
    parser.add_argument("--provider", default="openai-codex")
    parser.add_argument("--model", default="gpt-5.6-terra")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("OLD", "NEW"))
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    args = parser.parse_args()

    if args.compare:
        return compare(*args.compare)

    agents = load_agents()
    catalog = build_catalog(agents)
    fixture = json.loads(args.fixture.read_text())
    probes = fixture["probes"]
    valid = {name for name, _ in agents} | set(EXTRA_OPTIONS)

    print(
        f"agents={len(agents)} probes={len(probes)} trials={args.trials} "
        f"model={args.provider}/{args.model}"
    )
    print(f"catalog chars={len(catalog)}")

    results: List[Dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_probe, p, catalog, valid, args): p for p in probes}
        for done in concurrent.futures.as_completed(futures):
            results.append(done.result())
            print(
                f"  [{len(results)}/{len(probes)}] {done.result()['id']} -> "
                f"{done.result()['modal_choice']}"
            )
    results.sort(key=lambda r: r["id"])

    payload = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "fixture_id": fixture["fixture_id"],
        "fixture_sha256": hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
        "provider": args.provider,
        "model": args.model,
        "thinking": "low",
        "trials_per_probe": args.trials,
        "agent_count": len(agents),
        "agent_names": [n for n, _ in agents],
        "catalog": catalog,
        "catalog_sha256": hashlib.sha256(catalog.encode()).hexdigest(),
        "catalog_chars": len(catalog),
        "summary": summarize(results),
        "results": results,
    }

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        target = args.out / "routing-baseline.json"
        target.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"\nwrote {target}")

    s = payload["summary"]
    print(f"\nowned accuracy      : {s['accuracy_all_owned']}")
    print(f"  controls          : {s['accuracy_controls']}")
    print(f"  confusion pairs   : {s['accuracy_confusion_pairs']}")
    print(f"mean agreement      : {s['mean_agreement']}")
    if s["misroutes"]:
        print("misroutes:")
        for m in s["misroutes"]:
            print(f"  {m['id']} ({m['leans']}): expected {m['expected']}, got {m['got']}")
    print("unowned capability landing:")
    for pid, info in s["unowned_capability_landing"].items():
        print(f"  {pid} ({info['leans']}) -> {info['lands_on']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
