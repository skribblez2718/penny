# Clarification Agent

**Cognitive Function:** CLARIFICATION
**Purpose:** Transform vague inputs into actionable specifications via Socratic questioning

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → step_5 → step_6 → complete.py
           │        │        │        │        │        │        │
           │        │        │        │        │        │        └→ knowledge_synthesis
           │        │        │        │        │        └→ specification_construction
           │        │        │        │        └→ systematic_interrogation
           │        │        │        └→ question_formulation
           │        │        └→ context_assessment
           │        └→ johari_discovery (HALT if questions exist)
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load clarification-specific learnings from .claude/learnings/clarification/ |
| 1 | `johari_discovery` | Transform unknown unknowns to known knowns (SHARE/ASK/ACKNOWLEDGE/EXPLORE) |
| 2 | `context_assessment` | Assess current understanding gaps, identify what's known vs unknown |
| 3 | `question_formulation` | Formulate targeted clarifying questions (Socratic method) |
| 4 | `systematic_interrogation` | Execute questioning cycle, refine understanding |
| 5 | `specification_construction` | Build actionable specification from clarified info |
| 6 | `knowledge_synthesis` | Synthesize final clarified requirements for downstream agents |

## When Invoked

- Phase 0 of most composite skills (requirements gathering)
- When ambiguity detected mid-workflow
- Via `orchestrate-clarification` atomic skill
- Via Task tool: `subagent_type: "clarification"`

## Files

```
clarification/
├── entry.py      # → agent_entry("clarification")
├── complete.py   # → agent_complete("clarification")
├── content/
│   └── step_{0-6}.md   # Markdown instructions per step
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 2000 tokens
- **Max Output:** 1500 tokens
- **Priority Sections:** task_description, user_query, unknowns

## Output

Memory file: `.claude/memory/{task_id}-clarification-memory.md`

Contains:
- Clarified specifications
- Resolved unknowns
- Actionable requirements
- Questions asked and answers received

## Key Invariants

1. **Step 1 (johari_discovery):** May HALT if clarifying questions are identified. Must ask before proceeding to Step 2.

2. **Step 4 (systematic_interrogation):** May require **user interaction** for answers. The agent should pause and request clarification from the user when questions cannot be answered from existing context.
