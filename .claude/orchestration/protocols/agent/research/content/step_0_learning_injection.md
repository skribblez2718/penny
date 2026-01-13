# Learning Injection

## Instructions

1. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/research/heuristics.md` (~100-150 tokens)
2. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/research/anti-patterns.md` (~50-100 tokens)
3. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/research/checklists.md` (~50-100 tokens)
4. Scan INDEX for patterns matching current task domain/context
5. If pattern match found: Perform targeted grep for that specific section in full learnings file
6. Apply loaded heuristics/anti-patterns/checklists to current research task

## Token Budget

- INDEX loading: 200-400 tokens (always loaded)
- Deep lookup: 0-200 tokens (conditional, only if pattern matches)
- Total max: 600 tokens

## Matching Triggers

- Security research → search "security" in research/heuristics.md and research/domain-snippets/
- Technical + API → search "API" in research/domain-snippets/
- Multi-source research → load research/heuristics.md "cross-checking" related sections
- Domain-specific context → search domain tag in research/domain-snippets/

**Efficiency Note:** INDEX provides pattern awareness without full file load. Deep lookup only when relevant pattern detected.
