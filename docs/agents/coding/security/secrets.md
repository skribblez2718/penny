# Secrets Management

## Applies when

Creating, loading, transmitting, logging, scoping, storing, rotating, or revoking credentials and key material.

## Security properties

- Secret material is confined to approved identities, storage, transport, and lifetime.
- A compromise can be detected, revoked, contained, and recovered without relying on secrecy of source code.

## Requirements

- Use an appropriate managed secret mechanism for the deployment; environment variables are one option, not the only architecture.
- Apply least privilege, audience, scope, duration, rotation, revocation, and separation by workload/environment.
- Prevent exposure through source control, client bundles, browser storage, logs, analytics, errors, traces, caches, backups, and untrusted workers.
- Treat suspected exposure as an incident requiring revocation/rotation, not only a source edit.

## Failure modes

- Hardcoding credentials or embedding them in public configuration.
- Logging, serializing, caching, or sharing secrets with an untrusted execution boundary.
- Assuming a secret scan proves a secret is not exposed at runtime.

## Verification

- Run secret scans and inspect client artifacts, logs, errors, cache, role bindings, and runtime scope.
- Exercise rotation/revocation and verify a replaced credential no longer works.

## Related guidance

- [Cryptography](cryptography.md) owns cryptographic key use.
- [Supply chain](supply-chain.md), [logging and monitoring](logging-monitoring.md), and [incident response](incident-response.md) own related controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
