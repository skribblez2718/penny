# develop-architecture Skill

**Type:** Composite
**Phases:** 7 (0-6)
**Purpose:** Transform requirements into comprehensive architecture artifacts

## Phase Sequence

| Phase | Name | Agent | Type |
|-------|------|-------|------|
| 0 | Requirements Clarification | clarification | LINEAR |
| 1 | Pattern Selection | analysis | LINEAR |
| 2 | Architecture Design | generation | LINEAR |
| 3 | Security Architecture | generation | LINEAR |
| 4 | Infrastructure Architecture | generation | LINEAR |
| 5 | Platform Extensions | generation | OPTIONAL |
| 6 | Validation & Documentation | validation | REMEDIATION |

## Key Features

- Evidence-based pattern selection (team size/scale frameworks)
- Security-integrated (OWASP from Phase 2, not retrofitted)
- Platform-agnostic core + conditional platform extensions
- Complete deliverables: HLD, LLD, schemas, APIs, IaC, ADRs, C4 diagrams

## Default Team Assumptions

- Team size: 2 (user + Penny)
- Cloud strategy: on-premise
- Pattern preference: modular, extensible

## Output Artifacts

Generated in `.claude/architecture/{project}/`:
- hld.md, lld.md
- database-schema.md
- api-specification.yaml
- security-architecture.md
- infrastructure/ (IaC templates)
- adrs/ (Architecture Decision Records)
- c4-diagrams/
- validation-report.md
