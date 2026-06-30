#!/usr/bin/env python3
"""
scaffold-skill.py — Scaffold a new Penny skill directory tree.

Usage:
    python scripts/tools/scaffold-skill.py --name weather-analysis \
        --description "Analyze weather data and generate reports" \
        --agents echo,piper,vera --goal "Create a weather analysis skill"

Creates:
    .pi/skills/weather-analysis/
    ├── SKILL.md
    ├── README.md
    ├── requirements.txt
    ├── scripts/
    │   ├── __init__.py
    │   └── orchestrate.py
    ├── tests/
    │   ├── test_unit.py
    │   ├── test_integration.py
    │   └── test_e2e.py
    ├── assets/
    │   └── prompts/
    │       └── echo.md (and others per --agents)
    └── resources/
        ├── reference.md
        └── flow.mmd

After scaffolding, invoke the plan skill to design the state machine
and populate the agent prompts with domain-specific guidance.

MAINTENANCE: When Penny skill conventions change, update the templates
in this file. The templates are the single source of truth for skill structure.
"""

import argparse
import os
import sys
from pathlib import Path
from typing import List


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".pi" / "skills"

# ============================================================
# Templates — MUST stay in sync with canonical skill (plan)
# ============================================================

SKILL_MD_TEMPLATE = """---
name: {name}
description: {description}
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    parallel_phases:
      - working
    invocation_modes:
      - single
      - parallel
      - chain
    subagents:{subagents_list}
---

## When to Use

- {use_case_1}
- User explicitly requests {name}-related analysis or work
- Multi-step process requiring {name} orchestration

## When Not to Use

- Simple, single-step tasks (execute directly)
- User explicitly says "just do it" (execute directly)
- Task is already well-defined with clear steps (proceed directly)

## ⛔ MANDATORY: Use the skill Tool

**USE THE `skill` TOOL. Do NOT drive the workflow manually.**

```typescript
skill({{
  skill_name: "{name}",
  goal: "Your goal here",
  project_root: "/path/to/project"
}})
```

**You do NOT need to manually call `bash`, `subagent`, or `python3`.**

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `skill_name` | Yes | Must be `"{name}"` |
| `goal` | Yes | The goal for this skill |
| `session_id` | No | Unique session ID (auto-generated if omitted) |
| `project_root` | No | Project root directory (defaults to cwd) |
| `constraints` | No | JSON object of constraints |

## ⛔ MANDATORY: Approve/Refine Cycle (Post-Completion)

**After the skill returns `success: true`, you MUST NOT execute any plan steps, perform additional analysis, or start work on the skill's topic. Your ONLY job is to present the result for user approval.**

### Step 1: Fetch the Full Result

Retrieve the full result from mempalace:

```python
memory_smart_search(query="<session_id>", room="skills/{name}-<session_id>", limit=10, include_full=true)
```

### Step 2: Present the Result

Present the result to the user, then immediately use the questionnaire tool:

```typescript
questionnaire({{
  questions: [{{
    id: "{name}_approval",
    label: "Result Review",
    prompt: "## Result\\n<full result content>\\n\\nWould you like to approve, refine, or discard?",
    options: [
      {{ value: "approve", label: "Approve", description: "Accept and use the result" }},
      {{ value: "refine", label: "Refine", description: "Re-run with modifications" }},
      {{ value: "discard", label: "Discard", description: "Discard this result" }}
    ],
    allowOther: true
  }}]
}})
```

- **Approve**: Accept the result
- **Refine**: Re-invoke the skill with refinement context in constraints
- **Discard**: Stop. Do nothing further.

### Prohibited After Skill Completion

❌ Do NOT perform additional analysis or research on the skill's topic
❌ Do NOT execute any steps before approval
❌ Do NOT modify the result directly — that's what "Refine" is for

## ⚠️ Escalation State — UNKNOWN_STATE Protocol

When the `{name}` skill returns `success: false` with `escalation` data,
it is NOT a failure — it is a **pending user clarification state**.

Re-invoke the skill with the user's response in `constraints.user_response`.

## Storing Learnings

After the skill is complete, store learnings in mempalace:

```python
memory_add_drawer(
    wing="penny",
    room="skills",
    content="## {Name} Skill Session Summary\\n\\n**Session ID:** {{session_id}}\\n**Goal:** {{goal}}\\n**Success:** {{is_success}}"
)

memory_kg_add(f"SkillSession:{{session_id}}", "completed", f"Skill:{name}:{{goal[:50]}}")
```
"""

