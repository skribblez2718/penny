# Atomic Skills

Thin wrappers around cognitive agents. Each atomic skill maps 1:1 to exactly one agent. Atomic skills provide the bridge between composite skill phases and agent protocols.

## Atomic Skill Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    COMPOSITE PHASE INVOKES ATOMIC SKILL                     │
│                                    │                                         │
│                    uses_atomic_skill: "orchestrate-{function}"               │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  atomic/orchestrate_{function}.py                                      │  │
│  │     └→ atomic_entry(skill_name, task_id, context)                     │  │
│  │         ├→ Validate: skill is in ATOMIC_SKILLS registry               │  │
│  │         ├→ Get agent: ATOMIC_SKILLS[skill_name]["agent"]              │  │
│  │         ├→ Load context from predecessor memory files                 │  │
│  │         └→ invoke_agent(agent_name, task_id, context)                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  agent_invoker.py: invoke_agent()                                      │  │
│  │     └→ Build agent invocation context                                  │  │
│  │     └→ Format Task tool directive                                      │  │
│  │     └→ print(directive)                                                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Claude executes: Task tool                                            │  │
│  │     subagent_type: "{agent-name}-agent"                               │  │
│  │     prompt: "Execute agent protocol with context..."                   │  │
│  │        │                                                               │  │
│  │        ▼                                                               │  │
│  │  protocols/agent/{agent}/entry.py                                      │  │
│  │     └→ agent_entry()                                                   │  │
│  │         └→ step_0_learning_injection.py                                │  │
│  │         └→ step_1_{name}.py                                            │  │
│  │         └→ ...                                                         │  │
│  │         └→ complete.py                                                 │  │
│  │             └→ Write memory file                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Output: .claude/memory/{task_id}-{agent}-memory.md                    │  │
│  │     └→ Contains agent's cognitive work output                          │  │
│  │     └→ Read by next phase's agent as predecessor context               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
atomic/
├── CLAUDE.md              # THIS FILE
├── __init__.py            # Package init with skill registry
├── base.py                # BaseAtomicSkill abstract class
├── enforcer.py            # Constraint enforcement
├── orchestrate_clarification.py  # CLARIFICATION wrapper
├── orchestrate_research.py       # RESEARCH wrapper
├── orchestrate_analysis.py       # ANALYSIS wrapper
├── orchestrate_synthesis.py      # SYNTHESIS wrapper
├── orchestrate_generation.py     # GENERATION wrapper
└── orchestrate_validation.py     # VALIDATION wrapper
```

## Atomic Skill Registry (from config.py)

| Skill | Cognitive Function | Semantic Trigger | NOT for |
|-------|-------------------|------------------|---------|
| orchestrate-clarification | CLARIFICATION | ambiguity resolution, requirements refinement | well-defined tasks with clear specifications |
| orchestrate-research | RESEARCH | knowledge gaps, options exploration | tasks with complete information |
| orchestrate-analysis | ANALYSIS | complexity decomposition, risk assessment | simple tasks without dependencies |
| orchestrate-synthesis | SYNTHESIS | integration of findings, design creation | single-source tasks without integration |
| orchestrate-generation | GENERATION | artifact creation, TDD implementation | read-only or research tasks |
| orchestrate-validation | VALIDATION | quality verification, acceptance testing | tasks without deliverables to verify |
| orchestrate-memory | METACOGNITION | progress tracking, impasse detection | simple linear workflows |

## Call Chain: Atomic Skill → Agent

```python
# 1. Composite phase specifies atomic skill
# In config.py phase definition:
{
    "name": "RESEARCH_PHASE",
    "uses_atomic_skill": "orchestrate-research",  # ← THIS
    ...
}

# 2. Phase script calls atomic skill
phase_1_research.py
    └→ invoke_atomic_skill("orchestrate-research", task_id, context)

# 3. Atomic skill entry
orchestrate_research.py
    └→ atomic_entry("orchestrate-research", task_id, context)
        ├→ agent_name = ATOMIC_SKILLS["orchestrate-research"]["agent"]
        │   └→ Returns "research"
        ├→ load_predecessor_context(task_id, predecessors)
        └→ invoke_agent("research", task_id, full_context)

# 4. Agent invoker triggers Task tool
agent_invoker.invoke_agent("research", task_id, context)
    └→ Format directive:
        "Execute Task tool with subagent_type: 'research'"
    └→ print(directive)

# 5. Claude executes Task tool
Task(
    subagent_type="research",
    prompt="Execute research protocol for task {task_id}...",
    description="Research phase"
)
    └→ protocols/agent/research/entry.py

# 6. Agent protocol runs
research/entry.py
    └→ step_0_learning_injection.py (load research learnings)
    └→ step_1_scope_definition.py
    └→ step_2_information_gathering.py
    └→ step_3_source_evaluation.py
    └→ step_4_synthesis.py
    └→ step_5_deliverable.py
    └→ complete.py
        └→ Write: .claude/memory/{task_id}-research-memory.md
```

## Data Contract: Atomic Skill Invocation

```python
# Input to atomic skill
{
    "skill_name": "orchestrate-research",
    "task_id": "abc123def456",
    "context": {
        "user_query": "Research best practices for MCP servers",
        "predecessor_outputs": {
            "clarification": "Clarified scope: Python MCP server..."
        },
        "phase_config": {
            "research_depth": "standard"
        }
    }
}

