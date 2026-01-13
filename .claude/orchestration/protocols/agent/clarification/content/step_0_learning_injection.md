# Learning Injection

## Actions

1. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/clarification/heuristics.md` (~100-150 tokens)
2. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/clarification/checklists.md` (~50-100 tokens)
3. Scan INDEX for patterns matching current task domain/context
4. If pattern match found: Perform targeted grep for that specific section in full learnings file
5. Apply loaded heuristics/checklists to current clarification task

## Token Budget

- INDEX loading: 200-400 tokens (always loaded)
- Deep lookup: 0-200 tokens (conditional, only if pattern matches)
- Total max: 600 tokens

## Matching Triggers

- Technical domain + security → search "security" in clarification/heuristics.md
- Requirements gathering → load clarification/checklists.md relevant sections
- Domain-specific context → search domain tag in clarification/domain-snippets/

**Efficiency Note:** INDEX provides pattern awareness without full file load. Deep lookup only when relevant pattern detected.
