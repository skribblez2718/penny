# Agent Protocols

Seven cognitive agents spawned via Claude's Task tool. Each implements a specific cognitive function.

## Agent Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SKILL PHASE INVOKES AGENT                                │
│                              │                                               │
│                              ▼                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Task tool with subagent_type: "{agent-name}"                          │  │
│  │     │                                                                   │  │
│  │     ▼                                                                   │  │
│  │  {agent}/entry.py                                                       │  │
│  │     └→ agent_entry("{agent-name}")  [common/entry.py]                  │  │
│  │         ├→ AgentExecutionState(agent_name, task_id, current_step=0)    │  │
│  │         ├→ state.set_skill_context(skill, phase, pattern, predecessors)│  │
│  │         ├→ _print_mandatory_steps()  # List all required steps         │  │
│  │         ├→ state.save()  # ⚠️ SAVE BEFORE directive                    │  │
│  │         └→ format_agent_directive() + print  # Step 0 command          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│                              ▼                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP EXECUTION LOOP                                                   │  │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐  │  │
│  │  │ Step 0  │ → │ Step 1  │ → │ Step 2  │ → │ Step N  │ → │complete │  │  │
│  │  │learning │   │ Johari  │   │(varies) │   │(varies) │   │ .py     │  │  │
│  │  │injection│   │Discovery│   │         │   │         │   │         │  │  │
│  │  └─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘  │  │
│  │       │                                                       │        │  │
│  │       └── Each step: BaseAgentStep.run()                      │        │  │
│  │           ├→ print_content()  # Markdown instructions         │        │  │
│  │           ├→ execute()        # Subclass logic                │        │  │
│  │           ├→ mark_step_complete() + state.save()              │        │  │
│  │           └→ print_next_step_directive()                      │        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│                              ▼                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  {agent}/complete.py                                                   │  │
│  │     └→ agent_complete("{agent-name}")  [common/complete.py]            │  │
│  │         ├→ Validate all steps completed                                │  │
│  │         ├→ Verify memory file exists (if skill context)                │  │
│  │         ├→ signal_phase_completed()  # For skill orchestration         │  │
│  │         ├→ invoke_goal_memory()  # Metacognitive assessment            │  │
│  │         └→ Print: "{AGENT_NAME}_COMPLETE"                              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│                              ▼                                               │
│                    MEMORY FILE CREATED                                       │
│          .claude/memory/{task_id}-{agent}-memory.md                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
protocols/agent/
├── __init__.py             # Centralized exports
├── factory.py              # CLI: run agents via --agent and --mode flags
├── CLAUDE.md               # THIS FILE
│
├── common/                 # Shared entry/complete logic
│   ├── __init__.py
│   ├── entry.py            # agent_entry() - shared init for all agents
│   └── complete.py         # agent_complete() - shared finalization
│
├── config/                 # Configuration
│   ├── __init__.py
│   └── config.py           # AGENT_REGISTRY, context budgets, path helpers
│
├── steps/                  # Shared step implementations
│   ├── __init__.py
│   ├── base.py             # AgentExecutionState + BaseAgentStep
│   └── shared.py           # SHARED step 0-1 implementations (DRY)
│
├── state/                  # Agent state files (JSON)
│   └── {agent}-{task_id}.json
│
├── clarification/          # CLARIFICATION function
│   ├── entry.py            # Self-configuring: derives agent from directory name
│   ├── complete.py         # Self-configuring: derives agent from directory name
│   ├── content/step_{n}.md # Agent-specific markdown content
│   └── steps/step_{n}_{name}.py  # Step 2+ only (0-1 in steps/shared.py)
│
├── research/               # RESEARCH function
├── analysis/               # ANALYSIS function
├── synthesis/              # SYNTHESIS function
├── generation/             # GENERATION function
├── validation/             # VALIDATION function
└── memory/                 # METACOGNITION function
```

## Agent Factory (CLI)

The `factory.py` provides a unified command-line interface:

```bash
# Run agent entry
python3 factory.py --agent clarification --mode entry

# Run agent completion
python3 factory.py --agent clarification --mode complete

