# Learning Injection

## Instructions

1. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/generation/heuristics.md`
2. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/generation/anti-patterns.md`
3. Load INDEX section from `${CAII_DIRECTORY}/.claude/learnings/generation/checklists.md`
4. Scan INDEX for patterns matching current task domain/context
5. If pattern match found: Deep lookup that section
6. Apply loaded heuristics/anti-patterns/checklists

## Matching Triggers

- Code generation → load code-related patterns
- Security-sensitive code → search "security" patterns
- Specific tech stack → search technology name
- TDD approach → load test-related sections
