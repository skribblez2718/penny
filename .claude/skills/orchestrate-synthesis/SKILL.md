---
name: orchestrate-synthesis
description: Atomic skill for synthesis using synthesis
semantic_trigger: integration of findings, design creation
not_for: single-source tasks without integration
tags: atomic-skill, synthesis, integration, design
type: atomic
---

# orchestrate-synthesis

**Type:** Atomic Skill
**Purpose:** Integrate disparate findings into coherent recommendations and produce unified deliverables

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| memory_file | string | Path to synthesis output (`.claude/memory/task-{id}-synthesis-memory.md`) |

## Exit Criteria

- [ ] Multiple inputs integrated into unified output
- [ ] Contradictions identified and resolved
- [ ] Coherent recommendations documented
- [ ] Design/architecture defined (if applicable)
- [ ] Memory file written in standard format

---

## Agent Invocation Format

**CRITICAL:** When invoking the synthesis agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-synthesis`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `synthesis`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas for synthesis:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1: What inputs to integrate]
- [Focus area 2: What contradictions to resolve]
- [Focus area 3: What recommendations to produce]
- [Additional focus areas as needed]

> This section dynamically extends your base cognitive function for this specific task.
```

#### 3. Johari Context (REQUIRED if available)

```markdown
## Prior Knowledge (Johari Window)

### Open (Confirmed)
[Known facts from reasoning protocol]

### Blind (Gaps)
[Identified unknowns]

### Hidden (Inferred)
[Assumptions made]

### Unknown (To Explore)
[Areas requiring integration]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific synthesis instructions: what to integrate, what deliverable to produce]
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

```markdown
## Related Research Terms

- [Integration patterns]
- [Design approaches]
- [Relevant frameworks]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-synthesis-memory.md`
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
