---
name: [skill-name]
description: [Comprehensive description of what this skill accomplishes]
tags: [tag1, tag2, tag3]
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

**Context Loading:** WORKFLOW_ONLY (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** None (first agent)

**Additional Resources:**
- `.claude/[path]/[resource].md` [REQUIRED | OPTIONAL]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-[agent-name]-memory.md`
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

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** [previous-agent-name]

**Additional Resources:**
- `.claude/[path]/[resource].md` [REQUIRED | OPTIONAL]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical code generation]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-[agent-name]-memory.md`
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

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** [agent-1], [agent-2], [agent-3]

**Additional Resources:**
- `.claude/[path]/[resource].md` [REQUIRED | OPTIONAL]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical code generation]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-[agent-name]-memory.md`
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

- `.claude/references/[relevant-reference].md` - [What it provides]
- `.claude/protocols/[relevant-protocol].md` - [What it defines]
- `.claude/skills/[related-skill]/SKILL.md` - [How it relates]

## Notes

[Any additional implementation notes, edge cases, or special considerations for complex workflows]

## Validation Checklist

Before considering skill complete, verify:

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
