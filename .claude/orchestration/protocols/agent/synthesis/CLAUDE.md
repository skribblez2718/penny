# Synthesis Agent

**Cognitive Function:** SYNTHESIS
**Purpose:** Integrate disparate information into coherent designs and solutions

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → step_5 → complete.py
           │        │        │        │        │        │
           │        │        │        │        │        └→ validation_prep
           │        │        │        │        └→ framework_construction
           │        │        │        └→ conflict_resolution
           │        │        └→ integration_mapping
           │        └→ context_loading
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load synthesis-specific learnings from .claude/learnings/synthesis/ |
| 1 | `context_loading` | Load context from predecessor agents (research, analysis) |
| 2 | `integration_mapping` | Map how inputs relate, identify integration points |
| 3 | `conflict_resolution` | Resolve contradictions between inputs, reconcile trade-offs |
| 4 | `framework_construction` | Build coherent design/architecture/solution framework |
| 5 | `validation_prep` | Prepare output for validation agent, define acceptance criteria |

## When Invoked

- Synthesis phase of composite skills (after research/analysis)
- When multiple inputs need unification
- Via `orchestrate-synthesis` atomic skill
- Via Task tool: `subagent_type: "synthesis"`

## Files

```
synthesis/
├── entry.py      # → agent_entry("synthesis")
├── complete.py   # → agent_complete("synthesis")
├── content/
│   └── step_{0-5}.md   # Markdown instructions per step
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 3000 tokens
- **Max Output:** 2500 tokens
- **Priority Sections:** analysis_output, constraints, design_decisions

## Output

Memory file: `.claude/memory/{task_id}-synthesis-memory.md`

Contains:
- Integrated design/solution framework
- Resolution of conflicts/contradictions
- Design decisions with rationale
- Acceptance criteria for validation
- Architecture diagrams (ASCII) if applicable

## Key Invariant

Step 1 (context_loading) MUST load memory files from predecessor agents based on `context_pattern`:
- `WORKFLOW_ONLY`: No predecessor context
- `IMMEDIATE_PREDECESSORS`: Load direct predecessors only
- `MULTIPLE_PREDECESSORS`: Load all specified predecessors
