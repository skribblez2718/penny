# Reasoning Protocol

9-step mandatory reasoning protocol (Step 0 + Steps 1-8) that runs BEFORE any task execution. This is the entry point for ALL user queries.

**Step 0 (Johari Window Discovery)** executes at the START of every interaction to transform unknown unknowns into known knowns before formal reasoning begins.

## Step Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER QUERY ARRIVES                                   │
│                               │                                              │
│                               ▼                                              │
│                    ┌─────────────────────┐                                   │
│                    │ entry.py            │                                   │
│                    │ init_protocol()     │                                   │
│                    └──────────┬──────────┘                                   │
│                               │                                              │
│                               ▼                                              │
│                         ┌────────┐                                           │
│                         │ Step 0 │  ← Johari Window Discovery                │
│                         │ Johari │    (executes at START of every query)     │
│                         └────┬───┘                                           │
│                              │                                               │
│                              ▼                                               │
│  ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐                          │
│  │ Step 1 │ → │ Step 2 │ → │ Step 3 │ → │Step 3b │                          │
│  │Semantic│   │  CoT   │   │  ToT   │   │ Skill  │                          │
│  │Underst.│   │        │   │        │   │Detect  │                          │
│  └────────┘   └────────┘   └────────┘   └────────┘                          │
│       │                                      │                               │
│       │         ┌───────────────────────────────────────────────────────┐   │
│       │         │  ROUTING VALIDATION LOOP (max 3 iterations)           │   │
│       │         │  ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐   │   │
│       └────────►│  │ Step 4 │ → │ Step 5 │ → │ Step 6 │ → │ Step 7 │   │   │
│                 │  │Routing │   │  Self  │   │Socratic│   │Constit.│   │   │
│                 │  │        │   │Consist.│   │Interrog│   │Critique│   │   │
│                 │  └────────┘   └────────┘   └────────┘   └────────┘   │   │
│                 │       ▲                                      │        │   │
│                 │       │              ┌────────┐              │        │   │
│                 │       │              │ Step 8 │◄─────────────┘        │   │
│                 │       │              │Knowledge│                      │   │
│                 │       │              │Transfer │                      │   │
│                 │       │              └────┬────┘                      │   │
│                 │       │                   │                           │   │
│                 │       │     ┌─────────────┼─────────────┐             │   │
│                 │       │     │             │             │             │   │
│                 │  LOOP BACK  │         PROCEED       HALT             │   │
│                 │  (contradict)│             │             │             │   │
│                 └───────────────────────────────────────────────────────┘   │
│                                             │             │                  │
│       Agent mode: Step 3b → Step 5 (skips Step 4)        │                  │
│                                             ▼             ▼                  │
│                                      ┌──────────┐  ┌──────────┐             │
│                                      │complete.py│  │ CLARIFY │             │
│                                      │           │  │  USER   │             │
│                                      └─────┬─────┘  └──────────┘             │
│                                            │                                 │
│                                            ▼                                 │
│                                     dispatcher.py                            │
│                                            │                                 │
│                               ┌────────────┴────────────┐                   │
│                               │                         │                   │
│                               ▼                         ▼                   │
│                         skill-               dynamic-skill                  │
│                       orchestration           sequencing                    │
│                                                                              │
│  Note: Trivial task evaluation handled by routing gate in execution layer  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
protocols/reasoning/
├── __init__.py         # Package exports (ProtocolState, ReasoningFSM, etc.)
├── CLAUDE.md           # THIS FILE
├── entry.py            # Initialize reasoning session, print first directive
├── complete.py         # Finalize protocol, dispatch to execution
├── config/             # Configuration
│   ├── __init__.py     # Exports all config items
│   └── config.py       # STEP_NAMES, STEP_TITLES, format_mandatory_directive()
├── core/               # Core modules
│   ├── __init__.py     # Exports FSM, state, routing components
│   ├── fsm.py          # ReasoningFSM class with state transitions
│   ├── state.py        # ProtocolState class for JSON persistence
│   ├── semantic_routing.py  # Routing logic helpers
│   ├── set_route.py    # Route capture after Step 8
│   └── universal_learnings.py  # Post-protocol learning prompts
├── steps/              # Python scripts for each step
│   ├── __init__.py     # Exports BaseStep
│   ├── base.py         # BaseStep abstract class (ALL steps inherit)
│   ├── step_0_johari_discovery.py  # Step 0 - Ambiguity detection at START
│   ├── step_1_semantic_understanding.py
│   ├── step_2_chain_of_thought.py
│   ├── step_3_tree_of_thought.py
│   ├── step_3b_skill_detection.py  # Also handles agent mode routing
│   ├── step_4_task_routing.py
│   ├── step_5_self_consistency.py
│   ├── step_6_socratic_interrogation.py
│   ├── step_7_constitutional_critique.py
│   └── step_8_knowledge_transfer.py
├── content/            # Markdown instructions for each step
│   └── step_{n}_{name}.md   # e.g., step_0_johari_discovery.md
├── state/              # Session state files (JSON)
│   └── reasoning-{session_id}.json
└── tests/
```

Note: Planning is handled by Claude Code's built-in EnterPlanMode tool.

## Session Management

Each user prompt creates a fresh reasoning session:

1. **UserPromptSubmit Hook** creates a new session for each prompt
2. **New Session**: Hook calls `entry.py "{user_query}"` to create new session
3. **Session starts at Step 0** (Johari Discovery) and progresses through all steps

## Call Chain: Query → Execution

```python
# 1. Entry point (called by hook or manually)
entry.py "user query"
    ├→ init_protocol(user_query)
    │   ├→ ProtocolState(user_query=...)    # Create state object
    │   ├→ state.save()                      # Write to state/reasoning-{id}.json
    │   └→ return state
    ├→ print_protocol_preamble(state)        # Print "Query: ..."
    └→ print_step_directive(state, 0)        # Print MANDATORY command for Step 0
        └→ format_mandatory_directive(cmd)   # Wrap in enforcement language

