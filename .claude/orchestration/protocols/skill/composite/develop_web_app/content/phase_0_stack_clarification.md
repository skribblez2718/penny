# Phase 0: Stack Clarification

**Agent:** orchestrate-clarification
**Type:** LINEAR (mandatory)
**Purpose:** Confirm stack configuration, authentication architecture, and project constraints

## Context

This is the mandatory clarification phase for full-stack web application development. The skill uses an opinionated stack: Flask+Lit+Tailwind (frontend), FastAPI (backend), and PostgreSQL (database) with email+OTP authentication.

## Clarification Focus Areas

### 1. Stack Configuration Confirmation

**Default Stack:**
- **Frontend Framework:** Flask (routing, templates, static serving)
- **Component Library:** Lit (web components, reactive UI)
- **CSS Framework:** Tailwind CSS (utility-first styling)
- **Backend Framework:** FastAPI (REST API, async support)
- **Database:** PostgreSQL (relational data, ACID compliance)

**Clarify:**
- Is the default stack acceptable, or are there specific version requirements?
- Are there existing systems or APIs that must be integrated?
- Are there deployment environment constraints (Docker, K8s, serverless)?

### 2. Authentication Architecture

**Default Auth Flow:**
- **Method:** Email + 8-digit OTP
- **Frontend Auth:** Session cookies (httpOnly, secure flags)
- **Backend Auth:** JWT in Authorization header
- **JWT Storage:** sessionStorage (NOT localStorage for security)
- **Rate Limiting:** 3 attempts per 15-minute window, 5-minute cooldown

**Clarify:**
- Is email+OTP acceptable, or is OAuth/SSO required?
- Are the OTP parameters appropriate (8 digits, 3 attempts, 15min window)?
- Are there specific session duration requirements?
- Are there multi-factor authentication (MFA) requirements beyond OTP?

### 3. Security and Compliance

**Default Standards:**
- **OWASP Top 10:** Mandatory compliance
- **CSRF Protection:** Enabled on all forms
- **Input Validation:** Server-side validation on all inputs
- **Password Storage:** N/A (email+OTP, no passwords)
- **HTTPS:** Enforced in production

**Clarify:**
- Are there additional compliance requirements (SOC II, PCI, HIPAA, GDPR)?
- Are there data classification requirements (PII, PHI, financial)?
- Are there specific security audit requirements?
- Are there penetration testing requirements?

### 4. Testing and Quality

**Default Requirements:**
- **TDD Methodology:** Tests written before implementation
- **Test Coverage:** 70%+ on both frontend and backend
- **Testing Pyramid:** 70% unit, 20% integration, 10% E2E
- **Absolute Imports:** No relative imports allowed
- **Documentation:** CLAUDE.md in every code directory

**Clarify:**
- Is 70% coverage acceptable, or is higher coverage required?
- Are there specific testing frameworks required (pytest, jest, etc.)?
- Are there CI/CD pipeline requirements?
- Are there performance testing requirements?

### 5. Functional Requirements Overview

**Clarify:**
- What are the primary user flows (auth, CRUD operations, etc.)?
- Are there real-time features required (WebSockets, SSE)?
- Are there file upload/download requirements?
- Are there third-party integrations required (payment, email service)?
- What is the expected user load (concurrent users, requests/sec)?

### 6. Non-Functional Requirements

**Clarify:**
- **Performance:** Response time targets? Throughput requirements?
- **Scalability:** Horizontal scaling needed? Load balancing?
- **Availability:** Uptime SLA? Disaster recovery?
- **Observability:** Logging level? Metrics? Distributed tracing?
- **Accessibility:** WCAG level (AA is default)?

## Gate Criteria

Before advancing to Phase 1, confirm:

- [ ] Stack configuration approved: Flask+Lit+Tailwind, FastAPI, PostgreSQL
- [ ] Authentication architecture agreed: email+OTP with dual-layer security
- [ ] Compliance scope established: OWASP mandatory, additional frameworks identified
- [ ] Testing requirements confirmed: TDD, 70%+ coverage, testing pyramid
- [ ] Project constraints documented: deployment, integrations, performance targets
- [ ] Unknown areas flagged for Phase 1 requirements gathering

## Output

Document findings in memory file:
- Stack configuration (with any deviations from defaults)
- Authentication parameters (OTP length, rate limits, session duration)
- Compliance frameworks to implement
- Testing and quality standards
- Functional requirements summary
- Non-functional requirements summary
- Unknown areas requiring further requirements analysis

## Agent Invocation

```markdown
# Agent Invocation: clarification

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `0`
- **Domain:** `technical`
- **Agent:** `clarification`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Validate Flask+Lit+Tailwind+FastAPI+PostgreSQL stack suitability
- Confirm email+OTP authentication parameters and flow
- Identify compliance requirements beyond OWASP
- Clarify deployment and integration constraints
- Surface unknown requirements for Phase 1 analysis

## Task

Clarify the stack configuration, authentication architecture, and project constraints for a full-stack web application. Use the default stack (Flask+Lit+Tailwind, FastAPI, PostgreSQL) unless user has specific alternatives. Confirm email+OTP auth parameters or identify different auth requirements.

Focus on surfacing unknowns that will be addressed in Phase 1 (Requirements) rather than attempting to gather complete requirements now.

## Related Research Terms

- Flask web framework
- Lit web components
- Tailwind CSS utility-first
- FastAPI async Python
- PostgreSQL relational database
- Email OTP authentication
- Session cookie security
- JWT token storage
- OWASP Top 10 compliance

## Output

Write findings to: `.claude/memory/{task-id}-clarification-memory.md`

Include:
- Stack configuration (approved or modified)
- Auth architecture parameters
- Compliance scope
- Testing standards
- Flagged unknowns for Phase 1
```
