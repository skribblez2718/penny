# Web and PWA Invariants

## Applies when

Work affecting browser-delivered UI, browser state, offline web behavior, or service
workers. Server-only endpoints and local non-browser tools use the mandatory security
baseline and their triggered API, authorization, configuration, and resource guides.

## Security properties

- Server decisions remain authoritative despite browser, PWA, cache, and offline state.
- Public interfaces, browser execution, origin policy, caching, and resource consumption are explicit and bounded.

## Requirements

- Classify affected public and privileged routes, state transitions, browser storage, service-worker scope, cacheable responses, and external origins. Browser-only work does not imply a service worker or offline cache; apply those controls when those features are affected.
- Use defense in depth: server authorization, validation, rate/cost controls, browser policy, and safe operational visibility.
- Read every triggered detailed guide; this page is a routing baseline, not an implementation substitute.

## Failure modes

- Treating a PWA cache as an authority or a service worker as an ordinary static asset.
- Assuming CORS, CSP, or an edge control replaces server-side authorization and validation.

## Verification

- Test affected browser-originated mutations, cache/offline behavior, security headers, public-interface classification, and resource limits.
- For deployed browser applications, inspect the affected deployed route and origin configuration, not merely local source; report unavailable deployment evidence.

## Related guidance

- [Browser security](browser-security.md), [service workers](pwa-service-worker.md), and [XSS](xss.md) govern browser-specific controls.
- [API security](api-security.md), [authorization](authorization.md), [CSRF](csrf.md), and [resource limits](resource-limits.md) govern server-facing controls.
