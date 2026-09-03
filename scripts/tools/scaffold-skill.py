#!/usr/bin/env python3
"""Scaffold a static skill package for Penny's TypeScript orchestration engine.

The utility creates manifests, per-state Domain Guidance, references, and a
machine-readable flow diagram. It deliberately does not edit the TypeScript
playbook registry: registration is an authority-bearing source change that must
be reviewed with the playbook and tests.
"""

from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path


class SkillScaffolder:
    def __init__(self, name: str, description: str, agents: list[str]) -> None:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            raise ValueError("skill name must be lowercase kebab-case")
        if not agents or any(not re.fullmatch(r"[a-z][a-z0-9-]*", agent) for agent in agents):
            raise ValueError("at least one canonical agent name is required")
        self.name = name
        self.description = description.strip()
        self.agents = list(dict.fromkeys(agents))

    def state_for(self, agent: str) -> str:
        return f"working_{agent.replace('-', '_')}"

    def _build_skill_md(self) -> str:
        subagents = "\n".join(f"      - {agent}" for agent in self.agents)
        return f"""---
name: {self.name}
description: "{self.description}. Use when this established multi-stage workflow is required. Do not use when direct work or one agent is sufficient."
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents:
{subagents}
---

## When to Use

- Use for the proven `{self.name}` workflow when durable state, repair, or recovery matters.

## When Not to Use

- Do not use for a direct task that does not earn orchestration overhead.

## Invocation

```typescript
skill({{ skill_name: "{self.name}", goal: "..." }})
```

The TypeScript playbook supplies exact `input_artifacts` and an `output_artifact`
contract for every cognitive state. Workers read grants with `artifact_read`,
return complete stage content, and keep routing data only in the typed result.
"""

    def _build_readme_md(self) -> str:
        rows = "\n".join(
            f"| `{self.state_for(agent)}` | {agent} | Complete the state-specific mission. |"
            for agent in self.agents
        )
        return f"""# {self.name}

Static skill resources for the registered TypeScript `{self.name}` playbook.
The skill directory contains no executable delegate.

## States

| State | Agent | Mission |
|---|---|---|
{rows}

## Exact handoff

The owner persists complete worker bytes before routing. `RunContext` stores exact
selected refs, never payload bytes. Memory is optional and never workflow transport.

## Implementation

- Playbook: `apps/orchestration/src/playbooks/{self.name}.ts`
- Tests: `apps/orchestration/tests/{self.name}-playbook.test.ts`
- Flow: `resources/flow.html`
"""

    def _build_reference_md(self) -> str:
        states = ", ".join(f"`{self.state_for(agent)}`" for agent in self.agents)
        return f"""# {self.name} Reference

## Contract

The TypeScript playbook declares a closed `SkillContractV1`, state-specific result
schemas, authority posture, budgets, feedback kinds, and completion gate.

## States

{states}

Every state receives exact `input_artifacts`, emits owner-bound output metadata,
and has one `<agent>-<state>.md` prompt. Add bounded repair and gate tables here
when the playbook is implemented.

## Verification

The playbook test must cover every edge, gate, repair, terminal, recovery path,
and memory-absent execution. The prompt-surface and flow-diagram guards must include
this skill before registration.
"""

    def _build_prompt_md(self, agent: str, states: list[str]) -> str:
        state = states[0] if states else self.state_for(agent)
        return f"""# {agent} — {self.name} / {state}

## Mission

Complete the `{state}` state for the task goal within the supplied constraints.

## Exact artifact handoff

The task supplies `input_artifacts`. Read every granted ref with `artifact_read`
through `next_range` until complete. Do not discover predecessors through another channel; return `missing_input:` when a required ID/path is absent.
Return the complete stage output. The execution owner captures and registers it;
do not claim persistence. Typed result fields are routing data only.

## Non-negotiables

- Stay within the {agent} role and tool authority.
- Report blocking ambiguity through clarification fields rather than guessing.
- Do not claim completion without evidence appropriate to this state.

## Output

Return complete stage content and the exact typed routing fields declared by the
TypeScript state schema.
"""

    def _build_flow_html(self) -> str:
        """Build a safe, self-contained starter from the canonical flow template."""
        template_path = Path(__file__).with_name("templates") / "skill-flow.html"
        template = template_path.read_text(encoding="utf-8")
        states = [self.state_for(agent) for agent in self.agents]
        nodes: dict[str, dict[str, object]] = {}
        for index, (state, agent) in enumerate(zip(states, self.agents, strict=True)):
            nodes[state] = {
                "title": state,
                "desc": f"{agent} cognitive state; replace with the descriptor-backed mission.",
                "cls": agent,
                "who": agent,
                "lane": "center",
                "y": 40 + index * 150,
            }
        nodes["complete"] = {
            "title": "complete",
            "desc": "Positive terminal; replace with the descriptor-backed completion contract.",
            "cls": "done",
            "badge": "TERM",
            "lane": "center",
            "y": 40 + len(states) * 150,
        }
        edges: list[dict[str, str]] = [
            {"from": left, "to": right, "kind": "fwd", "label": "continue"}
            for left, right in zip(states, states[1:])
        ]
        if states:
            edges.append(
                {"from": states[-1], "to": "complete", "kind": "exit", "label": "complete"}
            )
        replacements = {
            "__FLOW_TITLE__": f"{self.name} flow | Penny",
            "__FLOW_HEADING__": f"{self.name} — draft execution flow",
            "__FLOW_SUMMARY__": "Draft visual mirror. Replace every placeholder and align N/E with the registered TypeScript descriptor before shipping.",
            "__FLOW_CALLOUT__": "Draft only: preserve authority boundaries, name every repair, and keep topology descriptor-backed.",
            "__FLOW_NOTES__": "Replace this draft note with bounded-repair, exhaustion, and omitted-seam documentation before registration.",
            "__N_JSON__": json.dumps(nodes, ensure_ascii=False, separators=(",", ":")),
            "__E_JSON__": json.dumps(edges, ensure_ascii=False, separators=(",", ":")),
        }
        missing = [token for token in replacements if token not in template]
        if missing:
            raise ValueError(
                f"canonical flow template is missing placeholders: {', '.join(missing)}"
            )
        for token, value in replacements.items():
            replacement = (
                value if token in {"__N_JSON__", "__E_JSON__"} else html.escape(value, quote=True)
            )
            template = template.replace(token, replacement)
        return template

    def write(self, project_root: Path) -> Path:
        root = project_root / ".pi" / "skills" / self.name
        prompts = root / "assets" / "prompts"
        resources = root / "resources"
        prompts.mkdir(parents=True, exist_ok=False)
        resources.mkdir(parents=True, exist_ok=True)
        (root / "SKILL.md").write_text(self._build_skill_md(), encoding="utf-8")
        (root / "README.md").write_text(self._build_readme_md(), encoding="utf-8")
        (resources / "reference.md").write_text(self._build_reference_md(), encoding="utf-8")
        (resources / "flow.html").write_text(self._build_flow_html(), encoding="utf-8")
        for agent in self.agents:
            state = self.state_for(agent)
            (prompts / f"{agent}-{state}.md").write_text(
                self._build_prompt_md(agent, [state]), encoding="utf-8"
            )
        return root


def main() -> int:
    parser = argparse.ArgumentParser(description="Scaffold a TypeScript-orchestrated Penny skill")
    parser.add_argument("--name", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--agents", required=True, help="comma-separated agent names")
    parser.add_argument("--project-root", default=".")
    args = parser.parse_args()
    scaffold = SkillScaffolder(
        args.name,
        args.description,
        [item.strip() for item in args.agents.split(",") if item.strip()],
    )
    target = scaffold.write(Path(args.project_root).resolve())
    print(target)
    print("Next: implement/register the TypeScript playbook and add full-path tests.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