README_MD_TEMPLATE = """# {Name} Skill

## Overview

- **Purpose**: {description}
- **Use When**: {use_case_1}
- **Outcome**: Validated skill result with structured output

## State Machine

```
[stateDiagram-v2 placeholder — design with plan skill before implementation]
```

## Subagents Used

| Subagent | Purpose | Prompt File |
|----------|---------|-------------|
{subagents_table}

## Mempalace Integration

**Context Retrieved (before workflow)**:
- Search `skills/{name}-<session_id>` for prior session context

**Learnings Stored (after completion)**:
- `penny/skills` — Session summary, decisions, outcomes

## Files

| File | Purpose |
|------|---------|
| `scripts/orchestrate.py` | State machine entry point |
| `tests/test_*.py` | Unit, integration, and E2E tests |
| `assets/prompts/*.md` | Domain Guidance for subagents |
| `resources/reference.md` | Technical reference |
| `resources/flow.mmd` | Pure Mermaid state diagram |

## Testing

```bash
cd .pi/skills/{name}/tests
pytest test_unit.py test_integration.py -v
pytest test_e2e.py -m e2e -v
```

## Version History

- **1.0.0** — Initial scaffold
"""

ORCHESTRATE_PY_TEMPLATE = """\"\"\"
{Name} Skill - State Machine Orchestration

Lightweight orchestration: Penny reads minimal directives, not full prompts.
Agents are self-sufficient — they read context from mempalace, write results to mempalace.
State passes through Penny as a small JSON blob, stored in mempalace between steps.

Key principle: Penny is a ROUTER, not a READER.
\"\"\"

import argparse
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from statemachine import State, StateMachine


# ============================================================
# Context Data Class
# ============================================================

@dataclass
class {Name}Context:
    \"\"\"Per-session skill state data — only metadata, no raw output.\"\"\"
    session_id: str = ""
    skill_name: str = "{name}"
    project_root: str = ""

    # Input
    goal: str = ""
    constraints: Dict[str, Any] = field(default_factory=dict)

    # Tracking
    iteration: int = 0
    max_iterations: int = 10
    errors: List[str] = field(default_factory=list)
    complete: bool = False


# ============================================================
# State Machine
# ============================================================

class {Name}Workflow(StateMachine):
    \"\"\"{Name} Workflow State Machine.\"\"\"

    # States
    intake = State(initial=True)
    working = State()
    reviewing = State()
    complete = State(final=True)
    error = State(final=True)

    # Transitions
    start = intake.to(working, cond="has_goal")
    proceed = working.to(reviewing, cond="work_complete")
    revise = reviewing.to(working, cond="needs_revision")
    finish = reviewing.to(complete, cond="review_approved")
    fail_work = working.to(error)
    fail_review = reviewing.to(error)

    # Guards
    def has_goal(self) -> bool:
        return bool(self.model.goal)

    def work_complete(self) -> bool:
        return self.model.iteration >= 1

    def needs_revision(self) -> bool:
        return False  # TODO: implement critique logic

    def review_approved(self) -> bool:
        return True  # TODO: implement review logic


# ============================================================
# Orchestrator
# ============================================================

class Orchestrator:
    \"\"\"Routes state to JSON actions for Penny.\"\"\"

    def __init__(self, context: {Name}Context):
        self.context = context
        self.workflow = {Name}Workflow(model=context)

    def _state_id(self) -> str:
        # Return current workflow state id without deprecation warning.
        return list(self.workflow.configuration)[0].id

    def _action(self, action: str, **kwargs) -> Dict[str, Any]:
        return {{
            "action": action,
            "state_id": self._state_id(),
            "session_id": self.context.session_id,
            "skills_used": ["{name}"],
            **kwargs,
        }}

    def _agent_for_state(self, state: str) -> str:
        mapping = {{
            "working": "echo",
            "reviewing": "vera",
        }}
        return mapping.get(state, "echo")

    def _task_summary(self, state: str) -> str:
        return f"Session: {{self.context.session_id}}. State: {{state}}. Goal: {{self.context.goal}}"

    def start(self, goal: str, constraints: dict = None) -> Dict[str, Any]:
        self.context.goal = goal
        if constraints:
            self.context.constraints = constraints
        self.workflow.start()
        return self._next_action()

    def step(self, agent: str, result: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
        # TODO: implement result processing and state transitions
        self.context.iteration += 1
        return self._action("complete", plan_summary={{
            "goal": self.context.goal,
            "steps_total": self.context.iteration,
            "requires_approval": False,
        }})

    def _next_action(self) -> Dict[str, Any]:
        state = self._state_id()
        if state == "complete":
            return self._action("complete", plan_summary={{
                "goal": self.context.goal,
                "steps_total": self.context.iteration,
                "requires_approval": False,
            }})
        elif state == "error":
            return self._action("error", errors=self.context.errors)
        elif state == "working":
            # ── Parallel exploration — identify independent aspects and dispatch in parallel ──
            # When a phase has independent sub-tasks, use invoke_agents_parallel instead of
            # sequential invoke_agent. Each task runs in its own agent instance.
            return self._action(
                "invoke_agents_parallel",
                tasks=[
                    {{
                        "agent": "echo",
                        "task_summary": (
                            f"Session: {{self.context.session_id}}. "
                            f"Goal: {{self.context.goal}}. "
                            f"Focus: entry points and call graph. "
                            f"Explore the codebase and write findings to mempalace."
                        ),
                    }},
                    {{
                        "agent": "echo",
                        "task_summary": (
                            f"Session: {{self.context.session_id}}. "
                            f"Goal: {{self.context.goal}}. "
                            f"Focus: tests and build pipeline. "
                            f"Explore the codebase and write findings to mempalace."
                        ),
                    }},
                ],
            )
        else:
            return self._action(
                "invoke_agent",
                agent=self._agent_for_state(state),
                task_summary=self._task_summary(state),
                orchestrator_state={{"session_id": self.context.session_id}},
            )


# ============================================================
# CLI Entry Point
# ============================================================

if __name__ == "__main__":
    # TODO: add argparse CLI for start/step/status subcommands
    pass
"""

