#!/usr/bin/env python3
"""
authority_audit.py — Phase 7 metrics that are decidable without sampling behaviour.

Two of the eight Phase 7 metrics do not need an LLM judge, and are stronger without one:

  * AUTHORITY ADHERENCE — "does a read-only role avoid mutation **at the tool level**?"
    Behavioural sampling can only ever show that a role did not happen to mutate. The
    grant is the fact. This audits every agent's actual expanded tool set against its
    declared authority class and reports every mutation-capable grant it holds.

  * TOKEN / MAINTENANCE COST — "how much duplicated content spans role and skill assets?"
    Measured as shared normalized sentence shingles between each Role Definition and the
    Domain Guidance that layers on top of it. Duplication across layers is the defect the
    layer architecture exists to prevent, and it is countable.

Exits 0 always; this reports, it does not gate. The gating conformance check is
`check_tool_profiles.py`.

Usage:
    python scripts/system/evals/authority_audit.py
    python scripts/system/evals/authority_audit.py --json --out .penny/evals/phase7
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Set

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
AGENTS_DIR = PROJECT_ROOT / ".pi" / "agents"
SKILLS_DIR = PROJECT_ROOT / ".pi" / "skills"

sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "system" / "checks"))
from check_tool_profiles import PROFILES  # noqa: E402
from check_capability_registry import load_registry, split_list  # noqa: E402

# A tool is mutation-capable if invoking it can change state outside the model's context:
# the filesystem, a remote page, an installed package, or a produced file.
MUTATING: Set[str] = (
    set(PROFILES["filesystem.write"]) - set(PROFILES["filesystem.observe"])
    | set(PROFILES["browser.interact"]) - set(PROFILES["browser.reveal"])
    | set(PROFILES["browser.execute"]) - set(PROFILES["browser.interact"])
    | set(PROFILES["shell.unbounded"])
    | set(PROFILES["docgen"])
)

NON_MODIFYING = {"read", "inspect"}


def audit_authority(registry: Dict[str, Dict[str, str]]) -> Dict:
    rows = []
    for agent, fm in sorted(registry.items()):
        tools = set(split_list(fm.get("tools", "")))
        authority = fm.get("authority", "?")
        held = sorted(tools & MUTATING)
        rows.append(
            {
                "agent": agent,
                "capability": fm.get("capability"),
                "authority": authority,
                "tool_count": len(tools),
                "mutating_grants": held,
                "violates_declared_authority": bool(held) and authority in NON_MODIFYING,
            }
        )
    non_modifying = [r for r in rows if r["authority"] in NON_MODIFYING]
    offenders = [r for r in non_modifying if r["violates_declared_authority"]]
    # Which specific tools account for the residual gap.
    residual: Dict[str, int] = {}
    for row in offenders:
        for tool in row["mutating_grants"]:
            residual[tool] = residual.get(tool, 0) + 1
    return {
        "agents": rows,
        "non_modifying_roles": len(non_modifying),
        "non_modifying_roles_holding_mutating_tools": len(offenders),
        "residual_gap_by_tool": dict(sorted(residual.items(), key=lambda kv: -kv[1])),
        "structural_browser_authority": not any(
            t.startswith("playwright_") for r in offenders for t in r["mutating_grants"]
        ),
    }


_SENT = re.compile(r"[.!?]\s+|\n")


def _shingles(text: str) -> Set[str]:
    """Normalized sentence-level fingerprints, long enough to be meaningful."""
    body = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)
    body = body.split("<agent_boundary>")[0]
    out = set()
    for raw in _SENT.split(body):
        norm = " ".join(re.sub(r"[^a-z0-9 ]+", " ", raw.lower()).split())
        if len(norm) >= 40:
            out.add(norm)
    return out


def audit_duplication() -> Dict:
    """Overlap between each Role Definition and the Domain Guidance layered on it."""
    pairs = []
    for skill_dir in sorted(SKILLS_DIR.glob("*/assets/prompts")):
        skill = skill_dir.parents[1].name
        for prompt in sorted(skill_dir.glob("*.md")):
            role_file = AGENTS_DIR / prompt.name
            if not role_file.exists():
                continue
            role = _shingles(role_file.read_text(encoding="utf-8"))
            domain = _shingles(prompt.read_text(encoding="utf-8"))
            shared = role & domain
            pairs.append(
                {
                    "skill": skill,
                    "agent": prompt.stem,
                    "role_units": len(role),
                    "domain_units": len(domain),
                    "shared_units": len(shared),
                    "overlap_rate": round(len(shared) / len(domain), 3) if domain else 0.0,
                    "shared_examples": sorted(shared)[:3],
                }
            )
    total_shared = sum(p["shared_units"] for p in pairs)
    return {
        "pairs": pairs,
        "layer_pairs_examined": len(pairs),
        "total_duplicated_units": total_shared,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    registry = load_registry()
    payload = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "metric": "authority_adherence + token_maintenance_cost",
        "authority_adherence": audit_authority(registry),
        "duplication": audit_duplication(),
    }

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "authority-audit.json").write_text(json.dumps(payload, indent=2) + "\n")
        print(f"wrote {args.out / 'authority-audit.json'}")

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    auth = payload["authority_adherence"]
    print("AUTHORITY ADHERENCE (measured against actual tool grants, not prose)\n")
    print(f"{'agent':10} {'capability':11} {'auth':8} {'tools':>5}  mutating grants held")
    for row in auth["agents"]:
        held = ", ".join(row["mutating_grants"]) or "\u2014"
        flag = "  \u26a0" if row["violates_declared_authority"] else ""
        print(
            f"{row['agent']:10} {str(row['capability']):11} {row['authority']:8} "
            f"{row['tool_count']:5}  {held}{flag}"
        )
    print(
        f"\nnon-modifying roles: {auth['non_modifying_roles']}; "
        f"holding a mutating tool: {auth['non_modifying_roles_holding_mutating_tools']}"
    )
    print(f"residual gap by tool: {auth['residual_gap_by_tool'] or 'none'}")
    print(f"browser authority structural: {auth['structural_browser_authority']}")

    dup = payload["duplication"]
    print("\n\nTOKEN / MAINTENANCE COST (role \u21d4 domain-guidance duplication)\n")
    print(f"{'skill':10} {'agent':10} {'role':>5} {'domain':>7} {'shared':>7} {'rate':>6}")
    for pair in dup["pairs"]:
        print(
            f"{pair['skill']:10} {pair['agent']:10} {pair['role_units']:5} "
            f"{pair['domain_units']:7} {pair['shared_units']:7} {pair['overlap_rate']:6}"
        )
    print(f"\nlayer pairs examined: {dup['layer_pairs_examined']}")
    print(f"total duplicated units: {dup['total_duplicated_units']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
