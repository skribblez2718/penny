# Learning Injection

## Instructions

1. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/metacognition/heuristics.md` (~100-150 tokens)
2. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/metacognition/anti-patterns.md` (~50-100 tokens)
3. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/metacognition/checklists.md` (~50-100 tokens)
4. Scan INDEX for patterns matching current impasse context
5. If pattern match found: Perform targeted grep for that specific section
6. Apply loaded heuristics/anti-patterns/checklists to current assessment

## Token Budget

- INDEX loading: 200-400 tokens (always loaded)
- Deep lookup: 0-200 tokens (conditional, only if pattern matches)
- Total max: 600 tokens

## Matching Triggers

- Impasse detection → load metacognition/heuristics.md impasse patterns
- Stall indicators → search "stall" or "loop" in anti-patterns.md
- Remediation selection → load metacognition/heuristics.md remediation patterns
- Agent-specific context → search agent name in domain-snippets/

**Efficiency Note:** INDEX provides pattern awareness without full file load. Deep lookup only when relevant pattern detected.
