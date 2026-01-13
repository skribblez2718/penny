# Orchestration System

Python-based orchestration for the system's cognitive workflows. Scripts output markdown directives that Claude must execute.

## System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER QUERY ARRIVES                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     REASONING PROTOCOL (9 Steps: 0-8)                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │ Step 0  │→ │ Step 1  │→ │ Step 2  │→ │ Step 3  │→ │ Step 3b │          │
│  │ Johari  │  │Semantic │  │ Chain   │  │ Tree    │  │ Skill   │          │
│  │Discovery│  │Underst. │  │of Thght │  │of Thght │  │Detect   │          │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘          │
│       │                                                    │                │
│       │       ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│       └─────→ │ Step 4  │→ │ Step 5  │→ │ Step 6  │→ │ Step 7  │          │
│               │ Task    │  │Self-Cons│  │Socratic │  │Constit. │          │
│               │ Routing │  └─────────┘  └─────────┘  └─────────┘          │
│               └─────────┘                                  │                │
│                                 ┌─────────┐                │                │
│                                 │ Step 8  │←───────────────┘                │
│                                 │Know.Xfer│                                 │
│                                 └─────────┘                                 │
│  Step 0: Johari Window Discovery - executes at START of every interaction  │
│  Agent mode (subagents) skips Step 4 → goes from 3b to Step 5              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
          ┌─────────────┐                 ┌─────────────┐
          │   SKILL     │                 │  DYNAMIC    │
          │ORCHESTRATION│                 │   SKILL     │
          │             │                 │ SEQUENCING  │
          └─────────────┘                 └─────────────┘
                 │                               │
                 ▼                               ▼
          ┌─────────────────────────────────────────────┐
          │              SKILL EXECUTION                 │
          │  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
          │  │ Phase 0 │→ │ Phase 1 │→ │ Phase N │     │
          │  │(Clarify)│  │(varies) │  │(varies) │     │
          │  └─────────┘  └─────────┘  └─────────┘     │
          └─────────────────────────────────────────────┘
                              │
                              ▼
          ┌─────────────────────────────────────────────┐
          │         AGENT INVOCATION (per phase)        │
          │                                             │
          │  protocols/skill/core/agent_invoker.py      │
          │            │                                │
          │            ▼                                │
          │  Task tool with subagent_type: {agent}      │
          │            │                                │
          │            ▼                                │
          │  protocols/agent/{agent}/entry.py           │
          │            │                                │
          │            ▼                                │
          │  Steps 0→1→2→...→N (varies by agent)       │
          │    Step 0: learning_injection (all)        │
          │    Step 1: johari_discovery (all)          │
          │    Step 2+: agent-specific work            │
          │            │                                │
          │            ▼                                │
          │  .claude/memory/{task_id}-{agent}-memory.md │
          └─────────────────────────────────────────────┘
```

## Directory Structure

```
orchestration/
├── CLAUDE.md               # THIS FILE
├── __init__.py             # Centralized path management and helpers
├── paths.py                # Additional path helpers
├── protocols/              # All protocol implementations
│   ├── reasoning/          # 9-step pre-task reasoning (Step 0-8, ALWAYS RUNS FIRST)
│   ├── execution/          # Post-reasoning execution routing
│   ├── agent/              # 7 cognitive agents (spawned via Task tool)
│   └── skill/              # Composite + atomic skill definitions
└── shared/                 # Reusable markdown content snippets
    └── templates/          # Agent prompt templates (CRITICAL)
