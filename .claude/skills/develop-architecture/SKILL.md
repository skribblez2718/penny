---
name: develop-architecture
description: Transform requirements into comprehensive architecture artifacts
tags: architecture, hld, lld, security, infrastructure, adr, c4-diagrams
type: composite
composition_depth: 0
uses_composites: []
---

# develop-architecture

**Type:** Composite Skill
**Description:** Transform requirements into comprehensive architecture artifacts across web, mobile, desktop, and API applications
**Status:** production
**Complexity:** high

## Overview

Orchestrates complete architecture design lifecycle from requirements clarification through validation with pattern selection frameworks, security integration, and platform-specific extensions.

**Cognitive Pattern:** CLARIFICATION (MANDATORY) → PATTERN SELECTION → ARCHITECTURE DESIGN → SECURITY ARCHITECTURE → INFRASTRUCTURE ARCHITECTURE → PLATFORM EXTENSIONS (OPTIONAL) → VALIDATION (with remediation loop)

**Key Capabilities:**
- Evidence-based pattern selection using team size/scale decision frameworks
- Platform-agnostic core with tagged platform extensions (web/mobile/desktop/API)
- Security-integrated (NOT retrofitted) using OWASP principles
- Complete deliverables: HLD, LLD, DB schema, API specs, IaC templates, ADRs, C4 diagrams
- Validation-automated with ArchUnit rules and fitness functions

**Default Team Assumptions:**
- Cloud strategy: **on-premise** (can override in Phase 0)
- Pattern preference: modular, extensible architectures
- Team size: 2-person (user + Penny)

## When to Use

Invoke this skill when queries match these semantic triggers:

- **Design architecture** - "design architecture for [app type]", "architect the system"
- **Create architecture plan** - "create architecture plan", "plan system architecture"
- **Generate HLD/LLD** - "generate high-level design", "create low-level design"
- **Define system architecture** - "define system architecture", "architecture for..."
- **Database schema design** - "design database schema", "create data model"
- **Architecture decision records** - "create ADRs", "document architecture decisions"
- **Infrastructure architecture** - "plan infrastructure", "design deployment architecture"

## NOT for

Do NOT invoke this skill for:

- **UI/UX design** - use design-system skill instead (wireframes, mockups, visual design)
- **Code implementation** - use development-phase skill (feature development, coding)
- **Infrastructure deployment** - use devops skill (CI/CD setup, deployment automation)
- **API endpoint implementation** - use development-phase skill (actual coding)
- **Database query optimization** - use performance-tuning skill (query tuning)
- **Requirements gathering** - use develop-requirements skill first

**Boundary Clarity:** Architecture defines STRUCTURE and DECISIONS; design defines APPEARANCE; development defines IMPLEMENTATION.

## Core Principles

1. **Decision-driven, not prescriptive** - Frameworks guide pattern selection based on context, not one-size-fits-all
2. **Platform-agnostic core** - Universal patterns apply everywhere, platform extensions activate conditionally
3. **Security-integrated** - OWASP principles designed in Phase 2, NOT added later
4. **Evidence-based** - Team size thresholds and pattern selection from validated research (0.84/1.0 quality score)
5. **Validation-automated** - ArchUnit rules and fitness functions enable CI/CD enforcement

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `task-arch-{project-keywords}`
- Create workflow metadata per protocol
- Task domain: technical
- Detect application type (web/mobile/desktop/API)

### Completion
- Aggregate all deliverables (HLD, LLD, schemas, ADRs, C4 diagrams)
- Review Unknown Registry for gaps
- Present completion summary with architecture package
- Finalize workflow per protocol

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_architecture/entry.py "{task_id}"
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_architecture/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Requirements Clarification | orchestrate-clarification | **LINEAR** (MANDATORY) |
| 1 | Pattern Selection | orchestrate-analysis | LINEAR |
| 2 | Architecture Design | orchestrate-generation | LINEAR |
| 3 | Security Architecture | orchestrate-generation | LINEAR |
| 4 | Infrastructure Architecture | orchestrate-generation | LINEAR |
| 5 | Platform Extensions | orchestrate-generation | **OPTIONAL** |
| 6 | Validation & Documentation | orchestrate-validation | **REMEDIATION** |

**Execution:** Phases are enforced by `protocols/skill/core/fsm.py` with state tracked in `protocols/skill/state/`.

### Phase Details

#### Phase 0: Requirements Clarification (LINEAR)
- Clarify application type (web/mobile/desktop/API)
- Determine team size and expected scale
- Identify consistency requirements (ACID vs eventual)
- Confirm cloud strategy (default: on-premise)
- Assess security sensitivity level
- **Gate:** Architecture context clarified, defaults set

#### Phase 1: Pattern Selection (LINEAR)
- Apply pattern selection decision framework
- Score patterns using team size/scale/complexity weights
- Select base pattern (layered/modular/microservices)
- Determine event-driven overlays (if needed)
- Document ADR for pattern selection
- **Gate:** Architecture pattern selected with confidence score

#### Phase 2: Architecture Design (LINEAR)
- Generate HLD (system context, major components)
- Generate LLD (container/component diagrams)
- Design database schema (normalized to 3NF/BCNF)
- Create API specifications (OpenAPI 3.0)
- Apply pattern-specific deliverables
- **Gate:** Core architecture artifacts complete

