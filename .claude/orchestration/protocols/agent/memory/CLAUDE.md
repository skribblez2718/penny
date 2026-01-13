# Goal Memory Agent

**Cognitive Function:** METACOGNITION
**Purpose:** Metacognitive monitor for impasse detection and remediation

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → step_5 → step_6 → complete.py
           │        │        │        │        │        │        │
           │        │        │        │        │        │        └→ output_generation
           │        │        │        │        │        └→ remediation_determination
           │        │        │        │        └→ impasse_detection
           │        │        │        └→ progress_assessment
           │        │        └→ goal_reconstruction
           │        └→ context_loading
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load metacognition learnings from .claude/learnings/metacognition/ |
| 1 | `context_loading` | Load completed agent's output summary, previous goal state |
| 2 | `goal_reconstruction` | Reconstruct current goal state from workflow context |
| 3 | `progress_assessment` | Assess progress toward goals, measure completion % |
| 4 | `impasse_detection` | Detect if workflow is stuck (impasse types below) |
| 5 | `remediation_determination` | Determine remediation action if impasse detected |
| 6 | `output_generation` | Generate metacognitive assessment output |

## When Invoked

- **Automatically** after every agent completion (via common_complete.py)
- Provides metacognitive oversight of workflow state
- Does NOT invoke itself (prevents infinite loop)

## Files

```
memory/
├── entry.py      # → agent_entry("memory")
├── complete.py   # → agent_complete("memory") with --skip-goal-memory
├── content/
│   └── step_{0-6}.md   # Markdown instructions per step (7 steps total)
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 1500 tokens (smallest - focused assessment)
- **Max Output:** 800 tokens
- **Priority Sections:** agent_output_summary, previous_goal_state

## Output

Memory file: `.claude/memory/{task_id}-memory-phase-{X}-to-{Y}-memory.md`

Contains:
- Goal state reconstruction
- Progress assessment (%)
- Impasse detection result
- Remediation action (if impasse)
- Confidence score

## Impasse Types

| Type | Detection | Remediation |
|------|-----------|-------------|
| `KNOWLEDGE_GAP` | Agent lacks needed information | Trigger research loop |
| `CONSTRAINT_CONFLICT` | Incompatible requirements | Escalate to user |
| `RESOURCE_EXHAUSTED` | Max iterations reached | Halt and report |
| `CIRCULAR_DEPENDENCY` | Same step repeating | Break cycle, escalate |
| `AMBIGUITY` | Unclear requirements | Trigger clarification |

## Assessment Output Format

```markdown
**Impasse Detected:** Yes/No
**Type:** {impasse_type or "none"}
**Confidence:** {0.0-1.0}
**Action:** continue | remediate | escalate | halt
**Remediation:** {description if needed}
```

## Key Invariant

This agent does NOT invoke itself after completion. The `--skip-goal-memory` flag is set in its own complete.py to prevent infinite recursion.