# List available agents
python3 factory.py --list-agents
```

## Self-Configuring Entry Pattern

All agent `entry.py` and `complete.py` files use a minimal self-configuring pattern (5 lines):

```python
#!/usr/bin/env python3
"""Agent Entry Point"""
if __name__ == "__main__":
    import sys; from pathlib import Path; sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from common.entry import agent_entry; agent_entry(Path(__file__).resolve().parent.name)
```

Key features:
- Derives agent name from directory name automatically
- No hardcoded agent names in individual files
- All logic centralized in `common/entry.py` and `common/complete.py`

## Agent Registry (from config/config.py)

| Agent | Cognitive Function | Steps | Color | Model |
|-------|-------------------|-------|-------|-------|
| clarification | CLARIFICATION | 7 | cyan | sonnet |
| research | RESEARCH | 7 | blue | sonnet |
| analysis | ANALYSIS | 7 | green | opus |
| synthesis | SYNTHESIS | 7 | magenta | opus |
| generation | GENERATION | 7 | yellow | sonnet |
| validation | VALIDATION | 6 | red | sonnet |
| memory | METACOGNITION | 8 | purple | haiku |

**Model Selection Rationale:**
- **Opus:** Analysis and Synthesis require maximum reasoning for mission-critical decisions
- **Sonnet:** Balanced intelligence for interactive (clarification), research, coding (generation), and validation
- **Haiku:** Memory runs frequently and has simple tasks - optimize for speed/cost

## Standard Step Sequence

All agents follow the same initial steps (DRY implementation), then diverge for agent-specific work:

| Step | Name | Purpose | Implementation |
|------|------|---------|----------------|
| 0 | `learning_injection` | Load domain-specific learnings | `steps/shared.py:LearningInjectionStep` |
| 1 | `johari_discovery` | Transform unknown unknowns to known knowns | `steps/shared.py:JohariDiscoveryStep` |
| 2+ | (varies) | Agent-specific cognitive work | `{agent}/steps/step_{n}_{name}.py` |

**DRY Pattern:** Steps 0-1 use a single shared implementation for ALL 7 agents in `steps/shared.py`.
The `config/config.py:get_step_script_path()` function routes steps 0-1 to the shared implementation.

**Critical Rule:** If Step 1 (Johari Discovery) identifies clarifying questions, the agent MUST halt and ask before proceeding to Step 2.

## Call Chain: Skill → Agent → Memory

```python
# 1. Skill phase triggers agent (via Task tool)
protocols/skill/agent_invoker.py
    └→ Task tool with subagent_type: "{agent-name}"
        └→ Claude Code invokes: protocols/agent/{agent}/entry.py

# 2. Agent entry (common for all agents)
{agent}/entry.py
    └→ agent_entry(agent_name)  [common/entry.py]
        ├→ parse_args()  # --skill-name, --phase-id, --context-pattern
        ├→ AgentExecutionState(agent_name, task_id, current_step=0)
        ├→ state.set_skill_context(...)  # Store skill orchestration info
        ├→ state.metadata["expected_steps"] = len(steps)
        ├→ _print_mandatory_steps()  # ENFORCEMENT: List all required steps
        └→ print(format_agent_directive(step_0_script))

# 3. Each step (inherits BaseAgentStep)
step_{n}_{name}.py --state {state_file}
    └→ BaseAgentStep.run()  [steps/base.py]
        ├→ print_content()  # Load markdown from content/step_{n}.md
        │   └→ enforce_context_budget()  # Truncate if over limit
        ├→ execute()  # Subclass implements cognitive work
        ├→ state.mark_step_complete(step_num, output)
        │   └→ state.save()  # ⚠️ MUST save before next directive
        └→ print_next_step_directive()

# 4. Agent completion
{agent}/complete.py --state {state_file}
    └→ agent_complete(agent_name)  [common/complete.py]
        ├→ Validate: completed_steps == total_steps
        ├→ verify_exists(task_id, agent_name)  # Check memory file
        ├→ signal_phase_completed(task_id, phase_id, agent_name)
        ├→ invoke_goal_memory(state, agent_name)  # Unless memory agent
        └→ print("{AGENT_NAME}_COMPLETE")

