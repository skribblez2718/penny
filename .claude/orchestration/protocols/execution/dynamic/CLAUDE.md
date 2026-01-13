# Dynamic Skill Sequencing Protocol

5-step protocol for dynamically determining and executing a sequence of atomic skills when no composite skill matches.

## Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│               DYNAMIC SKILL SEQUENCING (5 Steps)                            │
│                                                                             │
│  dispatcher.py --route dynamic-skill-sequencing                             │
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
│  │  Step 1: ANALYZE_REQUIREMENTS                                        │   │
│  │     └→ Analyze user query for cognitive function needs               │   │
│  │     └→ Determine: needs_clarification, needs_research, etc.          │   │
│  │     └→ state.step_outputs[1] = {"required_functions": [...]}         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 2: PLAN_SEQUENCE                                               │   │
│  │     └→ Map functions to orchestrate-* atomic skills                  │   │
│  │     └→ Determine execution order based on dependencies               │   │
│  │     └→ state.step_outputs[2] = {"skill_sequence": [...]}             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 3: INVOKE_SKILLS ← CORE STEP                                   │   │
│  │     └→ For each skill in sequence:                                   │   │
│  │         └→ Invoke: orchestrate-{function}/entry.py                   │   │
│  │         └→ Atomic skill invokes agent via Task tool                  │   │
│  │         └→ Wait for memory file                                      │   │
│  │     └→ state.step_outputs[3] = {"skills_executed": [...]}            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 4: VERIFY_COMPLETION                                           │   │
│  │     └→ Check all memory files exist                                  │   │
│  │     └→ Validate cognitive work completed                             │   │
│  │     └→ state.step_outputs[4] = {"verification": {...}}               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Step 5: COMPLETE                                                    │   │
│  │     └→ Aggregate skill outputs                                       │   │
│  │     └→ Generate final deliverable                                    │   │
│  │     └→ state.complete_protocol(summary)                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  complete.py --state {state_file}                                    │   │
│  │     └→ Validate all 5 steps completed                                │   │
│  │     └→ print("DYNAMIC_SKILL_SEQUENCING_COMPLETE")                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
dynamic-skill-sequencing/
├── CLAUDE.md              # THIS FILE
├── entry.py               # Initialize state, output Step 1 directive
├── complete.py            # Final validation and completion
├── content/               # Markdown instructions per step
│   ├── step_1_analyze_requirements.md
│   ├── step_2_plan_sequence.md
│   ├── step_3_invoke_skills.md
│   ├── step_4_verify_completion.md
│   └── step_5_complete.md
├── steps/
│   ├── step_1_analyze_requirements.py
│   ├── step_2_plan_sequence.py
│   ├── step_3_invoke_skills.py   # ← CORE: Skill invocation
│   ├── step_4_verify_completion.py
│   └── step_5_complete.py
└── state/                 # Session state files (gitignored)
    └── dynamic-skill-sequencing-{session_id}.json
```

## When Used

This protocol is invoked when:
- Task needs multiple cognitive functions but **doesn't match** a composite skill
- Novel task requiring custom skill sequence
- User explicitly requests dynamic sequencing
- Routing determines `AGENT_REQUIRED` with no skill match

## Cognitive Function to Atomic Skill Mapping

```
┌─────────────────────────────────────────────────────────────────────────────┐
│         COGNITIVE FUNCTION → ATOMIC SKILL → AGENT                          │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │ CLARIFICATION   │ → │ orchestrate-clarification │ → │ clarification │   │
│  └─────────────────┘   └────────────────────────┘   └──────────────────┘   │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │ RESEARCH        │ → │ orchestrate-research     │ → │ research     │   │
│  └─────────────────┘   └────────────────────────┘   └──────────────────┘   │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │ ANALYSIS        │ → │ orchestrate-analysis     │ → │ analysis     │   │
│  └─────────────────┘   └────────────────────────┘   └──────────────────┘   │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │ SYNTHESIS       │ → │ orchestrate-synthesis    │ → │ synthesis    │   │
│  └─────────────────┘   └────────────────────────┘   └──────────────────┘   │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │ GENERATION      │ → │ orchestrate-generation   │ → │ generation   │   │
│  └─────────────────┘   └────────────────────────┘   └──────────────────┘   │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │ VALIDATION      │ → │ orchestrate-validation   │ → │ validation   │   │
│  └─────────────────┘   └────────────────────────┘   └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Example Skill Sequences

