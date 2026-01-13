# Learning Injection

## Instructions

1. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/analysis/heuristics.md` (~100-150 tokens)
2. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/analysis/anti-patterns.md` (~50-100 tokens)
3. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/analysis/checklists.md` (~50-100 tokens)
4. Scan INDEX for patterns matching current task domain/context
5. If pattern match found: Perform targeted grep for that specific section in full learnings file
6. Apply loaded heuristics/anti-patterns/checklists to current analysis task

## Token Budget

- INDEX loading: 200-400 tokens (always loaded)
- Deep lookup: 0-200 tokens (conditional, only if pattern matches)
- Total max: 600 tokens

## Matching Triggers

- Complexity assessment → load analysis/heuristics.md decomposition patterns
- Risk analysis → search "risk" in analysis/heuristics.md
- Pattern recognition → load analysis/heuristics.md pattern-related sections
- Domain-specific context → search domain tag in analysis/domain-snippets/

**Efficiency Note:** INDEX provides pattern awareness without full file load. Deep lookup only when relevant pattern detected.
