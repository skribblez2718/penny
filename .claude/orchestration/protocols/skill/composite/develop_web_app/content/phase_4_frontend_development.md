# Phase 4: Frontend Development

**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Generate Flask application with Lit components and Tailwind styling

## Context

This phase generates the complete frontend using TDD methodology. Create a Flask application serving Lit web components styled with Tailwind CSS, implementing session cookie authentication.

## Creation Cycle: TDD (RED-GREEN-REFACTOR)

Follow test-driven development:
1. **RED:** Write failing test for feature
2. **GREEN:** Implement minimum code to pass test
3. **REFACTOR:** Clean up while keeping tests passing

## Generation Focus Areas

### 1. Flask Application Structure

**Python Environment Reference:** `${CAII_DIRECTORY}/.claude/orchestration/shared/skills/code-generation/python-setup.md`

Generate Flask app:

```
frontend/
├── .venv/                 # MANDATORY - uv venv (gitignored)
├── app.py                 # Flask application entry
├── __init__.py
├── CLAUDE.md              # Directory documentation
├── config.py              # Configuration management
├── pyproject.toml         # MANDATORY - Project config and dependencies
├── uv.lock                # AUTO-GENERATED - Locked dependencies
├── static/
│   ├── js/
│   │   └── components/    # Lit web components
│   ├── css/
│   │   └── tailwind.css   # Compiled Tailwind
│   └── assets/            # Images, fonts
├── templates/
│   ├── base.html          # Base template
│   ├── index.html         # Main app template
│   └── auth/              # Auth templates
│       ├── login.html
│       └── verify.html
├── routes/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── auth.py            # Auth routes
│   └── app_routes.py      # Application routes
├── middleware/
│   ├── __init__.py
│   ├── CLAUDE.md
│   └── session.py         # Session management
└── tests/
    ├── __init__.py
    ├── CLAUDE.md
    ├── test_routes.py
    ├── test_auth.py
    └── test_components.py
```

### 2. Lit Web Components

Generate Lit components (static/js/components/):
- `auth-login.js` - Email input form
- `auth-verify.js` - OTP input form
- `session-indicator.js` - Authentication status
- `app-header.js` - Navigation header
- `app-footer.js` - Footer component
- `form-input.js` - Reusable input component
- `button-component.js` - Button with loading states
- `toast-notification.js` - Toast messages

Each component:
- Extends `LitElement`
- Uses Tailwind classes for styling
- Implements ARIA attributes
- Handles events and state
- 70%+ test coverage (Jest or similar)

### 3. Tailwind Configuration

Generate tailwind.config.js using design tokens from Phase 3:
- Custom colors, typography, spacing
- Responsive breakpoints
- Plugin configuration

Generate PostCSS config for Tailwind compilation.

### 4. Session Cookie Authentication

Implement session management:
- **Session Creation:** On successful OTP verification (from backend)
- **Session Storage:** Flask session with httpOnly, secure, sameSite flags
- **CSRF Protection:** CSRF tokens on all forms
- **Session Validation:** Middleware checking session on protected routes
- **Session Logout:** Clear session on logout

### 5. API Integration

Integrate with FastAPI backend (from Phase 5):
- **Auth Endpoints:** POST `/auth/login`, POST `/auth/verify`, POST `/auth/logout`
- **Application Endpoints:** Per requirements
- **Error Handling:** Network errors, API errors, timeout handling
- **Request Patterns:** Fetch API with JWT in headers (for backend auth)

### 6. Testing (TDD)

Generate test files with 70%+ coverage:
- **Unit Tests:** Component logic, route handlers, utilities
- **Integration Tests:** Route+template rendering, middleware
- **E2E Tests:** Full auth flow (playwright/selenium)

### 7. Documentation

Generate CLAUDE.md files documenting:
- Application structure and entry points
- Route definitions and handlers
- Component hierarchy and props
- Testing strategy and coverage
- Deployment instructions

## Context from Previous Phases

- **Phase 0:** Stack config, auth params
- **Phase 1:** User stories, functional requirements
- **Phase 2:** API endpoints, component architecture
- **Phase 3:** Design tokens (Tailwind config), component specs

## Gate Criteria

- [ ] Flask application functional and serving templates
- [ ] Lit web components rendered and interactive
- [ ] Tailwind CSS compiled and applied
- [ ] Session cookie authentication implemented
- [ ] CSRF protection enabled on forms
- [ ] 70%+ test coverage achieved
- [ ] All tests passing
- [ ] CLAUDE.md documentation in all directories
- [ ] Absolute imports only (no relative imports)

## Quality Standards

1. **Absolute Imports:** All Python imports are absolute
2. **TDD Compliance:** Tests written before implementation
3. **Test Coverage:** 70%+ coverage verified
4. **OWASP Controls:** CSRF protection, secure session flags
5. **Accessibility:** ARIA attributes, semantic HTML
6. **Documentation:** CLAUDE.md in every code directory

## Output Artifacts

- Complete Flask application code
- Lit web components (JS files)
- Tailwind configuration and compiled CSS
- Test suite with 70%+ coverage
- CLAUDE.md documentation files
- pyproject.toml with dependencies (managed via `uv add`)
- Setup/deployment instructions

## Agent Invocation

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `4`
- **Domain:** `technical`
- **Agent:** `generation`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Generate Flask app using TDD methodology (RED-GREEN-REFACTOR)
- Create Lit web components with Tailwind styling
- Implement session cookie authentication with CSRF protection
- Achieve 70%+ test coverage on all code
- Use absolute imports exclusively
- Document all directories with CLAUDE.md files

## Johari Context

### Open (from Phase 0-3)
{Stack config, user stories, API specs, design tokens, component specs}

## Task

Generate complete Flask+Lit+Tailwind frontend application using TDD. Implement session cookie authentication integrating with FastAPI backend. Apply design system from Phase 3 and API contracts from Phase 2.

Ensure implementation:
- Follows TDD: tests before code
- Uses absolute imports only
- Includes CLAUDE.md in all directories
- Achieves 70%+ test coverage
- Implements OWASP security controls

## Related Research Terms

- Flask application structure
- Lit web components development
- Tailwind CSS compilation
- Session cookie security
- CSRF protection Flask
- TDD Python testing
- Absolute imports Python
- WCAG accessibility implementation

## Output

Write findings to: `.claude/memory/{task-id}-generation-memory.md`

Include:
- File paths of all generated artifacts
- Test coverage report
- TDD cycle documentation
- Integration points for Phase 5 backend
```