| Task Type | Required Functions | Skill Sequence |
|-----------|-------------------|----------------|
| Research task | CLARIFICATION → RESEARCH → SYNTHESIS | orchestrate-clarification → orchestrate-research → orchestrate-synthesis |
| Analysis task | ANALYSIS → SYNTHESIS → VALIDATION | orchestrate-analysis → orchestrate-synthesis → orchestrate-validation |
| Complex task | All 6 | orchestrate-clarification → research → analysis → synthesis → generation → validation |
| Simple code | GENERATION → VALIDATION | orchestrate-generation → orchestrate-validation |

## Call Chain: Entry → Steps → Completion

```python
# 1. Entry point (after dispatcher)
entry.py --state {state_file}
    └→ ExecutionState.load(ProtocolType.DYNAMIC_SKILL_SEQUENCING, session_id)
    └→ print(format_mandatory_directive(step_1 command))

# 2. Step 1: Analyze which cognitive functions are needed
step_1_analyze_requirements.py --state {state_file}
    └→ Analyze user query
    └→ Determine: needs_clarification, needs_research, needs_analysis...
    └→ Output: {"required_functions": ["CLARIFICATION", "RESEARCH", "SYNTHESIS"]}

# 3. Step 2: Plan the skill sequence
step_2_plan_sequence.py --state {state_file}
    └→ Map functions to orchestrate-* skills
    └→ Order by dependencies (clarification first, validation last)
    └→ Output: {"skill_sequence": ["orchestrate-clarification", "orchestrate-research", ...]}

# 4. Step 3: Execute skills in sequence (CORE)
step_3_invoke_skills.py --state {state_file}
    └→ For each skill in sequence:
        └→ invoke_atomic_skill(skill_name)
            └→ protocols/skill/atomic/{skill}/entry.py
            └→ Atomic skill invokes agent via Task tool
            └→ Agent writes memory file
        └→ Wait for memory file
    └→ Output: {"skills_executed": [...], "memory_files": [...]}

# 5. Step 4: Verify all cognitive work completed
step_4_verify_completion.py --state {state_file}
    └→ For each skill executed:
        └→ Verify memory file exists
        └→ Validate content is non-empty
    └→ Output: {"verification": {"all_complete": true, "issues": []}}

# 6. Step 5: Complete and aggregate
step_5_complete.py --state {state_file}
    └→ Aggregate all memory file contents
    └→ Generate final deliverable
    └→ state.complete_protocol(summary)

# 7. Completion
complete.py --state {state_file}
    └→ Validate len(step_outputs) == 5
    └→ print("DYNAMIC_SKILL_SEQUENCING_COMPLETE")
```

## Step 3 Skill Invocation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: INVOKE_SKILLS (Critical - Skill Invocation)                        │
│                                                                             │
│  For each skill in skill_sequence:                                          │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  1. Print atomic skill directive                                       │ │
│  │     "Execute: protocols/skill/atomic/{skill}/entry.py --task {task_id}"│ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  2. Atomic skill entry                                                 │ │
│  │     orchestrate-{function}/entry.py --task {task_id}                   │ │
│  │     └→ Creates skill execution context                                 │ │
│  │     └→ Prints Task tool directive for agent                            │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  3. Task tool invokes agent (TEMPLATE FORMAT REQUIRED)                 │ │
│  │     subagent_type: "{function}-agent"                                  │ │
│  │     prompt: Must use Agent Prompt Template format                      │ │
│  │     └→ protocols/agent/{agent}/entry.py                                │ │
│  │     └→ Steps 0-N execute                                               │ │
│  │     └→ complete.py writes memory file                                  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  4. Memory file created                                                │ │
│  │     .claude/memory/{task_id}-{agent}-memory.md                         │ │
│  │     └→ Contains agent's cognitive output                               │ │
│  │     └→ Available for next skill's context                              │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│        │                                                                    │
│        └──→ Next skill (loop) OR Step 4 (all skills done)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Agent Prompt Template Requirements (Step 3)

When Step 3 directs the DA to invoke atomic skills, the Task tool prompt **MUST** use the standardized Agent Prompt Template format.

### Required Sections

| Section | Required | Description |
|---------|----------|-------------|
| Task Context | Yes | task_id, skill, phase, domain, agent |
| Role Extension | Yes | DA generates 3-5 task-specific focus areas |
| Johari Context | If available | Open/Blind/Hidden/Unknown from reasoning |
| Task Instructions | Yes | Specific cognitive work |
| Related Research Terms | Yes | DA generates 7-10 keywords |
| Output Requirements | Yes | Memory file path |

### Why This Matters

