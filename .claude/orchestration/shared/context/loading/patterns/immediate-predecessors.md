# Pattern: IMMEDIATE_PREDECESSORS

## Use Case

Standard agent following another agent (most common pattern - ~80% of agents).

## Description

Agent loads workflow metadata plus the immediately preceding agent's output. This is the default pattern for sequential agent workflows.

## Context References

- `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS_REQUIRED]
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-{predecessor}-memory.md` [IMMEDIATE_PREDECESSOR_REQUIRED]

## Context Scope

IMMEDIATE_PREDECESSORS

## Token Budget

2,500-3,000 tokens
- Workflow metadata: ~500 tokens
- Predecessor output: ~2,000-2,500 tokens

## Usage in Skills

```markdown
**Context Loading:** IMMEDIATE_PREDECESSORS
**Predecessor:** clarification
```

## Expanded File Paths

- `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md`
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-clarification-memory.md`

## Compliance Requirements

- Agent MUST read workflow metadata file
- Agent MUST read EXACTLY ONE immediate predecessor file
- Agent MUST NOT read other predecessor files
- Agent's "Context Loaded" section MUST show:
  - `workflow_metadata_loaded: true`
  - `predecessors_loaded: [exactly 1 item]`
  - `context_loading_pattern_used: "IMMEDIATE_PREDECESSORS"`

## Verification

```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [
    {
      "agent_name": "clarification",
      "file_path": "${CAII_DIRECTORY}/.claude/memory/task-{id}-clarification-memory.md",
      "tokens_consumed": 1200,
      "required": true
    }
  ],
  "total_context_tokens": 1500-2000
}
```

## Fail Conditions

- `predecessors_loaded` array length ≠ 1
- `workflow_metadata_loaded` is false
- `total_context_tokens` < 1000 (likely skipped predecessor)
- `total_context_tokens` > 3000 (likely read extra predecessors)
- Agent listed wrong predecessor
