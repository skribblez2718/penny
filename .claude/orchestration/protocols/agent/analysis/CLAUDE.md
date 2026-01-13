# Analysis Agent

**Cognitive Function:** ANALYSIS
**Purpose:** Decompose complexity through systematic analytical frameworks

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → step_5 → complete.py
           │        │        │        │        │        │
           │        │        │        │        │        └→ output_generation
           │        │        │        │        └→ pattern_synthesis
           │        │        │        └→ evaluation
           │        │        └→ decomposition
           │        └→ context_extraction
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load analysis-specific learnings from .claude/learnings/analysis/ |
| 1 | `context_extraction` | Extract analysis context, identify what needs decomposition |
| 2 | `decomposition` | Break complex problem into components, map dependencies |
| 3 | `evaluation` | Evaluate each component: risks, complexity, trade-offs |
| 4 | `pattern_synthesis` | Identify patterns, anti-patterns, root causes |
| 5 | `output_generation` | Generate structured analysis output for synthesis |

## When Invoked

- Analysis phase of composite skills
- When complexity needs decomposition
- Via `orchestrate-analysis` atomic skill
- Via Task tool: `subagent_type: "analysis"`

## Files

```
analysis/
├── entry.py      # → agent_entry("analysis")
├── complete.py   # → agent_complete("analysis")
├── content/
│   └── step_{0-5}.md   # Markdown instructions per step
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 2500 tokens
- **Max Output:** 2000 tokens
- **Priority Sections:** research_findings, constraints, trade_offs

## Output

Memory file: `.claude/memory/{task_id}-analysis-memory.md`

Contains:
- Component decomposition
- Dependency map
- Risk assessment
- Complexity scores
- Identified patterns and anti-patterns
- Trade-off analysis

## Analysis Frameworks Used

- Dependency mapping (cascade effects)
- Risk assessment (probability × impact)
- Complexity scoring (1-5 scale)
- Trade-off matrices
- Root cause analysis (5 Whys)