#### Phase 3: Security Architecture (LINEAR)
- Design authentication architecture (OAuth 2.0/OIDC)
- Define authorization model (RBAC or ABAC)
- Plan encryption strategy (at rest + in transit)
- Address OWASP Top 10 mitigations
- Implement defense-in-depth layers
- **Gate:** Security architecture OWASP-aligned

#### Phase 4: Infrastructure Architecture (LINEAR)
- Select IaC tool (Terraform/CloudFormation/Pulumi)
- Design infrastructure templates (network/compute/data/security)
- Plan container orchestration (if applicable)
- Apply 12-Factor App methodology
- Estimate cloud costs
- **Gate:** Infrastructure-as-Code templates complete

#### Phase 5: Platform Extensions (OPTIONAL)
- **[PLATFORM:WEB]** SSR vs CSR, PWA, bundle optimization
- **[PLATFORM:MOBILE]** Offline-first, battery optimization, framework selection
- **[PLATFORM:DESKTOP]** Native APIs, auto-update, framework selection
- **[PLATFORM:API]** Service mesh vs API gateway, rate limiting, versioning
- **Trigger:** Application type from Phase 0
- **Gate:** Platform-specific architecture complete

#### Phase 6: Validation & Documentation (REMEDIATION)
- Validate architecture against AWS Well-Architected Framework
- Generate C4 diagrams (Levels 1-3 minimum)
- Finalize ADR catalog with cross-references
- Define ArchUnit rules and fitness functions
- If incomplete → loop back to relevant phase (max 2 remediation iterations)
- **Gate:** Architecture validation passed

### Remediation Flow

If Phase 6 validation identifies gaps:
1. orchestrate-validation identifies specific missing/incomplete artifacts
2. FSM transitions back to target phase (2, 3, 4, or 5)
3. Target phase re-executes with focused generation
4. Max 2 remediation loops before forced completion

## Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| application_type | enum | null | web \| mobile \| desktop \| api (clarified in Phase 0) |
| cloud_strategy | enum | on-premise | on-premise \| cloud-native \| hybrid |
| skip_platform_extensions | boolean | false | Skip Phase 5 if true |
| max_remediation | int | 2 | Max validation retry loops |

## Output Artifacts

Generated in `.claude/architecture/{project-name}/`:

1. **hld.md** - High-Level Design with system context, components, dependencies
2. **lld.md** - Low-Level Design with container/component diagrams, sequences
3. **database-schema.md** - ERD, table definitions, normalization verification, DDL scripts
4. **api-specification.yaml** - OpenAPI 3.0 compliant API documentation
5. **security-architecture.md** - Authentication, authorization, encryption, OWASP mitigations
6. **infrastructure/** - IaC templates (Terraform/CloudFormation), Helm charts
7. **adrs/** - Architecture Decision Records (Michael Nygard format)
8. **c4-diagrams/** - System Context, Container, Component levels (PlantUML/Draw.io)
9. **validation-report.md** - ArchUnit rules, fitness functions, Well-Architected review

## Validation Checklist

**Reference:** `${CAII_DIRECTORY}/.claude/skills/develop-architecture/resources/validation-checklist.md`

- [ ] HLD: All major components, external dependencies, tech stack justified
- [ ] LLD: Container + Component diagrams, sequence diagrams for 3+ workflows
- [ ] DB Schema: Normalized to 3NF/BCNF, indexes defined, DDL scripts provided
- [ ] API Specs: OpenAPI 3.0 compliant, auth documented per endpoint
- [ ] Security: OWASP Top 10 addressed, defense-in-depth, encryption strategy
- [ ] Infrastructure: IaC templates for all environments, cost estimated
- [ ] ADRs: Pattern selection + major tech decisions documented
- [ ] C4 Diagrams: Levels 1-3 complete with cross-references
- [ ] Platform-specific: Considerations addressed for app type
- [ ] AWS Well-Architected: All 5 pillars evaluated

## Agent Invocation Format

When atomic skills invoke agents, use the standardized Agent Prompt Template format:

**Required Sections:**
1. **Task Context** - task_id, skill_name, phase_id, domain, agent_name
2. **Role Extension** - 3-5 task-specific focus areas (architecture-specific)
3. **Johari Context** - Open/Blind/Hidden/Unknown from reasoning protocol
4. **Task Instructions** - Specific cognitive work
5. **Related Research Terms** - 7-10 keywords (architecture patterns, frameworks)
6. **Output Requirements** - Memory file path

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/agent-system-prompt.md`

## Related Research Terms

- Software architecture patterns
- Microservices architecture
- Modular monolith
- Event-driven architecture
- CQRS and Event Sourcing
- Clean architecture
- Hexagonal architecture
- OWASP secure architecture
- Infrastructure as Code
- C4 model
- Architecture Decision Records
- AWS Well-Architected Framework
- 12-Factor App
- Database normalization
- API design patterns

## Notes

- **Team defaults:** 2-person team (user + Penny), on-premise cloud strategy, modular patterns
- Phase 0 clarification can override defaults based on user context
- Phase 5 (OPTIONAL) activates based on application_type from Phase 0
- Phase 6 (REMEDIATION) can loop back to Phases 2-5 up to 2 times if validation fails
- Platform-agnostic design works across technical domains (web/mobile/desktop/API)
- Research-backed (0.84/1.0 quality score, 87 verified sources, 77% Tier 1-2)
- Decision frameworks enable context-driven architecture, not prescriptive templates
