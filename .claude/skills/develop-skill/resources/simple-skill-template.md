---
name: [skill-name]
description: [Brief description of what this skill accomplishes]
tags: [tag1, tag2, tag3]
---

# [skill-name]

**Description:** [Brief description]

**Status:** draft

**Complexity:** simple

## Overview

[Describe the skill's purpose, when to use it, and what it accomplishes. Simple skills typically involve a single cognitive function or a short sequential chain.]

## Usage

**When to use:**
- [Use case 1]
- [Use case 2]
- [Use case 3]

**Task Domain:** [technical | personal | creative | professional | recreational | hybrid]

## AGENT ORCHESTRATION

**Agent:** [agent-name] ([COGNITIVE_FUNCTION])

**Purpose:** [What this agent accomplishes in the workflow]

**Trigger:** [When this skill is invoked / what initiates this agent]

**Instructions:**
1. [Step 1 - What the agent should do]
2. [Step 2 - Specific tasks to perform]
3. [Step 3 - Analysis/generation/validation requirements]
4. [Step 4 - Domain-specific guidance if needed]
5. [Step 5 - Output requirements]

**Context Loading:** [WORKFLOW_ONLY | IMMEDIATE_PREDECESSORS | MULTIPLE_PREDECESSORS] (see `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md`)
**Predecessor:** [None (first agent) | previous-agent-name | agent-1, agent-2, agent-3]

**Additional Resources:**
- `${CAII_DIRECTORY}/.claude/[path]/[resource].md` [REQUIRED | OPTIONAL]
- `${CAII_DIRECTORY}/.claude/[path]/[resource].md` [REQUIRED | OPTIONAL]

**Protocol References:**
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` [ALWAYS]
- `${CAII_DIRECTORY}/.claude/docs/code-generation-reference.md` [IF technical code generation]

**Memory Output:**
- Write to: `${CAII_DIRECTORY}/.claude/memory/task-{id}-[agent-name]-memory.md`
- Format: Johari Window (open, hidden, blind, unknown)
- Token Limit: 1200 tokens for Johari section

**Output Format:**
```markdown
# [Output Title]

## [Section 1]
[Expected content structure]

## [Section 2]
[Expected content structure]

## [Section 3]
[Expected content structure]
```

## Success Criteria

- [Criterion 1 - What defines successful completion]
- [Criterion 2 - Quality standards to meet]
- [Criterion 3 - Output requirements]

## Related Documentation

- `${CAII_DIRECTORY}/.claude/docs/[relevant-reference].md` - [What it provides]
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/` - [What it defines]

## Notes

[Any additional implementation notes, edge cases, or special considerations]
