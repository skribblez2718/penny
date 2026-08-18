#!/usr/bin/env python3
"""
check_tool_profiles.py — Enforce that each agent's `tools:` list is exactly the
expansion of its declared `tool_profiles:`.

This module is the machine source of truth for the tool-authority ladder. The
prose in docs/agents/agents/tool-profiles.md is generated from PROFILES via
`--emit-markdown`; it is never hand-maintained.

Rules enforced:
  1. CONFORMANCE  — set(tools) == expansion(tool_profiles), exactly. No drift.
  2. NO ARBITRARY EXECUTION — playwright_run_code_unsafe is granted to no agent.
  3. AUTHORITY CEILING — an agent whose declared `authority` is read or inspect
     may not hold a browser rung above browser.reveal.
  4. LADDER INTEGRITY — each browser/filesystem rung is a strict superset of the
     rung below it.

Exits 0 if all pass, 1 if any fail.

Usage:
    python scripts/system/checks/check_tool_profiles.py
    python scripts/system/checks/check_tool_profiles.py --agent echo
    python scripts/system/checks/check_tool_profiles.py --emit-markdown
"""

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
AGENTS_DIR = PROJECT_ROOT / ".pi" / "agents"

# ── Canonical ladder ────────────────────────────────────────────────────────
# Each family is ordered weakest -> strongest. A rung expands to its own tools
# plus every tool of the rung below it (strict superset, enforced by rule 4).

_BROWSER_OBSERVE = [
    "playwright_navigate",
    "playwright_navigate_back",
    "playwright_navigate_forward",
    "playwright_reload",
    "playwright_get_current_url",
    "playwright_get_title",
    "playwright_snapshot",
    "playwright_screenshot",
    "playwright_close",
    "playwright_resize",
    "playwright_new_page",
    "playwright_close_page",
    "playwright_switch_tab",
    "playwright_list_tabs",
    "playwright_wait_for",
    "playwright_console_messages",
    "playwright_network_requests",
    "playwright_network_request",
    "playwright_pdf",
    "playwright_verify_element_visible",
    "playwright_verify_text_visible",
    "playwright_verify_value",
    "playwright_highlight",
    "playwright_hide_highlight",
    "playwright_mouse_move_xy",
    "playwright_mouse_wheel",
]
_BROWSER_REVEAL = [
    "playwright_click",
    "playwright_double_click",
    "playwright_hover",
    "playwright_press_key",
]
_BROWSER_INTERACT = [
    "playwright_type",
    "playwright_fill",
    "playwright_fill_form",
    "playwright_select_option",
    "playwright_check",
    "playwright_uncheck",
    "playwright_drag",
    "playwright_drop",
    "playwright_file_upload",
    "playwright_mouse_click_xy",
    "playwright_mouse_drag_xy",
    "playwright_handle_dialog",
    "playwright_route",
    "playwright_unroute",
    "playwright_cookies",
    "playwright_local_storage",
    "playwright_session_storage",
]
_BROWSER_EXECUTE = [
    "playwright_evaluate",
    "playwright_run_code_unsafe",
    "playwright_start_tracing",
    "playwright_stop_tracing",
]

# Ordered rungs per family; index = authority level.
LADDERS: Dict[str, List[Tuple[str, List[str]]]] = {
    "filesystem": [
        ("filesystem.read", ["read"]),
        ("filesystem.observe", ["grep", "find", "ls"]),
        ("filesystem.write", ["write", "edit"]),
    ],
    "browser": [
        ("browser.observe", _BROWSER_OBSERVE),
        ("browser.reveal", _BROWSER_REVEAL),
        ("browser.interact", _BROWSER_INTERACT),
        ("browser.execute", _BROWSER_EXECUTE),
    ],
}

# Flat (non-laddered) profiles.
FLAT: Dict[str, List[str]] = {
    # `bash` is unbounded: it can write files, delete them, install packages, and
    # reach the network. It is named honestly rather than as `shell.inspect` so the
    # gap stays visible in the metadata instead of being disguised by a calm label.
    "shell.unbounded": ["bash"],
    "web.search": ["web_search", "web_fetch"],
    "web.transcript": ["youtube_transcript"],
    "docgen": ["word_generate", "powerpoint_generate"],
    "artifact": ["artifact_read"],
    # Read-only memory recall: search, read drawers/list/taxonomy, read KG,
    # read Penny's diary. No write operations (add_drawer, diary_write,
    # kg_add, kg_invalidate, kg_supersede) and no logstream tools.
    # Operator-approved 2026-08-17 per the no-memory-injection ratchet
    # exception (agent-readonly-memory-plan.md). Read-only recall is not
    # semantic workflow transport.
    "memory.read": [
        "memory_search",
        "memory_smart_search",
        "memory_get_drawer",
        "memory_list_drawers",
        "memory_get_taxonomy",
        "memory_check_duplicate",
        "memory_kg_query",
        "memory_kg_timeline",
        "memory_kg_stats",
        "memory_diary_read",
    ],
}

# Browser rungs an agent declaring read/inspect authority may hold (rule 3).
READONLY_BROWSER_CEILING = "browser.reveal"

# Never granted to any agent in the roster (rule 2). A future grant requires an
# explicit, dated, recorded exception.
FORBIDDEN_TOOLS = {"playwright_run_code_unsafe"}

NON_MODIFYING_AUTHORITIES = {"read", "inspect"}


