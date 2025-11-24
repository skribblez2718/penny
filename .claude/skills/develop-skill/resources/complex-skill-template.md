---
name: [skill-name]
description: [comprehensive description]
tags: [relevant, tags, here]
---

# [SKILL NAME]

## Overview

[Comprehensive description of the skill's purpose and capabilities]

## Architecture

### Workflow Diagram

```
[ASCII or text-based workflow diagram showing orchestration flow]
```

## Agent Orchestration

### Agent 1: [NAME]

**Purpose:** [Detailed purpose - WHAT this agent accomplishes in the workflow]

**Trigger:** [What initiates this agent]

**Instructions:**

[Detailed agent instructions defining WHAT tasks to perform, not HOW to perform them]

**Output Format:**

[Expected output structure]

**Handoff Protocol:**

[How to pass control to next agent]

### Agent 2: [NAME]

[Repeat structure for all agents]

## State Management

### Persistent State

```json
{
  "workflow_id": "[unique_id]",
  "current_phase": "[phase_name]",
  "collected_data": {},
  "decisions_made": [],
  "agents_completed": []
}
```

### State Transitions

[Define how state changes between agents]

## Decision Trees

### Decision Point 1: [NAME]

```
IF [condition]
  THEN → Agent [X]
ELSE IF [condition]
  THEN → Agent [Y]
ELSE
  THEN → Agent [Z]
```

## Error Handling

### Error Recovery Matrix

| Error Type | Detection | Recovery Strategy | Fallback |
|-----------|-----------|------------------|----------|
| [Type 1] | [Method] | [Strategy] | [Action] |
| [Type 2] | [Method] | [Strategy] | [Action] |

## Usage Examples

### Scenario 1: [COMMON USE CASE]

**User:** [Request]

**Penny:** Initiating complex skill [name]

**Agent 1:** [Action]

**Agent 2:** [Action]

**Result:** [Outcome]

### Scenario 2: [EDGE CASE]

[Example with error handling]

## Performance Considerations

- Expected execution time: [estimate]
- Context window usage: [percentage per agent]
- Optimal agent parallelization opportunities

## Dependencies

### Required Skills

- **[Skill 1]:** [Why needed]
- **[Skill 2]:** [Why needed]

### Required Resources

- **[Resource 1]:** [Purpose]
- **[Resource 2]:** [Purpose]

## Testing Protocol

1. **[Test case 1]:** [Expected behavior]
2. **[Test case 2]:** [Expected behavior]
3. **[Edge case test]:** [Expected behavior]

## Maintenance Notes

[Guidelines for updating this skill]