# 5. Memory file creation (during agent execution)
# Agent writes: .claude/memory/{task_id}-{agent}-memory.md
# Format: Markdown with ## Step N: markers for each step output
```

## Data Contracts

### Expected Prompt Format (Agent Invocation)

When agents are invoked via the Task tool, the DA **MUST** structure the prompt using the standardized Agent Prompt Template format. This ensures consistent context and Johari knowledge transfer.

#### Required Sections in Agent Prompts

| Section | Required | Description |
|---------|----------|-------------|
| **Task Context** | Yes | task_id, skill_name, phase_id, domain, agent_name |
| **Role Extension** | Yes | 3-5 task-specific focus areas (DA generates dynamically) |
| **Johari Context** | If available | Open/Blind/Hidden/Unknown from reasoning protocol Step 0 |
| **Task Instructions** | Yes | Specific cognitive work for this agent |
| **Related Research Terms** | Yes | 7-10 keywords (DA generates dynamically) |
| **Output Requirements** | Yes | Memory file path and format |

#### Why Agents Expect This Format

1. **Task Context** - Identifies the workflow and phase, enables memory file path construction
2. **Role Extension** - Specializes the generic agent for the specific task at hand
3. **Johari Context** - Transfers reasoning protocol discoveries to inform agent work
4. **Research Terms** - Aids knowledge discovery during agent execution
5. **Output Requirements** - Ensures memory file is written to correct path

**Reference:** See skill's SKILL.md "Agent Invocation Format" section or DA.md "Agent Prompt Template Requirements"

### Agent State File (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `agent_name` | string | Agent identifier |
| `task_id` | string | UUID for this task |
| `current_step` | int | Current step number (0-indexed) |
| `started_at` | ISO datetime | When agent started |
| `completed_steps` | list[int] | Steps that have completed |
| `step_outputs` | dict | `{step_num: {output_data}}` |
| `metadata.skill_name` | string | Skill that invoked agent |
| `metadata.phase_id` | string | Phase within skill |
| `metadata.context_pattern` | string | How to load predecessor context |
| `metadata.predecessors` | list | Predecessor agent names |

### Memory File Format (Section-based with Johari Summary)

```markdown
# {Agent} Agent Output: {Task Description}

## Section 0: Context Loaded
[Task ID, skill, phase, domain, user request]

## Section 1: Step Overview
[What was clarified/researched/analyzed, key decisions]

## Section 2: Johari Summary
[Known Knowns, Known Unknowns, Unknown Unknowns]

## Section 3: Downstream Directives
[Instructions for next phase/agent]

---
**{AGENT_NAME}_COMPLETE**
```

### Context Budget Limits (from config/config.py)

| Agent | Max Input Tokens | Max Output Tokens | Priority Sections |
|-------|-----------------|-------------------|-------------------|
| clarification | 2000 | 1500 | task_description, user_query, unknowns |
| research | 3000 | 2500 | research_queries, unknowns, constraints |
| analysis | 2500 | 2000 | research_findings, constraints, trade_offs |
| synthesis | 3000 | 2500 | analysis_output, constraints, design_decisions |
| generation | 4000 | 8000 | specification, design, constraints |
| validation | 2500 | 1500 | artifact, criteria, constraints |
| memory | 1500 | 800 | agent_output_summary, previous_goal_state |

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Agents are NEVER called directly
   └→ Always via Task tool with subagent_type parameter
   └→ entry.py is invoked BY the Task tool

2. Every agent step MUST inherit BaseAgentStep
   └→ steps/base.py provides run(), state management

3. state.save() MUST be called BEFORE print_next_step_directive()
   └→ If Claude crashes after print, state is recoverable

4. Memory file MUST exist before complete.py succeeds
   └→ verify_exists() blocks completion without memory file
   └→ Format: .claude/memory/{task_id}-{agent}-memory.md

5. Step 0 is ALWAYS learning_injection
   └→ Loads domain-specific learnings from .claude/learnings/

6. Step 1 is ALWAYS johari_discovery
   └→ Executes SHARE/ASK/ACKNOWLEDGE/EXPLORE framework
   └→ MUST halt if clarifying questions exist

7. memory agent is invoked after EVERY agent completion
   └→ Provides metacognitive assessment of workflow state
   └→ Except: memory agent doesn't invoke itself
```

## Metacognitive Hook Bypass

