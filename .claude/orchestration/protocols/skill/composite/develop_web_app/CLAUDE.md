# Develop-web-app Skill

Full-stack web application development with Flask+Lit+Tailwind frontend, FastAPI backend, and PostgreSQL database.

## Overview

This composite skill (composition_depth: 1) orchestrates the development of production-ready web applications using an opinionated modern stack. It enforces absolute imports, CLAUDE.md documentation, TDD with 70%+ coverage, and OWASP compliance.

**Stack:**
- **Frontend:** Flask (routing/templates) + Lit (web components) + Tailwind (CSS)
- **Backend:** FastAPI (REST API)
- **Database:** PostgreSQL
- **Auth:** Email+OTP with dual-layer security (session cookies + JWT)

## Phase Execution Flow

```
Phase 0: Stack Clarification (orchestrate-clarification)
    └→ Confirm stack config, auth architecture, constraints

Phase 1: Requirements (orchestrate-synthesis)
    └→ Follow develop-requirements pattern: user stories, NFRs, RTM

Phase 2: Architecture (orchestrate-synthesis)
    └→ Follow develop-architecture pattern: HLD, LLD, API specs, DB schema

Phase 3: UI/UX Design (orchestrate-synthesis)
    └→ Follow develop-ui-ux pattern: design system with Tailwind

Phase 4: Frontend Development (orchestrate-generation)
    └→ Generate Flask app with Lit components and Tailwind styles
    └→ Implement session cookie authentication

Phase 5: Backend Development (orchestrate-generation)
    └→ Follow develop-backend pattern: FastAPI + PostgreSQL
    └→ Implement JWT authentication and email+OTP flow

Phase 6: Integration (orchestrate-synthesis)
    └→ Integrate frontend and backend, verify E2E flows

Phase 7: QA Validation (orchestrate-validation, REMEDIATION)
    └→ Follow perform-qa-analysis pattern: comprehensive testing
    └→ On failure: loop back to Phase 4 (max 2 iterations)
```

## Directory Structure

```
develop_web_app/
├── __init__.py           # Package metadata
├── entry.py              # Self-configuring entry point
├── complete.py           # Self-configuring completion point
├── CLAUDE.md             # THIS FILE
└── content/              # Phase instruction markdown files
    ├── phase_0_stack_clarification.md
    ├── phase_1_requirements.md
    ├── phase_2_architecture.md
    ├── phase_3_ui_ux_design.md
    ├── phase_4_frontend_development.md
    ├── phase_5_backend_development.md
    ├── phase_6_integration.md
    └── phase_7_qa_validation.md
```

## Embedded Composite Skills

This skill has `composition_depth: 1`, indicating it orchestrates other composite skills:
- develop-requirements (Phase 1)
- develop-architecture (Phase 2)
- develop-ui-ux (Phase 3)
- develop-backend (Phase 5)
- perform-qa-analysis (Phase 7)

**Implementation Note:** Current `config.py` does not support direct embedded composite invocation. Instead, phase content files instruct synthesis/generation agents to follow the workflow patterns of these composite skills.

## Authentication Architecture

**Dual-Layer Security:**
1. **Frontend (Flask):** Session cookies with httpOnly flag, CSRF protection
2. **Backend (FastAPI):** JWT in Authorization header, stored in sessionStorage

**Email+OTP Flow:**
1. User enters email → Backend generates 8-digit OTP → Email sent
2. User enters OTP → Backend validates (max 3 attempts per 15min)
3. On success → Backend issues session cookie + JWT token
4. Frontend stores JWT in sessionStorage (NOT localStorage)
5. Subsequent requests include session cookie + JWT header

**Rate Limiting:**
- Max 3 OTP attempts per 15-minute window
- 5-minute cooldown after exceeding limit
- Counter resets on successful authentication

## Core Standards

1. **Absolute Imports:** All Python code uses absolute imports only
2. **CLAUDE.md:** Every code directory includes CLAUDE.md documentation
3. **TDD:** Test-first development with 70%+ coverage
4. **OWASP:** Top 10 controls implemented and verified

## Gate Criteria Summary

| Gate | Transition | Criteria |
|------|------------|----------|
| G0→1 | Stack → Requirements | Stack confirmed, auth architecture agreed |
| G1→2 | Requirements → Architecture | User stories approved, NFRs documented, RTM created |
| G2→3 | Architecture → UI/UX | HLD/LLD complete, API specs finalized, DB schema designed |
| G3→4 | UI/UX → Frontend | Design tokens defined, component specs complete, WCAG AA validated |
| G4→5 | Frontend → Backend | Flask app functional, Lit components rendered, 70%+ coverage |
| G5→6 | Backend → Integration | FastAPI endpoints operational, PostgreSQL live, 70%+ coverage |
| G6→7 | Integration → QA | Frontend-backend verified, E2E paths tested |
| G7→Complete | QA → Done | Testing pyramid compliant (70/20/10), quality score >= 0.75 |
| G7→Phase 4 | REMEDIATION | QA fails with frontend issues (max 2 cycles) |

## Remediation Strategy

Phase 7 (QA Validation) uses REMEDIATION type:
- **Target:** Phase 4 (Frontend Development)
- **Max Iterations:** 2
- **Rationale:** Frontend is most likely failure point; preserves validated work in Phases 0-3

If QA identifies backend issues, manual intervention may be required (not automated remediation).

## Resources

Skills-side resources:
- `${CAII_DIRECTORY}/.claude/skills/develop-web-app/SKILL.md` - Full skill definition
- `${CAII_DIRECTORY}/.claude/skills/develop-web-app/resources/validation-checklist.md` - QA checklist
- `${CAII_DIRECTORY}/.claude/skills/develop-web-app/resources/auth-flow.md` - Auth architecture details

## Configuration

Default configuration defined in `config.py`:
```python
DEVELOP_WEB_APP_CONFIG = {
    "frontend_framework": "flask",
    "component_library": "lit",
    "css_framework": "tailwind",
    "backend_framework": "fastapi",
    "database": "postgresql",
    "auth_frontend": {"validation": "session_cookie", "csrf_protection": True},
    "auth_backend": {"validation": "jwt_header", "jwt_storage": "session_storage"},
    "auth_method": {"type": "email_otp", "otp_length": 8, "rate_limit_attempts": 3, "rate_limit_window": 900, "cooldown_duration": 300},
    "import_style": "absolute",
    "documentation_standard": "claude_md",
    "tdd_enforcement": True,
    "test_coverage_target": 70,
    "compliance_frameworks": ["owasp"],
}
```

## Common Pitfalls

- Mixing relative and absolute imports
- Missing CLAUDE.md in code directories
- Implementing before writing tests (violates TDD)
- Insufficient test coverage
- Missing OWASP controls
- Hardcoded secrets
- JWT in localStorage (security risk - use sessionStorage)
- Missing httpOnly flag on session cookies
- Inadequate rate limiting on OTP attempts

## Entry/Completion

- **Entry:** Self-configuring via `common_skill_entry.skill_entry()`
- **Completion:** Self-configuring via `common_skill_complete.skill_complete()`
- Both derive skill name from directory name: `develop_web_app` → `develop-web-app`