```

## Agent Prompt Template System

When invoking agents via atomic skills, the DA **MUST** use the standardized Agent Prompt Template format. This ensures consistent context passing and Johari knowledge transfer.

### Key Files

| File | Purpose |
|------|---------|
| `shared/templates/agent-system-prompt.md` | Full template with all placeholders |
| `shared/templates/SKILL-TEMPLATE-REFERENCE.md` | Shared reference for SKILL.md files |
| `shared/templates/CLAUDE.md` | Template system documentation |
| Individual `SKILL.md` files | "Agent Invocation Format" section |

### Required Template Sections

| Section | Required | Source |
|---------|----------|--------|
| Task Context | Yes | task_id, skill_name, phase_id, domain, agent_name |
| Role Extension | Yes | DA generates dynamically (3-5 focus areas) |
| Johari Context | If available | From reasoning protocol Step 0 |
| Task Instructions | Yes | Specific cognitive work |
| Related Research Terms | Yes | DA generates dynamically (7-10 keywords) |
| Output Requirements | Yes | Memory file path |

See DA.md "Agent Prompt Template Requirements" section for full details.

Note: Skill routing uses the orchestrator's semantic understanding (DA.md Skill Routing Table with semantic_trigger and not_for columns),
not keyword-based pattern matching. When routing confidence is not HIGH, the system HALTs and asks for user clarification.

## Shared Path Management (orchestration/__init__.py)

The `orchestration/__init__.py` module provides centralized path constants and helpers:

```python
from orchestration import (
    ORCHESTRATION_ROOT, CLAUDE_ROOT, PROJECT_ROOT,
    PROTOCOLS_DIR, AGENT_PROTOCOLS_DIR, SKILL_PROTOCOLS_DIR,
    get_agent_dir, get_composite_skill_dir, get_memory_file_path,
)
```

**Key paths:**
- `ORCHESTRATION_ROOT` - This directory
- `CLAUDE_ROOT` - Parent `.claude/` directory
- `PROTOCOLS_DIR` - `orchestration/protocols/`
- `AGENT_PROTOCOLS_DIR`, `SKILL_PROTOCOLS_DIR`, etc.

**Helper functions:**
- `get_agent_dir(agent_name)` - Get agent directory path
- `get_composite_skill_dir(skill_name)` - Get skill orchestration directory
- `get_memory_file_path(task_id, agent_name)` - Build memory file path
- `get_skill_state_file(skill_name, session_id)` - Build state file path

## Call Chain: Query → Execution

```python
# 1. Hook triggers reasoning protocol (starts at Step 0)
UserPromptSubmit hook
    └→ protocols/reasoning/entry.py "{user_query}"
        └→ Print directive for Step 0 (Johari Window Discovery)

# 2. Step 0 (Johari Discovery) executes at START of every interaction
step_0_johari_discovery.py --state {file}
    └→ Transforms unknown unknowns into known knowns
    └→ Uses SHARE/ASK/ACKNOWLEDGE/EXPLORE framework
    └→ If ANY clarifying questions exist → HALT and ask before Step 1

# 3. Each step loads state, prints content, outputs NEXT step command
step_N.py (inherits BaseStep)
    ├→ BaseStep.main()           # Entry point
    │   ├→ ProtocolState.load()  # Load from protocols/reasoning/state/
    │   └→ step.execute()        # Run the step
    │       ├→ state.start_step()
    │       ├→ print_content()   # Markdown from content/steps/step_N.md
    │       ├→ process_step()    # Step-specific logic
    │       ├→ state.complete_step()
    │       ├→ state.save()
    │       └→ print_next_directive()  # MANDATORY command for next step

# 4. Step 4 determines route → triggers execution protocol
step_4_task_routing.py
    └→ outputs one of:
        • skill-orchestration (skill matched)
        • dynamic-skill-sequencing (no match, needs agents)

# 5. Execution protocol triggers skill
protocols/skill/composite/{skill}/entry.py {task_id}
    ├→ common_skill_entry.skill_entry()
    │   ├→ SkillExecutionState() created
    │   ├→ Phase 0 content printed
    │   └→ Agent invocation directive printed

# 6. Each phase invokes an agent via Task tool
Task tool with subagent_type: {agent-name}
    └→ protocols/agent/{agent}/entry.py
        └→ common_entry.agent_entry()
            └→ step_0_learning_injection → step_1_johari_discovery → step_2+ → complete.py
            └→ Step 1 (Johari) may HALT if clarifying questions exist

# 7. After agent completes, advance to next phase
protocols/skill/core/advance_phase.py {skill_name} {session_id}
    ├→ Verify agent memory file exists (BLOCKING)
    ├→ Invoke memory-agent (BLOCKING)
    ├→ Transition FSM to next phase
    └→ Print next phase content + agent directive
