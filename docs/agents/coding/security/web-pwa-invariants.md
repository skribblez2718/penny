# Web and PWA Invariants

## Applies when

Browser-delivered, Internet-facing, API-backed, offline-capable, or service-worker-enabled application work.

## Security properties

- Server decisions remain authoritative despite browser, PWA, cache, and offline state.
- Public interfaces, browser execution, origin policy, caching, and resource consumption are explicit and bounded.

## Requirements

- Classify public and privileged routes, state transitions, browser storage, service-worker scope, cacheable responses, and external origins.
- Use defense in depth: server authorization, validation, rate/cost controls, browser policy, and safe operational visibility.
- Read every triggered detailed guide; this page is a routing baseline, not an implementation substitute.

## Failure modes

- Treating a PWA cache as an authority or a service worker as an ordinary static asset.
- Assuming CORS, CSP, or an edge control replaces server-side authorization and validation.

## Verification

- Test browser-originated mutation, cache/offline behavior, security headers, public-interface classification, and affected resource limits.
- Inspect the deployed route and origin configuration, not merely local source.

## Related guidance

- [Browser security](browser-security.md), [service workers](pwa-service-worker.md), and [XSS](xss.md) govern browser-specific controls.
- [API security](api-security.md), [authorization](authorization.md), [CSRF](csrf.md), and [resource limits](resource-limits.md) govern server-facing controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