TEST_UNIT_TEMPLATE = """\"\"\"
Unit tests for {name} skill orchestrator.

TDD: write failing tests first, then make them pass.
\"\"\"

import pytest
from pathlib import Path
import sys

# Import production classes from scripts package
from scripts.orchestrate import {Name}Context, {Name}Workflow, Orchestrator


def test_context_default_goal():
    ctx = {Name}Context(session_id="test-001")
    assert ctx.goal == ""
    assert ctx.skill_name == "{name}"


def test_workflow_starts_in_intake():
    ctx = {Name}Context(session_id="test-001")
    workflow = {Name}Workflow(model=ctx)
    assert workflow.intake.is_active


def test_orchestrator_action_structure():
    ctx = {Name}Context(session_id="test-001")
    orch = Orchestrator(ctx)
    action = orch.start(goal="test goal")
    assert "action" in action
    assert "session_id" in action


def test_complete_action_has_summary():
    ctx = {Name}Context(session_id="test-002", goal="test")
    orch = Orchestrator(ctx)
    action = orch.start(goal="test")
    # Force workflow to complete for test
    ctx.iteration = 1
    action = orch._next_action()
    # ... add more assertions based on actual implementation
"""

TEST_INTEGRATION_TEMPLATE = """\"\"\"
Integration tests for {name} skill.

Tests multi-module interactions:
- Orchestrator → State Machine
- Result processing → State transitions
- CLI entry points
\"\"\"

import pytest
import json
from pathlib import Path

from scripts.orchestrate import {Name}Context, Orchestrator


def test_start_to_first_action():
    ctx = {Name}Context(session_id="int-test-001")
    orch = Orchestrator(ctx)
    action = orch.start(goal="integration test goal")
    assert action["action"] in ("invoke_agent", "complete", "error")
    assert action["session_id"] == "int-test-001"


def test_step_advances_state():
    ctx = {Name}Context(session_id="int-test-002")
    orch = Orchestrator(ctx)
    orch.start(goal="step test")
    result = {{"exitCode": 0, "summary": {{"complete": True}}}}
    next_action = orch.step("echo", result, {{}})
    assert "action" in next_action
"""

