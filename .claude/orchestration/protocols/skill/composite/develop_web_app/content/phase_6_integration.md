# Phase 6: Integration

**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Integrate frontend and backend, verify end-to-end flows

## Context

This phase synthesizes the integration of the Flask+Lit+Tailwind frontend (Phase 4) with the FastAPI+PostgreSQL backend (Phase 5). Verify that the dual-layer authentication (session cookies + JWT) works end-to-end.

## Integration Focus Areas

### 1. Authentication Flow Integration

Verify complete auth flow:

**Login Flow:**
1. User enters email in Flask frontend (auth-login.js Lit component)
2. Frontend POSTs to FastAPI `/auth/login`
3. Backend generates OTP, sends email, returns success
4. Frontend displays OTP entry form (auth-verify.js)
5. User enters OTP from email
6. Frontend POSTs OTP to FastAPI `/auth/verify`
7. Backend validates OTP, generates JWT, creates session
8. Backend returns session cookie (httpOnly) + JWT token
9. Frontend stores JWT in sessionStorage
10. Frontend redirects to authenticated view

**Authenticated Request Flow:**
1. Frontend makes API request with:
   - Session cookie (automatic, httpOnly)
   - Authorization: Bearer <JWT> header
2. Flask middleware validates session cookie
3. FastAPI middleware validates JWT
4. Request proceeds to handler
5. Response returns to frontend

**Logout Flow:**
1. Frontend calls `/auth/logout`
2. Backend invalidates session and JWT
3. Frontend clears sessionStorage
4. Frontend redirects to login

### 2. API Contract Verification

Verify API integration:
- **Endpoint Alignment:** Frontend calls match backend endpoints
- **Request/Response Schemas:** Pydantic models match frontend expectations
- **Error Handling:** Frontend handles all backend error responses
- **CORS Configuration:** Backend allows frontend origin (if different hosts)

### 3. End-to-End Test Paths

Create E2E tests for critical flows:
- **Happy Path:** Email → OTP → Login → Authenticated request → Logout
- **Invalid Email:** Frontend validates, backend rejects
- **Wrong OTP:** Attempts increment, max 3 reached → locked
- **Expired OTP:** Backend rejects, frontend shows error
- **Rate Limiting:** 3 failed attempts → 5-minute cooldown
- **Session Expiry:** JWT expires → frontend redirects to login
- **CSRF Protection:** Invalid CSRF token → request rejected

### 4. Integration Testing

Implement integration tests:
- **Playwright/Selenium:** Browser-based E2E tests
- **API Testing:** Direct API calls simulating frontend
- **Database State:** Verify OTP records, session creation, user records

### 5. Configuration Integration

Align configurations:
- **Environment Variables:** Backend API URL in frontend config
- **CORS Settings:** Allowed origins for frontend
- **Session Settings:** Cookie domain, path, secure flag alignment
- **JWT Settings:** Shared secret or public key for validation

### 6. Documentation Integration

Create integrated documentation:
- **API Integration Guide:** How frontend calls backend
- **Auth Flow Diagram:** Complete login/logout flow
- **Error Handling Guide:** All error scenarios and frontend responses
- **Deployment Guide:** Running frontend + backend together

## Context from Previous Phases

- **Phase 4:** Flask frontend with session cookie auth, API integration code
- **Phase 5:** FastAPI backend with JWT auth, API endpoints, database

## Gate Criteria

- [ ] Authentication flow working end-to-end
- [ ] All API endpoints functional from frontend
- [ ] Dual-layer security verified (session cookies + JWT)
- [ ] E2E test suite passing
- [ ] Error handling verified for all scenarios
- [ ] CORS configured correctly (if applicable)
- [ ] Integration documentation complete

## Integration Patterns

### Dual-Layer Authentication

**Why Both Session Cookies and JWT:**
- **Session Cookies:** Protect against XSS (httpOnly flag prevents JS access)
- **JWT in Headers:** API authentication, can be sent to mobile apps
- **Combined:** Defense in depth, both must be valid

**Implementation:**
- Flask middleware checks session cookie
- FastAPI middleware checks JWT in Authorization header
- Both must validate for request to proceed

### Error Response Standardization

Backend error format:
```json
{
  "error": {
    "code": "AUTH_INVALID_OTP",
    "message": "Invalid or expired OTP",
    "details": {},
    "timestamp": "2026-01-18T12:00:00Z"
  }
}
```

Frontend error handling:
- Parse error response
- Display user-friendly message
- Log technical details
- Handle retry logic

## Output Artifacts

- Integration test suite (E2E)
- API integration documentation
- Auth flow diagram (updated with actual implementation)
- Error handling guide
- Deployment guide (frontend + backend)
- Configuration examples (env files)

## Agent Invocation

```markdown
# Agent Invocation: synthesis

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `6`
- **Domain:** `technical`
- **Agent:** `synthesis`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Synthesize integration of Flask frontend with FastAPI backend
- Verify dual-layer authentication (session cookies + JWT) works E2E
- Create E2E test suite for critical auth flows
- Document complete integration patterns
- Validate error handling across frontend-backend boundary

## Johari Context

### Open (from Phase 4-5)
{Frontend artifacts, backend artifacts, API contracts, auth implementations}

## Task

Synthesize the integration of frontend and backend components. Verify that email+OTP authentication with dual-layer security works end-to-end. Create E2E tests and integration documentation.

Ensure integration:
- Session cookies and JWT both validate
- All API endpoints accessible from frontend
- Error handling works across tiers
- CORS configured correctly
- E2E tests cover critical flows

## Related Research Terms

- End-to-end testing
- API integration testing
- CORS configuration
- Session cookie authentication
- JWT header authentication
- Playwright browser testing
- Error response standardization
- Integration documentation

## Output

Write findings to: `.claude/memory/{task-id}-synthesis-memory.md`

Include:
- Integration test results
- E2E flow verification
- Error scenarios tested
- Documentation artifacts created
```
