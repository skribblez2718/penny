# API Security — Secure API design for generated code

## What

Every generated API endpoint must apply authentication, authorization, rate limiting, and input validation. No endpoint is exempt.

## Why

APIs are the primary attack surface for web applications. An unauthenticated, unvalidated endpoint is an open door.

## Rules

1. **Authenticate every endpoint.** No anonymous access unless explicitly designed as public.
2. **Authorize per operation.** Check that the authenticated user has permission for this specific action.
3. **Rate limit all endpoints.** 100 req/min per user default; lower for auth endpoints.
4. **Validate all inputs.** See input validation rules.
5. **Use HTTPS only.** Redirect HTTP to HTTPS. Set HSTS headers.
6. **Set security headers.** `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

## Constraints

- **CRITICAL severity.** Missing auth on non-public endpoints must be fixed.
- **Rate limiting is mandatory on login, password reset, and token endpoints.**

## Verification

- [ ] All endpoints authenticated (except explicit public)
- [ ] Authorization checked per operation
- [ ] Rate limiting configured
- [ ] HTTPS enforced with HSTS
- [ ] Security headers set

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/authentication.md` | Auth patterns |
| `docs/agents/coding/security/input-validation.md` | Input validation |
