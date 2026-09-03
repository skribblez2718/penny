# CSRF and Browser State Transitions

## Applies when

Browser requests use ambient credentials or trigger state changes across origins.

## Security properties

- A cross-origin site cannot cause an authenticated state transition without the intended user interaction and server validation.
- Mutations have explicit replay and idempotency behavior where repeated execution matters.

## Requirements

- Use a defense-in-depth combination appropriate to the browser architecture: safe methods, Origin/Referer validation where applicable, anti-CSRF tokens, cookie policy, and explicit CORS.
- Require authorization for every mutation; never make GET or other safe retrieval semantics mutate state.
- Design replay/idempotency protections for costly, irreversible, or retry-prone operations.

## Failure modes

- Relying on a UI control, CORS alone, or SameSite alone.
- Making state changes through cacheable or link-prefetchable methods.

## Verification

- Test cross-origin form/fetch attempts, token and origin validation failures, and repeated delivery behavior.
- Verify protected mutations still require server-side authorization.

## Related guidance

- [Session security](session-security.md) owns session lifecycle.
- [API security](api-security.md) owns interface behavior; [authorization](authorization.md) owns permission decisions.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