TEST_E2E_TEMPLATE = """\"\"\"
End-to-end tests for {name} skill.

Tests the complete lifecycle from CLI invocation to final output.
These are SLOW tests — they exercise the full orchestration loop.

Mark with @pytest.mark.e2e:
    pytest test_e2e.py -m e2e -v
\"\"\"

import pytest
import subprocess
import json
from pathlib import Path

ORCHESTRATE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "orchestrate.py"


@pytest.mark.e2e
def test_cli_start_emits_json():
    \"\"\"CLI start must emit valid JSON action.\"\"\"
    result = subprocess.run(
        ["python", str(ORCHESTRATE_PATH), "start",
         "--session-id", "e2e-test-001",
         "--goal", "e2e test goal",
         "--project-root", str(Path(__file__).resolve().parent.parent)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stderr: {{result.stderr}}"
    action = json.loads(result.stdout)
    assert "action" in action
    assert "state_id" in action
"""

PROMPT_TEMPLATE = """# {{agent_name}} Prompt — {Name} Domain Guidance

## Mission

{{agent_name}}'s role in the {name} skill context.

## Mempalace-First Communication

Read prior results from mempalace room `skills/{name}-<session_id>`.
Write full results to the same room.
Return only a minimal SUMMARY to the orchestrator.

## Domain Guide

[Add CREST-derived domain checklists here]

## Output Format

Mandatory SUMMARY: `SUMMARY:{{"field": "value", "complete": true|false}}`
"""

REFERENCE_MD_TEMPLATE = """# {Name} Reference

## State Machine

### States
| State | Description | Entry Action |
|-------|-------------|--------------|
| intake | Starting state | Validate input |
| working | Main work phase | Execute subagent |
| reviewing | Review results | Validate output |
| complete | Success state | Store learnings |
| error | Failure state | Log and report |

### Transitions
| Transition | From | To | Guard |
|------------|------|-----|-------|
| start | intake | working | has_goal |
| proceed | working | reviewing | work_complete |
| finish | reviewing | complete | review_approved |
| fail | working | error | error_occurred |

## Subagents Used

| Name | Purpose | Expected Output |
|------|---------|-----------------|
{subagents_reference}

## Mempalace Integration

### Context Sources
- `skills/{name}-<session_id>` — Session-specific context

### Learning Outputs
- `penny/skills` — Session summary

## Error Handling

- Max iterations: configurable via constraints
- Error states log to stderr and mempalace
"""

FLOW_MMD_TEMPLATE = """stateDiagram-v2
    [*] --> Intake
    Intake --> Working : start
    Working --> Reviewing : work_complete
    Reviewing --> Complete : review_approved
    Complete --> [*]
    Working --> Error : error_occurred
    Reviewing --> Error : error_occurred
"""

REQUIREMENTS_TXT = """python-statemachine>=0.9.0
"""


# ============================================================
# Main Scaffolding Logic
# ============================================================

