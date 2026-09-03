# PWA and Service-Worker Security

## Applies when

Changing service workers, offline caches, install scope, update lifecycle, navigation fallbacks, push, or background work.

## Security properties

- Persistent worker scope and cached content cannot silently broaden authority or expose private state.
- Offline state is a client claim, not server authority.

## Requirements

- Require secure contexts outside explicitly trusted development and serve worker code from the intended origin.
- Use the narrowest scope; treat `Service-Worker-Allowed` expansion, dynamic imports, push, and background work as security-sensitive changes.
- Cache only explicitly classified responses. Keep authentication, session, privileged, personalized, and protocol endpoints network-only unless an explicitly reviewed offline design proves otherwise.
- Version caches, clean obsolete entries on activation, and ensure navigation fallbacks do not intercept APIs, authentication, callbacks, or privileged routes.

## Failure modes

- Caching every successful GET or returning an app shell for a protocol endpoint.
- Letting cached/offline values grant identity, role, entitlement, progress credit, or authorization.
- Assuming a service worker is removed immediately after deployment.

## Verification

- Test scope, update/activation, cache allowlists, fallback exclusions, offline behavior, stale-cache cleanup, and tampered sync data.
- Inspect headers and deployed worker script origin/scope.

## Related guidance

- [Web and PWA invariants](web-pwa-invariants.md) provides the conditional baseline.
- [Browser security](browser-security.md), [API security](api-security.md), and [security verification](security-verification.md) cover adjacent controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
- [Service Workers](https://www.w3.org/TR/service-workers/) defines secure-context, origin, registration, scope, lifecycle, and cache behavior; review its current state before relying on browser details.
