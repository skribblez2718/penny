---
name: orchestrate-{function}
description: Atomic skill for {function} using {agent-name} agent
tags: atomic-skill, {function}, {additional-tags}
type: atomic
---

# orchestrate-{function}

**Type:** Atomic Skill
**Purpose:** {one-line description of what this atomic skill accomplishes}

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| memory_file | string | Path to output (`${CAII_DIRECTORY}/.claude/memory/task-{id}-{agent-name}-memory.md`) |

## Agent Sequence

### Step 1: {Function Name}

**Agent:** {agent-name}
**Cognitive Function:** {COGNITIVE_FUNCTION}

**Context Loading:** {WORKFLOW_ONLY | IMMEDIATE_PREDECESSORS | MULTIPLE_PREDECESSORS}
**Predecessors:** {None | previous-agent | agent-1, agent-2}

**Gate Entry:**
- {Entry condition 1}
- {Entry condition 2}

**Gate Exit:**
- {Exit criterion 1}
- {Exit criterion 2}
- {Exit criterion 3}

**Memory Output:** Standard format per `protocols/agent-protocol-core.md`
- Agent: {agent-name}
- Task: {task_id}

## Exit Criteria

- [ ] {Criterion 1}
- [ ] {Criterion 2}
- [ ] {Criterion 3}
- [ ] Memory file written in standard format

## References

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Memory output format
- `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md` - Context loading patterns
- `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` - Quick reference checklist
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/agent-invocation-template.md` - Invocation patterns