class SkillScaffolder:
    def __init__(self, name: str, description: str, agents: List[str]):
        self.name = name
        self.description = description
        self.agents = agents
        self.Name = name.replace("-", " ").title().replace(" ", "")

    def _render(self, template: str) -> str:
        subagents_list = "\n".join(f"      - {a}" for a in self.agents)
        subagents_table = "\n".join(
            f"| {a} | Purpose in {self.name} | assets/prompts/{a}.md |"
            for a in self.agents
        )
        subagents_reference = "\n".join(
            f"| {a} | {self.name}-specific task | Structured SUMMARY |"
            for a in self.agents
        )

        return template.format(
            name=self.name,
            Name=self.Name,
            description=self.description,
            subagents_list=subagents_list,
            subagents_table=subagents_table,
            subagents_reference=subagents_reference,
            use_case_1=f"Multi-step process requiring {self.name} orchestration",
        )

    def scaffold(self, base_dir: Path) -> Path:
        skill_dir = base_dir / self.name
        if skill_dir.exists():
            raise FileExistsError(f"Skill directory already exists: {skill_dir}")

        # Create directories
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "tests").mkdir(parents=True)
        (skill_dir / "assets" / "prompts").mkdir(parents=True)
        (skill_dir / "resources").mkdir(parents=True)

        # Write files
        (skill_dir / "SKILL.md").write_text(self._render(SKILL_MD_TEMPLATE), encoding="utf-8")
        (skill_dir / "README.md").write_text(self._render(README_MD_TEMPLATE), encoding="utf-8")
        (skill_dir / "scripts" / "__init__.py").write_text("", encoding="utf-8")
        (skill_dir / "scripts" / "orchestrate.py").write_text(
            self._render(ORCHESTRATE_PY_TEMPLATE), encoding="utf-8"
        )
        (skill_dir / "tests" / "test_unit.py").write_text(
            self._render(TEST_UNIT_TEMPLATE), encoding="utf-8"
        )
        (skill_dir / "tests" / "test_integration.py").write_text(
            self._render(TEST_INTEGRATION_TEMPLATE), encoding="utf-8"
        )
        (skill_dir / "tests" / "test_e2e.py").write_text(
            self._render(TEST_E2E_TEMPLATE), encoding="utf-8"
        )
        (skill_dir / "requirements.txt").write_text(REQUIREMENTS_TXT, encoding="utf-8")
        (skill_dir / "resources" / "reference.md").write_text(
            self._render(REFERENCE_MD_TEMPLATE), encoding="utf-8"
        )
        (skill_dir / "resources" / "flow.mmd").write_text(
            self._render(FLOW_MMD_TEMPLATE), encoding="utf-8"
        )

        # Write agent prompts
        for agent in self.agents:
            prompt = PROMPT_TEMPLATE.replace("{{agent_name}}", agent)
            (skill_dir / "assets" / "prompts" / f"{agent}.md").write_text(
                prompt, encoding="utf-8"
            )

        return skill_dir


def main():
    parser = argparse.ArgumentParser(description="Scaffold a new Penny skill")
    parser.add_argument("--name", required=True, help="Skill name (kebab-case)")
    parser.add_argument("--description", required=True, help="1-2 sentence description")
    parser.add_argument(
        "--agents",
        default="echo,piper,vera",
        help="Comma-separated list of subagents (default: echo,piper,vera)",
    )
    parser.add_argument(
        "--skills-dir",
        type=Path,
        default=SKILLS_DIR,
        help=f"Base directory for skills (default: {SKILLS_DIR})",
    )

    args = parser.parse_args()
    agents = [a.strip() for a in args.agents.split(",")]

    scaffolder = SkillScaffolder(
        name=args.name, description=args.description, agents=agents
    )

    try:
        skill_dir = scaffolder.scaffold(args.skills_dir)
    except FileExistsError as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print(f"✅ Scaffolded skill at: {skill_dir}")
    print()
    print("Next steps:")
    print(f"  1. Design the state machine with the plan skill:")
    print(f'     skill({{ skill_name: "plan", goal: "Design state machine for {args.name} skill" }})')
    print(f"  2. Implement the state machine in {skill_dir}/scripts/orchestrate.py")
    print(f"  3. Write domain guidance in {skill_dir}/assets/prompts/*.md")
    print(f"  4. Update {skill_dir}/resources/flow.mmd with the actual state diagram")
    print(f"  5. Run tests: cd {skill_dir}/tests && pytest test_*.py -v")
    print(f"  6. Register with: python scripts/system/register_artifact.py skill --name {args.name} --description \"{args.description}\"")
    print()
    print(f"Project root: {args.skills_dir.parent.parent}")


if __name__ == "__main__":
    main()
