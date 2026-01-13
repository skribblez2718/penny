# Execution Protocols Documentation

**Purpose:** Reference documentation for the Python-enforced execution protocol system.

---

## Overview

Execution protocols are automatically dispatched by the reasoning protocol after Step 8 routing is validated. The `dispatcher.py` script routes to the appropriate protocol's `entry.py`, which prints directives for the orchestrator to follow.

---

## Protocol Types

| Protocol | Steps | Purpose |
|----------|-------|---------|
| Skill Orchestration | 6 | Multi-phase cognitive workflows matching formal skill patterns |
| Dynamic Skill Sequencing | 5 | Flexible cognitive workflows using orchestrate-* atomic skills |

---

## Architecture

### Directory Structure

```
${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/
├── __init__.py            # Package exports
├── CLAUDE.md              # System documentation
│
├── config/                # Configuration module
│   ├── __init__.py
│   └── config.py          # Protocol types, routes, step definitions, helpers
│
├── core/                  # Core execution components
│   ├── __init__.py
│   ├── dispatcher.py      # Route dispatcher (reasoning → execution)
│   ├── state.py           # ExecutionState class
│   └── fsm.py             # Finite state machines per protocol
│
├── steps/                 # Shared step infrastructure
│   ├── __init__.py
│   └── base.py            # ExecutionBaseStep abstract base class
│
├── skill/                 # 6-step workflow
│   ├── CLAUDE.md
│   ├── entry.py
│   ├── complete.py
│   ├── steps/
│   │   ├── step_1_generate_task_id.py
│   │   ├── step_2_classify_domain.py
│   │   ├── step_3_read_skill.py
│   │   ├── step_4_create_memory.py
│   │   ├── step_5_trigger_agents.py
│   │   └── step_6_complete_workflow.py
│   ├── content/           # Step instructions (step_1.md - step_6.md)
│   └── state/             # Session state files (gitignored)
│
└── dynamic/               # 5-step workflow
    ├── CLAUDE.md
    ├── entry.py
    ├── complete.py
    ├── steps/
    │   ├── step_1_analyze_requirements.py
    │   ├── step_2_plan_sequence.py
    │   ├── step_3_invoke_skills.py
    │   ├── step_4_verify_completion.py
    │   └── step_5_complete.py
    ├── content/           # Step instructions
    └── state/             # Session state files (gitignored)
```

---

## FSM Definitions

### Skill Orchestration (6 steps + 2 terminal states)

```
INITIALIZED → GENERATE_TASK_ID → CLASSIFY_DOMAIN → READ_SKILL →
CREATE_MEMORY → TRIGGER_AGENTS → COMPLETE_WORKFLOW → COMPLETED
```

**When to Use:**
- Task matches a defined composite skill pattern (develop-project, perform-research, etc.)
- Multi-phase cognitive work requiring formal workflow

### Dynamic Skill Sequencing (5 steps + 2 terminal states)

```
INITIALIZED → ANALYZE_REQUIREMENTS → PLAN_SEQUENCE →
INVOKE_SKILLS → VERIFY_COMPLETION → COMPLETE → COMPLETED
```

**When to Use:**
- Task requires multiple cognitive functions but doesn't match existing composite skill
- Novel task patterns requiring flexible orchestration
- The orchestrator determines which orchestrate-* atomic skills to invoke dynamically

**Key Difference from Skill Orchestration:**
- No formal skill definition required
- The orchestrator dynamically determines which orchestrate-* atomic skills to invoke
- More flexible for novel task patterns that don't match existing composite skills

**Agent Prompt Template Requirement (Step 3 - INVOKE_SKILLS):**

When Step 3 invokes atomic skills, the DA **MUST** structure Task tool prompts using the Agent Prompt Template format:

| Section | Required | Source |
|---------|----------|--------|
| Task Context | Yes | task_id, skill, phase, domain, agent |
| Role Extension | Yes | DA generates 3-5 task-specific focus areas |
| Johari Context | If available | From reasoning protocol Step 0 |
| Task Instructions | Yes | Specific cognitive work |
| Related Research Terms | Yes | DA generates 7-10 keywords |
| Output Requirements | Yes | Memory file path |

Plain text prompts passed to agents will result in incomplete context transfer. See `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md` for the complete template.

---

## Execution Flow

```
Reasoning Protocol Step 8 completes
              ↓
set_route.py --route <final_route>
              ↓
dispatcher.py (creates ExecutionState, prints directive)
              ↓
entry.py (prints Step 1 directive)
              ↓
step_1_*.py (transitions FSM, prints Step 2 directive)
              ↓
...continues until complete.py...
              ↓
complete.py (final aggregation, learning prompt)
```

---

## Related Files

- `config/config.py` - ProtocolType enum, route mapping, step definitions
- `core/fsm.py` - FSM classes with valid state transitions
- `core/state.py` - ExecutionState class for session persistence
- `core/dispatcher.py` - Route dispatch logic
- `steps/base.py` - Abstract base class for all step scripts

---

## Pythonized Execution Protocols

Execution protocols are fully pythonized in `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/`:

| Protocol | Location |
|----------|----------|
| Skill Orchestration | `protocols/execution/skill/` |
| Dynamic Skill Sequencing | `protocols/execution/dynamic/` |

Each protocol directory contains:
- `entry.py` - Python entry point
- `content/` - Step markdown files printed to STDOUT
- `steps/` - Individual step Python scripts
- `state/` - Session state files