```

## Data Contracts

### State Files (JSON) - Session Scoped

| Location | Created By | Contains |
|----------|------------|----------|
| `protocols/reasoning/state/reasoning-{session}.json` | `entry.py` | FSM state, step outputs, user query |
| `protocols/skill/state/{skill}-{session}.json` | `skill_entry()` | Phase outputs, metadata, FSM state |
| `protocols/agent/state/{agent}-{task}.json` | `agent_entry()` | Step outputs, skill context |

**Note:** FSM JSON serialization is now aligned across all protocols:
- All protocols: `.fsm.state` (enum name string)
- Skill protocol also has: `.fsm.current_phase_id` (phase ID)
- Legacy `current_state` key is supported for backwards compatibility

### Memory Files (Markdown) - Passed Between Agents

| Location | Created By | Consumed By |
|----------|------------|-------------|
| `.claude/memory/{task}-{agent}-memory.md` | Agent's `complete.py` | Next phase's agent |
| `.claude/memory/{task}-memory-phase-X-to-Y-memory.md` | memory-agent | advance_phase.py verification |

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Every step script MUST print a next command directive
   └→ Uses format_mandatory_directive() from config.py

2. State MUST be saved BEFORE printing the next directive
   └→ If Claude crashes, state is recoverable

3. Agents are NEVER called directly by scripts
   └→ Always via Task tool with subagent_type parameter
   └→ protocols/agent/entry.py is called BY the Task tool internals

4. Phase advancement BLOCKS until memory file exists
   └→ advance_phase.py checks for .claude/memory/{task}-{agent}-memory.md
   └→ No bypass mechanism exists by design

5. Phase 0 of every skill MUST be LINEAR (mandatory clarification)
   └→ Enforced in common_skill_entry.py lines 90-103

6. memory-agent MUST complete at every phase transition
   └→ Creates phase-specific memory file for verification
   └→ advance_phase.py blocks until file exists
```

## Metacognitive Hook Bypass

Controlled by constants in:
- `protocols/agent/common/complete.py`: `SKILLS_BYPASSING_METACOGNITIVE_HOOKS`
- `protocols/skill/core/advance_phase.py`: `SKILLS_BYPASSING_GOAL_MEMORY`
- `protocols/skill/composite/common_skill_complete.py`: `SKILLS_BYPASSING_LEARNINGS`

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Adding new steps/phases (update respective config.py)
- Modifying markdown content in `content/` directories
- Adding new metadata fields to state
- Adding new helper functions that don't change call flow

### ⚠️ Requires Careful Testing

- Changing step/phase order (update FSM transitions)
- Adding new agents (must register in config.py, create full directory structure)
- Modifying state.py or fsm.py classes

### ❌ Dangerous - Will Break System

- Removing `format_mandatory_directive()` calls
- Changing state file paths/naming without updating all references
- Removing memory file verification in advance_phase.py
- Making Phase 0 non-LINEAR (bypasses clarification)
- Adding `--force` flags to bypass blocking checks
- Calling agent entry.py directly instead of via Task tool

## Key Files Summary

| File | Purpose | Key Functions |
|------|---------|---------------|
| `protocols/reasoning/config/config.py` | Step names (0-8), paths, formatting | `format_mandatory_directive()`, `STEP_NAMES` |
| `protocols/reasoning/core/state.py` | `ProtocolState` class | `load()`, `save()`, `start_step()`, `complete_step()` |
| `protocols/reasoning/steps/base.py` | Base class for reasoning steps | `execute()`, `print_next_directive()` |
| `protocols/execution/steps/base.py` | Base class for execution steps | `ExecutionBaseStep`, `main()` |
| `protocols/agent/steps/base.py` | Base class for agent steps | `BaseAgentStep`, `main()` |
| `protocols/agent/steps/shared.py` | Shared step 0/1 implementations | `LearningInjectionStep`, `JohariDiscoveryStep` |
| `protocols/skill/config/config.py` | **MASTER SKILL REGISTRY** | All `*_PHASES` dicts, `PhaseType` enum |
| `protocols/skill/core/state.py` | `SkillExecutionState` class | Phase management, memory file paths |
| `protocols/skill/core/advance_phase.py` | Phase transitions | `advance_phase()`, blocking verification |
| `protocols/agent/config/config.py` | Agent registry | `AGENT_REGISTRY`, context budgets |
| `protocols/agent/common/entry.py` | Agent initialization | `agent_entry()` |

