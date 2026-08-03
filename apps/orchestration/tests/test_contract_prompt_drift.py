"""Contract<->prompt SUMMARY drift guard.

For every skill, the top-level keys declared in a state's ``summary_contract``
(required + optional) must match the top-level keys shown in the SUMMARY schema
of the prompt file that state maps to. The engine renders the schema from the
contract as the final agent directive; the prompt example must agree so the two
never drift (2026-07-08 alignment). A prompt that omits the SUMMARY schema entirely
is skipped by this guard — but note the cost: omitting it makes the prompt DEPEND on
the engine directive, which is a tagged loan (``summary_schema_restatement``)
returning "" under ``PI_MODEL_TIER=strong`` or ablation. prd's two prompts were
de-dup'd that way and so lost their key list on exactly the strong-model path; both
now carry their own schema and are enforced here (2026-07-28).

Mapping: single-prompt skills use ``<agent>.md``; jsa/sca use ``_PROMPT_BY_STATE``.
Comparison is at the FILE level (union across all states that map to a file), so
files serving multiple states (e.g. code's skribble.md = implement+verify) are
handled correctly.
"""

import json
import os
import re
import subprocess
from collections import defaultdict
from copy import deepcopy
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
_SKILLS = ["code", "jsa", "plan", "prd", "research", "sca"]


def _top_level_keys(s: str) -> set:  # noqa: C901 - small placeholder-tolerant parser
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


def _drift_report() -> list:  # noqa: C901 - matrix traversal remains explicit
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


def _semantic_drift_problems(matrix: dict, root: Path = _ROOT) -> list[str]:
    """Validate each owning surface independently, including explicit contradictions."""
    problems: list[str] = []
    if matrix.get("schema_version") != 1 or matrix.get("version") != 2:
        problems.append("contract/drift matrix schema or selected version is stale")
    topics = matrix.get("topics")
    if not isinstance(topics, dict) or not topics:
        return problems + ["contract/drift matrix has no topics"]
    for topic, contract in topics.items():
        surface_contracts = contract.get("surface_contracts") if isinstance(contract, dict) else None
        if not isinstance(surface_contracts, dict) or not surface_contracts:
            problems.append(f"{topic}: no typed surface contracts")
            continue
        for relative, surface_contract in surface_contracts.items():
            path = root / relative
            if not path.is_file():
                problems.append(f"{topic}/{relative}: stale or missing surface")
                continue
            if not isinstance(surface_contract, dict) or set(surface_contract) != {
                "required_tokens",
                "forbidden_tokens",
            }:
                problems.append(f"{topic}/{relative}: malformed surface contract")
                continue
            text = path.read_text(encoding="utf-8").lower()
            omitted = [
                token
                for token in surface_contract["required_tokens"]
                if token.lower() not in text
            ]
            contradictions = [
                token
                for token in surface_contract["forbidden_tokens"]
                if token.lower() in text
            ]
            if omitted:
                problems.append(f"{topic}/{relative}: omitted {omitted}")
            if contradictions:
                problems.append(f"{topic}/{relative}: contradictions {contradictions}")
    return problems


def test_named_code_p0_contract_drift_matrix_has_no_per_surface_omission_or_contradiction():
    matrix_path = _ROOT / "scripts/system/checks/code_p0_contract_drift_matrix.json"
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    assert matrix["matrix_id"] == "penny-code-skill-p0-contract-drift"
    assert _semantic_drift_problems(matrix) == []


def test_contract_drift_validator_bites_on_one_surface_contradiction():
    matrix_path = _ROOT / "scripts/system/checks/code_p0_contract_drift_matrix.json"
    matrix = deepcopy(json.loads(matrix_path.read_text(encoding="utf-8")))
    contract = matrix["topics"]["target-profiles"]["surface_contracts"][
        ".pi/skills/code/assets/prompts/skribble.md"
    ]
    contract["forbidden_tokens"].append("consume the selected target profile")

    problems = _semantic_drift_problems(matrix)
    assert any("target-profiles" in problem and "contradictions" in problem for problem in problems)


def test_root_integration_aggregate_propagates_a_child_failure(tmp_path):
    root_package = json.loads((_ROOT / "package.json").read_text(encoding="utf-8"))
    command = root_package["scripts"]["test:integration"]
    assert command.startswith("set -e;")

    extensions = tmp_path / "extensions"
    log = tmp_path / "calls.log"
    for name in ("a-first", "b-failing", "c-never"):
        directory = extensions / name
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(
            json.dumps({"scripts": {"test:integration": "fixture"}}), encoding="utf-8"
        )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_bun = fake_bin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$PWD\" >> {str(log)!r}\n"
        "case \"$PWD\" in *b-failing) exit 9;; esac\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_bun.chmod(0o755)
    fixture_command = command.replace(".pi/extensions/*/", f"{extensions}/*/")
    process = subprocess.run(
        ["sh", "-c", fixture_command],
        cwd=tmp_path,
        env={**os.environ, "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert process.returncode == 9
    calls = log.read_text(encoding="utf-8")
    assert str(extensions / "a-first") in calls
    assert str(extensions / "b-failing") in calls
    assert str(extensions / "c-never") not in calls
