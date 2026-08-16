"""Contract-to-prompt SUMMARY drift guard for the retained research skill."""

import json
import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path

from orchestration.playbooks import PLAYBOOKS

_ROOT = Path(__file__).resolve().parents[3]
_SKILLS = ("research",)
_RESEARCH_PROMPTS = tuple(
    sorted((_ROOT / ".pi" / "skills" / "research" / "assets" / "prompts").glob("*.md"))
)
_ACTIVE_RESEARCH_SURFACES = (
    _ROOT / "apps" / "orchestration" / "src" / "orchestration" / "playbooks" / "research.py",
    _ROOT / ".pi" / "skills" / "research" / "SKILL.md",
    _ROOT / ".pi" / "skills" / "research" / "README.md",
    _ROOT / ".pi" / "skills" / "research" / "resources" / "reference.md",
    _ROOT / ".pi" / "skills" / "research" / "resources" / "flow.html",
    _ROOT / "docs" / "agents" / "capabilities" / "research-skill" / "research-skill.md",
    _ROOT / "docs" / "humans" / "capabilities" / "research-skill" / "research-skill.md",
    *_RESEARCH_PROMPTS,
)


def _top_level_keys(source: str) -> set[str]:  # noqa: C901
    """Return depth-one keys from the first object in placeholder-tolerant text."""
    keys: set[str] = set()
    depth = 0
    index = source.find("{")
    if index == -1:
        return keys
    while index < len(source):
        character = source[index]
        if character == '"':
            end = index + 1
            value = ""
            while end < len(source) and source[end] != '"':
                if source[end] == "\\":
                    end += 2
                    continue
                value += source[end]
                end += 1
            marker = end + 1
            while marker < len(source) and source[marker] in " \t":
                marker += 1
            if depth == 1 and marker < len(source) and source[marker] == ":":
                keys.add(value)
            index = end + 1
            continue
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                break
        index += 1
    return keys


def _drift_report() -> list[str]:
    problems: list[str] = []
    for skill in _SKILLS:
        playbook = PLAYBOOKS[skill]
        file_contract_keys: dict[str, set[str]] = defaultdict(set)
        items = list(playbook.PRIMITIVE_BY_STATE.items())
        for state, parallel in playbook.PARALLEL_BY_STATE.items():
            items.extend((state, branch) for branch in parallel.branches.values())
        for _state, spec in items:
            contract = spec.summary_contract or {}
            file_contract_keys[spec.agent] |= set(contract.get("required", {}))
            file_contract_keys[spec.agent] |= set(contract.get("optional", {}))
        for agent, contract_keys in file_contract_keys.items():
            prompt = _ROOT / ".pi" / "skills" / skill / "assets" / "prompts" / f"{agent}.md"
            if not prompt.exists():
                continue
            prompt_keys: set[str] = set()
            for line in prompt.read_text(encoding="utf-8").splitlines():
                match = re.search(r'SUMMARY:(\{".*)', line)
                if match:
                    prompt_keys |= _top_level_keys(match.group(1))
            if not prompt_keys:
                continue
            prompt_only = prompt_keys - contract_keys
            contract_only = contract_keys - prompt_keys
            if prompt_only or contract_only:
                problems.append(
                    f"{skill}/{agent}.md: prompt-only={sorted(prompt_only)} "
                    f"contract-only={sorted(contract_only)}"
                )
    return problems


def test_no_contract_prompt_summary_drift():
    problems = _drift_report()
    assert not problems, "Contract<->prompt SUMMARY drift detected:\n" + "\n".join(problems)


def test_active_research_surfaces_have_no_semantic_workflow_transport():
    forbidden = {
        "model-authored drawer field": re.compile(r"m[e]mpalace_drawer", re.IGNORECASE),
        "session room field": re.compile(r"session_room", re.IGNORECASE),
        "semantic skill room": re.compile(r"(?<!\.pi/)skills/[A-Za-z0-9_*<{]"),
        "semantic read/write call": re.compile(
            r"memory_(?:smart_search|add_drawer|check_duplicate|kg_add)\s*\(", re.IGNORECASE
        ),
    }
    problems: list[str] = []
    for path in _ACTIVE_RESEARCH_SURFACES:
        text = path.read_text(encoding="utf-8")
        for label, pattern in forbidden.items():
            if pattern.search(text):
                problems.append(f"{path.relative_to(_ROOT)}: {label}")
    assert not problems, "active research semantic handoff returned:\n" + "\n".join(problems)


def test_every_research_prompt_requires_exact_owner_artifact_handoff():
    problems: list[str] = []
    for path in _RESEARCH_PROMPTS:
        text = path.read_text(encoding="utf-8")
        lowered = text.lower()
        for required in (
            "input_artifacts",
            "artifact_read",
            "execution owner",
            "`summary` is routing data only",
            "do not claim artifact persistence or registration",
        ):
            if required not in lowered:
                problems.append(f"{path.name}: missing {required!r}")
    assert not problems, "research prompt artifact contract drift:\n" + "\n".join(problems)


def test_final_report_prompt_makes_owner_output_a_complete_product_artifact():
    text = (_ROOT / ".pi" / "skills" / "research" / "assets" / "prompts" / "skribble.md").read_text(
        encoding="utf-8"
    )
    for required in (
        "registered product artifact",
        "# report.md",
        "# sources.md",
        "# README.md",
        "complete contents",
    ):
        assert required in text


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
            json.dumps({"scripts": {"test:integration": "fixture"}}),
            encoding="utf-8",
        )
        (directory / "tests").mkdir()
        (directory / "tests" / "vitest.integration.config.ts").write_text(
            "export default {};\n", encoding="utf-8"
        )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_bun = fake_bin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$PWD\" >> {str(log)!r}\n"
        'case "$PWD" in *b-failing) exit 9;; esac\n'
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
