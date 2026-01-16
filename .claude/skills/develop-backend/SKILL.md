---
name: develop-backend
description: Production-grade backend development skill with technology-agnostic patterns
semantic_trigger: backend development, API design, database architecture, authentication, microservices, server-side development, backend API, RESTful services, GraphQL API, backend security
not_for: frontend development, UI/UX design, infrastructure deployment, DevOps, mobile app development
tags: backend, api, database, authentication, security, microservices, testing, monitoring, scalability, architecture
type: composite
composition_depth: 0
uses_composites: []
---

# develop-backend

Production-grade backend development with technology-agnostic patterns covering API design, database architecture, authentication, security, testing, and observability.

## Overview

This skill guides the development of robust backend systems using proven patterns and best practices. It adapts to any technology stack (Node.js, Python, Go, Java, etc.) while maintaining consistent quality standards including OWASP security alignment, comprehensive testing, and production observability.

## Phases

The skill executes 8 phases with structured agent invocation:

### Phase 0: Requirements Clarification
**Agent:** orchestrate-clarification
**Type:** LINEAR (mandatory)
**Purpose:** Clarify backend requirements, tech stack, client types, and constraints

**Gate Criteria:**
- Tech stack confirmed (language, framework, database)
- Client types identified (web, mobile, internal services)
- Scalability requirements defined
- Security requirements clarified

### Phase 1: API Design
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Design API contracts (REST/GraphQL), versioning, rate limiting, pagination

**Gate Criteria:**
- API endpoints defined with contracts
- Versioning strategy established
- Rate limiting rules specified
- Error handling patterns defined

### Phase 2: Database Architecture
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Schema design, indexing strategy, migration approach, data integrity

**Gate Criteria:**
- Database schema documented
- Indexing strategy defined
- Migration approach established
- Data validation rules specified

### Phase 3: Authentication & Security
**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Implement JWT/OAuth patterns, input validation, OWASP alignment

**Gate Criteria:**
- Authentication mechanism implemented
- Authorization rules defined
- Input validation present
- OWASP Top 10 addressed

### Phase 4: Architecture & Scalability
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Define scaling strategy, caching, circuit breakers, service boundaries

**Gate Criteria:**
- Scaling strategy documented
- Caching layers identified
- Circuit breaker patterns applied
- Service boundaries defined

### Phase 5: Testing & Quality
**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Implement test pyramid (unit, integration, E2E), achieve 70%+ coverage

**Gate Criteria:**
- Unit tests present (70%+ coverage)
- Integration tests implemented
- E2E tests for critical paths
- CI/CD pipeline configured

### Phase 6: Monitoring & Observability
**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Add logging, metrics, traces, alerting, health checks

**Gate Criteria:**
- Structured logging implemented
- Metrics collection configured
- Distributed tracing enabled
- Health check endpoints present

### Phase 7: Final Validation
**Agent:** orchestrate-validation
**Type:** REMEDIATION (loops to Phase 3 on security failure)
**Purpose:** Validate all components, run security scan, verify all gates

**Gate Criteria:**
- All previous gates verified
- Security scan passed
- Performance benchmarks met
- Documentation complete

**Remediation:** If security validation fails, return to Phase 3 (max 2 iterations)

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tech_stack` | `node-express` | Backend technology (node-express, python-fastapi, go-gin, java-spring) |
| `database` | `postgresql` | Database system (postgresql, mysql, mongodb, dynamodb) |
| `auth_method` | `jwt` | Authentication approach (jwt, oauth2, session, api-key) |
| `test_coverage_target` | `70` | Minimum test coverage percentage |
| `api_style` | `rest` | API paradigm (rest, graphql, grpc) |
| `deployment_target` | `docker` | Deployment method (docker, serverless, vm) |

## Agent Invocation Format

When invoking agents in each phase, use the standardized Agent Prompt Template:

```markdown
# Agent Invocation: {agent-name}

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-backend`
- **Phase:** `{phase-id}`
- **Domain:** `technical`
- **Agent:** `{agent-name}`

## Role Extension
**Task-Specific Focus:**
- {3-5 focus areas specific to this phase}

## Johari Context (if available)
### Open (Confirmed)
{Known requirements from prior phases}

### Blind (Gaps)
{Areas needing discovery}

### Hidden (Inferred)
{Reasonable assumptions}

### Unknown (To Explore)
{Open questions}

## Task
{Specific instructions for this phase's cognitive work}

## Related Research Terms
{7-10 keywords relevant to this phase}

## Output
Write findings to: `.claude/memory/{task-id}-{agent}-memory.md`
```

## Success Criteria

1. **API Completeness:** All endpoints documented with contracts
2. **Security Compliance:** OWASP Top 10 addressed, security scan passed
3. **Test Coverage:** 70%+ unit test coverage, integration tests present
4. **Observability:** Logs, metrics, traces, and alerts configured
5. **Scalability:** Caching, circuit breakers, and scaling strategy defined
6. **Documentation:** API docs, architecture diagrams, runbooks complete

## Common Pitfalls

- Skipping authentication/authorization in early phases
- Missing database indexing strategy
- Inadequate error handling patterns
- Insufficient test coverage
- Missing observability from the start
- Unclear API versioning strategy
- Hardcoded configuration values
- Missing input validation

## Integration Points

- **Frontend:** API contracts must align with frontend requirements
- **Infrastructure:** Docker/K8s configs, environment variables
- **CI/CD:** Test execution, security scans, deployment pipeline
- **Monitoring:** APM tools (DataDog, NewRelic, etc.)
- **Documentation:** OpenAPI/Swagger specs, architecture diagrams

## Related Skills

- `develop-frontend` - For full-stack development
- `develop-microservices` - For distributed system patterns
- `develop-infrastructure` - For deployment and scaling
- `perform-security-audit` - For security validation

## Version History

- **1.0.0** - Initial release with 8-phase backend development workflow
