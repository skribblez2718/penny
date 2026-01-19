---
name: develop-web-app
description: Full-stack web application development with Flask+Lit+Tailwind frontend, FastAPI backend, PostgreSQL database
semantic_trigger: full-stack web app, Flask Lit Tailwind, FastAPI PostgreSQL, web application development, full stack application
not_for: mobile apps, desktop apps, CLI tools, static sites, API-only services
tags: web-app, flask, fastapi, lit, tailwind, postgresql, full-stack, owasp, tdd, authentication, email-otp
type: composite
composition_depth: 1
uses_composites: [develop-requirements, develop-architecture, develop-ui-ux, develop-backend, perform-qa-analysis]
---

# develop-web-app

Full-stack web application development with Flask+Lit+Tailwind frontend, FastAPI backend, and PostgreSQL database. Implements email+OTP authentication, dual-layer security (session cookies + JWT), and OWASP compliance.

## Overview

This skill guides the development of production-ready full-stack web applications using a modern, opinionated stack: Flask for the frontend framework, Lit for web components, Tailwind for styling, FastAPI for the backend API, and PostgreSQL for the database. It enforces absolute imports, CLAUDE.md documentation, TDD with 70%+ coverage, and OWASP security standards.

**Stack:** Flask + Lit + Tailwind (frontend) | FastAPI (backend) | PostgreSQL (database)

## When to Use

Use develop-web-app when building:
- Full-stack web applications requiring both frontend and backend
- Applications needing secure email+OTP authentication
- Projects requiring Flask+Lit+Tailwind frontend with FastAPI backend
- Web apps with PostgreSQL database requirements
- Applications requiring OWASP compliance and TDD

Do NOT use for:
- Mobile applications (iOS, Android)
- Desktop applications
- CLI tools or scripts
- Static websites without backend
- API-only services without frontend

## Core Principles

1. **Absolute Imports Only** - All Python code MUST use absolute imports. Relative imports are forbidden to ensure code portability and clear dependency chains.

2. **Directory Documentation** - Every code directory MUST include a CLAUDE.md file documenting the directory's purpose, key files, and usage patterns.

3. **Test-Driven Development** - All code MUST be developed using TDD methodology with 70%+ test coverage. Tests are written before implementation.

4. **OWASP Compliance** - Security implementations MUST align with OWASP Top 10 controls including input validation, authentication, authorization, and secure session management.

## Python Environment Requirements (MANDATORY)

**Reference:** `${CAII_DIRECTORY}/.claude/orchestration/shared/skills/code-generation/python-setup.md`

CRITICAL: ALL Python operations MUST use project-specific virtual environments.

| Requirement | Command |
|-------------|---------|
| Create venv | `uv venv` |
| Add dependency | `uv add <package>` |
| Add dev dependency | `uv add --dev pytest black ruff mypy` |
| Run tests | `uv run pytest` |
| Run code | `uv run python -m <module>` |

**PROHIBITED:**
- `pip install` for project dependencies
- Global package installation
- Running Python without `uv run`
- `requirements.txt` files (use `pyproject.toml`)

**Rationale:** Global installations cause system instability, dependency conflicts, and bloat.

## MANDATORY Execution

```bash
# Invoke this skill (via reasoning protocol routing)
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_web_app/entry.py
```

## Workflow Phases

The skill executes 8 phases with structured agent invocation:

| Phase | Name | Agent | Type | Next | Description |
|-------|------|-------|------|------|-------------|
| 0 | STACK_CLARIFICATION | orchestrate-clarification | LINEAR | 1 | Confirm stack, auth flow, and constraints |
| 1 | REQUIREMENTS | orchestrate-synthesis | LINEAR | 2 | Invoke develop-requirements workflow pattern |
| 2 | ARCHITECTURE | orchestrate-synthesis | LINEAR | 3 | Invoke develop-architecture workflow pattern |
| 3 | UI_UX_DESIGN | orchestrate-synthesis | LINEAR | 4 | Invoke develop-ui-ux workflow pattern |
| 4 | FRONTEND_DEVELOPMENT | orchestrate-generation | LINEAR | 5 | Generate Flask+Lit+Tailwind frontend |
| 5 | BACKEND_DEVELOPMENT | orchestrate-generation | LINEAR | 6 | Invoke develop-backend workflow pattern |
| 6 | INTEGRATION | orchestrate-synthesis | LINEAR | 7 | Integrate frontend and backend |
| 7 | QA_VALIDATION | orchestrate-validation | REMEDIATION | None | Invoke perform-qa-analysis workflow pattern |

