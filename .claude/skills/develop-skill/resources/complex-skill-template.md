---
name: [skill-name]
description: [Comprehensive description of what this skill accomplishes]
tags: [tag1, tag2, tag3]
type: composite
composition_depth: 0  # 0=base (atomics only), 1=uses composites
uses_composites: []   # list of composite skill names if depth=1
---

# [skill-name]

**Description:** [Comprehensive description]

**Status:** draft

**Complexity:** complex

## Overview

[Describe the skill's purpose, when to use it, and what it accomplishes. Complex skills involve multiple phases with distinct cognitive functions and gate criteria between phases.]

## Key Features

- [Feature 1 - Major capability]
- [Feature 2 - Major capability]
- [Feature 3 - Major capability]

## Usage

**When to use:**
- [Use case 1]
- [Use case 2]
- [Use case 3]

**Task Domain:** [technical | personal | creative | professional | recreational | hybrid]

## Workflow Overview

```
Phase 0: [PHASE NAME]
  ├─ Agent: [agent-name] ([COGNITIVE_FUNCTION])
  └─ Gate: [Exit criteria]
      ↓
Phase 1: [PHASE NAME]
  ├─ Agent: [agent-name] ([COGNITIVE_FUNCTION])
  └─ Gate: [Exit criteria]
      ↓
Phase 2: [PHASE NAME]
  ├─ Agent: [agent-name] ([COGNITIVE_FUNCTION])
  ├─ Agent: [agent-name] ([COGNITIVE_FUNCTION])
  └─ Gate: [Exit criteria]
      ↓
Phase N: [PHASE NAME] (if using composite skill)
  ├─ Composite: [skill-name]
  ├─ Mode: embedded|delegated
  └─ Gate: [Exit criteria]
      ↓
[Continue for all phases...]
```

---

## AGENT ORCHESTRATION

### PHASE 0: [PHASE NAME]

**Agent:** [agent-name] ([COGNITIVE_FUNCTION])

**Purpose:** [What this phase accomplishes in the overall workflow]

**Trigger:** [When this skill is invoked / what initiates this phase]

**Instructions:**
1. [Step 1 - What the agent should do]
2. [Step 2 - Specific tasks to perform]
3. [Step 3 - Analysis/generation/validation requirements]
4. [Step 4 - Domain-specific guidance if needed]
5. [Step 5 - Output requirements]

**Context Loading:** WORKFLOW_ONLY (see `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md`)
**Predecessor:** None (first agent)

**Additional Resources:**
- `${CAII_DIRECTORY}/.claude/[path]/[resource].md` [REQUIRED | OPTIONAL]

**Protocol References:**
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` [ALWAYS]

**Memory Output:**
- Write to: `${CAII_DIRECTORY}/.claude/memory/task-{id}-[agent-name]-memory.md`
- Format: Johari Window (open, hidden, blind, unknown)
- Token Limit: 1200 tokens for Johari section

**Output Format:**
```markdown
# [Output Title]

## [Section 1]
[Expected content structure]
```

**Gate Exit Criteria:**
- [Criterion 1 - Must be met to proceed]
- [Criterion 2 - Quality standard required]
- [Criterion 3 - Blocking issues identified]

---

### PHASE 1: [PHASE NAME]

**Agent:** [agent-name] ([COGNITIVE_FUNCTION])

**Purpose:** [What this phase accomplishes]

**Trigger:** Phase 0 gate passed

**Instructions:**
1. [Phase-specific instructions]
2. [What to research/analyze/synthesize]
3. [How to use predecessor context]
4. [What decisions to make]
5. [Output requirements]

**Context Loading:** IMMEDIATE_PREDECESSORS (see `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md`)
**Predecessor:** [previous-agent-name]

**Additional Resources:**
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
```

**Gate Exit Criteria:**
- [Criterion 1]
- [Criterion 2]
- [Criterion 3]

---

### PHASE 2: [PHASE NAME]

**Agent:** [agent-name] ([COGNITIVE_FUNCTION])

**Purpose:** [What this phase accomplishes]

**Trigger:** Phase 1 gate passed

**Instructions:**
1. [Phase-specific instructions]
2. [Synthesis/integration requirements]
3. [How to combine multiple predecessor outputs]
4. [What to generate/validate]
5. [Output requirements]

**Context Loading:** MULTIPLE_PREDECESSORS (see `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md`)
**Predecessors:** [agent-1], [agent-2], [agent-3]

**Additional Resources:**
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
```

**Gate Exit Criteria:**
- [Criterion 1]
- [Criterion 2]
- [Criterion 3]

---

[Continue with additional phases...]

---

## COMPOSITE SKILL ORCHESTRATION (Optional)

> Include this section only if the skill invokes other composite skills (composition_depth: 1).
> A phase uses EITHER atomic skills OR composite skills, not both.
> All referenced composite skills MUST have composition_depth: 0.
> Reference: `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/composite-skill-reference.md`

### PHASE [N]: [PHASE NAME]

**Uses Composite Skill:** `{composite-skill-name}`

**Purpose:** [What this composite skill accomplishes in the overall workflow]

**Trigger:** [When to invoke this composite skill / prerequisite conditions]

**Configuration:**
- {param1}: {value}  # Match the child skill's documented interface
- {param2}: {value}
- {param3}:          # Nested configuration if needed
    sub_key1: value
    sub_key2: value

**Sub-workflow Mode:** {embedded | delegated}
- embedded: Child runs in parent context, shares memory files
- delegated: Child runs independently, returns summary to parent

**Context Passthrough:**
- task_id: {inherit | new}           # Whether child uses parent's task-id
- workflow_memory: {merge | isolated}  # How outputs are combined

**Gate Entry Criteria:**
- [Prerequisite 1 - from previous phase]
- [Prerequisite 2 - required inputs available]

**Gate Exit Criteria:**
- [Criterion 1 - what composite must produce]
- [Criterion 2 - quality standard for output]
- [Criterion 3 - state after completion]

---

[Continue with additional composite skill phases as needed...]

---

## Quality Standards

**Domain-Specific Standards:**
- [Standard 1 - For technical domain]
- [Standard 2 - For personal domain]
- [Standard 3 - General standards]

**Success Metrics:**
- [Metric 1 - Measurable outcome]
- [Metric 2 - Quality indicator]
- [Metric 3 - Completion criteria]

## Error Handling

**Common Issues:**
- **[Issue 1]:** [How to detect and handle]
- **[Issue 2]:** [How to detect and handle]
- **[Issue 3]:** [How to detect and handle]

**Recovery Strategies:**
- If Phase X fails → [Fallback action]
- If Agent Y blocks → [Resolution path]
- If validation fails → [Remediation loop]

## Related Documentation

- `${CAII_DIRECTORY}/.claude/docs/[relevant-reference].md` - [What it provides]
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/` - [What it defines]
- `${CAII_DIRECTORY}/.claude/skills/[related-skill]/SKILL.md` - [How it relates]

## Notes

[Any additional implementation notes, edge cases, or special considerations for complex workflows]

## Validation Checklist

Before considering skill complete, verify:

### Core Requirements

- [ ] Defines cognitive sequences (which agents, what order)
- [ ] All sequences are sequential (no parallel agent calls)
- [ ] Includes domain classification approach
- [ ] Specifies context loading pattern for each agent
- [ ] References documentation instead of duplicating
- [ ] Zero implementation details (100% orchestration)
- [ ] Gate criteria defined for each phase
- [ ] Memory output specified for each agent
- [ ] Follows zero redundancy principle
- [ ] Protocol references included for each agent

### Composition Requirements (if using composite skills)

- [ ] `composition_depth` correctly set in frontmatter (1 if composites used)
- [ ] `uses_composites` list matches actual composite references
- [ ] All referenced composite skills have `composition_depth: 0`
- [ ] Configuration parameters match child skill interfaces
- [ ] Sub-workflow mode specified for each composite reference
- [ ] Context passthrough strategy defined (task_id, workflow_memory)
- [ ] No circular references in skill dependency graph
- [ ] Each phase uses EITHER atomic OR composite skills, not both
