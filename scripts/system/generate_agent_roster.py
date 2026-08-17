#!/usr/bin/env python3
"""
generate_agent_roster.py — Emit roster tables into marked doc regions from the registry.

Hand-maintained roster tables drift. The repository already proved this: a
four-agent enumeration survived in the prompt-layer docs long after the roster
reached eight. Every roster table therefore lives inside a marked region and is
regenerated from `.pi/agents/*.md` frontmatter, which is the single source of truth.

Marked regions look like:

    <!-- BEGIN GENERATED: roster -->
    ...generated content...
    <!-- END GENERATED -->

Blocks available: `roster`, `coordinates`, `transformations`, `families`.

The generator is idempotent: running it twice produces byte-identical files.

Usage:
    python scripts/system/generate_agent_roster.py            # write
    python scripts/system/generate_agent_roster.py --check    # CI: fail if stale
"""

import argparse
import re
import sys
from pathlib import Path
from typing import Callable, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "system" / "checks"))

from check_capability_registry import load_registry, split_list  # noqa: E402

# Docs that carry generated roster regions.
TARGETS = [
    PROJECT_ROOT / "docs" / "agents" / "agents" / "capability-registry.md",
    PROJECT_ROOT / "docs" / "humans" / "agents" / "capability-registry.md",
    PROJECT_ROOT / "docs" / "agents" / "skills" / "design-methodology.md",
    PROJECT_ROOT / "docs" / "humans" / "agents" / "overview.md",
    PROJECT_ROOT / "README.md",
]

FAMILY_ORDER = ["epistemic", "deliberative", "operational"]
FAMILY_BLURB = {
    "epistemic": "transform information into knowledge or judgment",
    "deliberative": "determine what should happen",
    "operational": "convert intent into externalizable work",
}


def _sorted_agents(registry: Dict[str, Dict[str, str]]) -> List[Dict[str, str]]:
    """Family order, then capability name — stable and independent of filenames."""
    rows = [dict(fm, agent=agent) for agent, fm in registry.items() if fm.get("capability")]
    return sorted(rows, key=lambda r: (FAMILY_ORDER.index(r["family"]), r["capability"]))


def block_roster(registry) -> str:
    lines = [
        "| Capability | Agent | Family | Authority | Transformation |",
        "|---|---|---|---|---|",
    ]
    for r in _sorted_agents(registry):
        lines.append(
            f"| `{r['capability']}` | `{r['agent']}` | {r['family']} | "
            f"`{r['authority']}` | {r['transformation']} |"
        )
    return "\n".join(lines)


def block_coordinates(registry) -> str:
    """Semantic coordinates. These replace pairwise 'do not use me for X' prose."""
    header = "| Capability | Gathers | Evaluates | Selects | Sequences | Writes | Needs standard |"
    lines = [header, "|---|---|---|---|---|---|---|"]
    for r in _sorted_agents(registry):
        cells = [
            r["gathers"],
            r["evaluates"],
            r["selects"],
            r["sequences"],
            r["writes"],
            r["requires_standard"],
        ]
        rendered = " | ".join("—" if c == "no" else f"**{c}**" if c == "yes" else c for c in cells)
        lines.append(f"| `{r['capability']}` | {rendered} |")
    return "\n".join(lines)


def block_transformations(registry) -> str:
    lines = ["| Capability | Accepts | Produces | Nearest confusable |", "|---|---|---|---|"]
    for r in _sorted_agents(registry):
        neighbors = ", ".join(f"`{n}`" for n in split_list(r["neighbors"])) or "—"
        lines.append(f"| `{r['capability']}` | {r['accepts']} | {r['produces']} | {neighbors} |")
    return "\n".join(lines)


def _third_person(verb: str) -> str:
    """'verify' -> 'verifies', 'taskify' -> 'taskifies', 'plan' -> 'plans'."""
    if len(verb) > 1 and verb.endswith("y") and verb[-2] not in "aeiou":
        return verb[:-1] + "ies"
    return verb + "s"


def block_role_semantics(registry) -> str:
    """Compact state->agent assignment line used by skill design methodology."""
    rows = _sorted_agents(registry)
    parts = [f"`{r['agent']}` {_third_person(r['capability'])}" for r in rows]
    return "(" + ", ".join(parts) + ")"


def block_families(registry) -> str:
    rows = _sorted_agents(registry)
    lines = []
    for family in FAMILY_ORDER:
        members = [f"`{r['capability']}`" for r in rows if r["family"] == family]
        if members:
            lines.append(f"- **{family.title()}** — {FAMILY_BLURB[family]}: {', '.join(members)}")
    return "\n".join(lines)


BLOCKS: Dict[str, Callable] = {
    "roster": block_roster,
    "coordinates": block_coordinates,
    "transformations": block_transformations,
    "families": block_families,
    "role_semantics": block_role_semantics,
}


def _normalize(text: str) -> str:
    """Content identity, ignoring whitespace.

    Prettier realigns Markdown table pipes after this generator writes them. If
    staleness were judged byte-exactly, the two tools would rewrite each other
    forever. The generator owns a region's *content*; the formatter owns its
    whitespace. Comparing normalized text keeps each authoritative over exactly
    the thing it should be.
    """

    def canon(line: str) -> str:
        line = " ".join(line.split())
        if not line.startswith("|"):
            return line
        # Table row: strip cell padding, and collapse separator runs so the
        # generator's `|---|` equals the formatter's `| ------------ |`.
        cells = [cell.strip() for cell in line.split("|")]
        cells = [re.sub(r"^:?-{2,}:?$", "-", cell) for cell in cells]
        return "|".join(cells)

    return "\n".join(canon(line) for line in text.strip().splitlines() if line.strip())


def render(text: str, registry) -> str:
    def replace(match: re.Match) -> str:
        name = match.group(1).strip()
        if name not in BLOCKS:
            return match.group(0)
        body = BLOCKS[name](registry)
        if _normalize(match.group(2)) == _normalize(body):
            # Content is current; preserve the formatter's whitespace verbatim.
            return match.group(0)
        # Inline blocks sit inside a sentence; block-level ones need blank lines.
        sep = "\n" if name == "role_semantics" else "\n\n"
        return f"<!-- BEGIN GENERATED: {name} -->{sep}" f"{body}{sep}" f"<!-- END GENERATED -->"

    return re.sub(
        r"<!-- BEGIN GENERATED: ([a-z_]+) -->(.*?)<!-- END GENERATED -->",
        replace,
        text,
        flags=re.S,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if any target is stale")
    args = parser.parse_args()

    registry = load_registry()
    stale: List[Path] = []
    written: List[Path] = []

    for target in TARGETS:
        if not target.exists():
            print(f"  skip (absent): {target.relative_to(PROJECT_ROOT)}")
            continue
        current = target.read_text(encoding="utf-8")
        updated = render(current, registry)
        if current == updated:
            continue
        if args.check:
            stale.append(target)
        else:
            target.write_text(updated, encoding="utf-8")
            written.append(target)

    if args.check:
        if stale:
            print(f"FAIL: {len(stale)} generated region(s) are stale:")
            for path in stale:
                print(f"  - {path.relative_to(PROJECT_ROOT)}")
            print("\nRun: python scripts/system/generate_agent_roster.py")
            return 1
        print("PASS: all generated roster regions are current")
        return 0

    for path in written:
        print(f"  updated: {path.relative_to(PROJECT_ROOT)}")
    print(f"PASS: generated roster regions ({len(written)} file(s) changed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
