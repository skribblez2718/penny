# Phase 7: QA Validation

**Agent:** orchestrate-validation
**Type:** REMEDIATION (loops to Phase 4 on failure)
**Purpose:** Follow perform-qa-analysis workflow pattern for comprehensive testing

## Context

This phase validates the complete web application following the perform-qa-analysis composite skill workflow pattern. The validation agent should verify quality across all tiers: frontend, backend, integration, and security.

**Remediation:** If validation fails with frontend issues, loop back to Phase 4 (Frontend Development). Maximum 2 remediation cycles.

## Workflow Pattern: perform-qa-analysis

Follow the perform-qa-analysis skill phases:
1. Test Strategy Definition
2. Test Execution (unit, integration, E2E)
3. Quality Metrics Analysis
4. Issue Triage and Remediation Planning
5. Validation Report

**Reference:** `perform-qa-analysis` skill documentation

## Validation Focus Areas

### 1. Testing Pyramid Validation

Verify testing pyramid compliance (70/20/10 ratio):

**Unit Tests (70%):**
- Frontend: Lit component logic, utility functions
- Backend: Service functions, OTP generation, JWT validation
- Target: 70%+ code coverage on both tiers

**Integration Tests (20%):**
- Frontend: Route handlers with templates
- Backend: API endpoints with database
- Auth flow: Login → OTP → JWT issuance

**E2E Tests (10%):**
- Complete user flows in browser
- Auth flow: Email entry → OTP → Authenticated session → Logout
- Error scenarios: Invalid email, wrong OTP, rate limiting

### 2. Security Validation (OWASP)

Verify OWASP Top 10 controls:

| Control | Validation |
|---------|------------|
| A01 Broken Access Control | JWT validation, session validation, authorization checks |
| A02 Cryptographic Failures | HTTPS enforcement, JWT signing, secure session cookies |
| A03 Injection | SQL injection tests, input validation (Pydantic) |
| A04 Insecure Design | Auth flow review, rate limiting, secure defaults |
| A05 Security Misconfiguration | httpOnly cookies, CSRF protection, CORS settings |
| A06 Vulnerable Components | Dependency scan (safety, bandit) |
| A07 Authentication Failures | OTP attempts, rate limiting, session expiry |
| A08 Software/Data Integrity | JWT signature validation, migration checksums |
| A09 Logging Failures | Audit trail for auth events, no secrets in logs |
| A10 SSRF | Input validation on URLs (if applicable) |

Run security scan tools:
- **bandit:** Python code security scanner
- **safety:** Dependency vulnerability scanner
- **OWASP ZAP:** Web application security scanner (if applicable)

### 3. Accessibility Validation (WCAG AA)

Verify WCAG AA compliance:
- **Color Contrast:** >= 4.5:1 for normal text, >= 3:1 for large text
- **Keyboard Navigation:** All interactive elements keyboard accessible
- **Focus Indicators:** Visible focus states on all controls
- **ARIA Attributes:** Proper labels, roles, states
- **Form Validation:** Error messages associated with inputs
- **Screen Reader:** Test with NVDA/JAWS/VoiceOver

Tools:
- **axe DevTools:** Automated accessibility testing
- **Lighthouse:** Accessibility audit
- **Manual Testing:** Keyboard-only navigation, screen reader

### 4. Performance Validation

Verify performance metrics:
- **Frontend Load Time:** < 3 seconds for initial load
- **API Response Time:** < 200ms for 95th percentile
- **Database Query Time:** Indexed queries, < 100ms
- **Concurrent Users:** Load testing (target from NFRs)

Tools:
- **Lighthouse:** Performance audit
- **Locust/k6:** Load testing
- **PostgreSQL EXPLAIN:** Query analysis

### 5. Code Quality Validation