# 2. Each step script (inherits BaseStep)
step_N_*.py --state {state_file}
    └→ BaseStep.main()                       # Static entry point
        ├→ argparse: --state required
        ├→ ProtocolState.load(session_id)    # Load from JSON
        └→ step.execute()                    # Core execution
            ├→ state.start_step(N)           # FSM: transition to step N
            │   └→ fsm.transition(target)    # Validate + record transition
            ├→ print_extra_context()         # Optional: prior step data
            ├→ print_content()               # Print markdown from content/
            ├→ process_step()                # Subclass logic (return dict)
            ├→ state.complete_step(N, output)  # Store output, set timestamp
            ├→ state.save()                  # ⚠️ MUST save BEFORE next directive
            └→ print_next_directive()        # Print command for step N+1

# 3. Step 8 determines outcome
step_8_knowledge_transfer.py
    └→ One of three outcomes:
        • PROCEED   → complete.py (all good, dispatch)
        • HALT      → state.halt_for_clarification() (ask user)
        • LOOP BACK → state.trigger_loop_back() (contradiction, retry Step 4)

# 4. Protocol completion
complete.py --state {state_file}
    ├→ verify_all_steps_completed(state)     # Check steps 1-8 have outputs
    ├→ state.complete_protocol()             # FSM: COMPLETED state
    ├→ state.save()
    ├→ print_completion_summary()
    ├→ check_and_prompt_learnings(state)     # Self-learning prompt if applicable
    └→ print_dispatch_directive(state)       # MANDATORY command for dispatcher
        └→ state.set_dispatch_pending(...)   # Backup: hook can retry if missed
