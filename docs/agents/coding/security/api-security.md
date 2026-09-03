# API Security

## Applies when

Adding or changing endpoints, RPC handlers, webhooks, machine interfaces, object access, sockets, or public/private route classification.

## Security properties

- Each interface is intentionally classified public or protected, with operation-level controls.
- Inputs, object/property access, response data, idempotency, and consumption are bounded at the interface.

## Requirements

- Document route purpose, audience, authentication mode, authorization boundary, accepted content types, schemas, pagination/query limits, errors, and observability.
- Apply object/property authorization and explicit writable-field allowlists through their owning guides.
- Use route-, source-, identity-, cost-, and global budgets rather than one universal request-rate value; classify sockets and webhooks with equivalent limits.
- Review CORS, debug/schema/admin exposure, idempotency, and third-party callbacks explicitly.

## Failure modes

- Authenticating every endpoint without declaring intentionally public endpoints.
- Using an IP-only or universal request count as the complete abuse control.
- Assuming a route-level check covers object properties, webhooks, subscriptions, or background side effects.

## Verification

- Test public/private classification, authorization, invalid content types, payload/query bounds, pagination, idempotency, and abusive consumption paths.
- Inspect deployed CORS, route inventory, and debug/administrative exposure.

## Related guidance

- [Authorization](authorization.md), [input validation](input-validation.md), [resource limits](resource-limits.md), and [anti-automation](anti-automation.md) own their detailed controls.
- [Logging and monitoring](logging-monitoring.md) and [error handling](error-handling.md) cover operational behavior.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
