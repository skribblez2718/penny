---
name: orchestrate-validation
description: Atomic skill for quality validation using validation agent
semantic_trigger: quality verification, acceptance testing
not_for: tasks without deliverables to verify
tags: atomic-skill, validation, quality
type: atomic
---

# orchestrate-validation

**Type:** Atomic Skill
**Purpose:** Systematically verify artifacts and deliverables against established criteria

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |
| validation_target | string | yes | Agent whose output to validate (e.g., "generation") |
| quality_criteria | list | no | Additional quality criteria beyond workflow standards |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| verdict | GO\|NO-GO\|CONDITIONAL | Validation verdict |
| memory_file | string | Path to validation output (`.claude/memory/task-{id}-validation-memory.md`) |

## Validation Scope

Quality-validator evaluates against:

1. **Workflow Standards:** From task-{id}-memory.md quality_standards
2. **Domain Standards:** Based on task_domain classification
3. **Custom Criteria:** From quality_criteria parameter if provided

## Verdict Definitions

| Verdict | Meaning | Action |
|---------|---------|--------|
| GO | All criteria pass | Proceed to next phase |
| NO-GO | Critical issues found | Return to generation for fixes |
| CONDITIONAL | Minor issues found | Proceed with documented caveats |

## Exit Criteria

- [ ] All quality criteria evaluated
- [ ] Issues categorized by severity (critical/major/minor)
- [ ] Verdict issued with justification
- [ ] Memory file written in standard format

---

## Agent Invocation Format

**CRITICAL:** When invoking the validation agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-validation`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `validation`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas for validation:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1: What criteria to validate against]
- [Focus area 2: What quality standards apply]
- [Focus area 3: What issues to look for]
- [Additional focus areas as needed]

> This section dynamically extends your base cognitive function for this specific task.
```

#### 3. Johari Context (REQUIRED if available)

```markdown
## Prior Knowledge (Johari Window)

### Open (Confirmed)
[Known requirements and criteria]

### Blind (Gaps)
[Validation areas needing attention]

### Hidden (Inferred)
[Quality assumptions]

### Unknown (To Explore)
[Edge cases to test]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific validation instructions: what to validate, against what criteria]

Validation target: {agent whose output to validate}
Quality criteria: {additional criteria if provided}
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

```markdown
## Related Research Terms

- [Relevant quality standards]
- [Validation methodologies]
- [Domain-specific requirements]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-validation-memory.md`
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