### Phase 0: Stack Clarification
**Agent:** orchestrate-clarification
**Type:** LINEAR (mandatory)
**Purpose:** Confirm stack configuration, auth architecture, and project constraints

**Gate Criteria:**
- Stack confirmed: Flask+Lit+Tailwind, FastAPI, PostgreSQL
- Auth method verified: email+OTP with specified parameters
- Compliance scope established: OWASP mandatory
- Project constraints documented

### Phase 1: Requirements
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Invoke develop-requirements workflow pattern to generate user stories, NFRs, RTM

**Gate Criteria:**
- User stories approved
- Non-functional requirements documented
- Requirements Traceability Matrix created
- Success criteria defined

### Phase 2: Architecture
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Invoke develop-architecture workflow pattern to generate HLD, LLD, API specs, DB schema

**Gate Criteria:**
- High-Level Design complete
- Low-Level Design finalized
- API specifications documented (OpenAPI)
- Database schema designed

### Phase 3: UI/UX Design
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Invoke develop-ui-ux workflow pattern to generate design system with Tailwind

**Gate Criteria:**
- Design tokens defined (Tailwind config)
- Component specifications complete
- WCAG AA accessibility validated
- Responsive layouts designed

### Phase 4: Frontend Development
**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Generate Flask app with Lit components and Tailwind styling

**Gate Criteria:**
- Flask application functional
- Lit web components rendered
- Tailwind styles applied
- 70%+ test coverage achieved
- Session cookie authentication implemented

### Phase 5: Backend Development
**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Invoke develop-backend workflow pattern to generate FastAPI backend

**Gate Criteria:**
- FastAPI endpoints operational
- PostgreSQL schema implemented
- JWT authentication functional
- 70%+ test coverage achieved
- Email+OTP flow complete

### Phase 6: Integration
**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Integrate frontend and backend, verify E2E flows

**Gate Criteria:**
- Frontend-backend communication verified
- End-to-end authentication tested
- Integration test suite passing
- API contract alignment confirmed

### Phase 7: QA Validation
**Agent:** orchestrate-validation
**Type:** REMEDIATION (loops to Phase 4 on failure)
**Purpose:** Invoke perform-qa-analysis workflow pattern for comprehensive testing

**Gate Criteria:**
- Testing pyramid compliant (70/20/10: unit/integration/E2E)
- Quality score >= 0.75
- OWASP Top 10 verified
- Performance benchmarks met

**Remediation:** If validation fails with frontend issues, return to Phase 4 (max 2 iterations)

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `frontend_framework` | `flask` | Flask for routing and templates |
| `component_library` | `lit` | Lit web components for UI |
| `css_framework` | `tailwind` | Tailwind CSS for styling |
| `backend_framework` | `fastapi` | FastAPI for REST API |
| `database` | `postgresql` | PostgreSQL for data persistence |
| `auth_frontend.validation` | `session_cookie` | Frontend auth via session cookies |
| `auth_frontend.csrf_protection` | `true` | CSRF protection enabled |
| `auth_backend.validation` | `jwt_header` | Backend auth via JWT in headers |
| `auth_backend.jwt_storage` | `session_storage` | JWT stored in sessionStorage |
| `auth_method.type` | `email_otp` | Email + OTP authentication |
| `auth_method.otp_length` | `8` | 8-digit OTP codes |
| `auth_method.rate_limit_attempts` | `3` | Max 3 attempts per window |
| `auth_method.rate_limit_window` | `900` | 15-minute rate limit window (seconds) |
| `auth_method.cooldown_duration` | `300` | 5-minute cooldown after limit (seconds) |
| `import_style` | `absolute` | REQUIRED - relative imports forbidden |
| `documentation_standard` | `claude_md` | CLAUDE.md in every code directory |
| `tdd_enforcement` | `true` | TDD methodology required |
| `test_coverage_target` | `70` | Minimum 70% test coverage |
| `compliance_frameworks` | `['owasp']` | OWASP Top 10 compliance mandatory |

