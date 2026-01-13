---
name: orchestrate-clarification
description: Atomic skill for clarification using clarification agent
semantic_trigger: ambiguity resolution, requirements refinement
not_for: well-defined tasks with clear specifications
tags: atomic-skill, clarification, requirements
type: atomic
---

# orchestrate-clarification

**Type:** Atomic Skill
**Purpose:** Transform vague inputs into actionable specifications through systematic questioning

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| memory_file | string | Path to clarification output (`.claude/memory/task-{id}-clarification-memory.md`) |

## Exit Criteria

- [ ] Ambiguities resolved or explicitly documented as unknowns
- [ ] Requirements transformed to explicit specifications
- [ ] Success criteria defined and measurable
- [ ] Memory file written in standard format

---

## Agent Invocation Format

**CRITICAL:** When invoking the clarification agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-clarification`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `clarification`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas for clarification:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1: What ambiguities to resolve]
- [Focus area 2: What requirements to clarify]
- [Focus area 3: What success criteria to define]
- [Additional focus areas as needed]

> This section dynamically extends your base cognitive function for this specific task.
```

#### 3. Johari Context (REQUIRED if available)

```markdown
## Prior Knowledge (Johari Window)

### Open (Confirmed)
[Known facts from reasoning protocol]

### Blind (Gaps)
[Identified unknowns to clarify]

### Hidden (Inferred)
[Assumptions that need validation]

### Unknown (To Explore)
[Questions to ask]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific clarification instructions: what to clarify, what questions to answer]
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

```markdown
## Related Research Terms

- [Relevant domain terminology]
- [Concepts requiring clarification]
- [Potential alternative interpretations]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-clarification-memory.md`
```

### Template Reference

For full template documentation, see:
`${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md`

---

## References

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Memory output format
- `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md` - Context loading patterns
- `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` - Quick reference checklist
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/agent-invocation-template.md` - Invocation patterns
