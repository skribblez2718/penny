# World-Class PRD Template

Reference for piper when generating questionnaire prompts and for synthia when synthesizing PRDs. Not all sections apply to every task — scope determines depth.

## 1. Overview
One paragraph. What are we building and why now?
```
"We're building a rate limiting system for the auth API to prevent brute-force attacks. 
Currently, attackers can attempt unlimited login requests with no throttling."
```

## 2. Problem Statement
Who's affected, quantified pain, why current approaches fail.
```
"Security audit found 14,000 failed login attempts in 24h from a single IP. 
Our SOC team can't distinguish attacks from legitimate traffic. 
This is our #1 security gap per Q2 audit."
```

## 3. Success Metrics
Measurable outcomes. Pick 2-5 concrete, testable indicators.
```
- Failed login attempts from single IP: reduced 95%+ 
- Legitimate user login success rate: unchanged (≥98%)
- P99 login latency: <50ms added overhead
```

## 4. User Stories
Format: "As a [persona], I want [action], so that [benefit]." Each story requires acceptance criteria.
```
1. As a user, I want to log in normally, so that rate limiting doesn't block legitimate access.
   Acceptance: 5 successful logins within 60s window all succeed.

2. As an attacker, I want to brute-force passwords, so that I can gain unauthorized access.
   Acceptance: After 5 failed attempts from same IP in 60s, subsequent attempts return 429.
```

## 5. Features (max 5 per iteration)
Priority: P0 (must have), P1 (should have), P2 (nice to have).
```
| P0 | Rate limit counter | Track failed attempts per IP with 60s sliding window |
| P0 | 429 response | Return HTTP 429 with Retry-After header when exceeded |
| P1 | Rate limit headers | X-RateLimit-Remaining, X-RateLimit-Reset headers |
| P2 | Admin override | Manual rate limit reset for support staff |
```

## 6. Out of Scope
What will NOT be built. Write it down so it stays excluded.
```
- IP whitelisting/blacklisting
- Geo-based rate limiting
- User-specific rate limits (per-account, not per-IP)
- Redis cluster for distributed rate limiting (v1 uses in-memory)
```

## 7. Non-Functional Requirements
Performance, security, reliability, maintainability.
```
- Performance: <5ms overhead per request (in-memory counter)
- Security: Rate limit counter must not leak via timing side-channel
- Reliability: Counter reset on service restart is acceptable for v1
- Compliance: Rate limit events logged to audit trail
```

## 8. Dependencies & Constraints
External systems, APIs, platform limits.
```
- Python 3.12+, Flask 3.x (existing stack)
- No new dependencies (use collections.defaultdict + time)
- Must work behind nginx reverse proxy (use X-Forwarded-For)
```

## 9. Risks & Assumptions
```
- Risk: Shared IPs (NAT, corporate VPN) could rate-limit innocent users
  Mitigation: Higher threshold for known corporate IP ranges (future)

- Assumption: In-memory storage adequate for single-instance deployment
  Risk: Won't scale horizontally without shared state (Redis in v2)
```

## 10. Edge Cases
What if scenarios. Anticipate failures.
```
- What if X-Forwarded-For header is missing or spoofed?
- What if Redis (future) is unreachable? Fallback to in-memory?
- What if 10,000 unique IPs attack simultaneously? Memory pressure?
- What happens during server restart? Counters reset.
```

## 11. Build Order
Implementation sequence. Dependencies first.
```
1. Rate limit counter (in-memory, sliding window) → unit tests
2. 429 response with Retry-After header → integration tests  
3. Rate limit headers (X-RateLimit-*) → unit tests
4. Admin override endpoint (P2) → E2E tests
5. Logging to audit trail → integration tests
```

## 12. Deliverables
All artifacts this task produces.
```
- src/auth/rate_limit.py (rate limit counter)
- src/auth/middleware.py (429 response + headers)
- tests/test_rate_limit.py (unit tests)
- tests/test_rate_limit_integration.py (integration tests)
- docs/rate-limiting.md (operational docs)
- CHANGELOG.md entry
```

## Scope Calibration

| Task Type | Sections to Cover | Question Depth |
|-----------|------------------|----------------|
| Targeted bug fix | 1-2, 5, 8, 10 | 3-4 questions |
| Single feature | 1-6, 8, 10-12 | 6-8 questions |
| New module/system | All 12 sections | Full PRD questionnaire |