- **Consistency:** All agents receive context in the same structure
- **Johari Transfer:** Reasoning protocol discoveries flow to agents
- **Task Specialization:** Role Extension adapts agents to specific tasks

**Reference:** See DA.md "Agent Prompt Template Requirements" or skill's SKILL.md "Agent Invocation Format" section

## Data Contract: Step Outputs

```json
{
  "1": {
    "required_functions": ["CLARIFICATION", "RESEARCH", "SYNTHESIS"],
    "analysis": {
      "has_ambiguity": true,
      "needs_research": true,
      "needs_design": false
    }
  },
  "2": {
    "skill_sequence": [
      "orchestrate-clarification",
      "orchestrate-research",
      "orchestrate-synthesis"
    ],
    "rationale": "Task has ambiguity (needs clarification) and requires research..."
  },
  "3": {
    "skills_executed": [
      {"skill": "orchestrate-clarification", "agent": "clarification", "status": "complete"},
      {"skill": "orchestrate-research", "agent": "research", "status": "complete"},
      {"skill": "orchestrate-synthesis", "agent": "synthesis", "status": "complete"}
    ],
    "memory_files": [
      ".claude/memory/{task_id}-clarification-memory.md",
      ".claude/memory/{task_id}-research-memory.md",
      ".claude/memory/{task_id}-synthesis-memory.md"
    ]
  },
  "4": {
    "verification": {
      "all_complete": true,
      "files_verified": 3,
      "issues": []
    }
  },
  "5": {
    "summary": "Completed dynamic skill sequence with 3 cognitive functions...",
    "deliverables": [...]
  }
}
```

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Requirements analysis (Step 1) determines cognitive functions needed
   └→ Missing analysis = wrong skill sequence
   └→ Must identify ALL required functions

2. Skill sequence order matters (Step 2)
   └→ Dependencies: clarification → research → analysis → synthesis → generation → validation
   └→ Clarification ALWAYS first if ambiguity exists
   └→ Validation ALWAYS last if verification needed

3. Each atomic skill invokes EXACTLY ONE agent
   └→ orchestrate-clarification → clarification
   └→ No composite skills in dynamic sequencing

4. Memory files pass context between skills
   └→ Later skills read earlier skills' memory files
   └→ Missing memory file = context loss

5. Step 4 verification is NOT optional
   └→ Must verify all memory files exist
   └→ Must verify content is non-empty

6. state.save() MUST precede print_next_directive()
   └→ Same invariant as all protocols
```

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/step_{n}.md`
- Adding logging to step implementations
- Adding new cognitive function indicators in Step 1
- Adjusting skill sequence rationale text

### ⚠️ Requires Careful Testing

- Adding new atomic skills (must have corresponding agent)
- Changing function-to-skill mapping
- Modifying dependency order logic in Step 2
- Adding parallel skill execution

### ❌ Dangerous - Will Break System

- Removing requirements analysis (Step 1)
- Bypassing skill sequence ordering (Step 2)
- Calling agents directly instead of via atomic skills
- Removing verification step (Step 4)
- Changing memory file path format
- Removing state.save() before print_next_directive()

## Debugging Tips

```bash
# Check protocol state
cat dynamic-skill-sequencing/state/dynamic-skill-sequencing-*.json | jq .

# Check required functions (Step 1)
cat dynamic-skill-sequencing/state/*.json | jq '.step_outputs["1"].required_functions'

# Check planned sequence (Step 2)
cat dynamic-skill-sequencing/state/*.json | jq '.step_outputs["2"].skill_sequence'

# Check skills executed (Step 3)
cat dynamic-skill-sequencing/state/*.json | jq '.step_outputs["3"].skills_executed'

# Check verification result (Step 4)
cat dynamic-skill-sequencing/state/*.json | jq '.step_outputs["4"].verification'

# List memory files for task
ls -la .claude/memory/{task_id}-*

# Verify FSM state
cat dynamic-skill-sequencing/state/*.json | jq '.fsm.state'
```

## Comparison: Skill Orchestration vs Dynamic Sequencing

| Aspect | Skill Orchestration | Dynamic Skill Sequencing |
|--------|---------------------|-------------------------|
| Trigger | Composite skill matched | No skill match |
| Steps | 6 | 5 |
| Skill type | Composite (multi-phase) | Atomic (single agent each) |
| Sequence | Pre-defined in skill config | Dynamically determined |
| Flexibility | Fixed phases | Adapts to task |
| Use case | Known workflow patterns | Novel/unique tasks |
