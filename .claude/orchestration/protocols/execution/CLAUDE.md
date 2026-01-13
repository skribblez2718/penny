# Execution Protocols

Post-reasoning execution routing. After the 8-step reasoning protocol determines the route, execution flows here.

## System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              REASONING PROTOCOL COMPLETES (2 Valid Routes Only)             │
│                                    │                                         │
│                    ┌───────────────┴───────────────┐                        │
│                    │                               │                        │
│                    ▼                               ▼                        │
│          ┌─────────────┐                 ┌─────────────┐                    │
│          │  SKILL      │                 │  DYNAMIC    │                    │
│          │ORCHESTRATION│                 │ SEQUENCING  │                    │
│          └─────────────┘                 └─────────────┘                    │
│                 │                               │                            │
│                 ▼                               ▼                            │
│          ┌─────────────┐                 ┌─────────────┐                    │
│          │dispatcher.py│                 │dispatcher.py│                    │
│          │  --route    │                 │  --route    │                    │
│          │skill-orch   │                 │dynamic-seq  │                    │
│          └─────────────┘                 └─────────────┘                    │
│                 │                               │                            │
│                 └───────────────┬───────────────┘                            │
│                                 │                                            │
└─────────────────────────────────┼────────────────────────────────────────────┘
                  │                 │
                  ▼                 ▼
    ┌─────────────────────┐  ┌─────────────────────┐
    │ SKILL ORCHESTRATION │  │ DYNAMIC SKILL SEQ   │
    │    (6 Steps)        │  │    (5 Steps)        │
    ├─────────────────────┤  ├─────────────────────┤
    │ 1. generate_task_id │  │ 1. analyze_reqs     │
    │ 2. classify_domain  │  │ 2. plan_sequence    │
    │ 3. read_skill       │  │ 3. invoke_skills    │
    │ 4. create_memory    │  │ 4. verify_complete  │
    │ 5. trigger_agents   │  │ 5. complete         │
    │ 6. complete_workflow│  └─────────────────────┘
    └─────────────────────┘
                  │                 │
                  ▼                 ▼
    ┌─────────────────────────────────────────────┐
    │         SKILL EXECUTION (via Task tool)     │
    │  ┌─────────┐   ┌─────────┐   ┌─────────┐   │
    │  │ Phase 0 │ → │ Phase 1 │ → │ Phase N │   │
    │  │(Clarify)│   │(varies) │   │(varies) │   │
    │  └─────────┘   └─────────┘   └─────────┘   │
    │                      │                      │
    │                      ▼                      │
    │  ┌─────────────────────────────────────────┐│
    │  │  Task tool: subagent_type={agent}       ││
    │  │              │                          ││
    │  │              ▼                          ││
    │  │  protocols/agent/{agent}/entry.py       ││
    │  │              │                          ││
    │  │              ▼                          ││
    │  │  .claude/memory/{task}-{agent}-memory.md││
    │  └─────────────────────────────────────────┘│
    └─────────────────────────────────────────────┘
```

## Directory Structure

```
protocols/execution/
├── __init__.py            # Package exports
├── CLAUDE.md              # THIS FILE
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
├── skill/                 # 6-step skill invocation protocol (was skill-orchestration/)
│   ├── CLAUDE.md
│   ├── entry.py           # Initialize, output Step 1 directive
│   ├── complete.py        # Finalize execution
│   ├── content/step_{n}.md
│   ├── steps/step_{n}_*.py
│   └── state/             # Session state (gitignored)
│
└── dynamic/               # 5-step dynamic sequencing protocol (was dynamic-skill-sequencing/)
    ├── CLAUDE.md
    ├── entry.py
    ├── complete.py
    ├── content/step_{n}.md
    ├── steps/step_{n}_*.py
    └── state/
```

## Call Chain: Reasoning → Dispatch → Execution

```python
# 1. Reasoning protocol Step 4 determines route (2 valid routes only)
protocols/reasoning/steps/step_4_task_routing.py
    └→ Outputs route: "skill-orchestration" | "dynamic-skill-sequencing"
    └→ print(directive: "python dispatcher.py --reasoning-session {id} --route {route}")

# 2. Dispatcher receives route and creates execution session
core/dispatcher.py --reasoning-session {id} --route {route}
    └→ dispatch(reasoning_session_id, route)
        ├→ ROUTE_TO_PROTOCOL[route]  # Get ProtocolType enum
        ├→ ExecutionState(protocol_type, reasoning_session_id)
        ├→ state.save()  # Create state file
        └→ print(format_mandatory_directive(entry.py command))
        # Note: Planning is handled by Claude Code's built-in EnterPlanMode tool

# 3. Protocol entry initializes execution
{protocol}/entry.py --state {state_file}
    └→ Loads state, initializes FSM
    └→ print(Step 1 directive)

# 4. Each step executes via base class
step_{n}_{name}.py --state {state_file}
    └→ ExecutionBaseStep.main(protocol_type)
        ├→ parse_args()
        ├→ ExecutionState.load(protocol_type, session_id)
        └→ step.execute()  # Orchestrates step execution
            ├→ state.start_step(n)
            ├→ print_extra_context()  # From previous steps if any
            ├→ print_content()  # Load markdown from content/step_{n}.md
            ├→ process_step()  # Subclass-specific logic
            ├→ state.complete_step(n, output)
            ├→ state.save()  # ⚠️ MUST save BEFORE directive
            └→ print_next_directive()  # format_mandatory_directive()

# 5. Final step triggers skill/agent invocation via Task tool
step_5_trigger_agents.py (skill-orchestration)
    └→ Invokes: protocols/skill/composite/{skill}/entry.py

