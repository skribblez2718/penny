# Develop-web-app Validation Checklist

Use this checklist in Phase 7 (QA Validation) to verify all quality criteria.

## Testing Pyramid (70/20/10)

### Unit Tests (70%)

**Frontend (Flask + Lit):**
- [ ] Lit component rendering tests
- [ ] Component event handler tests
- [ ] Utility function tests
- [ ] Route handler unit tests
- [ ] Middleware unit tests
- [ ] Coverage >= 70%

**Backend (FastAPI):**
- [ ] Service function tests (auth_service, otp_service)
- [ ] OTP generation tests
- [ ] JWT validation tests
- [ ] Rate limiting logic tests
- [ ] Email service tests (mocked)
- [ ] Coverage >= 70%

### Integration Tests (20%)

**Frontend:**
- [ ] Route + template rendering tests
- [ ] Session middleware integration tests
- [ ] CSRF protection tests

**Backend:**
- [ ] API endpoint + database tests
- [ ] Auth flow integration tests
- [ ] Database transaction tests

### E2E Tests (10%)

- [ ] Complete auth flow: email → OTP → login → logout
- [ ] Invalid email handling
- [ ] Wrong OTP handling (max 3 attempts)
- [ ] Rate limiting enforcement
- [ ] Session expiry handling
- [ ] CSRF token validation

## Security (OWASP Top 10)

### A01: Broken Access Control
- [ ] JWT validation on protected endpoints
- [ ] Session cookie validation on protected routes
- [ ] Authorization checks (if role-based access)

### A02: Cryptographic Failures
- [ ] HTTPS enforced in production
- [ ] JWT signed with strong algorithm (HS256/RS256)
- [ ] Session cookies with secure flag
- [ ] No secrets in code or logs

### A03: Injection
- [ ] SQLAlchemy ORM used (no raw SQL)
- [ ] Pydantic input validation on all endpoints
- [ ] Email format validation
- [ ] SQL injection tests passed

### A04: Insecure Design
- [ ] Rate limiting implemented (3 attempts/15min)
- [ ] OTP expiry enforced (5 minutes)
- [ ] Cooldown after max attempts (5 minutes)
- [ ] Secure session defaults

### A05: Security Misconfiguration
- [ ] Session cookies: httpOnly, secure, sameSite
- [ ] CSRF protection enabled on forms
- [ ] CORS configured properly
- [ ] No default credentials

### A06: Vulnerable and Outdated Components
- [ ] `safety` scan passed (Python dependencies)
- [ ] `npm audit` passed (Node dependencies)
- [ ] All dependencies up to date

### A07: Identification and Authentication Failures
- [ ] OTP attempts tracked and limited
- [ ] Session expiry enforced
- [ ] JWT expiry enforced
- [ ] No credential stuffing vulnerabilities

### A08: Software and Data Integrity Failures
- [ ] JWT signature validation
- [ ] Database migration checksums
- [ ] No unsigned/unverified code execution

### A09: Security Logging and Monitoring Failures
- [ ] Auth events logged (login, OTP request, failures)
- [ ] No sensitive data in logs (no OTPs, JWTs)
- [ ] Failed login attempts logged
- [ ] Audit trail complete

### A10: Server-Side Request Forgery (SSRF)
- [ ] URL input validation (if applicable)
- [ ] No user-controlled outbound requests

## Accessibility (WCAG AA)

### Perceivable
- [ ] Color contrast >= 4.5:1 for normal text
- [ ] Color contrast >= 3:1 for large text
- [ ] Images have alt text
- [ ] Semantic HTML used
- [ ] Form labels associated with inputs

### Operable
- [ ] All interactive elements keyboard accessible
- [ ] Focus indicators visible
- [ ] No keyboard traps
- [ ] Skip navigation links present

### Understandable
- [ ] Form error messages clear
- [ ] Error messages associated with inputs (ARIA)
- [ ] Consistent navigation
- [ ] Language attribute set (html lang)

### Robust
- [ ] Valid HTML (W3C validator)
- [ ] ARIA attributes correct
- [ ] Screen reader tested (NVDA/JAWS/VoiceOver)

## Performance

### Frontend
- [ ] Initial load < 3 seconds
- [ ] First Contentful Paint < 1.8s
- [ ] Time to Interactive < 3.8s
- [ ] Lighthouse performance score >= 90

### Backend
- [ ] API response time < 200ms (95th percentile)
- [ ] Database queries indexed
- [ ] Query time < 100ms
- [ ] Concurrent user target met (from NFRs)

### Load Testing
- [ ] Load test executed (Locust/k6)
- [ ] No errors under expected load
- [ ] Response times stable under load

## Code Quality

### Python (Backend)
- [ ] Absolute imports only (no relative imports)
- [ ] CLAUDE.md in all directories
- [ ] flake8 passed
- [ ] black formatting applied
- [ ] mypy type checking passed
- [ ] No hardcoded secrets

### JavaScript (Frontend)
- [ ] ESLint passed
- [ ] Prettier formatting applied
- [ ] No console.log in production

### Documentation
- [ ] CLAUDE.md in every code directory
- [ ] API documentation generated (OpenAPI)
- [ ] README with setup instructions
- [ ] Deployment guide present

## Integration

### API Contract
- [ ] Frontend calls match backend OpenAPI spec
- [ ] Request schemas match Pydantic models
- [ ] Response schemas match frontend expectations
- [ ] Error responses standardized

### Authentication
- [ ] Session cookies set correctly
- [ ] JWT issued on successful OTP verification
- [ ] Both session and JWT validated on protected requests
- [ ] Logout clears both session and JWT

### CORS
- [ ] CORS headers configured
- [ ] Allowed origins match frontend
- [ ] Credentials allowed (for cookies)

### Error Handling
- [ ] Network errors handled
- [ ] API errors displayed to user
- [ ] Timeout handling implemented
- [ ] Retry logic (if applicable)

## Quality Score Calculation

Calculate quality score (target >= 0.75):

| Component | Weight | Score (0-1) | Weighted |
|-----------|--------|-------------|----------|
| Test Coverage | 0.25 | {frontend_cov + backend_cov} / 2 / 70 | |
| Security | 0.30 | {owasp_controls_passed} / 10 | |
| Accessibility | 0.15 | {wcag_checks_passed} / {total_wcag_checks} | |
| Performance | 0.15 | {perf_benchmarks_met} / {total_benchmarks} | |
| Code Quality | 0.15 | {quality_checks_passed} / {total_quality_checks} | |

**Total Quality Score:** {weighted_sum} (target >= 0.75)

## Remediation Decision

If quality_score < 0.75:
- **Frontend issues** (Lit components, Tailwind, session cookies) → Remediate to Phase 4
- **Backend issues** (FastAPI, PostgreSQL, JWT, OTP) → HALT with manual intervention
- **Integration issues** (CORS, API contract, E2E) → HALT with manual intervention

Maximum 2 remediation cycles to Phase 4.

## Sign-Off

- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] All E2E tests passing
- [ ] Security scan passed
- [ ] Accessibility audit passed
- [ ] Performance benchmarks met
- [ ] Code quality standards met
- [ ] Quality score >= 0.75
- [ ] Ready for deployment