Controlled by `SKILLS_BYPASSING_METACOGNITIVE_HOOKS` constant in `common/complete.py`.

## Key Functions

| Location | Function | Purpose |
|----------|----------|---------|
| `config/config.py` | `AGENT_REGISTRY` | All agents, steps, colors, models |
| `config/config.py` | `AGENT_CONTEXT_BUDGETS` | Token limits per agent |
| `config/config.py` | `format_agent_directive()` | Wrap command in enforcement language |
| `common/entry.py` | `agent_entry()` | Shared agent initialization |
| `common/entry.py` | `_print_mandatory_steps()` | Print enforcement step list |
| `common/complete.py` | `agent_complete()` | Shared agent finalization |
| `common/complete.py` | `invoke_goal_memory()` | Trigger metacognitive assessment |
| `steps/base.py` | `AgentExecutionState` | State management dataclass |
| `steps/base.py` | `BaseAgentStep.run()` | Step execution orchestration |
| `steps/base.py` | `enforce_context_budget()` | Truncate content over limit |
| `steps/shared.py` | `LearningInjectionStep` | Shared Step 0 for all agents |
| `steps/shared.py` | `JohariDiscoveryStep` | Shared Step 1 for all agents |

## Step Class Architecture (DRY Pattern)

All agent step files follow a consistent pattern using class-level attributes:

```python
#!/usr/bin/env python3
"""Step N: Step Name"""
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from steps.base import BaseAgentStep

class StepNStepName(BaseAgentStep):
    """Step N: Description"""
    _step_num = N              # Class attribute (not property)
    _step_name = "STEP_NAME"   # Class attribute (not property)

    def execute(self) -> dict[str, Any]:
        return {"action": "step_action_initiated"}

if __name__ == "__main__":
    sys.exit(StepNStepName.main())  # Uses base class main()
```

**Key DRY Patterns:**
- `_step_num` and `_step_name` as **class attributes**, not property methods
- `main()` in base class handles argparse and state loading
- No redundant `main()` boilerplate in individual step files
- Steps 0-1 implemented ONCE in `steps/shared.py`, used by ALL agents

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/step_{n}.md`
- Adding fields to step_outputs
- Adding new metadata fields to state
- Adjusting context budget limits in config/config.py
- Enhancing execute() in individual step scripts

### ⚠️ Requires Careful Testing

- Adding new steps (update config/config.py AGENT_REGISTRY)
- Changing step order (update config/config.py steps list)
- Adding new agents (full directory structure required)
- Modifying state schema (handle backwards compatibility)

### ❌ Dangerous - Will Break System

- Calling entry.py directly instead of via Task tool
- Removing state.save() before print_next_step_directive()
- Removing memory file verification in complete.py
- Removing memory agent invocation from agent_complete()
- Changing task_id format (breaks memory file path resolution)
- Removing Step 0 (learning_injection) from any agent
- Removing Step 1 (johari_discovery) from any agent

## Debugging Tips

```bash
# Check agent state
cat .claude/orchestration/protocols/agent/state/{agent}-*.json | jq .

# List memory files for a task
ls -la .claude/memory/ | grep {task_id_prefix}

# Check which steps completed
cat protocols/agent/state/{agent}-{task_id}.json | jq '.completed_steps'

# Verify agent registry
python3 -c "from config.config import AGENT_REGISTRY; print(list(AGENT_REGISTRY.keys()))"

# Check context budget
python3 -c "from config.config import get_agent_budget; print(get_agent_budget('research'))"
```

## Agent Mode in Reasoning Protocol

When an agent runs the reasoning protocol (via `--agent-mode`):
- Step 4 (Task Routing) is **skipped** - agents are already routed
- Step sequence: 1, 2, 3, 3b, 5, 6, 7, 8
- FSM transition: `SKILL_DETECTION → SELF_CONSISTENCY` (bypasses `TASK_ROUTING`)
- This is for agents doing internal reasoning, not task routing
- Set via: `entry.py "task" --agent-mode`
- Metadata flag: `state.metadata["is_agent_session"] = True`
- Handled by: `step_3b_skill_detection.py` detects agent mode and routes to Step 5

Note: Planning is handled by Claude Code's EnterPlanMode tool.
