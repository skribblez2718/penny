# Composite Skills

Multi-phase workflows that orchestrate sequences of atomic skills. Each composite skill defines a sequence of phases, where each phase invokes an atomic skill (which in turn invokes an agent).

## Composite Skill Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    EXECUTION PROTOCOL TRIGGERS SKILL                        │
│                                    │                                         │
│                    dispatcher.py --route skill-orchestration                 │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  {skill-name}/entry.py                                                 │  │
│  │     └→ skill_entry(skill_name, task_id)                               │  │
│  │         ├→ SkillExecutionState(skill_name, task_id)                   │  │
│  │         ├→ SkillFSM(skill_name)  # Initialize FSM                     │  │
│  │         ├→ phase_0 = get_first_phase(skill_name)                      │  │
│  │         ├→ print(phase_0.content)  # Phase 0 instructions             │  │
│  │         ├→ state.save()  # ⚠️ SAVE BEFORE DIRECTIVE                   │  │
│  │         └→ print(atomic_skill_directive)                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    PHASE EXECUTION LOOP                                │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Phase 0: CLARIFICATION (LINEAR, always runs)                     │  │  │
│  │  │   └→ uses_atomic_skill: "orchestrate-clarification"             │  │  │
│  │  │       └→ Task tool → clarification                         │  │  │
│  │  │           └→ Output: {task_id}-clarification-memory.md           │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                         │                                              │  │
│  │                         ▼ advance_phase.py                             │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Phase 1: {varies by skill}                                       │  │  │
│  │  │   └→ uses_atomic_skill: "orchestrate-{function}"                │  │  │
│  │  │       └→ Task tool → {function}-agent                            │  │  │
│  │  │           └→ Output: {task_id}-{function}-memory.md              │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                         │                                              │  │
│  │                         ▼ ... (repeat for each phase)                  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Phase N: Final phase (usually VALIDATION or GENERATION)          │  │  │
│  │  │   └→ uses_atomic_skill: "orchestrate-validation"                │  │  │
│  │  │       └→ Task tool → validation                            │  │  │
│  │  │           └→ Output: {task_id}-validation-memory.md              │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  {skill-name}/complete.py                                              │  │
│  │     └→ skill_complete(skill_name, state)                              │  │
│  │         ├→ Validate all phases completed                               │  │
│  │         ├→ Aggregate phase outputs                                     │  │
│  │         ├→ Generate completion summary                                 │  │
│  │         └→ print("{SKILL_NAME}_COMPLETE")                             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
composite/
├── CLAUDE.md              # THIS FILE
├── common_skill_entry.py  # Shared entry logic for all composite skills
├── common_skill_complete.py # Shared completion logic
│
├── develop-skill/         # Meta-skill for creating workflow skills
│   ├── CLAUDE.md
│   ├── entry.py           # skill_entry("develop-skill", ...)
│   ├── complete.py        # skill_complete("develop-skill", ...)
│   ├── content/           # Phase instruction markdown
│   │   ├── phase_0_requirements_clarification.md
│   │   ├── phase_0_5_atomic_provisioning.md
│   │   └── ...
│   └── phases/            # Phase scripts (if complex logic needed)
│       └── phase_{n}_{name}.py
│
└── develop-learnings/     # Transform experiences to learnings
```

## Per-Skill Directory Structure

### Orchestration Side (This Directory)

```
{skill-name}/
├── CLAUDE.md          # Skill-specific documentation
├── __init__.py        # Package init
├── entry.py           # Self-configuring entry (7 lines)
├── complete.py        # Self-configuring completion (7 lines)
├── content/           # Markdown instructions per phase
│   ├── phase_0_{phase_name}.md     # Phase 0 (clarification) instructions
│   ├── phase_0_5_{phase_name}.md   # Sub-phase (if any)
│   ├── phase_1_{phase_name}.md
│   └── ...
└── phases/            # Optional phase scripts
    └── phase_{n}_{name}.py
