# Skill Protocols

Central registry and execution framework for both atomic and composite skills. Skills are the primary execution units that orchestrate cognitive agents.

## Skill Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    EXECUTION PROTOCOL TRIGGERS SKILL                        │
│                                    │                                         │
│                    ┌───────────────┼───────────────┐                        │
│                    │               │               │                        │
│                    ▼               ▼               ▼                        │
│          ┌─────────────┐  ┌─────────────┐                                  │
│          │  COMPOSITE  │  │   ATOMIC    │                                  │
│          │  SKILL      │  │   SKILL     │                                  │
│          └─────────────┘  └─────────────┘                                  │
│                 │                 │                                         │
│                 ▼                 │                                         │
│  ┌──────────────────────────────┐│                                         │
│  │ composite/{skill}/entry.py   ││                                         │
│  │   └→ skill_entry()           ││                                         │
│  │       ├→ SkillExecutionState ││                                         │
│  │       ├→ SkillFSM()          ││                                         │
│  │       ├→ Phase 0 content     ││                                         │
│  │       └→ Agent directive     ││                                         │
│  └──────────────────────────────┘│                                         │
│                 │                 │                                         │
│                 ▼                 │                                         │
│  ┌──────────────────────────────┐│                                         │
│  │    PHASE EXECUTION LOOP      ││                                         │
│  │  ┌─────────┐   ┌─────────┐   ││                                         │
│  │  │ Phase 0 │ → │ Phase 1 │ → ││...                                      │
│  │  │(Clarify)│   │(varies) │   ││                                         │
│  │  └─────────┘   └─────────┘   ││                                         │
│  │       │             │        ││                                         │
│  │       ▼             ▼        ││                                         │
│  │  uses_atomic_skill: "orchestrate-*"                                     │
│  │       │             │        ││                                         │
│  └───────┼─────────────┼────────┘│                                         │
│          │             │         │                                         │
│          └──────┬──────┘         │                                         │
│                 │                │                                         │
│                 ▼                ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │               ATOMIC SKILL INVOCATION (agent_invoker.py)              │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │  atomic/{orchestrate-*}/entry.py                                │  │  │
│  │  │     └→ atomic_entry()                                           │  │  │
│  │  │         └→ Task tool with subagent_type: "{agent-name}"        │  │  │
│  │  │             └→ protocols/agent/{agent}/entry.py                 │  │  │
│  │  │                 └→ Steps 0→1→2→...→N                            │  │  │
│  │  │                     └→ .claude/memory/{task_id}-{agent}.md      │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                 │                                                           │
│                 ▼                                                           │
│  ┌──────────────────────────────┐                                          │
│  │    advance_phase.py          │                                          │
│  │    └→ Verify memory file     │                                          │
│  │    └→ FSM transition         │                                          │
│  │    └→ Next phase directive   │                                          │
│  └──────────────────────────────┘                                          │
│                 │                                                           │
│                 ▼                                                           │
│  ┌──────────────────────────────┐                                          │
│  │ composite/{skill}/complete.py│                                          │
│  │   └→ skill_complete()        │                                          │
│  │       └→ Aggregate outputs   │                                          │
│  │       └→ Generate summary    │                                          │
│  │       └→ SKILL_COMPLETE      │                                          │
│  └──────────────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
protocols/skill/
├── CLAUDE.md              # THIS FILE
├── __init__.py            # Package init with path constants
├── config/                # Configuration module
│   ├── __init__.py
│   └── config.py          # MASTER REGISTRY - skills, phases, phase types
├── core/                  # Core infrastructure
│   ├── __init__.py
│   ├── state.py           # SkillExecutionState class
│   ├── fsm.py             # SkillFSM finite state machine
│   ├── advance_phase.py   # Phase transitions with memory verification
│   ├── agent_invoker.py   # Invoke agents via Task tool
│   └── execution_verifier.py  # Hard enforcement of phase execution
├── steps/                 # Phase step base classes
│   ├── __init__.py
│   └── base.py            # BasePhase, AutoPhase classes
├── common_skill_entry.py  # Shared skill initialization
├── common_skill_complete.py # Shared skill completion
├── atomic/                # Atomic skill definitions
│   ├── CLAUDE.md
│   ├── base.py            # BaseAtomicSkill class
│   ├── enforcer.py        # Constraint enforcement
│   └── orchestrate_*.py   # Individual atomic skills
├── composite/             # Composite skill definitions
│   ├── CLAUDE.md
│   ├── {skill-name}/      # Per-skill directory
│   │   ├── entry.py
│   │   ├── complete.py
│   │   ├── content/phase_{n}.md
│   │   └── phases/phase_{n}_*.py
├── episodes/              # Episodic memory storage (gitignored)
├── state/                 # Session state files (gitignored)
└── tests/                 # Skill tests
```

## Call Chain: Execution → Skill → Agent

```python
# 1. Execution protocol triggers skill
protocols/execution/skill-orchestration/steps/step_5_trigger_agents.py
    └→ For each phase: print Task tool directive