Verify code standards:
- **Absolute Imports:** No relative imports in Python code
- **CLAUDE.md:** Present in all code directories
- **Test Coverage:** 70%+ on frontend and backend
- **Linting:** flake8/black (Python), ESLint (JavaScript)
- **Type Checking:** mypy (Python), TypeScript (if applicable)

### 6. Integration Validation

Verify integration quality:
- **API Contract Alignment:** Frontend calls match backend OpenAPI spec
- **Error Handling:** All error scenarios handled gracefully
- **CORS:** Properly configured for frontend origin
- **Session Management:** Session cookies and JWT both required
- **Data Flow:** End-to-end data integrity

## Validation Checklist

Use checklist at: `${CAII_DIRECTORY}/.claude/skills/develop-web-app/resources/validation-checklist.md`

## Quality Score Calculation

Calculate quality score (target >= 0.75):

```
quality_score = (
    test_coverage * 0.25 +
    security_score * 0.30 +
    accessibility_score * 0.15 +
    performance_score * 0.15 +
    code_quality_score * 0.15
)
```

Each component scored 0.0-1.0.

## Remediation Decision

If validation fails:

**Frontend Issues (Phase 4 remediation):**
- Lit component bugs
- Tailwind styling issues
- Frontend test failures
- Accessibility failures in UI
- Session cookie handling

**Backend Issues (manual intervention):**
- FastAPI endpoint bugs
- Database query issues
- JWT validation failures
- OTP generation/validation bugs

**Integration Issues (manual intervention):**
- CORS misconfigurations
- API contract mismatches
- E2E test failures spanning both tiers

## Gate Criteria

- [ ] Testing pyramid validated (70/20/10 ratio)
- [ ] Test coverage >= 70% on frontend and backend
- [ ] OWASP Top 10 controls verified
- [ ] Security scan passed (no high/critical vulnerabilities)
- [ ] WCAG AA compliance verified
- [ ] Performance benchmarks met
- [ ] Code quality standards met (absolute imports, CLAUDE.md, linting)
- [ ] Quality score >= 0.75

## Remediation Flow

```
If quality_score < 0.75:
    If frontend_issues and remediation_count < 2:
        Loop back to Phase 4 (Frontend Development)
        Increment remediation_count
    Else if backend_issues:
        HALT with manual intervention required
    Else:
        HALT with issue triage report
Else:
    Proceed to SKILL_COMPLETE
```

## Output Artifacts

- Validation report (test results, security scan, quality score)
- Issue triage document (if failures found)
- Remediation plan (if looping back to Phase 4)
- Quality metrics dashboard
- Compliance verification (OWASP, WCAG)

## Agent Invocation

```markdown
# Agent Invocation: validation

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `7`
- **Domain:** `technical`
- **Agent:** `validation`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Follow perform-qa-analysis workflow pattern
- Validate testing pyramid (70/20/10 ratio)
- Verify OWASP Top 10 controls implemented
- Check WCAG AA accessibility compliance
- Calculate quality score (target >= 0.75)
- Determine remediation target if validation fails

## Johari Context

### Open (from Phase 0-6)
{All prior artifacts: frontend code, backend code, tests, integration}

## Task

Validate the complete web application following the perform-qa-analysis workflow pattern. Verify testing pyramid, security controls, accessibility, performance, and code quality. Calculate quality score and determine if remediation is needed.

If quality_score < 0.75 or critical failures exist:
- Frontend issues → remediate to Phase 4
- Backend/integration issues → HALT with triage report

## Related Research Terms

- Testing pyramid validation
- OWASP Top 10 verification
- WCAG AA compliance testing
- Security vulnerability scanning
- Quality metrics calculation
- Code coverage analysis
- Performance benchmarking
- Remediation planning

## Output

Write findings to: `.claude/memory/{task-id}-validation-memory.md`

Include:
- Quality score calculation
- Test coverage results
- Security scan results
- Accessibility audit results
- Remediation decision (PASS / REMEDIATE_PHASE_4 / HALT)
```
