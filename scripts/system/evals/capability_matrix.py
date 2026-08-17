#!/usr/bin/env python3
"""
capability_matrix.py — Phase 7 cross-domain boundary eval.

The claim under test is not "these prompts read as generic". It is:

    The same role contract transfers across unrelated domains without domain
    leakage or routing collapse.

Each cell runs one Role Definition, unedited, as the sole system prompt against a task
from an unrelated domain, then scores the output with a rubric judge on four of the §7.3
metrics that require behaviour to observe:

  role_purity          did it stay inside its capability, or do a neighbour's job?
  domain_leakage       did generic role assumptions distort an unrelated domain?
  cross_domain_transfer did the contract hold without strain?
  invented_criteria    did it fabricate criteria/preferences it was never given?

The remaining §7.3 metrics are measured elsewhere and more decisively:
routing accuracy and composition by `routing_probe.py`, authority adherence and
token/maintenance cost by `authority_audit.py`.

Usage:
    python scripts/system/evals/capability_matrix.py --out .penny/evals/phase7
    python scripts/system/evals/capability_matrix.py --capabilities decide,ideate
    python scripts/system/evals/capability_matrix.py --domains personal,research
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
AGENTS_DIR = PROJECT_ROOT / ".pi" / "agents"
FIXTURE = Path(__file__).resolve().parent / "capability_matrix.json"

sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "system" / "checks"))
from check_capability_registry import load_registry  # noqa: E402

JUDGE_SYSTEM = """You are evaluating whether a reusable agent role held its contract when \
applied to a domain it was not written for.

You will be given: the role's contract (its Purpose and Non-Negotiables), the task, and the \
role's output.

Score four dimensions. Be strict and evidence-based; quote nothing, judge the output.

- role_purity: did the output stay inside the stated capability? Doing a neighbouring \
capability's job (e.g. a role that must not select nonetheless recommending one option; a \
role that must not gather nonetheless inventing external facts) is a FAIL.
- domain_leakage: did the role impose assumptions from some other domain (typically \
software/engineering) that do not fit this task? Software vocabulary in a non-software task \
is leakage. A PASS means the output is native to its own domain.
- cross_domain_transfer: did the contract hold naturally, or did it visibly strain — \
producing empty ceremony, forced structure, or sections that make no sense here?
- invented_criteria: did the output fabricate evaluation criteria, user preferences, \
weights, or a standard that the task never supplied? Fabricating them is a FAIL. Correctly \
naming what is missing, or asking for it, is a PASS.

