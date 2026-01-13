# Context Loading

## Instructions

1. Parse task-id and load all available context
2. Review research findings from previous agents
3. Understand workflow state and what comes next
4. Identify the domain and adapt your analytical lens accordingly

## Context Sources

Load from `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`:
- Original request/requirement
- Previous agent outputs (clarification, research)
- Johari summaries from predecessors
- Unknown registry entries

## Domain Identification

| Domain | Key Indicators | Analytical Focus |
|--------|----------------|------------------|
| Technical | Code, systems, architecture | Dependencies, complexity, risks |
| Personal | Decisions, goals, life choices | Trade-offs, impacts, factors |
| Creative | Content, art, design | Structure, patterns, impact |
| Professional | Business, career, strategy | Dynamics, positioning, alignment |
| Entertainment | Games, activities, experiences | Mechanics, enjoyment, accessibility |

## State Assessment

Document:
- Current workflow position
- What analysis is expected to deliver
- Who consumes the analysis output (synthesis typically)
- Critical constraints or priorities

## Completion Criteria

- [ ] Task context fully loaded
- [ ] Research findings reviewed
- [ ] Domain identified and lens selected
- [ ] Workflow position understood
- [ ] Ready to select analysis framework