## Authentication Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EMAIL + OTP AUTHENTICATION                          │
│                                                                             │
│  FRONTEND (Flask + Lit)              BACKEND (FastAPI)                      │
│  ┌─────────────────────┐             ┌──────────────────────┐              │
│  │ 1. User enters email│────────────>│ 2. Validate email    │              │
│  │    in login form    │             │    format            │              │
│  └─────────────────────┘             └──────────┬───────────┘              │
│                                                  │                          │
│                                                  ▼                          │
│                                      ┌──────────────────────┐              │
│                                      │ 3. Generate 8-digit  │              │
│                                      │    OTP, send email   │              │
│                                      │    Store: email, OTP,│              │
│                                      │    attempts=0        │              │
│                                      └──────────┬───────────┘              │
│                                                  │                          │
│  ┌─────────────────────┐             ┌──────────▼───────────┐              │
│  │ 4. User enters OTP  │────────────>│ 5. Verify OTP        │              │
│  │    from email       │             │    - Check attempts  │              │
│  └─────────────────────┘             │    - Validate OTP    │              │
│                                      │    - Apply rate limit│              │
│                                      └──────────┬───────────┘              │
│                                                  │                          │
│                                      ┌───────────▼──────────┐              │
│                                      │ 6. On success:       │              │
│                                      │    - Generate JWT    │              │
│                                      │    - Create session  │              │
│                                      └──────────┬───────────┘              │
│                                                  │                          │
│  ┌─────────────────────┐             ┌──────────▼───────────┐              │
│  │ 7. Store session    │<────────────│ 8. Return:           │              │
│  │    cookie (Flask)   │             │    - Session cookie  │              │
│  │    Store JWT in     │             │    - JWT token       │              │
│  │    sessionStorage   │             └──────────────────────┘              │
│  └─────────────────────┘                                                   │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────────┐             ┌──────────────────────┐              │
│  │ 9. Subsequent reqs: │────────────>│ 10. Validate:        │              │
│  │    - Session cookie │             │     - Session cookie │              │
│  │    - JWT in header  │             │     - JWT signature  │              │
│  └─────────────────────┘             │     - JWT expiry     │              │
│                                      └──────────────────────┘              │
│                                                                             │
│  RATE LIMITING:                                                             │
│  - Max 3 OTP attempts per 15-minute window                                  │
│  - 5-minute cooldown after exceeding limit                                  │
│  - Attempts counter resets after successful login                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Agent Invocation Format

When invoking agents in each phase, use the standardized Agent Prompt Template:

```markdown
# Agent Invocation: {agent-name}

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
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

## Validation Checklist

Use the validation checklist at: `${CAII_DIRECTORY}/.claude/skills/develop-web-app/resources/validation-checklist.md`

## References

- **Auth Flow:** `${CAII_DIRECTORY}/.claude/skills/develop-web-app/resources/auth-flow.md`
- **OWASP Top 10:** https://owasp.org/www-project-top-ten/
- **Flask Documentation:** https://flask.palletsprojects.com/
- **Lit Documentation:** https://lit.dev/
- **Tailwind CSS:** https://tailwindcss.com/
- **FastAPI Documentation:** https://fastapi.tiangolo.com/
- **PostgreSQL Documentation:** https://www.postgresql.org/docs/

## Success Criteria

1. **Frontend Functional:** Flask app serving Lit components with Tailwind styles
2. **Backend Operational:** FastAPI endpoints connected to PostgreSQL
3. **Auth Complete:** Email+OTP flow with session cookies and JWT working
4. **Security Validated:** OWASP Top 10 controls implemented and verified
5. **Test Coverage:** 70%+ coverage on both frontend and backend
6. **Integration Verified:** E2E flows tested and passing
7. **Documentation Complete:** CLAUDE.md files in all code directories

## Common Pitfalls

- Mixing relative and absolute imports
- Missing CLAUDE.md documentation files
- Skipping TDD workflow (writing implementation before tests)
- Inadequate test coverage (< 70%)
- Missing OWASP security controls
- Hardcoded secrets or configuration
- Insufficient rate limiting on OTP attempts
- Missing CSRF protection on frontend forms
- JWT stored in localStorage instead of sessionStorage
- Session cookies without httpOnly flag

## Embedded Composite Skills

**Note:** This skill uses `composition_depth: 1`, indicating it orchestrates other composite skills. However, the current `config.py` implementation does not support direct embedded composite invocation. Instead, phases invoke `orchestrate-*` atomic skills with instructions to follow the workflow pattern of the referenced composite skill.

**Embedded Composites (Future Feature):**
- `develop-requirements` (Phase 1)
- `develop-architecture` (Phase 2)
- `develop-ui-ux` (Phase 3)
- `develop-backend` (Phase 5)
- `perform-qa-analysis` (Phase 7)

Phase content files include detailed instructions for agents to follow these workflow patterns.

## Integration Points

- **Frontend → Backend:** API contract defined in Phase 2, implemented in Phases 4-5
- **Design → Frontend:** Design tokens from Phase 3 used in Phase 4
- **Backend → Database:** Database schema from Phase 2 implemented in Phase 5
- **Auth Flow:** Session cookies (Phase 4) + JWT (Phase 5) integrated in Phase 6
