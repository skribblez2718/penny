---
name: orchestrate-analysis
description: Atomic skill for analysis using analysis
semantic_trigger: complexity decomposition, risk assessment
not_for: simple tasks without dependencies
tags: atomic-skill, analysis, complexity, risk
type: atomic
---

# orchestrate-analysis

**Type:** Atomic Skill
**Purpose:** Decompose complex problems, assess complexity, and identify risks and dependencies

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| memory_file | string | Path to analysis output (`.claude/memory/task-{id}-analysis-memory.md`) |

## Exit Criteria

- [ ] Problem decomposed into components
- [ ] Complexity scored and justified
- [ ] Risks identified with severity
- [ ] Dependencies mapped
- [ ] Memory file written in standard format

---

## Agent Invocation Format

**CRITICAL:** When invoking the analysis agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-analysis`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `analysis`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas for analysis:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1: What aspects to decompose]
- [Focus area 2: What risks to assess]
- [Focus area 3: What dependencies to map]
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
[Areas requiring investigation]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific analysis instructions: what to decompose, assess, and map]
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

```markdown
## Related Research Terms

- [Relevant analysis terminology]
- [Risk categories to consider]
- [Dependency patterns]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-analysis-memory.md`
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
