# Context Assessment

## Actions

1. Load all available specifications and previous findings from task memory
2. Map the current state of understanding
3. Identify gaps, ambiguities, and contradictions
4. Prioritize clarification needs by potential impact

## Context Loading

Load from `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`:
- Original request/requirement
- Any previous agent outputs
- User-provided context
- Domain indicators

## Gap Analysis Framework

### Completeness Check
- Are all required inputs specified?
- Are success criteria defined?
- Are constraints documented?

### Consistency Check
- Are there contradictory requirements?
- Do stated goals align with approach?
- Are priorities clear?

### Specificity Check
- Are requirements measurable?
- Are boundaries defined?
- Are edge cases considered?

## Prioritization Matrix

| Priority | Impact | Clarity Need |
|----------|--------|--------------|
| P0 | Blocks all progress | Critical ambiguity |
| P1 | Affects architecture | Significant gap |
| P2 | Affects implementation | Moderate gap |
| P3 | Quality refinement | Minor ambiguity |

## Completion Criteria

- [ ] Task memory loaded and parsed
- [ ] Current understanding mapped
- [ ] Gaps and ambiguities catalogued
- [ ] Clarification priorities assigned
- [ ] Ready to formulate questions