```

## Self-Configuring Entry Pattern

All skill `entry.py` and `complete.py` files use a minimal self-configuring pattern (7 lines):

```python
#!/usr/bin/env python3
"""skill-name Entry Point"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from protocols/skill.composite.common_skill_entry import skill_entry
    skill_entry(Path(__file__).parent.name.replace("_", "-"), Path(__file__).parent)
```

Key features:
- Derives skill name from directory name (converts `develop_skill` → `develop-skill`)
- Uses `Path.parents[3]` for cleaner ancestor navigation
- No hardcoded skill names in individual files
- All logic centralized in `common_skill_entry.py` and `common_skill_complete.py`

### Skills with Custom Arguments

Skills needing custom CLI arguments define a local callback:

```python
# perform_research/entry.py (with --depth argument)
if __name__ == "__main__":
    import argparse; import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from protocols/skill.composite.common_skill_entry import skill_entry
    def add_depth(p: argparse.ArgumentParser) -> None:
        p.add_argument("--depth", default="standard", choices=["quick", "standard", "comprehensive"])
    skill_entry(Path(__file__).parent.name.replace("_", "-"), Path(__file__).parent, add_extra_args=add_depth)
```

### Skills with Custom Completion Logic

Skills needing custom completion behavior (e.g., `develop_learnings`) extend after calling `skill_complete()`:

```python
# develop_learnings/complete.py (with memory cleanup)
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from protocols/skill.composite.common_skill_complete import skill_complete
    skill_complete(Path(__file__).parent.name.replace("_", "-"))
    cleaned = cleanup_memory_files()  # Custom post-completion logic
```

### Skills Side (Resource Files)

Resources are stored in `.claude/skills/{skill-name}/resources/`:

```
.claude/skills/{skill-name}/
├── SKILL.md           # Skill definition and trigger patterns
└── resources/         # Reference materials for agents
    ├── {reference-1}.md
    ├── {reference-2}.md
    └── ...
```

**Resource Reference Pattern:**

Phase content files reference resources using the full path:
```markdown
**Reference:** `${CAII_DIRECTORY}/.claude/skills/{skill-name}/resources/{file}.md`
```

**Why Separate Locations?**
- **Orchestration side** (`protocols/skill/composite/`): Phase execution logic and instructions
- **Skills side** (`.claude/skills/`): Skill definitions, triggers, and reference materials
- This separation keeps orchestration machinery separate from skill-specific knowledge

## Registered Composite Skills (from config.py)

| Skill | Semantic Trigger | NOT for | Phases |
|-------|------------------|---------|--------|
| develop-skill | create/modify skills, update workflows, new skill | system mods, direct code, architecture | 9 |
| develop-learnings | capture learnings, document insights, preserve knowledge | mid-workflow, skill creation, active execution | 7 |
| develop-command | create/modify slash commands, utility commands | workflow skills, multi-phase operations | 3 |

## Call Chain: Skill Entry → Phases → Completion

```python
# 1. Skill entry (invoked by execution protocol)
{skill}/entry.py
    └→ skill_entry(skill_name)  # from common_skill_entry.py
        ├→ task_id = generate_task_id()  # From execution protocol
        ├→ state = SkillExecutionState(skill_name, task_id)
        ├→ fsm = SkillFSM(skill_name)
        ├→ phases = get_skill_phases(skill_name)  # From config.py
        ├→ first_phase = get_first_phase(skill_name)
        ├→ phase_content = load_phase_content(skill_name, first_phase)
        ├→ print(phase_content)
        ├→ state.start_phase(first_phase)
        ├→ state.save()  # ⚠️ MUST save before directive
        └→ print(format_skill_directive(atomic_skill_command))

# 2. Each phase invokes atomic skill → agent
# Claude executes the directive:
Task tool with subagent_type: "orchestrate-{function}"
    └→ atomic/orchestrate_{function}.py
        └→ Task tool with subagent_type: "{agent}-agent"
            └→ protocols/agent/{agent}/entry.py
                └→ Steps → complete.py
                    └→ Write: .claude/memory/{task_id}-{agent}-memory.md

# 3. Phase advancement
advance_phase.py {skill_name} {session_id}
    └→ advance_phase(skill_name, session_id)
        ├→ state = SkillExecutionState.load(skill_name, session_id)
        ├→ verify_memory_file(task_id, current_agent)  # BLOCKING
        ├→ state.complete_phase(current_phase, output)
        ├→ next_phase = fsm.advance()
        ├→ if next_phase:
        │   ├→ print(load_phase_content(skill_name, next_phase))
        │   ├→ state.start_phase(next_phase)
        │   ├→ state.save()  # ⚠️ MUST save before directive
        │   └→ print(format_skill_directive(next_atomic_skill_command))
        └→ else:  # All phases done
            └→ print(complete.py directive)

# 4. Skill completion
{skill}/complete.py
    └→ skill_complete(skill_name)  # from common_skill_complete.py
        ├→ state = SkillExecutionState.load(...)
        ├→ Validate: all phases in completed_phases
        ├→ outputs = aggregate_phase_outputs(state)
        ├→ summary = generate_summary(outputs)
        ├→ state.complete()
        ├→ state.save()
        └→ print("{SKILL_NAME}_COMPLETE")
```

## Phase Configuration (from config.py)

Each phase has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Internal phase identifier |
| `title` | string | Human-readable title |
| `type` | PhaseType | LINEAR, OPTIONAL, ITERATIVE, REMEDIATION, AUTO, PARALLEL |
| `uses_atomic_skill` | string \| None | Atomic skill to invoke (None for AUTO phases) |
| `script` | string | Phase script filename (optional) |
| `content` | string | Markdown content filename |
| `next` | string \| None | Next phase ID (None = final phase) |
| `description` | string | What this phase accomplishes |
| `trigger` | string | For OPTIONAL phases: when to execute |
| `configuration` | dict | Phase-specific settings |
| `remediation_target` | string | For REMEDIATION: phase to retry |
| `max_remediation` | int | Maximum retry attempts |
| `parallel_branches` | dict | For PARALLEL: branch definitions |

## Example Phase Definition

```python
# From DEVELOP_SKILL_PHASES in config.py
"3": {
    "name": "SKILL_SYNTHESIS",
    "title": "Skill Synthesis",
    "type": PhaseType.LINEAR,
    "uses_atomic_skill": "orchestrate-synthesis",
    "content": "phase_3_skill_synthesis.md",
    "next": "4",
    "description": "Synthesize skill design from research and analysis",
},
"4": {
    "name": "SKILL_GENERATION",
    "title": "Skill Generation",
    "type": PhaseType.LINEAR,
    "uses_atomic_skill": "orchestrate-generation",
    "content": "phase_4_skill_generation.md",
    "next": "5",
    "description": "Generate skill artifacts using TDD methodology",
},
```

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. ALL phase definitions are in config.py
   └→ SKILL_PHASES[skill_name] is the source of truth
   └→ Never hardcode phases in skill directories

2. Phase 0 MUST be LINEAR (mandatory clarification)
   └→ Johari Window principle: clarification is never optional
   └→ Enforced in common_skill_entry.py

3. entry.py MUST use common_skill_entry.skill_entry()
   └→ Shared initialization ensures consistency
   └→ Manual entry bypasses FSM initialization

4. complete.py MUST use common_skill_complete.skill_complete()
   └→ Shared completion ensures all phases verified
   └→ Manual completion may miss validation

5. Phase scripts can exist in phases/ but are OPTIONAL
   └→ Most phases just load content + invoke atomic skill
   └→ Scripts only needed for complex phase logic

6. state.save() MUST precede print_next_directive()
   └→ Crash recovery depends on persisted state
   └→ This is enforced in advance_phase.py

7. Memory files track agent outputs, not phase outputs
   └→ .claude/memory/{task_id}-{agent}-memory.md
   └→ Phase outputs are in state.phase_outputs
```

## Metacognitive Hook Bypass

Controlled by `SKILLS_BYPASSING_LEARNINGS` constant in `common_skill_complete.py`.

## Safe vs Dangerous Modifications

### ✅ Safe Changes

- Modifying markdown content in `content/phase_{n}.md`
- Adding new composite skills (full directory + config.py registration)
- Adding metadata to phase_outputs
- Adding logging/debugging to phase scripts
- Adjusting phase descriptions in config.py

### ⚠️ Requires Careful Testing

- Adding new phases (update config.py + create content file)
- Changing phase order (update `next` pointers in config.py)
- Changing phase types (e.g., LINEAR → OPTIONAL)
- Adding PARALLEL branches

### ❌ Dangerous - Will Break System

- Making Phase 0 non-LINEAR
- Removing memory file verification
- Bypassing common_skill_entry/complete.py
- Hardcoding phases outside config.py
- Removing state.save() before directives
- Changing skill name format (affects state file paths)

## Debugging Tips

```bash
# Check skill phases
python3 -c "from protocols/skill.config import get_skill_phases; import json; print(json.dumps(get_skill_phases('develop-skill'), indent=2, default=str))"

# Check phase order
python3 -c "from protocols/skill.config import get_phase_list; print(get_phase_list('develop-skill'))"

# Check skill state
cat protocols/skill/state/{skill_name}-*.json | jq .

# View current phase
cat protocols/skill/state/{skill}-{session}.json | jq '.fsm.current_phase_id'

# List phase content files
ls -la protocols/skill/composite/{skill-name}/content/

# Check FSM completed phases
cat protocols/skill/state/{skill}-{session}.json | jq '.fsm.completed_phases'
```
