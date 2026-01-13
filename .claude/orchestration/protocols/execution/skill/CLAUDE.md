# Skill Orchestration Protocol

6-step protocol for invoking a matched composite skill from the skill registry.

## Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SKILL ORCHESTRATION (6 Steps)                            │
│                                                                             │
│  dispatcher.py --route skill-orchestration                                  │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  entry.py --state {state_file}                                       │   │
│  │     └→ ExecutionState.load()                                         │   │
│  │     └→ print(Step 1 directive)                                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 1: GENERATE_TASK_ID                                            │   │
│  │     └→ task_id = uuid.uuid4()[:12]                                   │   │
│  │     └→ state.step_outputs[1] = {"task_id": task_id}                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 2: CLASSIFY_DOMAIN                                             │   │
│  │     └→ domain = technical | personal | creative | professional       │   │
│  │     └→ state.step_outputs[2] = {"domain": domain}                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 3: READ_SKILL                                                  │   │
│  │     └→ Load protocols/skill/composite/{skill}/config.yaml            │   │
│  │     └→ Extract: phases, agents, context patterns                     │   │
│  │     └→ state.step_outputs[3] = {"skill_config": {...}}               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 4: CREATE_MEMORY                                               │   │
│  │     └→ Initialize: .claude/memory/{task_id}-workflow-context.md      │   │
│  │     └→ Write: user query, domain, skill config                       │   │
│  │     └→ state.step_outputs[4] = {"memory_file": path}                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 5: TRIGGER_AGENTS ← CORE STEP                                  │   │
│  │     └→ For each skill phase:                                         │   │
│  │         └→ Task tool: subagent_type = phase.agent                    │   │
│  │         └→ Wait for memory file: {task_id}-{agent}-memory.md         │   │
│  │         └→ advance_phase.py (verify + transition FSM)                │   │
│  │     └→ state.step_outputs[5] = {"phases_completed": [...]}           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 6: COMPLETE_WORKFLOW                                           │   │
│  │     └→ Aggregate agent outputs from memory files                     │   │
│  │     └→ Generate final deliverable summary                            │   │
│  │     └→ state.complete_protocol(summary)                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  complete.py --state {state_file}                                    │   │
│  │     └→ Validate: all 6 steps completed                               │   │
│  │     └→ state.save()                                                  │   │
│  │     └→ print("SKILL_ORCHESTRATION_COMPLETE")                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
skill-orchestration/
├── CLAUDE.md              # THIS FILE
├── entry.py               # Initialize state, output Step 1 directive
├── complete.py            # Final validation and completion
├── content/               # Markdown instructions per step
│   ├── step_1_generate_task_id.md
│   ├── step_2_classify_domain.md
│   ├── step_3_read_skill.md
│   ├── step_4_create_memory.md
│   ├── step_5_trigger_agents.md
│   └── step_6_complete_workflow.md
├── steps/
│   ├── step_1_generate_task_id.py
│   ├── step_2_classify_domain.py
│   ├── step_3_read_skill.py
│   ├── step_4_create_memory.py
│   ├── step_5_trigger_agents.py   # ← CORE: Agent invocation
│   └── step_6_complete_workflow.py
└── state/                 # Session state files (gitignored)
    └── skill-orchestration-{session_id}.json
```

## Call Chain: Entry → Steps → Completion

```python
# 1. Entry point (after dispatcher)
entry.py --state {state_file}
    └→ ExecutionState.load(ProtocolType.SKILL_ORCHESTRATION, session_id)
    └→ print(format_mandatory_directive(step_1 command))

# 2. Each step follows ExecutionBaseStep pattern
step_{n}_{name}.py --state {state_file}
    └→ ExecutionBaseStep.main(ProtocolType.SKILL_ORCHESTRATION)
        ├→ ExecutionState.load(...)
        └→ step.execute()
            ├→ state.start_step(n)  # FSM transition
            ├→ print_content()       # Load content/step_{n}.md
            ├→ process_step()        # Step-specific logic (see below)
            ├→ state.complete_step(n, output)
            ├→ state.save()          # ⚠️ BEFORE directive
            └→ print_next_directive()

# 3. Step 5 core logic (agent invocation)
step_5_trigger_agents.py
    └→ For each phase in skill config:
        └→ PRINTS directive for Claude:
            "Execute Task tool with subagent_type: '{agent_name}'"
        └→ Claude invokes Task tool
        └→ Agent runs full protocol (entry → steps → complete)
        └→ Agent writes: .claude/memory/{task_id}-{agent}-memory.md
        └→ advance_phase.py verifies memory file exists
        └→ FSM transitions to next phase

# 4. Completion
complete.py --state {state_file}
    └→ Validate len(step_outputs) == 6
    └→ state.save()
    └→ print("SKILL_ORCHESTRATION_COMPLETE")
