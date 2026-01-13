# Context Integration

## Instructions

1. Load all available context: research findings, analysis results, workflow state, previous agent outputs
2. Identify the synthesis goal and success criteria from task context
3. Note any domain-specific quality standards or constraints

## Context Sources

- `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
- Research agent outputs (findings, patterns)
- Analysis agent outputs (decomposition, risks, dependencies)
- User requirements and constraints

## Goal Identification

Document:
- Primary synthesis objective
- Success criteria
- Quality standards
- Constraints and boundaries

## Completion Criteria

- [ ] All predecessor context loaded
- [ ] Synthesis goal clearly identified
- [ ] Success criteria documented
- [ ] Ready for strategy development
