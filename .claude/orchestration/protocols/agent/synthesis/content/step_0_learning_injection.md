# Learning Injection

## Instructions

1. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/synthesis/heuristics.md` (~100-150 tokens)
2. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/synthesis/anti-patterns.md` (~50-100 tokens)
3. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/synthesis/checklists.md` (~50-100 tokens)
4. Scan INDEX for patterns matching current task domain/context
5. If pattern match found: Perform targeted grep for that specific section in full learnings file
6. Apply loaded heuristics/anti-patterns/checklists to current synthesis task

## Token Budget

- INDEX loading: 200-400 tokens (always loaded)
- Deep lookup: 0-200 tokens (conditional, only if pattern matches)
- Total max: 600 tokens

## Matching Triggers

- Integration task → load synthesis/heuristics.md integration patterns
- Contradiction resolution → search "contradiction" or "conflict" in synthesis/heuristics.md
- Framework design → load synthesis/heuristics.md framework-related sections
- Domain-specific context → search domain tag in synthesis/domain-snippets/
