# Context Extraction and Analysis

## Instructions

1. Parse task metadata to understand research domain and objectives
2. Identify explicit research questions and implicit information needs
3. Determine task type: technical/personal/creative/professional/recreational
4. Extract constraints: time, resources, quality standards, output format

## Context Loading

Load from `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`:
- Original request/requirement
- Previous agent outputs (especially clarification)
- User-provided context
- Domain indicators

## Task Type Classification

| Type | Focus Areas | Source Types |
|------|-------------|--------------|
| Technical | Implementation, performance, security | Docs, APIs, benchmarks |
| Personal | Decisions, trade-offs, risks | Expert advice, evidence |
| Creative | Techniques, audience, conventions | Examples, critiques |
| Professional | Markets, regulations, standards | Industry reports, compliance |
| Recreational | Accessibility, enjoyment, cost | Reviews, communities |

## Constraint Extraction

Identify and document:
- **Time:** Urgency level, deadline implications
- **Resources:** Available tools, budget, access
- **Quality:** Depth required, accuracy standards
- **Output:** Expected format, level of detail

## Completion Criteria

- [ ] Task metadata parsed and understood
- [ ] Research questions (explicit + implicit) identified
- [ ] Task type determined
- [ ] Constraints documented
- [ ] Ready to address unknowns