```

## FSM State Transitions

```python
# Valid transitions (from fsm.py)
TRANSITIONS = {
    INITIALIZED           → JOHARI_DISCOVERY,           # Step 0 first
    JOHARI_DISCOVERY      → SEMANTIC_UNDERSTANDING,     # Then Step 1
    SEMANTIC_UNDERSTANDING → CHAIN_OF_THOUGHT,
    CHAIN_OF_THOUGHT      → TREE_OF_THOUGHT,
    TREE_OF_THOUGHT       → SKILL_DETECTION,
    SKILL_DETECTION       → [TASK_ROUTING, SELF_CONSISTENCY],  # Normal flow + Agent mode (skip Step 4)
    TASK_ROUTING          → SELF_CONSISTENCY,
    SELF_CONSISTENCY      → SOCRATIC_INTERROGATION,
    SOCRATIC_INTERROGATION → CONSTITUTIONAL_CRITIQUE,
    CONSTITUTIONAL_CRITIQUE → KNOWLEDGE_TRANSFER,
    KNOWLEDGE_TRANSFER    → [COMPLETED, HALTED, TASK_ROUTING],  # 3 options
}

# Step number mapping
STATE_TO_STEP = {
    JOHARI_DISCOVERY: 0,       # Step 0 - Ambiguity detection at START
    SEMANTIC_UNDERSTANDING: 1,
    CHAIN_OF_THOUGHT: 2,
    TREE_OF_THOUGHT: 3,
    SKILL_DETECTION: 3.2,      # Step 3b
    TASK_ROUTING: 4,
    SELF_CONSISTENCY: 5,
    SOCRATIC_INTERROGATION: 6,
    CONSTITUTIONAL_CRITIQUE: 7,
    KNOWLEDGE_TRANSFER: 8,
}
```

## Data Contracts

### State File (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Unique identifier (12 chars from UUID) |
| `user_query` | string | Original user query |
| `fsm` | object | FSM state: `state`, `history`, `is_final` |
| `step_outputs` | dict | `{step_num: {output_data}}` |
| `step_timestamps` | dict | `{step_num: {started_at, completed_at}}` |
| `iteration_count` | int | Routing loop iterations (0-2) |
| `routing_decision` | string | Final route: skill-orchestration or dynamic-skill-sequencing |
| `halt_reason` | string | Why protocol halted (if HALTED) |
| `clarification_questions` | list | Questions to ask user (if HALTED) |
| `dispatch_pending` | object | Backup dispatch info for hook |

### Routing Outcomes (Step 4)

| Route | Description |
|-------|-------------|
| `skill-orchestration` | Matched a composite skill |
| `dynamic-skill-sequencing` | Needs dynamic orchestrate-* skill sequence |

Note: Trivial task evaluation is handled by the routing gate in the execution layer,
not as a routing decision in the reasoning protocol.

### Step 8 Outcomes

| Outcome | FSM Transition | Action |
|---------|----------------|--------|
| PROCEED | → COMPLETED | Dispatch to protocols/execution |
| HALT | → HALTED | Ask user clarification questions |
| LOOP BACK | → TASK_ROUTING | Re-run Steps 4-8 (max 3 times) |

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Every step MUST inherit from BaseStep
   └→ steps/base.py provides execute(), main(), state management

2. Every step MUST call state.save() BEFORE print_next_directive()
   └→ If Claude crashes after print but before save, state is lost

3. format_mandatory_directive() MUST wrap all next-step commands
   └→ Ensures Claude executes before any other action
   └→ Found in config/config.py

4. Step 8 has THREE valid transitions, not one
   └→ COMPLETED (proceed), HALTED (clarify), TASK_ROUTING (loop back)
   └→ Max 3 iterations before forced HALT

5. complete.py sets dispatch_pending before printing directive
   └→ Hook can retry dispatch if print wasn't processed
   └→ Prevents execution chain breaks

6. Step 3b (skill detection) is a sub-step AND handles agent mode routing
   └→ Step number is 3.2, NOT 3b in FSM
   └→ Routes to Step 4 (normal) or Step 5 (agent mode, skips routing)
   └→ Planning is handled by Claude Code's EnterPlanMode tool
```

## Key Classes and Functions

