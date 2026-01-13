---
name: orchestrate-memory
description: Atomic skill for metacognitive assessment using memory agent
semantic_trigger: progress tracking, impasse detection
not_for: simple linear workflows
tags: atomic-skill, metacognition, impasse-detection, remediation
type: atomic
---

# orchestrate-memory

**Type:** Atomic Skill
**Purpose:** Perform metacognitive assessment to detect impasses and recommend remediation strategies

## Important Note

**This skill is typically invoked AUTOMATICALLY** by the orchestration layer after agent completions and at phase transitions. However, it can also be explicitly invoked when the orchestrator determines additional metacognitive assessment is beneficial - such as after completing complex tasks or when progress appears stalled.

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier to assess |
| context | string | no | Additional context about what triggered the assessment |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| memory_file | string | Path to assessment output (`.claude/memory/task-{id}-memory-memory.md`) |
| impasse_detected | boolean | Whether an impasse was detected |
| impasse_type | string | Type of impasse if detected (CONFLICT, MISSING-KNOWLEDGE, TIE, NO-CHANGE) |
| action | string | Recommended action (continue, re-invoke, escalate, abort) |

## Impasse Types (from Soar Cognitive Architecture)

| Type | Description | Primary Remediation |
|------|-------------|---------------------|
| CONFLICT | Contradictory requirements | Invoke orchestrate-clarification |
| MISSING-KNOWLEDGE | Required information absent | Invoke orchestrate-research |
| TIE | Multiple valid options, no selection criteria | Invoke orchestrate-analysis |
| NO-CHANGE | Output shows no meaningful progress | Re-invoke same agent with enhanced context |

## Exit Criteria

- [ ] Goal state reconstructed
- [ ] Progress assessed against expected outcomes
- [ ] Impasse detection complete with confidence score
- [ ] Remediation recommendation provided if impasse detected
- [ ] Memory file written in standard format

---

## Agent Invocation Format

**CRITICAL:** When invoking the memory agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-memory`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `memory`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas for metacognitive assessment:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1: What workflow state to assess]
- [Focus area 2: What progress indicators to check]
- [Focus area 3: What impasses to detect]
- [Additional focus areas as needed]

> This section dynamically extends your base cognitive function for this specific task.
```

#### 3. Johari Context (REQUIRED if available)

```markdown
## Prior Knowledge (Johari Window)

### Open (Confirmed)
[Known workflow state]

### Blind (Gaps)
[Areas of uncertainty in workflow]

### Hidden (Inferred)
[Progress assumptions]

### Unknown (To Explore)
[Potential impasse indicators]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific metacognitive assessment instructions: what to assess, what triggers to check]

Context: {additional context about what triggered the assessment}
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

```markdown
## Related Research Terms

- [Metacognition terminology]
- [Impasse detection patterns]
- [Remediation strategies]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-memory-memory.md`

**Note:** Maximum output 800 tokens (STRICT)
```

### Template Reference

For full template documentation, see:
`${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md`

---

## Token Constraints

**Maximum Output:** 800 tokens (STRICT)

The memory agent is designed for concise, actionable output. Prioritize essential information over verbose explanations.

## When This Skill is Auto-Invoked

1. **After Agent Completion:** When any cognitive agent finishes, the orchestration layer invokes metacognitive assessment
2. **At Phase Transitions:** When advancing from one workflow phase to another
3. **On Stall Detection:** When progress indicators suggest workflow stagnation

## Manual Invocation

The orchestrator can explicitly invoke when metacognitive assessment would be beneficial:

```
/orchestrate-memory --task-id {task-id}
```

**Use cases for explicit invocation:**
- After completing a complex multi-step task
- When uncertain about progress or next steps
- To assess what should be retained in working memory
- When deciding between alternative approaches

## References

- `${CAII_DIRECTORY}/.claude/agents/memory.md` - Full agent definition
- `${CAII_DIRECTORY}/.claude/orchestration/protocols/agent/memory/` - Protocol implementation
- `${CAII_DIRECTORY}/.claude/docs/cognitive-enhancements.md` - GoalMemory integration documentation
