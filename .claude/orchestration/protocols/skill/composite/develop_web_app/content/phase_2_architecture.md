# Phase 2: Architecture

**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Follow develop-architecture workflow pattern to generate HLD, LLD, API specs, DB schema

## Context

This phase synthesizes architecture using the develop-architecture composite skill workflow pattern. The synthesis agent should follow the develop-architecture methodology to produce comprehensive architecture artifacts.

## Workflow Pattern: develop-architecture

Follow the develop-architecture skill phases:
1. High-Level Design (system components, interactions)
2. Low-Level Design (detailed component design)
3. API Design (OpenAPI specs)
4. Database Design (schema, indexes, migrations)
5. Architecture Decision Records (ADRs)

**Reference:** `develop-architecture` skill documentation

## Focus Areas

### 1. High-Level Design (HLD)

Design system architecture:
- **Frontend Tier:** Flask app structure, Lit component hierarchy, Tailwind config
- **Backend Tier:** FastAPI service architecture, middleware, dependencies
- **Data Tier:** PostgreSQL database, connection pooling, migrations
- **Auth Layer:** Email+OTP service, session management, JWT issuance
- **External Integrations:** Email service, logging, monitoring

### 2. Low-Level Design (LLD)

Detail component design:
- **Flask Application:** Routes, blueprints, static file serving, template rendering
- **Lit Components:** Component tree, state management, event handling
- **FastAPI Services:** Endpoint handlers, dependency injection, Pydantic models
- **PostgreSQL Schema:** Tables, relationships, constraints, indexes
- **Auth Components:** OTP generator, rate limiter, session store, JWT validator

### 3. API Design

Create OpenAPI specifications:
- **Auth Endpoints:** `/auth/login` (email), `/auth/verify` (OTP), `/auth/logout`
- **Application Endpoints:** CRUD operations per requirements
- **Request/Response Models:** Pydantic schemas
- **Error Responses:** Standardized error format
- **API Versioning:** Version strategy (/v1, /v2)

### 4. Database Design

Design PostgreSQL schema:
- **Users Table:** id, email, created_at, updated_at
- **Sessions Table:** id, user_id, token, expires_at
- **OTP Table:** id, email, code, attempts, expires_at, created_at
- **Application Tables:** Per requirements from Phase 1
- **Indexes:** Performance-critical queries
- **Migrations:** Alembic/SQLAlchemy migration strategy

### 5. Architecture Decisions

Document ADRs for:
- Stack selection rationale
- Email+OTP vs other auth methods
- Session cookies + JWT dual-layer approach
- Frontend component architecture (Lit)
- Backend async/sync design
- Database normalization decisions

## Context from Previous Phases

- **Phase 0:** Stack config, auth params, compliance scope
- **Phase 1:** User stories, NFRs, RTM

## Gate Criteria

- [ ] HLD complete with component diagram
- [ ] LLD finalized with detailed component specs
- [ ] OpenAPI specification generated for all endpoints
- [ ] Database schema designed with ER diagram
- [ ] Architecture Decision Records documented
- [ ] Design reviewed against NFRs

## Output Artifacts

- High-Level Design document
- Low-Level Design document
- OpenAPI specification (YAML/JSON)
- Database schema (SQL DDL)
- ER diagram
- Architecture Decision Records

## Agent Invocation

```markdown
# Agent Invocation: synthesis

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `2`
- **Domain:** `technical`
- **Agent:** `synthesis`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Follow develop-architecture workflow pattern
- Design Flask app structure with Lit component hierarchy
- Architect FastAPI service with email+OTP auth flow
- Design PostgreSQL schema supporting auth + application data
- Create OpenAPI specs for all backend endpoints
- Document ADRs for stack and auth decisions

## Johari Context

### Open (from Phase 0-1)
{Stack config, auth params, user stories, NFRs}

## Task

Synthesize comprehensive architecture following the develop-architecture workflow pattern. Design HLD, LLD, API specs, and DB schema for the Flask+Lit+Tailwind frontend with FastAPI+PostgreSQL backend.

Ensure architecture supports:
- Email+OTP authentication with rate limiting
- Session cookies (frontend) + JWT (backend) dual-layer security
- OWASP security controls
- Horizontal scalability
- 70%+ test coverage

## Related Research Terms

- High-level design patterns
- Low-level component design
- OpenAPI specification
- PostgreSQL schema design
- Architecture decision records
- Flask application structure
- FastAPI service architecture
- JWT authentication architecture

## Output

Write findings to: `.claude/memory/{task-id}-synthesis-memory.md`
```
