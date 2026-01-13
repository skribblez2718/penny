---
name: orchestrate-generation
description: Atomic skill for generation using generation
semantic_trigger: artifact creation, TDD implementation
not_for: read-only or research tasks
tags: atomic-skill, generation, code, tdd
type: atomic
---

# orchestrate-generation

**Type:** Atomic Skill
**Purpose:** Generate code artifacts and deliverables using Test-Driven Development methodology

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |
| implementation_scope | string | yes | What to implement (from synthesis/design output) |
| iteration | integer | no | Current TDD iteration (default: 1) |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| tests_passing | boolean | Whether all tests pass |
| memory_file | string | Path to generation output (`.claude/memory/task-{id}-generation-memory.md`) |

## TDD Cycle Requirements

### RED Phase
- Write failing tests first
- Tests define expected behavior
- Tests are specific and isolated

### GREEN Phase
- Write minimal code to pass tests
- No optimization during this phase
- Focus on correctness only

### REFACTOR Phase
- Improve code structure
- Maintain test passage
- Apply domain-specific patterns

## Code Generation Standards

Generation-agent MUST apply:

1. **Domain Patterns:** From task_domain (technical -> SOLID, security patterns)
2. **Quality Standards:** From workflow quality_standards
3. **TDD Discipline:** Strict RED-GREEN-REFACTOR cycle
4. **Security First:** OWASP compliance for web, input validation

## Iteration Support

For complex implementations requiring multiple TDD cycles:

```
iteration: 1  -> Core functionality
iteration: 2  -> Edge cases
iteration: 3  -> Error handling
iteration: N  -> Polish/optimization
```

Each iteration follows full RED-GREEN-REFACTOR cycle.

## Exit Criteria

- [ ] Tests written before implementation
- [ ] All tests passing
- [ ] Code refactored for maintainability
- [ ] Memory file written in standard format
- [ ] Artifacts documented in downstream_directives

---

## Agent Invocation Format

**CRITICAL:** When invoking the generation agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-generation`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `generation`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas for generation:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1: What to generate]
- [Focus area 2: What patterns to apply]
- [Focus area 3: What quality standards to follow]
- [Additional focus areas as needed]

> This section dynamically extends your base cognitive function for this specific task.
```

#### 3. Johari Context (REQUIRED if available)

```markdown
## Prior Knowledge (Johari Window)

### Open (Confirmed)
[Known specifications from synthesis]

### Blind (Gaps)
[Implementation details to determine]

### Hidden (Inferred)
[Architectural assumptions]

### Unknown (To Explore)
[Edge cases to handle]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific generation instructions: what to implement, TDD cycle requirements]

Implementation scope: {from synthesis/design output}
Iteration: {current TDD iteration}
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

```markdown
## Related Research Terms

- [Relevant implementation patterns]
- [Testing frameworks]
- [Code quality standards]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-generation-memory.md`
```

### Template Reference

For full template documentation, see:
`${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md`

---

## References

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Memory output format
- `${CAII_DIRECTORY}/.claude/docs/code-generation-reference.md` - Code generation requirements
- `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md` - Context loading patterns
- `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` - Quick reference checklist
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/agent-invocation-template.md` - Invocation patterns
