# Pattern: MULTIPLE_PREDECESSORS

## Use Case

Agent needing context from multiple sources (synthesis, validation, or agents resolving complex dependencies).

## Description

Agent loads workflow metadata, one required immediate predecessor, and additional optional predecessor outputs for reference.

## Context References

- `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS_REQUIRED]
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-{predecessor-1}-memory.md` [IMMEDIATE_PREDECESSOR_REQUIRED]
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-{predecessor-2}-memory.md` ({context note}) [OPTIONAL]
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-{predecessor-3}-memory.md` ({context note}) [OPTIONAL]

## Context Scope

IMMEDIATE_PREDECESSORS + OPTIONAL_REFERENCES

## Token Budget

3,000-4,000 tokens
- Workflow metadata: ~500 tokens
- Immediate predecessor: ~2,000-2,500 tokens
- Optional references: ~500-1,000 tokens (specific sections only)

## Usage in Skills

```markdown
**Context Loading:** MULTIPLE_PREDECESSORS
**Predecessor (required):** research
**Optional References:**
- synthesis (Phase 1 decisions context)
- analysis (requirements for alignment check)
```

## Expanded File Paths

- `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md`
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-research-memory.md`
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-synthesis-memory.md` (optional)
- `${CAII_DIRECTORY}/.claude/memory/task-{id}-analysis-memory.md` (optional)

## Compliance Requirements

- Agent MUST read workflow metadata file
- Agent MUST read 1+ required predecessor files
- Agent MAY read optional predecessor files for reference
- Agent's "Context Loaded" section MUST show:
  - `workflow_metadata_loaded: true`
  - `predecessors_loaded: [1+ items with required field]`
  - `context_loading_pattern_used: "MULTIPLE_PREDECESSORS"`

## Verification

```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [
    {
      "agent_name": "research",
      "file_path": "${CAII_DIRECTORY}/.claude/memory/task-{id}-research-memory.md",
      "tokens_consumed": 1200,
      "required": true
    },
    {
      "agent_name": "clarification",
      "file_path": "${CAII_DIRECTORY}/.claude/memory/task-{id}-clarification-memory.md",
      "tokens_consumed": 800,
      "required": false
    }
  ],
  "total_context_tokens": 2500-3500
}
```

## Fail Conditions

- `predecessors_loaded` array is empty
- No predecessor has `required: true`
- `workflow_metadata_loaded` is false
- `total_context_tokens` > 4000 (exceeded hard limit)
