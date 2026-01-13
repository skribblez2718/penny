# Output Generation

## Johari Framework Application

### OPEN (Known-Known): The Integrated Design

Present the complete synthesized artifact:
- Component definitions and boundaries
- Interface specifications and contracts
- Integration patterns and relationships
- Design diagrams in text/markdown format

### HIDDEN (Known-Unknown): Design Decisions

Document every significant choice:
- Alternatives considered and why rejected
- Assumptions underlying the design
- Constraints that shaped decisions
- Decision matrices with criteria

### BLIND (Unknown-Known): Integration Challenges

Acknowledge limitations encountered:
- Unresolved tensions or partial conflicts
- Areas where perfect integration wasn't achievable
- Technical or practical limitations
- Compromises made and their implications

### UNKNOWN (Unknown-Unknown): Validation Needs

Identify areas needing further work:
- Aspects requiring testing or validation
- External dependencies needing verification
- Assumptions requiring future confirmation
- Evolution and extension considerations

## Memory File Update

Write synthesis results to task memory:
- Path: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
- Append synthesis section with:
  - Integrated design
  - Component definitions
  - Interface specifications
  - Decision log
  - Downstream directive

## Completion Criteria

- [ ] Design documented by Johari quadrant
- [ ] All decisions have rationale
- [ ] Validation needs identified
- [ ] Memory file updated
- [ ] Token budget respected (≤5,000)
- [ ] Ready for handoff
