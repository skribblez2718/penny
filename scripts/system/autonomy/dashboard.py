#!/usr/bin/env python3
"""Trust dashboard — what would run unattended, and why.

    make trust                 # per-domain trust from the live ledger
    make trust ARGS=--check    # + probe a few sample actions through the gate
    ... --json

Shows each domain's earned trust (recency-weighted success, sample size, and the
verifier-reliability cap), and — with --check — how the gate would decide on
sample actions. With an empty/thin ledger everything reads zero-trust → ask,
which is the correct, safe starting state: trust is earned from real outcomes
(rate them with `make rate` / `make auto-capture`).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from action_classes import known_domains  # noqa: E402
from gate import DEFAULT_THRESHOLD, decide  # noqa: E402
from trust import (  # noqa: E402
    compute_trust,
    load_ledger_outcomes,
    load_verifier_false_pass,
)

_SAMPLE_ACTIONS = [
    "rename a variable in the auth module",
    "summarize the research notes into a brief",
    "deploy the service to production",
    "send the status email to the team",
    "delete the staging database",
]


def build_report(threshold: float = DEFAULT_THRESHOLD) -> dict:
    outcomes = load_ledger_outcomes()
    fp = load_verifier_false_pass()
    domains = {}
    for d in known_domains():
        s = compute_trust(outcomes, d, false_pass_rate=fp)
        domains[d] = {
            "trust": s.trust,
            "n": s.n,
            "weighted_match_rate": s.weighted_match_rate,
            "false_pass_cap": s.false_pass_cap,
        }
    return {
        "threshold": threshold,
        "verifier_false_pass": fp,
        "outcomes_in_scope": len(outcomes),
        "domains": domains,
    }


def _print_report(report: dict, check: bool) -> None:
    fp = report["verifier_false_pass"]
    print(
        f"trust threshold {report['threshold']:.0%} · "
        f"verifier false-pass {'—' if fp is None else f'{fp:.0%}'} · "
        f"{report['outcomes_in_scope']} outcome(s) in scope\n"
    )
    print(f"{'domain':<15}{'trust':>7}{'n':>5}{'w-match':>9}{'cap':>6}")
    for d, s in sorted(report["domains"].items()):
        print(
            f"{d:<15}{s['trust']:>7.0%}{s['n']:>5}{s['weighted_match_rate']:>9.0%}{s['false_pass_cap']:>6.0%}"
        )
    if not check:
        return
    print("\ngate decisions on sample actions:")
    outcomes = load_ledger_outcomes()
    fp2 = load_verifier_false_pass()
    cache = {}

    def lookup(domain):
        if domain not in cache:
            cache[domain] = compute_trust(outcomes, domain, false_pass_rate=fp2)
        return cache[domain]

    for action in _SAMPLE_ACTIONS:
        d = decide(action, lookup, report["threshold"])
        print(f"  {d.action:<4} [{d.action_class:<18} {d.reversibility:<12}] {action}")
        print(f"        → {d.reason}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="probe sample actions through the gate"
    )
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = build_report(args.threshold)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_report(report, args.check)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