# 2. Claude executes Task tool with atomic skill
Task tool with subagent_type: "orchestrate-{function}"
    └→ protocols/skill/atomic/orchestrate_{function}.py

# 3. Atomic skill invokes agent via agent_invoker
atomic/orchestrate_{function}.py
    └→ agent_invoker.invoke_agent(agent_name, task_id, context)
        └→ Task tool with subagent_type: "{agent_name}-agent"
            └→ protocols/agent/{agent}/entry.py

# 4. Agent executes protocol
protocols/agent/{agent}/entry.py
    └→ agent_entry(agent_name)
        └→ step_0_learning_injection.py
        └→ step_1_{name}.py
        └→ ... → complete.py
            └→ Write: .claude/memory/{task_id}-{agent}-memory.md

# 5. Advance to next phase
advance_phase.py {skill_name} {session_id}
    └→ advance_phase()
        ├→ verify_memory_file()  # BLOCKING
        ├→ fsm.advance()
        └→ print(next_phase_directive)

# 6. Skill completion (after all phases)
composite/{skill}/complete.py
    └→ skill_complete()
        ├→ aggregate_outputs()
        ├→ generate_summary()
        └→ print("SKILL_COMPLETE")
```

## Agent Invocation Template (CRITICAL)

When atomic skills invoke agents via the Task tool, the DA **MUST** structure the prompt using the standardized Agent Prompt Template format. Plain text prompts are NOT acceptable.

### Required Template Sections

| Section | Required | Source |
|---------|----------|--------|
| Task Context | Yes | task_id, skill_name, phase_id, domain, agent_name |
| Role Extension | Yes | DA generates dynamically (3-5 task-specific focus areas) |
| Johari Context | If available | From reasoning protocol Step 0 |
| Task Instructions | Yes | Specific cognitive work for this agent |
| Related Research Terms | Yes | DA generates dynamically (7-10 keywords) |
| Output Requirements | Yes | Memory file path: `.claude/memory/{task_id}-{agent}-memory.md` |

### Why Template Format Is Required

- **Consistency:** All agents receive context in the same structure
- **Johari Transfer:** Reasoning discoveries flow to agents via template
- **Task Specialization:** Role Extension adapts agents to specific tasks
- **Traceability:** Explicit memory file paths ensure workflow completion

### Template Integration Points

| File | Role |
|------|------|
| `core/agent_invoker.py` | Formats Task tool invocation with template context |
| `atomic/orchestrate_*.py` | Entry points that invoke agent_invoker |
| Individual `SKILL.md` files | "Agent Invocation Format" section with template requirements |
| `DA.md` | "Agent Prompt Template Requirements" section |

**Reference:** See `shared/templates/SKILL-TEMPLATE-REFERENCE.md` for the complete template documentation.

## Skill Registries (from config.py)

### Atomic Skills

| Skill | Cognitive Function | Semantic Trigger | NOT for |
|-------|-------------------|------------------|---------|
| orchestrate-clarification | CLARIFICATION | ambiguity resolution, requirements refinement | well-defined tasks with clear specifications |
| orchestrate-research | RESEARCH | knowledge gaps, options exploration | tasks with complete information |
| orchestrate-analysis | ANALYSIS | complexity decomposition, risk assessment | simple tasks without dependencies |
| orchestrate-synthesis | SYNTHESIS | integration of findings, design creation | single-source tasks without integration |
| orchestrate-generation | GENERATION | artifact creation, TDD implementation | read-only or research tasks |
| orchestrate-validation | VALIDATION | quality verification, acceptance testing | tasks without deliverables to verify |
| orchestrate-memory | METACOGNITION | progress tracking, impasse detection | simple linear workflows |

### Composite Skills

| Skill | Semantic Trigger | NOT for | Phases |
|-------|------------------|---------|--------|
| develop-skill | create/modify skills, update workflows, new skill | system mods, direct code, architecture | 9 |
| develop-learnings | capture learnings, document insights, preserve knowledge | mid-workflow, skill creation, active execution | 7 |
| develop-command | create/modify slash commands, utility commands | workflow skills, multi-phase operations | 3 |

## Phase Types (from config.py)

```python
class PhaseType(Enum):
    LINEAR = auto()      # Standard sequential phase
    OPTIONAL = auto()    # Conditional (may skip based on trigger)
    ITERATIVE = auto()   # Loop pattern (3A, 3B, 3C...)
    REMEDIATION = auto() # Retry after validation failure
    AUTO = auto()        # DEPRECATED: Use LINEAR with appropriate agent
    PARALLEL = auto()    # Execute branches concurrently