# Output (via memory file)
# .claude/memory/abc123def456-research-memory.md
# Contains structured research findings
```

## Agent Prompt Template (CRITICAL)

When atomic skills invoke agents via the Task tool, the DA **MUST** structure the prompt using the standardized Agent Prompt Template format.

### Required Template Sections

| Section | Required | Source |
|---------|----------|--------|
| Task Context | Yes | task_id, skill_name, phase_id, domain, agent_name |
| Role Extension | Yes | DA generates dynamically (3-5 task-specific focus areas) |
| Johari Context | If available | From reasoning protocol Step 0 |
| Task Instructions | Yes | Specific cognitive work for this agent |
| Related Research Terms | Yes | DA generates dynamically (7-10 keywords) |
| Output Requirements | Yes | Memory file path and format |

### Template Structure

```markdown
# Agent Invocation: {agent_name}

## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `{skill_name}`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `{agent_name}`

## Role Extension
[DA generates 3-5 task-specific focus areas]

## Prior Knowledge (Johari Window)
### Open (Confirmed)
[From reasoning protocol]
### Blind (Gaps)
[Identified unknowns]
### Hidden (Inferred)
[Assumptions]
### Unknown (To Explore)
[Areas for investigation]

## Task
[Specific instructions for this cognitive function]

## Related Research Terms
[DA generates 7-10 keywords]

## Output
Write findings to: `.claude/memory/{task_id}-{agent_name}-memory.md`
```

### Why This Matters

- **Consistency:** All agents receive context in the same structure
- **Johari Transfer:** Reasoning discoveries flow to agents
- **Task Specialization:** Role Extension adapts agents to specific tasks

**Reference:** See each skill's SKILL.md "Agent Invocation Format" section or `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md`

## Atomic Skill Constraints

```
⚠️  ATOMIC SKILL CONSTRAINTS (Enforced by atomic_enforcer.py)

1. Atomic skills CANNOT compose other skills
   └→ composition_depth = 0 (always)
   └→ No skill can call another skill

2. Atomic skills wrap EXACTLY ONE agent
   └→ 1:1 mapping enforced in ATOMIC_SKILLS registry
   └→ orchestrate-research → research (only)

3. Agent invocation ONLY via Task tool
   └→ Never call protocols/agent/{agent}/entry.py directly
   └→ agent_invoker.invoke_agent() prints Task tool directive

4. Memory file is the ONLY output
   └→ Agent writes to .claude/memory/{task_id}-{agent}-memory.md
   └→ Return values are NOT passed back to caller

5. Context is passed via predecessor memory files
   └→ Each atomic skill can read predecessor agent outputs
   └→ context_pattern in phase config defines which predecessors to load
```

## Key Functions

| Location | Function | Purpose |
|----------|----------|---------|
| `base.py` | `BaseAtomicSkill` | Abstract base class |
| `base.py` | `invoke()` | Return Task tool invocation parameters |
| `base.py` | `get_memory_file_path()` | Get expected memory file path |
| `enforcer.py` | `AtomicSkillEnforcer` | Enforcement class for execution chain |
| `enforcer.py` | `enforce_completion()` | Verify agent invoked and completed |
| `../core/agent_invoker.py` | `invoke_agent()` | Format and print Task tool directive |
| `../config/config.py` | `ATOMIC_SKILLS` | Registry of atomic skills |
| `../config/config.py` | `get_atomic_skill_agent()` | Get agent name for skill |

## Usage Patterns

### From Composite Skill Phase

```python
# In phase script (e.g., phase_1_research.py)
from protocols/skill.atomic import invoke_atomic_skill

def execute_phase(state: SkillExecutionState):
    # Invoke atomic skill
    invoke_atomic_skill(
        skill_name="orchestrate-research",
        task_id=state.task_id,
        context={
            "user_query": state.metadata.get("user_query"),
            "phase_config": state.configuration,
        },
        predecessors=["clarification"],  # Load predecessor memory
    )
```

### From Dynamic Skill Sequencing

```python
# In dynamic-skill-sequencing/step_3_invoke_skills.py
for skill_name in planned_sequence:
    # Each skill in sequence is an atomic skill
    invoke_atomic_skill(
        skill_name=skill_name,
        task_id=task_id,
        context=context,
        predecessors=get_predecessors(skill_name),
    )
```

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. ATOMIC_SKILLS registry is the source of truth
   └→ All atomic skill definitions live in config.py
   └→ Never hardcode agent mappings in skill files

2. Every atomic skill MUST have a corresponding orchestrate_*.py file
   └→ File implements atomic_entry() call
   └→ No orphan skills in registry

3. Task tool subagent_type MUST match AGENT_REGISTRY
   └→ subagent_type: "{agent_name}" (e.g., "research")
   └→ Agent registry in protocols/agent/config.py

4. Memory file path format is FIXED
   └→ .claude/memory/{task_id}-{agent_name}-memory.md
   └→ Changing breaks predecessor context loading
```

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Adding logging/debugging to atomic skill scripts
- Modifying how predecessor context is formatted
- Adding new validation in atomic_enforcer.py

### ⚠️ Requires Careful Testing

- Adding new atomic skills (update config.py + create orchestrate_*.py)
- Modifying BaseAtomicSkill interface
- Changing context loading logic

### ❌ Dangerous - Will Break System

- Allowing atomic skills to compose other skills
- Calling agent entry.py directly (bypass Task tool)
- Changing memory file path format
- Removing skill from ATOMIC_SKILLS but keeping file (orphan)
- Having multiple agents per atomic skill

## Debugging Tips

```bash
# Verify atomic skill registration
python3 -c "from protocols/skill.config import ATOMIC_SKILLS; import json; print(json.dumps(ATOMIC_SKILLS, indent=2))"

# Check agent for atomic skill
python3 -c "from protocols/skill.config import get_atomic_skill_agent; print(get_atomic_skill_agent('orchestrate-research'))"

# List memory files for task
ls -la .claude/memory/{task_id}*

# Verify agent registry matches
python3 -c "from agent_protocols.config import AGENT_REGISTRY; print(list(AGENT_REGISTRY.keys()))"
```
