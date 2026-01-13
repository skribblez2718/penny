# Unknown Registry Management

## Purpose

Track and manage unknowns across cognitive agent execution to ensure systematic resolution.

## Unknown Categories

### Technical Group
- Research, Implementation, Architecture, Requirements, Risk, Scope, Source
- Interpretation, Validation, Depth, Technical, Security, Integration
- Performance, Environment

### Domain-Specific
- **Personal:** Personal preference, values, constraints
- **Creative:** Artistic direction, style, audience
- **Professional:** Business context, stakeholders, objectives
- **Recreational:** Fun factors, participant preferences
- **Ethical:** Moral considerations, impact assessment
- **Resource:** Time, budget, availability constraints
- **Quality:** Standards, expectations, success metrics

## Resolution Strategy by Cognitive Agent

| Category | Resolving Agent |
|----------|-----------------|
| Scope, Requirements, Personal, Creative, Quality | CLARIFICATION |
| Source, Research, Professional, Environment | RESEARCH |
| Technical, Risk, Integration, Performance, Resource | ANALYSIS |
| Architecture, Interpretation, Ethical | SYNTHESIS |
| Implementation, Creative | GENERATION |
| Validation, Depth, Security, Quality | VALIDATION |

## Unknown Entry Format

```json
{
  "id": "U{N}",
  "type": "CATEGORY",
  "description": "Specific unknown description",
  "priority": "HIGH | MEDIUM | LOW",
  "resolution_phase": "Phase where this should be resolved",
  "resolution_agent": "Agent responsible for resolution",
  "discovery_agent": "Agent that discovered this unknown",
  "discovery_phase": "Phase where discovered"
}
```

## Context Request Mechanism

If agent needs additional context not in scope:
- Add to unknown registry with:
  - **id:** U{N}
  - **type:** CONTEXT_REQUEST
  - **description:** Need {specific_file} to complete {task}
  - **priority:** HIGH
  - **resolution:** Add {file} to context scope and re-invoke

## Registry Updates

Agents MUST include unknown registry updates in downstream directives:

```json
{
  "unknownRegistryUpdates": {
    "added": [
      {"id": "U1", "type": "Technical", "description": "..."}
    ],
    "resolved": ["U0"],
    "escalated": []
  }
}
```