```

## Step Details

| Step | Name | Input | Output | Key Logic |
|------|------|-------|--------|-----------|
| 1 | generate_task_id | user query | `{task_id}` | `uuid.uuid4()[:12]` |
| 2 | classify_domain | query + context | `{domain, confidence}` | Domain classification (technical/personal/etc) |
| 3 | read_skill | skill name | `{skill_config}` | Load YAML, extract phases/agents |
| 4 | create_memory | task_id, query | `{memory_file}` | Initialize workflow context file |
| 5 | trigger_agents | skill_config | `{phases_completed}` | Invoke agents via Task tool |
| 6 | complete_workflow | all outputs | `{summary}` | Aggregate results, generate final output |

## Data Contract: Step Outputs

```json
{
  "1": {"task_id": "abc123def456"},
  "2": {"domain": "technical", "confidence": "CERTAIN"},
  "3": {
    "skill_config": {
      "name": "develop-project",
      "phases": [
        {"id": "clarification", "agent": "clarification"},
        {"id": "research", "agent": "research"}
      ]
    }
  },
  "4": {"memory_file": ".claude/memory/abc123def456-workflow-context.md"},
  "5": {
    "phases_completed": [
      {"phase_id": "clarification", "agent": "clarification", "memory_file": "..."},
      {"phase_id": "research", "agent": "research", "memory_file": "..."}
    ]
  },
  "6": {"summary": "Workflow completed successfully..."}
}
```

## Step 5 Agent Invocation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: TRIGGER_AGENTS (Critical - Agent Invocation)                       │
│                                                                             │
│  For each phase in skill_config.phases:                                     │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  1. Print Task tool directive                                          │ │
│  │     "Execute Task tool with subagent_type: '{agent_name}'"            │ │
│  │     "Prompt: {phase instructions from skill config}"                   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  2. Claude executes Task tool                                          │ │
│  │     subagent_type: "{agent_name}"                                      │ │
│  │     prompt: "{phase_instructions}"                                     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  3. Agent executes full protocol                                       │ │
│  │     protocols/agent/{agent}/entry.py                                   │ │
│  │     → step_0_learning_injection.py                                     │ │
│  │     → step_1 ... step_N                                                │ │
│  │     → complete.py                                                      │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  4. Agent writes memory file                                           │ │
│  │     .claude/memory/{task_id}-{agent}-memory.md                         │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  5. advance_phase.py (BLOCKING verification)                           │ │
│  │     ├→ Check: memory file exists                                       │ │
│  │     ├→ Check: memory completed                              │ │
│  │     └→ Transition FSM to next phase                                    │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        └──→ Next phase (loop) OR Step 6 (all phases done)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Task ID must be generated FIRST (Step 1)
   └→ All subsequent steps depend on task_id for file paths
   └→ Memory file naming: {task_id}-{agent}-memory.md

2. Domain classification (Step 2) affects agent context
   └→ Domain-specific learnings loaded in agents
   └→ Affects quality standards and approach

3. Skill config must be fully loaded (Step 3)
   └→ Phases define agent sequence
   └→ Context patterns define memory file dependencies

4. Memory file MUST exist before workflow context (Step 4)
   └→ Agents read workflow context at entry
   └→ Missing context = agent failure

5. Agents invoked ONLY via Task tool (Step 5)
   └→ NEVER call agent entry.py directly
   └→ Task tool provides isolation and context management

6. Phase advancement BLOCKS until verification (Step 5)
   └→ advance_phase.py checks for memory file
   └→ No force/bypass mechanism by design

7. state.save() MUST precede print_next_directive()
   └→ Crash recovery depends on persisted state
```

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/step_{n}.md`
- Adding logging/debugging to process_step() methods
- Adding new fields to step_outputs
- Adjusting domain classification criteria

### ⚠️ Requires Careful Testing

- Changing step order (must update FSM transitions)
- Adding new steps (update config.py, fsm.py)
- Modifying skill config loading logic (Step 3)

### ❌ Dangerous - Will Break System

- Removing task_id generation (Step 1)
- Calling agent entry.py directly (bypass Task tool)
- Removing advance_phase.py verification (Step 5)
- Removing state.save() before print_next_directive()
- Changing memory file path format

## Debugging Tips

```bash
# Check protocol state
cat skill-orchestration/state/skill-orchestration-*.json | jq .

# Check step outputs
cat skill-orchestration/state/skill-orchestration-{session_id}.json | jq '.step_outputs'

# Verify skill config loaded
cat skill-orchestration/state/*.json | jq '.step_outputs["3"].skill_config'

# Check which phases completed
cat skill-orchestration/state/*.json | jq '.step_outputs["5"].phases_completed'

# List memory files for task
ls -la .claude/memory/{task_id}-*

# Verify FSM state
cat skill-orchestration/state/*.json | jq '.fsm.state'
```
