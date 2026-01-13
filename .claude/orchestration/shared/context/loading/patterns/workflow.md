# Pattern: WORKFLOW_ONLY

## Use Case

First agent in workflow with no predecessor agents.

## Description

Agent loads only the workflow metadata file. Used for initial agents like clarification when starting from scratch.

## Context References

- `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS_REQUIRED]

## Context Scope

WORKFLOW_ONLY

## Token Budget

500-1,000 tokens

## Usage in Skills

```markdown
**Context Loading:** WORKFLOW_ONLY
**Predecessor:** None (first agent)
```

## Compliance Requirements

- Agent MUST read workflow metadata file
- Agent MUST NOT read any predecessor files
- Agent's "Context Loaded" section MUST show:
  - `workflow_metadata_loaded: true`
  - `predecessors_loaded: []` (empty array)
  - `context_loading_pattern_used: "WORKFLOW_ONLY"`

## Verification

```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [],
  "total_context_tokens": 400-600
}
```

## Fail Conditions

- `predecessors_loaded` array is NOT empty
- `workflow_metadata_loaded` is false
- `total_context_tokens` > 1000