```

### Phase Type Behaviors

| Type | Description | When to Use |
|------|-------------|-------------|
| LINEAR | Execute sequentially, always runs | Default for most phases |
| OPTIONAL | Skip if trigger condition not met | Conditional features |
| ITERATIVE | Execute sub-phases in sequence (3A→3B→3C) | Multi-step generation |
| REMEDIATION | Retry on validation failure | Post-validation corrections |
| AUTO | **DEPRECATED** - Do not use | All phases must invoke agents |
| PARALLEL | Execute branches concurrently, merge | Parallel research/work |

**Important:** `PhaseType.AUTO` is deprecated. All cognitive work should flow through specialized agents. Use `orchestrate-generation` for phases that create/write artifacts, and `orchestrate-validation` for phases that verify/check constraints.

## Data Contracts

### SkillExecutionState (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | "1.0" |
| `skill_name` | string | Skill identifier |
| `task_id` | string | Task ID from protocols/execution |
| `session_id` | string | UUID[:8] for this skill session |
| `execution_session_id` | string | Link to protocols/execution session |
| `created_at` | ISO datetime | When skill started |
| `updated_at` | ISO datetime | Last modification |
| `status` | string | "initialized" \| "executing" \| "halted" \| "completed" |
| `halt_reason` | string \| null | Reason if halted |
| `fsm` | object | FSM state: `{state, current_phase_id, phase_info, ...}` (NOTE: uses `state` not `current_state`) |
| `phase_outputs` | dict | `{phase_id: {output_data}}` |
| `phase_timestamps` | dict | `{phase_id: {started_at, completed_at}}` |
| `memory_files` | list[string] | Paths to created memory files |
| `configuration` | dict | Phase configuration overrides |
| `metadata` | dict | Additional metadata |

### State File Location

```
protocols/skill/state/{skill_name}-{session_id}.json
```

### Memory File Location

```
.claude/memory/{task_id}-{agent_name}-memory.md
```

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

Memory files are verified by `memory_verifier.py` which checks for:
- Agent header with task description
- All four sections present with meaningful content
- Completion marker

## Key Functions

| Location | Function | Purpose |
|----------|----------|---------|
| `config/config.py` | `ATOMIC_SKILLS` | Registry of all atomic skills |
| `config/config.py` | `COMPOSITE_SKILLS` | Registry of all composite skills |
| `config/config.py` | `SKILL_PHASES` | Map skill → phase configurations |
| `config/config.py` | `get_skill_type()` | Determine if skill is atomic/composite |
| `config/config.py` | `get_skill_phases()` | Get phase definitions for skill |
| `config/config.py` | `get_phase_config()` | Get config for specific phase |
| `config/config.py` | `get_atomic_skill_agent()` | Get agent for atomic skill |
| `config/config.py` | `format_skill_directive()` | Format mandatory execution directive |
| `core/state.py` | `SkillExecutionState` | State management class |
| `core/state.py` | `start_phase()` | Record phase start |
| `core/state.py` | `complete_phase()` | Record phase completion |
| `core/state.py` | `add_memory_file()` | Track created memory file |
| `core/state.py` | `get_memory_file_path()` | Build memory file path |
| `core/advance_phase.py` | `advance_phase()` | Verify + transition to next phase |
| `core/advance_phase.py` | `--complete-branch PHASE:BRANCH` | Mark parallel branch complete |
| `core/advance_phase.py` | `--complete-all-branches PHASE` | Mark all parallel branches complete |
| `core/agent_invoker.py` | `invoke_agent()` | Spawn agent via Task tool |
| `steps/base.py` | `BasePhase` | Abstract base class for phases |
| `steps/base.py` | `AutoPhase` | Base class for AUTO phases |

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. ALL skill/phase definitions are in config.py
   └→ Never hardcode phases in skill directories
   └→ SKILL_PHASES is the source of truth

2. Phase 0 MUST always be LINEAR (mandatory clarification)
   └→ Enforced in common_skill_entry.py
   └→ Johari Window principle: clarification is never optional

3. Agents are NEVER invoked directly
   └→ Always via atomic skill → agent_invoker → Task tool
   └→ Never call protocols/agent/{agent}/entry.py directly

4. advance_phase.py BLOCKS until memory file exists
   └→ verify_memory_file() checks for file
   └→ No bypass mechanism by design

5. state.save() MUST be called BEFORE next directive
   └→ Crash recovery depends on persisted state
   └→ See common_skill_entry.py pattern

6. Memory file paths follow strict format
   └→ .claude/memory/{task_id}-{agent_name}-memory.md
   └→ Changing format breaks predecessor context loading

7. PhaseType.REMEDIATION must specify remediation_target
   └→ Target phase is re-executed on validation failure
   └→ max_remediation limits retry attempts (default: 2)
```