Respond with strict JSON only, no prose, no code fence:
{"role_purity":"pass|fail","domain_leakage":"pass|fail","cross_domain_transfer":"pass|fail",\
"invented_criteria":"pass|fail","note":"<= 25 words on the weakest dimension"}"""


def role_contract(agent: str) -> str:
    text = (AGENTS_DIR / f"{agent}.md").read_text(encoding="utf-8")
    return text.split("---", 2)[2].split("<agent_boundary>")[0].strip()


def call_model(prompt: str, provider: str, model: str, timeout_s: int) -> str:
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
    text = ""
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            event.get("type") == "message_end"
            and event.get("message", {}).get("role") == "assistant"
        ):
            text = "".join(
                b.get("text", "")
                for b in event["message"].get("content", [])
                if isinstance(b, dict) and b.get("type") == "text"
            )
    return text


VERDICTS = ("role_purity", "domain_leakage", "cross_domain_transfer", "invented_criteria")


def parse_judgement(text: str) -> Optional[Dict[str, str]]:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not all(data.get(k) in ("pass", "fail") for k in VERDICTS):
        return None
    return data


def run_cell(job, args) -> Dict:
    capability, agent, domain, task = job
    contract = role_contract(agent)
    try:
        output = call_model(
            f"{contract}\n\n---\n\nTask: {task}", args.provider, args.model, args.timeout
        )
    except Exception:  # noqa: BLE001 — a failed cell is recorded, never inferred
        output = ""
    judgement = None
    if output.strip():
        judge_prompt = (
            f"{JUDGE_SYSTEM}\n\n## Role contract\n{contract}\n\n"
            f"## Task ({domain})\n{task}\n\n## Role output\n{output[:12000]}"
        )
        try:
            judgement = parse_judgement(
                call_model(judge_prompt, args.provider, args.judge_model, args.timeout)
            )
        except Exception:  # noqa: BLE001
            judgement = None
    return {
        "capability": capability,
        "agent": agent,
        "domain": domain,
        "output_chars": len(output),
        "judged": judgement is not None,
        **({k: judgement[k] for k in VERDICTS} if judgement else {}),
        "note": (judgement or {}).get("note", ""),
    }


def summarize(results: List[Dict]) -> Dict:
    judged = [r for r in results if r["judged"]]
    per_metric = {
        k: round(sum(1 for r in judged if r.get(k) == "pass") / len(judged), 3) if judged else None
        for k in VERDICTS
    }
    by_capability: Dict[str, Dict] = {}
    for row in judged:
        entry = by_capability.setdefault(row["capability"], {"cells": 0, "clean": 0})
        entry["cells"] += 1
        entry["clean"] += int(all(row.get(k) == "pass" for k in VERDICTS))
    by_domain: Dict[str, Dict] = {}
    for row in judged:
        entry = by_domain.setdefault(row["domain"], {"cells": 0, "clean": 0})
        entry["cells"] += 1
        entry["clean"] += int(all(row.get(k) == "pass" for k in VERDICTS))
    return {
        "cells_total": len(results),
        "cells_judged": len(judged),
        "cells_unjudged": len(results) - len(judged),
        "pass_rate_by_metric": per_metric,
        "clean_cells": sum(1 for r in judged if all(r.get(k) == "pass" for k in VERDICTS)),
        "by_capability": by_capability,
        "by_domain": by_domain,
        "failures": [
            {
                "capability": r["capability"],
                "domain": r["domain"],
                "failed": [k for k in VERDICTS if r.get(k) == "fail"],
                "note": r["note"],
            }
            for r in judged
            if any(r.get(k) == "fail" for k in VERDICTS)
        ],
    }


def build_jobs(fixture: Dict, by_capability: Dict[str, str], args) -> List:
    """Expand the matrix into (capability, agent, domain, task) jobs, honouring filters."""
    want_caps = set(args.capabilities.split(",")) if args.capabilities else None
    want_doms = set(args.domains.split(",")) if args.domains else None
    jobs = []
    for capability, cells in fixture["cells"].items():
        if want_caps and capability not in want_caps:
            continue
        agent = by_capability.get(capability)
        if not agent:
            print(f"  skip: no agent owns capability '{capability}'")
            continue
        for domain, task in cells.items():
            if want_doms and domain not in want_doms:
                continue
            jobs.append((capability, agent, domain, task))
    return jobs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--provider", default="ollama")
    parser.add_argument("--model", default="glm-5.2:cloud")
    parser.add_argument("--judge-model", default="glm-5.2:cloud")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=420)
    parser.add_argument("--capabilities", help="comma-separated subset")
    parser.add_argument("--domains", help="comma-separated subset")
    args = parser.parse_args()

    fixture = json.loads(FIXTURE.read_text())
    registry = load_registry()
    by_capability = {
        fm["capability"]: agent for agent, fm in registry.items() if fm.get("capability")
    }

    jobs = build_jobs(fixture, by_capability, args)

    print(f"cells={len(jobs)} model={args.provider}/{args.model} judge={args.judge_model}")
    results: List[Dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for done in concurrent.futures.as_completed([pool.submit(run_cell, j, args) for j in jobs]):
            row = done.result()
            results.append(row)
            mark = (
                "?"
                if not row["judged"]
                else ("." if all(row.get(k) == "pass" for k in VERDICTS) else "F")
            )
            print(f"  [{len(results)}/{len(jobs)}] {mark} {row['capability']}/{row['domain']}")
    results.sort(key=lambda r: (r["capability"], r["domain"]))

    payload = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "fixture_id": fixture["fixture_id"],
        "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
        "provider": args.provider,
        "model": args.model,
        "judge_model": args.judge_model,
        "summary": summarize(results),
        "results": results,
    }

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        target = args.out / "capability-matrix.json"
        target.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"\nwrote {target}")

    s = payload["summary"]
    print(f"\ncells judged        : {s['cells_judged']}/{s['cells_total']}")
    print(f"fully clean cells   : {s['clean_cells']}/{s['cells_judged']}")
    for metric, rate in s["pass_rate_by_metric"].items():
        print(f"  {metric:22}: {rate}")
    if s["failures"]:
        print("\nfailures:")
        for f in s["failures"]:
            print(f"  {f['capability']}/{f['domain']}: {','.join(f['failed'])} \u2014 {f['note']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
