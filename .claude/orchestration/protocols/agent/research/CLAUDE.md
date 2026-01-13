# Research Agent

**Cognitive Function:** RESEARCH
**Purpose:** Systematic information discovery, retrieval, and evaluation

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → step_5 → complete.py
           │        │        │        │        │        │
           │        │        │        │        │        └→ synthesis_documentation
           │        │        │        │        └→ discovery_process
           │        │        │        └→ strategy_formulation
           │        │        └→ unknown_resolution
           │        └→ context_extraction
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load research-specific learnings from .claude/learnings/research/ |
| 1 | `context_extraction` | Extract research context from task, identify knowledge gaps |
| 2 | `unknown_resolution` | Prioritize unknowns, determine research approach per unknown |
| 3 | `strategy_formulation` | Design research strategy (web search, code exploration, docs) |
| 4 | `discovery_process` | Execute research using WebSearch, WebFetch, Read, Grep, Glob |
| 5 | `synthesis_documentation` | Synthesize findings, document sources, assess confidence |

## When Invoked

- Research phase of composite skills
- Via `orchestrate-research` atomic skill
- Via Task tool: `subagent_type: "research"`

## Files

```
research/
├── entry.py      # → agent_entry("research")
├── complete.py   # → agent_complete("research")
├── content/
│   └── step_{0-5}.md   # Markdown instructions per step
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 3000 tokens
- **Max Output:** 2500 tokens
- **Priority Sections:** research_queries, unknowns, constraints

## Output

Memory file: `.claude/memory/{task_id}-research-memory.md`

Contains:
- Research findings with source attribution
- Resolved unknowns
- Remaining unknowns (if any)
- Confidence scores per finding
- Recommended next steps

## Key Tools Used

- `WebSearch` - Web search for general information
- `WebFetch` - Fetch specific web pages
- `Read` - Read local files and documentation
- `Grep` - Search code patterns
- `Glob` - Find files by pattern
