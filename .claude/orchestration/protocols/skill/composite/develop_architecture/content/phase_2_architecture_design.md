# Phase 2: Architecture Design

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR

## Purpose

Generate core architecture artifacts based on selected pattern from Phase 1.

## Domain-Specific Extensions (Architecture)

**Deliverables:**

1. **High-Level Design (HLD)**
   - System Context Diagram (C4 Level 1)
   - Major component breakdown
   - External dependencies
   - Data flow diagrams
   - Technology stack with rationale

2. **Low-Level Design (LLD)**
   - Container Diagram (C4 Level 2)
   - Component Diagram (C4 Level 3)
   - Sequence diagrams (3+ critical workflows)
   - Module dependency graph

3. **Database Schema**
   - ERD with all entities/relationships
   - Normalized to 3NF minimum (target BCNF)
   - Index strategy
   - DDL scripts

4. **API Specifications**
   - OpenAPI 3.0 compliant
   - All endpoints documented
   - Auth per endpoint
   - Versioning strategy

**Templates:**
- `${CAII_DIRECTORY}/.claude/skills/develop-architecture/resources/templates/hld-lld-template.md`
- `${CAII_DIRECTORY}/.claude/skills/develop-architecture/resources/templates/c4-templates.md`

## Pattern-Specific Additions

**Microservices:** Service boundaries, inter-service comms, distributed tracing
**Event-Driven:** Event catalog, CQRS models, saga orchestration
**Modular Monolith:** Module boundaries, dependency rules, refactoring path

## Gate Exit Criteria

- [ ] HLD complete with C4 Level 1
- [ ] LLD complete with C4 Levels 2-3
- [ ] Database schema normalized, DDL provided
- [ ] OpenAPI spec complete
- [ ] Pattern-specific artifacts created

## Output

- hld.md
- lld.md
- database-schema.md
- api-specification.yaml
- c4-diagrams/ (Levels 1-3)

## MANDATORY Agent Invocation

```bash
Task tool with subagent_type: "orchestrate-generation"
```

Produces: `.claude/memory/{task_id}-generation-memory.md`