def build_profiles() -> Dict[str, List[str]]:
    """Expand every ladder rung cumulatively and merge with flat profiles."""
    profiles: Dict[str, List[str]] = {}
    for rungs in LADDERS.values():
        cumulative: List[str] = []
        for name, added in rungs:
            cumulative = cumulative + added
            profiles[name] = list(cumulative)
    profiles.update({k: list(v) for k, v in FLAT.items()})
    return profiles


PROFILES = build_profiles()


def _browser_rank(profile: str) -> int:
    for idx, (name, _) in enumerate(LADDERS["browser"]):
        if name == profile:
            return idx
    return -1


def parse_frontmatter(path: Path) -> Dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not match:
        return {}
    block = match.group(1)
    fields: Dict[str, str] = {}
    for key in ("name", "authority", "tools", "tool_profiles"):
        found = re.search(rf"^{key}:\s*(.*?)(?=^[a-z_]+:|\Z)", block, re.M | re.S)
        if found:
            fields[key] = found.group(1).strip()
    return fields


def split_list(raw: str) -> List[str]:
    return [item.strip() for item in re.split(r"[,\n\-\[\]]+", raw) if item.strip()]


def check_ladder_integrity() -> List[str]:
    errors: List[str] = []
    for family, rungs in LADDERS.items():
        previous: Set[str] = set()
        for name, _ in rungs:
            current = set(PROFILES[name])
            if not previous <= current:
                missing = sorted(previous - current)
                errors.append(
                    f"ladder {family}: '{name}' is not a superset of the rung below "
                    f"(missing {missing})"
                )
            previous = current
    return errors


def _check_conformance(agent: str, actual: Set[str], expected: Set[str]) -> List[str]:
    """Rule 1 — declared profiles must expand to exactly the granted tools."""
    errors = [
        f"{agent}: holds '{t}' but no declared profile grants it" for t in sorted(actual - expected)
    ]
    errors += [
        f"{agent}: profile grants '{t}' but `tools:` omits it" for t in sorted(expected - actual)
    ]
    return errors


def _check_forbidden(agent: str, actual: Set[str]) -> List[str]:
    """Rule 2 — arbitrary execution is granted to nobody."""
    return [
        f"{agent}: holds forbidden tool '{tool}' (no agent may hold it)"
        for tool in sorted(actual & FORBIDDEN_TOOLS)
    ]


def _check_ceiling(agent: str, authority: str, declared: List[str]) -> List[str]:
    """Rule 3 — a read/inspect role may not exceed the browser authority ceiling."""
    if authority not in NON_MODIFYING_AUTHORITIES:
        return []
    ceiling = _browser_rank(READONLY_BROWSER_CEILING)
    return [
        f"{agent}: declares authority '{authority}' but holds browser profile "
        f"'{profile}' above the '{READONLY_BROWSER_CEILING}' ceiling"
        for profile in declared
        if _browser_rank(profile) > ceiling
    ]


def check_agent(path: Path) -> List[str]:
    agent = path.stem
    fm = parse_frontmatter(path)

    for required in ("tool_profiles", "tools"):
        if required not in fm:
            return [f"{agent}: missing required `{required}:` frontmatter field"]

    declared = split_list(fm["tool_profiles"])
    actual = set(split_list(fm["tools"]))

    unknown = [p for p in declared if p not in PROFILES]
    if unknown:
        return [f"{agent}: unknown tool profile(s) {unknown}; valid: {sorted(PROFILES)}"]

    expected: Set[str] = set()
    for profile in declared:
        expected |= set(PROFILES[profile])

    return (
        _check_conformance(agent, actual, expected)
        + _check_forbidden(agent, actual)
        + _check_ceiling(agent, fm.get("authority", "").strip(), declared)
    )


def emit_markdown() -> str:
    """Render the ladder incrementally: each rung shows only what it *adds*.

    Cumulative listings are unreadable at 51 browser tools, and the additive
    shape is the point of the ladder — one rung up is one bounded step up in
    authority.
    """
    lines: List[str] = []
    for family, rungs in LADDERS.items():
        lines.append(f"#### `{family}.*`\n")
        lines.append("| Rung | Adds | Cumulative |")
        lines.append("|---|---|---:|")
        for name, added in rungs:
            adds = ", ".join(f"`{t}`" for t in added)
            lines.append(f"| `{name}` | {adds} | {len(PROFILES[name])} |")
        lines.append("")
    lines.append("#### Flat profiles\n")
    lines.append("| Profile | Tools | Count |")
    lines.append("|---|---|---:|")
    for name in FLAT:
        tools = PROFILES[name]
        lines.append(f"| `{name}` | {', '.join(f'`{t}`' for t in tools)} | {len(tools)} |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", help="check a single agent by name")
    parser.add_argument(
        "--emit-markdown",
        action="store_true",
        help="print the generated profile table and exit",
    )
    args = parser.parse_args()

    if args.emit_markdown:
        print(emit_markdown())
        return 0

    errors = check_ladder_integrity()

    paths = sorted(AGENTS_DIR.glob("*.md"))
    if args.agent:
        paths = [p for p in paths if p.stem == args.agent]
        if not paths:
            print(f"FAIL: no agent named '{args.agent}' in {AGENTS_DIR}")
            return 1
    if not paths:
        print(f"FAIL: no agent definitions found in {AGENTS_DIR}")
        return 1

    for path in paths:
        errors.extend(check_agent(path))

    if errors:
        print(f"FAIL: tool-profile conformance ({len(errors)} error(s))\n")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(f"PASS: tool-profile conformance for {len(paths)} agent(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
