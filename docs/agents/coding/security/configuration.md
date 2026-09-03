# Configuration Security

## Applies when

Changing runtime settings, public/client configuration, CORS, trusted proxies, headers, debug behavior, error exposure, or startup validation.

## Security properties

- Runtime policy is explicit, typed, validated, least-privilege, and fails closed.
- Public and privileged surfaces, client-visible values, proxy trust, and error behavior are intentional.

## Requirements

- Use typed startup validation with safe production defaults and explicit environment separation; do not require a particular file layout.
- Separate public/client configuration from secrets. Define trusted proxies, CORS, headers, debug, logging, and feature exposure deliberately.
- Fail startup or disable unsafe capability when required controls/configuration are absent; review privileged/admin reachability separately from ordinary public traffic.

## Failure modes

- Hardcoding a configuration topology, provider, server, or default deployment command.
- Trusting forwarded headers from arbitrary sources, exposing debug/error internals, or shipping server configuration to clients.
- Using environment variables as the only configuration or secret mechanism.

## Verification

- Test invalid/missing configuration, production-safe defaults, client artifact contents, CORS/proxy behavior, headers, and privileged-surface reachability.
- Inspect effective deployed configuration rather than source templates alone.

## Related guidance

- [Secrets](secrets.md) owns credential lifecycle.
- [Browser security](browser-security.md), [deployment conventions](../deployment-conventions.md), and [error handling](error-handling.md) cover related domains.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
