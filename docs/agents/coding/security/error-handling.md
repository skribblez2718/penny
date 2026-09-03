# Secure Error Handling

## Applies when

Code handles malformed requests, parser failures, exceptions, partial state, retries, fallbacks, or user-visible errors.

## Security properties

- Failure paths preserve authorization, integrity, availability, and controlled disclosure.
- Partial work is atomic, compensated, or explicitly recoverable; retries do not multiply harmful effects.

## Requirements

- Fail closed on malformed, ambiguous, or unauthenticated/unauthorized input. Keep external errors stable and minimally disclosive while retaining safe internal diagnostic context.
- Define transaction/rollback, idempotency, retry, timeout, cancellation, and cleanup semantics for partial state.
- Do not substitute a permissive fallback, cached response, or debug mode after a security control fails.

## Failure modes

- Returning stack traces, secrets, internal topology, or authorization distinctions to callers.
- Retrying non-idempotent work blindly or committing partial state without a recovery plan.
- Catching exceptions and continuing with default-allow behavior.

## Verification

- Test malformed input, dependency failure, timeout, cancellation, duplicate delivery, partial-state recovery, and error redaction.
- Inspect logs/metrics to ensure diagnosis remains possible without exposing sensitive data.

## Related guidance

- [Logging and monitoring](logging-monitoring.md) owns operational visibility.
- [Configuration](configuration.md), [API security](api-security.md), and [incident response](incident-response.md) own related controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
