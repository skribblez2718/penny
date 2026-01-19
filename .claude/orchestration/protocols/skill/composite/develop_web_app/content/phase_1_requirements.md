# Phase 1: Requirements

**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Follow develop-requirements workflow pattern to generate user stories, NFRs, and RTM

## Context

This phase synthesizes requirements using the develop-requirements composite skill workflow pattern. The synthesis agent should follow the develop-requirements methodology to produce comprehensive requirements artifacts.

## Workflow Pattern: develop-requirements

Follow the develop-requirements skill phases:
1. Stakeholder Analysis
2. Requirements Elicitation
3. Requirements Documentation (user stories, NFRs)
4. Requirements Validation
5. Traceability Matrix

**Reference:** `develop-requirements` skill documentation

## Focus Areas

### 1. User Stories

Generate user stories for:
- User authentication (email+OTP flow)
- User session management
- Core application features (from Phase 0 clarification)
- Administrative functions
- Error handling and recovery

Format: "As a [user type], I want [goal] so that [benefit]"

### 2. Non-Functional Requirements

Document NFRs for:
- **Performance:** Response times, throughput targets
- **Security:** OWASP controls, auth requirements, data protection
- **Scalability:** Concurrent users, horizontal scaling
- **Availability:** Uptime SLA, failover
- **Usability:** WCAG AA accessibility, responsive design
- **Maintainability:** Code standards, documentation, testing

### 3. Requirements Traceability Matrix (RTM)

Create RTM linking:
- User stories → features → components
- NFRs → architecture decisions → implementation
- Compliance requirements → security controls → tests

## Context from Phase 0

Use Phase 0 clarification output:
- Stack configuration
- Auth architecture parameters
- Compliance scope
- Functional requirements overview
- Non-functional requirements overview

## Gate Criteria

- [ ] User stories complete with acceptance criteria
- [ ] Non-functional requirements documented with measurable targets
- [ ] Requirements Traceability Matrix created
- [ ] Stakeholder validation (if applicable)
- [ ] Requirements prioritized (MoSCoW or similar)

## Output Artifacts

- User stories document (markdown)
- Non-functional requirements specification
- Requirements Traceability Matrix
- Requirements validation summary

## Agent Invocation

```markdown
# Agent Invocation: synthesis

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `1`
- **Domain:** `technical`
- **Agent:** `synthesis`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Follow develop-requirements workflow pattern
- Generate user stories for Flask+Lit frontend and FastAPI backend
- Document NFRs covering performance, security, scalability, accessibility
- Create RTM linking stories to architecture (Phase 2 prep)
- Synthesize email+OTP auth requirements into user stories

## Johari Context (from Phase 0)

### Open (Confirmed)
{Stack config, auth params, compliance scope from Phase 0}

### Unknown (To Explore)
{Flagged unknowns from Phase 0}

## Task

Synthesize comprehensive requirements following the develop-requirements workflow pattern. Generate user stories, NFRs, and RTM for the Flask+Lit+Tailwind+FastAPI+PostgreSQL web application with email+OTP authentication.

Ensure requirements support:
- Dual-layer security (session cookies + JWT)
- OWASP compliance
- TDD with 70%+ coverage
- WCAG AA accessibility

## Related Research Terms

- User story format
- Non-functional requirements
- Requirements traceability matrix
- MoSCoW prioritization
- Acceptance criteria
- WCAG accessibility requirements
- OWASP security requirements
- Performance SLA targets

## Output

Write findings to: `.claude/memory/{task-id}-synthesis-memory.md`
```