| Location | Class/Function | Purpose |
|----------|---------------|---------|
| `config/config.py` | `STEP_NAMES` | Map step num → FSM state name |
| `config/config.py` | `format_mandatory_directive()` | Wrap command in enforcement language |
| `core/fsm.py` | `ReasoningFSM` | State machine with transition validation |
| `core/fsm.py` | `ReasoningState` | Enum of all possible states |
| `core/state.py` | `ProtocolState` | Session state management + JSON persistence |
| `core/state.py` | `ProtocolState.load()` | Load state from JSON file |
| `core/state.py` | `ProtocolState.save()` | Save state to JSON file |
| `core/state.py` | `ProtocolState.halt_for_clarification()` | Transition to HALTED + store questions |
| `core/state.py` | `ProtocolState.trigger_loop_back()` | Start new iteration (Step 4-8 retry) |
| `core/semantic_routing.py` | `generate_routing_prompt_from_state()` | Generate routing prompt for Step 4 |
| `core/set_route.py` | `main()` | Capture final route after Step 8 |
| `core/universal_learnings.py` | `check_and_prompt_learnings()` | Post-protocol learning prompts |
| `steps/base.py` | `BaseStep` | Abstract base class for all steps |
| `steps/base.py` | `BaseStep.execute()` | Core step execution orchestration |
| `steps/base.py` | `BaseStep.main()` | CLI entry point (argparse + execution) |

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/` (instructions)
- Adding fields to step outputs (step_outputs dict)
- Adding new metadata fields to state
- Enhancing `process_step()` in individual step scripts
- Adding logging/debugging to steps

### ⚠️ Requires Careful Testing

- Adding new steps (update config.py, fsm.py, state.py)
- Changing step order (update FSM transitions)
- Modifying routing logic in step_4_task_routing.py
- Changing state file schema (handle backwards compatibility)

### ❌ Dangerous - Will Break System

- Removing `format_mandatory_directive()` from next-step prints
- Removing `state.save()` before `print_next_directive()`
- Changing session ID format (breaks file path resolution)
- Modifying FSM transitions without updating all references
- Removing the HALT pathway from Step 8
- Removing loop-back capability from routing validation

## Debugging Tips

```bash
# Check current state of a session
cat .claude/orchestration/protocols/reasoning/state/reasoning-*.json | jq .

# Find sessions in progress
grep -l '"status": "in_progress"' protocols/reasoning/state/*.json

# Find halted sessions
grep -l '"status": "halted"' protocols/reasoning/state/*.json

# Check FSM history
cat protocols/reasoning/state/reasoning-*.json | jq '.fsm.history'

# See routing decision
cat protocols/reasoning/state/reasoning-*.json | jq '.routing_decision'
```

## Agent Mode

When running for cognitive agents (via `--agent-mode`):
- Step 4 (Task Routing) is **skipped** - agents are already routed
- Step sequence: 0, 1, 2, 3, 3b, 5, 6, 7, 8
- FSM transition: `SKILL_DETECTION → SELF_CONSISTENCY` (bypasses `TASK_ROUTING`)
- Metadata flag: `state.metadata["is_agent_session"] = True`
- Handled by: `step_3b_skill_detection.py` detects agent mode and routes to Step 5

Note: Planning was previously handled by step_3c (planning checkpoint), but is now handled
by Claude Code's EnterPlanMode tool. Step 3c has been removed from the protocol.

## Step 0: Johari Window Discovery

Step 0 executes at the **START of every interaction** to transform unknown unknowns into known knowns before formal reasoning begins. Uses the SHARE/ASK/ACKNOWLEDGE/EXPLORE framework:

| Phase | Purpose |
|-------|---------|
| **SHARE** | What I can infer from the prompt (task type, complexity, pitfalls) |
| **ASK** | What I need to know (max 5 questions, only if critical) |
| **ACKNOWLEDGE** | Boundaries and assumptions (what remains uncertain) |
| **EXPLORE** | Unknown unknowns to consider (edge cases, failure modes) |

**Critical Rule:** If ANY clarifying questions exist after Step 0, HALT and ask before proceeding to Step 1.
