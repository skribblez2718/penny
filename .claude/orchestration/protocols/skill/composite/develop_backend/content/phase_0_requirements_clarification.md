# Phase 0: Requirements Clarification

**Agent:** orchestrate-clarification
**Type:** LINEAR (mandatory)

## Objective

Clarify backend requirements through Johari Window discovery, focusing on tech stack, client types, scalability needs, and security constraints.

## Key Areas to Clarify

### 1. Technology Stack
- **Language/Framework:** Node.js/Express, Python/FastAPI, Go/Gin, Java/Spring?
- **Database:** PostgreSQL, MySQL, MongoDB, DynamoDB?
- **ORM/Query Builder:** Prisma, SQLAlchemy, GORM, Hibernate?
- **Package Management:** npm, pip, go modules, maven?

### 2. Client Types & Integration
- **Web Clients:** Browser-based applications?
- **Mobile Clients:** iOS, Android native apps?
- **Internal Services:** Other microservices, background workers?
- **Third-party Integrations:** External APIs, webhooks?

### 3. Scalability Requirements
- **Expected Load:** Concurrent users, requests per second?
- **Growth Trajectory:** 6-month, 1-year, 3-year projections?
- **Geographic Distribution:** Single region or multi-region?
- **Data Volume:** Record counts, storage requirements?

### 4. Security Requirements
- **Authentication:** JWT, OAuth2, session-based, API keys?
- **Authorization:** RBAC, ABAC, simple ownership?
- **Compliance:** GDPR, HIPAA, SOC2, PCI-DSS?
- **Data Sensitivity:** PII, financial, health, public?

### 5. Performance Constraints
- **Response Time:** P50, P95, P99 targets?
- **Availability:** Uptime SLA requirements?
- **Data Consistency:** Strong vs eventual consistency?
- **Caching Strategy:** In-memory, distributed, CDN?

### 6. Development Constraints
- **Team Size:** Solo, small team, large team?
- **Timeline:** MVP timeline, production readiness?
- **Budget:** Cloud costs, third-party services?
- **Existing Systems:** Legacy integration needs?

## Configuration Parameters to Set

Use Johari discovery to set these defaults:

| Parameter | Options | Questions to Ask |
|-----------|---------|------------------|
| `tech_stack` | node-express, python-fastapi, go-gin, java-spring | What language/framework does the team know best? |
| `database` | postgresql, mysql, mongodb, dynamodb | Relational or NoSQL? Managed service or self-hosted? |
| `auth_method` | jwt, oauth2, session, api-key | External identity provider or custom auth? |
| `test_coverage_target` | 60, 70, 80 | What coverage level meets quality standards? |
| `api_style` | rest, graphql, grpc | What do clients expect? Mobile-first or web-first? |
| `deployment_target` | docker, serverless, vm | What infrastructure is available? |

## Johari Window Framework

### SHARE (What we can infer)
- Backend systems require API contracts
- Security must be considered from the start
- Testing strategy affects long-term maintainability
- Scalability patterns depend on load characteristics

### ASK (Critical questions - max 5)
Prioritize these clarifications:
1. What is the primary use case for this backend? (defines API design)
2. What tech stack is the team most comfortable with? (affects productivity)
3. What are the security/compliance requirements? (affects architecture)
4. What scale is expected in 6 months? (affects scalability decisions)
5. What are the non-negotiable constraints? (budget, timeline, team)

### ACKNOWLEDGE (Assumptions if unanswered)
- Default to popular, well-documented tech stacks
- Assume OWASP Top 10 security compliance required
- Assume 70% test coverage target
- Assume RESTful API unless GraphQL explicitly needed

### EXPLORE (Edge cases to consider)
- Multi-tenancy requirements?
- Offline-first mobile clients?
- Real-time features (WebSockets, Server-Sent Events)?
- File upload/download handling?
- Rate limiting and abuse prevention?

## Gate Criteria

Before advancing to Phase 1 (API Design), ensure:

- [ ] **Tech stack confirmed:** Language, framework, database selected
- [ ] **Client types identified:** Web, mobile, internal services, third-party
- [ ] **Scalability requirements defined:** Load expectations, growth trajectory
- [ ] **Security requirements clarified:** Auth method, compliance needs, data sensitivity
- [ ] **Performance targets set:** Response time, availability SLA
- [ ] **Configuration parameters validated:** All 6 parameters set with justification

## Output Expectations

The CLARIFICATION agent should produce:

1. **Requirements Summary:** 3-5 paragraphs of confirmed backend requirements
2. **Configuration Values:** All 6 parameters with rationale
3. **Unknowns Registry:** Document any unresolved questions for later phases
4. **Constraints List:** Budget, timeline, team, technical constraints
5. **Risk Flags:** Early-identified risks (security, scalability, integration)

## Next Phase

Upon gate verification, advance to **Phase 1: API Design** where the SYNTHESIS agent will design API contracts based on these clarified requirements.
