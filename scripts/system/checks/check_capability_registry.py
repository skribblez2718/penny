#!/usr/bin/env python3
"""
check_capability_registry.py — Validate the agent capability registry.

`.pi/agents/*.md` frontmatter is the SINGLE source of truth for the roster. There is
deliberately no parallel registry file: a second place to update is exactly the drift
vector that hand-maintained roster tables already demonstrated.

Validates:
  1. COMPLETENESS      — every required field present and non-empty.
  2. ENUMS             — every constrained field holds an allowed value.
  3. UNIQUENESS        — `capability` is unique across the roster.
  4. REFERENTIAL INTEGRITY — every `neighbors` entry resolves to an existing capability,
     and no agent lists itself. Symmetry is NOT required: confusability is genuinely
     asymmetric (ideate is easily mistaken for decide; decide is more often confused
     with plan), and forcing symmetric lists would spend scarce description budget
     on noise.
  5. NEIGHBOR COUNT    — at most 3, so descriptions carry semantic coordinates rather
     than an exhaustive negative enumeration of the whole roster.
  6. ROUTING DESCRIPTION — requires a positive use trigger and an anti-case clause.
  7. DESCRIPTION BUDGET — hard fail above 1024 (the runtime truncates silently, which
     removes the tail, exactly where disambiguating anti-cases live); warn above the
     preferred 500-character target while allowing justified longer descriptions.
  8. TRANSFORMATION    — must be a domain-free `input → output` statement.

Exits 0 if all pass, 1 if any fail. Warnings do not fail the build.

Usage:
    python scripts/system/checks/check_capability_registry.py
    python scripts/system/checks/check_capability_registry.py --json
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
AGENTS_DIR = PROJECT_ROOT / ".pi" / "agents"

DESCRIPTION_HARD_LIMIT = 1024
DESCRIPTION_PREFERRED_LIMIT = 500
MAX_NEIGHBORS = 3
POSITIVE_TRIGGER = re.compile(r"\buse\s+(?:when|for|to|if|on)\b", re.IGNORECASE)
ANTI_CASE = re.compile(r"\b(?:do not use|don't use|do not apply|avoid using)\b", re.IGNORECASE)

REQUIRED = [
    "name",
    "description",
    "capability",
    "family",
    "transformation",
    "accepts",
    "produces",
    "authority",
    "tool_profiles",
    "side_effects",
    "gathers",
    "evaluates",
    "selects",
    "sequences",
    "writes",
    "requires_standard",
    "neighbors",
]

ENUMS: Dict[str, set] = {
    "family": {"epistemic", "deliberative", "operational"},
    "authority": {"read", "inspect", "write"},
    "side_effects": {"none", "artifacts"},
    "gathers": {"no", "limited", "yes"},
    "evaluates": {"no", "yes", "quality", "validity", "integrative", "self_check", "limited"},
    "selects": {"no", "yes", "strategy_only"},
    "sequences": {"no", "yes", "dependencies"},
    "writes": {"no", "yes"},
    "requires_standard": {"no", "yes", "criteria", "spec"},
}

LIST_FIELDS = {"accepts", "produces", "neighbors", "tool_profiles"}


def parse_frontmatter(path: Path) -> Dict[str, str]:
    match = re.match(r"^---\n(.*?)\n---\n", path.read_text(encoding="utf-8"), re.S)
    if not match:
        return {}
    block = match.group(1)
    fields: Dict[str, str] = {}
    for line in re.finditer(r"^([a-z_]+):[ \t]*(.*)$", block, re.M):
        fields[line.group(1)] = line.group(2).strip()
    return fields


def split_list(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def load_registry() -> Dict[str, Dict[str, str]]:
    return {p.stem: parse_frontmatter(p) for p in sorted(AGENTS_DIR.glob("*.md"))}


def check_fields(agent: str, fm: Dict[str, str]) -> List[str]:
    errors = [f"{agent}: missing or empty required field `{f}`" for f in REQUIRED if not fm.get(f)]
    if errors:
        return errors
    for field, allowed in ENUMS.items():
        if fm[field] not in allowed:
            errors.append(f"{agent}: `{field}` is '{fm[field]}'; allowed: {sorted(allowed)}")
    if "→" not in fm["transformation"]:
        errors.append(f"{agent}: `transformation` must be an 'input → output' statement")
    return errors


def check_description(agent: str, fm: Dict[str, str]) -> tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    description = fm.get("description", "")
    length = len(description)
    if not POSITIVE_TRIGGER.search(description):
        errors.append(
            f"{agent}: description needs a positive routing clause such as 'Use when/for/to …'"
        )
    if not ANTI_CASE.search(description):
        errors.append(f"{agent}: description needs an anti-case clause such as 'Do not use …'")
    if length > DESCRIPTION_HARD_LIMIT:
        errors.append(
            f"{agent}: description is {length} chars, above the hard limit of "
            f"{DESCRIPTION_HARD_LIMIT} (the runtime truncates silently)"
        )
    elif length > DESCRIPTION_PREFERRED_LIMIT:
        warnings.append(
            f"{agent}: description is {length} chars, above the preferred target of "
            f"{DESCRIPTION_PREFERRED_LIMIT}; retain the extra text only when it improves routing"
        )
    return errors, warnings


def check_neighbors(agent: str, fm: Dict[str, str], capabilities: set) -> List[str]:
    errors: List[str] = []
    neighbors = split_list(fm.get("neighbors", ""))
    if len(neighbors) > MAX_NEIGHBORS:
        errors.append(
            f"{agent}: names {len(neighbors)} neighbors, above the maximum of {MAX_NEIGHBORS}"
        )
    for neighbor in neighbors:
        if neighbor not in capabilities:
            errors.append(f"{agent}: neighbor '{neighbor}' resolves to no capability in the roster")
        if neighbor == fm.get("capability"):
            errors.append(f"{agent}: lists its own capability '{neighbor}' as a neighbor")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit the registry as JSON")
    args = parser.parse_args()

    registry = load_registry()
    if not registry:
        print(f"FAIL: no agent definitions found in {AGENTS_DIR}")
        return 1

    if args.json:
        print(json.dumps(registry, indent=2))
        return 0

    errors: List[str] = []
    warnings: List[str] = []

    capabilities = {fm.get("capability") for fm in registry.values() if fm.get("capability")}

    seen: Dict[str, str] = {}
    for agent, fm in registry.items():
        errors.extend(check_fields(agent, fm))
        desc_errors, desc_warnings = check_description(agent, fm)
        errors.extend(desc_errors)
        warnings.extend(desc_warnings)
        errors.extend(check_neighbors(agent, fm, capabilities))
        capability = fm.get("capability")
        if capability:
            if capability in seen:
                errors.append(
                    f"{agent}: capability '{capability}' is already owned by '{seen[capability]}'"
                )
            else:
                seen[capability] = agent

    for warning in warnings:
        print(f"  warn: {warning}")

    if errors:
        print(f"\nFAIL: capability registry ({len(errors)} error(s))\n")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(f"PASS: capability registry for {len(registry)} agent(s), {len(seen)} capabilities")
    return 0


if __name__ == "__main__":
    sys.exit(main())
