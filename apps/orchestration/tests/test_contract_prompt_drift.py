"""Contract<->prompt SUMMARY drift guard.

For every skill, the top-level keys declared in a state's ``summary_contract``
(required + optional) must match the top-level keys shown in the SUMMARY schema
of the prompt file that state maps to. The engine renders the schema from the
contract as the final agent directive; the prompt example must agree so the two
never drift (2026-07-08 alignment). A prompt that intentionally omits the SUMMARY
schema entirely (de-dup'd, e.g. prd) is skipped.

Mapping: single-prompt skills use ``<agent>.md``; jsa/sca use ``_PROMPT_BY_STATE``.
Comparison is at the FILE level (union across all states that map to a file), so
files serving multiple states (e.g. code's skribble.md = implement+verify) are
handled correctly.
"""

import re
from collections import defaultdict
from pathlib import Path

import orchestration.playbooks.jsa as jsa_mod
import orchestration.playbooks.sca as sca_mod
from orchestration.playbooks import PLAYBOOKS

_PROMPT_BY_STATE = {
    "jsa": getattr(jsa_mod, "_PROMPT_BY_STATE", {}),
    "sca": getattr(sca_mod, "_PROMPT_BY_STATE", {}),
}
# apps/orchestration/tests/<this file> -> repo root is three parents up.
_ROOT = Path(__file__).resolve().parents[3]
_SKILLS = ["agent", "code", "jsa", "plan", "prd", "research", "sca"]


def _top_level_keys(s: str) -> set:
    """Depth-1 keys of the first {...} object in ``s`` (placeholder-tolerant)."""
    keys, depth, j, n = set(), 0, s.find("{"), len(s)
    if j == -1:
        return keys
    while j < n:
        ch = s[j]
        if ch == '"':
            k = j + 1
            val = ""
            while k < n and s[k] != '"':
                if s[k] == "\\":
                    k += 2
                    continue
                val += s[k]
                k += 1
            m = k + 1
            while m < n and s[m] in " \t":
                m += 1
            if depth == 1 and m < n and s[m] == ":":
                keys.add(val)
            j = k + 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return keys


def _drift_report() -> list:
    problems = []
    for skill in _SKILLS:
        pb = PLAYBOOKS[skill]
        pbs = _PROMPT_BY_STATE.get(skill, {})
        file_contract_keys = defaultdict(set)
        items = list(pb.PRIMITIVE_BY_STATE.items())
        for pstate, pspec in pb.PARALLEL_BY_STATE.items():
            for branch in pspec.branches.values():
                items.append((pstate, branch))
        for state, spec in items:
            name = pbs.get(state, spec.agent)
            c = spec.summary_contract or {}
            file_contract_keys[name] |= set(c.get("required", {})) | set(c.get("optional", {}))
        for name, ckeys in file_contract_keys.items():
            pf = _ROOT / ".pi" / "skills" / skill / "assets" / "prompts" / f"{name}.md"
            if not pf.exists():
                continue
            pkeys = set()
            for line in pf.read_text(encoding="utf-8").splitlines():
                # Only real schema lines (a quoted key follows the brace) — not
                # prose placeholders like `SUMMARY:{...}`.
                m = re.search(r'SUMMARY:(\{".*)', line)
                if m:
                    pkeys |= _top_level_keys(m.group(1))
            if not pkeys:
                continue  # de-dup'd prompt (no schema restated) — intentional
            prompt_only = pkeys - ckeys
            contract_only = ckeys - pkeys
            if prompt_only or contract_only:
                problems.append(
                    f"{skill}/{name}.md: prompt-only={sorted(prompt_only)} "
                    f"contract-only={sorted(contract_only)}"
                )
    return problems


def test_no_contract_prompt_summary_drift():
    problems = _drift_report()
    assert not problems, "Contract<->prompt SUMMARY drift detected:\n" + "\n".join(problems)