## Step Class Architecture (DRY Pattern)

All step files follow a consistent DRY pattern using class-level attributes:

```python
#!/usr/bin/env python3
"""Step N: Step Name"""
import sys
from pathlib import Path

# Standard path setup pattern
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

from base_step import BaseStep  # or ExecutionBaseStep, BaseAgentStep

class StepNStepName(BaseStep):
    """Step N: Description"""
    _step_num = N              # Class attribute (not property)
    _step_name = "STEP_NAME"   # Class attribute (not property)
    # _protocol_type = ProtocolType.X  # For execution steps only

if __name__ == "__main__":
    sys.exit(StepNStepName.main())  # Uses base class main()
```

**Key DRY Patterns:**
- `_step_num` and `_step_name` as **class attributes**, not property methods
- `main()` in base class handles argparse and state loading
- No redundant `main()` boilerplate in individual step files
- Shared steps 0-1 for agents in `protocols/agent/steps/shared.py`

**Base Class Hierarchy:**
```
protocols/reasoning/steps/base.py::BaseStep
protocols/execution/steps/base.py::ExecutionBaseStep
protocols/agent/steps/base.py::BaseAgentStep
```

Each base class provides:
- `main()` - CLI entry point with argparse
- `execute()` - Step execution orchestration
- `step_number` / `step_name` properties (read from `_step_num` / `_step_name`)

## Johari Window Discovery Protocol

The Johari Discovery Protocol transforms unknown unknowns into known knowns. It is implemented in TWO places:

### 1. Main Reasoning Protocol (Step 0)

Step 0 executes at the **START of every user interaction** before formal reasoning begins.

**Files:**
- `protocols/reasoning/steps/step_0_johari_discovery.py` - Python script
- `protocols/reasoning/content/step_0_johari_discovery.md` - Markdown instructions

### 2. All Cognitive Agents (Step 0-1)

Steps 0-1 execute at the **START of every agent invocation**:
- Step 0: Learning Injection - loads domain-specific learnings
- Step 1: Johari Discovery - transforms unknown unknowns into known knowns

**Files (Shared Implementation - DRY):**
- `protocols/agent/steps/shared.py` - Shared Python implementations for ALL agents
  - `LearningInjectionStep` (Step 0) - single implementation for all 7 agents
  - `JohariDiscoveryStep` (Step 1) - single implementation for all 7 agents
- `protocols/agent/{agent}/content/step_0_learning_injection.md` - Agent-specific markdown content
- `protocols/agent/{agent}/content/step_1_johari_discovery.md` - Agent-specific markdown content
- `shared/protocols/agent/johari-discovery-protocol.md` - Shared protocol content

### The SHARE/ASK/ACKNOWLEDGE/EXPLORE Framework

| Phase | Purpose |
|-------|---------|
| **SHARE** | What I can infer from the prompt (task type, complexity, pitfalls) |
| **ASK** | What I need to know (max 5 questions, only if critical) |
| **ACKNOWLEDGE** | Boundaries and assumptions (what remains uncertain) |
| **EXPLORE** | Unknown unknowns to consider (edge cases, failure modes) |

**Critical Rule:** If ANY clarifying questions exist, HALT and ask before proceeding to the next step.

## Debugging Tips

```bash
# Check reasoning state
cat .claude/orchestration/protocols/reasoning/state/reasoning-*.json | jq .

# Check reasoning FSM current state
cat .claude/orchestration/protocols/reasoning/state/reasoning-*.json | jq '.fsm.state'

# Check skill state
cat .claude/orchestration/protocols/skill/state/*.json | jq .

# Check skill FSM current phase (uses 'state' and 'current_phase_id')
cat .claude/orchestration/protocols/skill/state/{skill}-{session}.json | jq '.fsm.state, .fsm.current_phase_id'

# List memory files
ls -la .claude/memory/

# Find which agent hasn't completed
ls .claude/memory/ | grep -v memory

# Check memory file format
head -50 .claude/memory/{task_id}-{agent}-memory.md
```