## Metacognitive Hook Bypass

Controlled by constants in:
- `advance_phase.py`: `SKILLS_BYPASSING_GOAL_MEMORY`
- `composite/common_skill_complete.py`: `SKILLS_BYPASSING_LEARNINGS`

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/phase_{n}.md`
- Adding new metadata fields to phase_outputs
- Adding new composite skills (register in config.py)
- Adjusting phase descriptions or titles
- Adding logging/debugging to phase scripts

### ⚠️ Requires Careful Testing

- Adding new phases to existing skills (update config.py, create content/phases)
- Changing phase order (update `next` pointers in config.py)
- Adding new PhaseTypes (update fsm.py transition logic)
- Modifying advance_phase.py verification logic

### ❌ Dangerous - Will Break System

- Making Phase 0 non-LINEAR (bypasses clarification)
- Removing memory file verification in advance_phase.py
- Calling agent entry.py directly (bypass atomic skills)
- Removing state.save() before next directive
- Changing memory file path format
- Removing config.py phase definitions (hardcoding in skills)
- Adding `--force` flags to bypass blocking checks

## Debugging Tips

```bash
# Check skill state
cat protocols/skill/state/{skill_name}-*.json | jq .

# Check phase progression
cat protocols/skill/state/*.json | jq '.fsm.completed_phases'

# List memory files for task
ls -la .claude/memory/{task_id}*

# Verify skill registration
python3 -c "from protocols/skill.config import COMPOSITE_SKILLS; print(list(COMPOSITE_SKILLS.keys()))"

# Check phase configuration
python3 -c "from protocols/skill.config import get_skill_phases; import json; print(json.dumps(get_skill_phases('develop-project'), indent=2, default=str))"

# Verify FSM state
cat protocols/skill/state/{skill}-{session}.json | jq '.fsm'

# Check current phase
cat protocols/skill/state/{skill}-{session}.json | jq '.fsm.current_phase_id'
```