step_3_invoke_skills.py (dynamic-skill-sequencing)
    └→ For each atomic skill: protocols/skill/atomic/orchestrate-*/entry.py
```

## Data Contracts

### ExecutionState (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | "1.0" |
| `protocol_version` | string | "1.0" |
| `protocol_type` | string | "SKILL_ORCHESTRATION" \| "DYNAMIC_SKILL_SEQUENCING" |
| `protocol_name` | string | "skill-orchestration" \| "dynamic-skill-sequencing" |
| `session_id` | string | UUID[:12] |
| `reasoning_session_id` | string | Link to originating reasoning session |
| `created_at` | ISO datetime | When session started |
| `status` | string | "initialized" \| "in_progress" \| "completed" |
| `fsm` | object | FSM state: `{state, history}` |
| `step_outputs` | dict | `{step_num: {output_data}}` |
| `step_timestamps` | dict | `{step_num: {started_at, completed_at}}` |
| `completed_at` | ISO datetime | When protocol completed (null if in progress) |
| `completion_summary` | string | Final summary |
| `plan` | object | (Deprecated) Previously held plan from reasoning protocol. Planning now handled by Claude Code's EnterPlanMode tool. |

### State File Locations

| Protocol | Path |
|----------|------|
| skill-orchestration | `skill/state/skill-{session_id}.json` |
| dynamic-skill-sequencing | `dynamic/state/dynamic-{session_id}.json` |

## Key Configuration (config/config.py)

```python
# Valid routes from reasoning protocol
VALID_ROUTES = ["skill-orchestration", "dynamic-skill-sequencing"]

# Protocol step definitions
SKILL_ORCHESTRATION_STEPS = {
    1: {"name": "GENERATE_TASK_ID", "script": "step_1_generate_task_id.py"},
    2: {"name": "CLASSIFY_DOMAIN", "script": "step_2_classify_domain.py"},
    3: {"name": "READ_SKILL", "script": "step_3_read_skill.py"},
    4: {"name": "CREATE_MEMORY", "script": "step_4_create_memory.py"},
    5: {"name": "TRIGGER_AGENTS", "script": "step_5_trigger_agents.py"},
    6: {"name": "COMPLETE_WORKFLOW", "script": "step_6_complete_workflow.py"},
}

DYNAMIC_SKILL_SEQUENCING_STEPS = {
    1: {"name": "ANALYZE_REQUIREMENTS", "script": "step_1_analyze_requirements.py"},
    2: {"name": "PLAN_SEQUENCE", "script": "step_2_plan_sequence.py"},
    3: {"name": "INVOKE_SKILLS", "script": "step_3_invoke_skills.py"},
    4: {"name": "VERIFY_COMPLETION", "script": "step_4_verify_completion.py"},
    5: {"name": "COMPLETE", "script": "step_5_complete.py"},
}
```

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Dispatcher MUST link to reasoning session
   └→ reasoning_session_id connects execution back to reasoning context
   └→ Note: Planning is handled by Claude Code's built-in EnterPlanMode tool

2. state.save() MUST be called BEFORE print_next_directive()
   └→ If Claude crashes after print, state is recoverable
   └→ See steps/base.py execute() method

3. All steps MUST inherit ExecutionBaseStep
   └→ Provides execute() orchestration
   └→ Provides print_next_directive() with format_mandatory_directive()

4. Step 5 (trigger_agents) is the ONLY step that invokes agents
   └→ All agent invocation flows through Task tool
   └→ Never call agent entry.py directly

5. FSM transitions are STRICT
   └→ Steps must execute in order (no skipping)
   └→ core/fsm.py defines valid transitions per protocol
```

## Key Functions

| Location | Function | Purpose |
|----------|----------|---------|
| `config/config.py` | `format_mandatory_directive()` | Wrap command in enforcement language |
| `config/config.py` | `get_state_file_path()` | Build state file path |
| `config/config.py` | `get_step_script_path()` | Build step script path |
| `core/dispatcher.py` | `dispatch()` | Main dispatcher entry point |
| `steps/base.py` | `ExecutionBaseStep.execute()` | Step execution orchestration |
| `steps/base.py` | `ExecutionBaseStep.main()` | CLI entry point for steps |
| `core/state.py` | `ExecutionState.start_step()` | Begin step, update FSM |
| `core/state.py` | `ExecutionState.complete_step()` | Complete step, store output |
| `core/state.py` | `ExecutionState.save()` | Persist to JSON |

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/step_{n}.md`
- Adding new metadata fields to step_outputs
- Adding trivial criteria logging/debugging

### ⚠️ Requires Careful Testing

- Adding new steps (update config.py PROTOCOL_STEPS, fsm.py transitions)
- Changing step order (update FSM transitions)
- Modifying dispatcher to add new routes

### ❌ Dangerous - Will Break System

- Removing state.save() before print_next_directive()
- Removing format_mandatory_directive() wrappers
- Calling agent entry.py directly (must use Task tool)
- Changing state file path format without updating all references

## Debugging Tips

```bash
# Check execution state
cat protocols/execution/skill-orchestration/state/*.json | jq .

# List available routes
python3 -c "from config import VALID_ROUTES; print(VALID_ROUTES)"

# Check FSM state
python3 -c "from fsm import create_fsm; from config import ProtocolType; print(create_fsm(ProtocolType.SKILL_ORCHESTRATION).state)"

# Trace dispatcher execution
python3 dispatcher.py --reasoning-session TEST --route skill-orchestration 2>&1
```
