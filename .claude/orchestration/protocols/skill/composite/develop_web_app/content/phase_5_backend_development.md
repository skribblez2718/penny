# Phase 5: Backend Development

**Agent:** orchestrate-generation
**Type:** LINEAR
**Purpose:** Follow develop-backend workflow pattern to generate FastAPI backend with PostgreSQL

## Context

This phase generates the backend following the develop-backend composite skill workflow pattern. The generation agent should follow develop-backend phases adapted to the specific requirements of this web application.

## Workflow Pattern: develop-backend

Follow the develop-backend skill phases:
1. Requirements Clarification (auth, database, scalability)
2. API Design (OpenAPI from Phase 2)
3. Database Architecture (PostgreSQL schema from Phase 2)
4. Authentication & Security (JWT + email+OTP)
5. Architecture & Scalability (async, caching, circuit breakers)
6. Testing & Quality (TDD, 70%+ coverage)
7. Monitoring & Observability (logging, metrics, traces)
8. Final Validation (security scan, performance)

**Reference:** `develop-backend` skill documentation

## Generation Focus Areas

### 1. FastAPI Application Structure

Generate backend using develop-backend pattern:

```
backend/
├── main.py                # FastAPI app entry
├── __init__.py
├── CLAUDE.md
├── requirements.txt
├── api/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── auth.py            # Auth endpoints
│   ├── users.py           # User endpoints
│   └── app_endpoints.py   # Application endpoints
├── models/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── user.py            # SQLAlchemy User model
│   ├── session.py         # Session model
│   └── otp.py             # OTP model
├── schemas/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── auth.py            # Pydantic auth schemas
│   └── user.py            # Pydantic user schemas
├── services/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── auth_service.py    # Auth business logic
│   ├── otp_service.py     # OTP generation/validation
│   └── email_service.py   # Email sending
├── middleware/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── jwt_auth.py        # JWT validation
│   └── rate_limit.py      # Rate limiting
├── database/
│   ├── __init__.py
│   ├── CLAUDE.md
│   ├── connection.py      # DB connection pool
│   └── migrations/        # Alembic migrations
└── tests/
    ├── __init__.py
    ├── CLAUDE.md
    ├── test_auth.py
    ├── test_otp.py
    └── test_endpoints.py
```

### 2. Email+OTP Authentication Flow

Implement authentication per develop-backend Phase 4:
- **POST /auth/login:** Validate email, generate 8-digit OTP, send email, store with expiry
- **POST /auth/verify:** Validate OTP, check attempts (max 3), check rate limit (3/15min)
- **POST /auth/logout:** Invalidate JWT and session
- **Middleware:** JWT validation on protected endpoints

**OTP Service:**
- Generate cryptographically secure 8-digit codes
- Store: email, OTP, attempts, created_at, expires_at (5min)
- Validate: check expiry, check attempts <= 3, increment attempts
- Rate Limit: max 3 requests per 15-minute window, 5-minute cooldown

**JWT Service:**
- Issue JWT on successful OTP verification
- Store in response for frontend to save in sessionStorage
- Validate JWT signature and expiry on protected routes
- Use HS256 or RS256 algorithm

### 3. PostgreSQL Database

Implement schema from Phase 2:
- **users:** id, email, created_at, updated_at
- **sessions:** id, user_id, token, expires_at
- **otps:** id, email, code, attempts, expires_at, created_at
- **Application tables:** Per requirements

Use SQLAlchemy ORM with async support (asyncpg driver).
Generate Alembic migrations for schema versioning.

### 4. Security (OWASP)

Implement OWASP controls:
- **Input Validation:** Pydantic schemas, email format, SQL injection prevention
- **Authentication:** JWT with secure signing, OTP with rate limiting
- **Authorization:** Role-based access control (if applicable)
- **Data Protection:** Hash sensitive data, HTTPS only
- **Logging:** Audit trail for auth events, no sensitive data in logs
- **Error Handling:** Generic error messages, detailed logs server-side

### 5. Testing (TDD)

Generate tests with 70%+ coverage:
- **Unit Tests:** Service logic, OTP generation, JWT validation
- **Integration Tests:** API endpoints, database interactions
- **Security Tests:** SQL injection, XSS, auth bypass attempts

### 6. Monitoring & Observability

Implement per develop-backend Phase 7:
- **Logging:** Structured logs (JSON), log levels, request IDs
- **Metrics:** Request counts, latencies, error rates
- **Health Checks:** `/health` endpoint, database connectivity
- **Tracing:** Distributed tracing (if microservices)

## Context from Previous Phases

- **Phase 0:** Stack config, auth params
- **Phase 1:** User stories, security NFRs
- **Phase 2:** API specs, database schema, architecture
- **Phase 4:** Frontend API contract (endpoints consumed, auth flow)

## Gate Criteria

- [ ] FastAPI endpoints operational (per OpenAPI spec)
- [ ] PostgreSQL schema implemented with migrations
- [ ] Email+OTP authentication functional
- [ ] JWT issuance and validation working
- [ ] Rate limiting enforced (3 attempts/15min, 5min cooldown)
- [ ] 70%+ test coverage achieved
- [ ] OWASP security controls implemented
- [ ] Absolute imports only
- [ ] CLAUDE.md in all directories

## Quality Standards

1. **Absolute Imports:** All Python imports are absolute
2. **TDD Compliance:** Tests written before implementation
3. **Test Coverage:** 70%+ coverage verified
4. **OWASP Compliance:** Top 10 controls implemented
5. **Async Support:** Use async/await for I/O operations
6. **Documentation:** CLAUDE.md in every code directory

## Output Artifacts

- Complete FastAPI application code
- PostgreSQL schema and migrations
- Authentication services (OTP, JWT, email)
- Test suite with 70%+ coverage
- CLAUDE.md documentation files
- OpenAPI specification (auto-generated by FastAPI)
- Deployment/setup instructions

## Agent Invocation

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `5`
- **Domain:** `technical`
- **Agent:** `generation`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Follow develop-backend workflow pattern for FastAPI+PostgreSQL
- Implement email+OTP authentication with JWT issuance
- Generate database models and migrations
- Enforce rate limiting (3 attempts/15min, 5min cooldown)
- Achieve 70%+ test coverage using TDD
- Implement OWASP security controls

## Johari Context

### Open (from Phase 0-4)
{Stack config, API specs, database schema, frontend integration points}

## Task

Generate complete FastAPI+PostgreSQL backend following the develop-backend workflow pattern. Implement email+OTP authentication with rate limiting and JWT issuance. Integrate with Flask frontend from Phase 4.

Ensure implementation:
- Follows TDD methodology
- Uses absolute imports only
- Includes CLAUDE.md in all directories
- Achieves 70%+ test coverage
- Implements OWASP Top 10 controls
- Uses async/await for database operations

## Related Research Terms

- FastAPI async development
- PostgreSQL SQLAlchemy async
- JWT authentication FastAPI
- Email OTP implementation
- Rate limiting algorithms
- Pydantic validation
- Alembic migrations
- OWASP Top 10 controls

## Output

Write findings to: `.claude/memory/{task-id}-generation-memory.md`

Include:
- File paths of all generated artifacts
- Test coverage report
- Security controls implemented
- API endpoint documentation
```
