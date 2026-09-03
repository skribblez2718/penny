# Deployment and Environment Security

## Applies when

Deployment, infrastructure, runtime configuration, release paths, ingress, health
checks, migration/rollback behavior, or production operations change.

## Security properties

- Development, test, staging, and production behavior are explicit; production refuses
  unsafe or incomplete configuration rather than silently degrading.
- Secrets and public configuration are separated, runtime identities are least-privilege,
  and filesystem, network, process, and credential capabilities are intentional.
- Ingress, trusted-proxy boundaries, public routes, privileged/admin surfaces, health
  endpoints, transport, migrations, rollback, and configuration drift are observable
  and tested on the actual deployed path.

## Requirements

- Select tooling, server, platform, package manager, database, container runtime, and
  deployment commands from the caller's system; this guide mandates properties, not a
  fixed topology.
- Validate typed runtime configuration at startup. Use safe production defaults, make
  client-visible configuration explicit, keep debug and detailed errors out of public
  production responses, and fail closed when a required control is absent.
- Use separate least-privilege identities and scopes for runtime, build, migration,
  administrative, and release operations. Limit writable storage, network egress, and
  trusted proxy sources to the capability each component needs.
- Define the public ingress path and verify that privileged/admin surfaces have
  intentional reachability and authentication/authorization layers independent of
  ordinary public traffic.
- Design health/readiness checks so they do not reveal sensitive data or create an
  alternate application ingress. If an origin is described as TLS-only, it must not
  expose a network-reachable cleartext application listener. A separate cleartext
  health listener is acceptable only when loopback-only or equivalently isolated,
  never forwarded as application ingress, and free of sensitive data; otherwise use the
  protected application listener.
- Plan migration, rollback, backup/restore, session/credential implications, and
  observable configuration drift before release. Verify the running deployment, not
  only a template or local command.

## HTTP protocol normalization and desynchronization

HTTP/2 binary framing reduces several HTTP/1.1 message-framing ambiguities on an
individual hop. It does **not** prove request-smuggling or desynchronization risk is
absent: HTTP processing is hop-by-hop, and protocol conversion, permissive parsing,
malformed fields, early responses, connection reuse, and intermediary disagreement can
still create a parser mismatch.

- Prefer a simple, consistently configured request path where appropriate, but do not
  require or reject a server solely because it speaks a particular HTTP version.
- Reject malformed messages; validate field names and values; reject prohibited or
  conflicting connection-specific/message-length semantics; and translate fields
  correctly at protocol boundaries.
- Minimize and inventory protocol conversions, patch intermediaries, control connection
  reuse where risk warrants it, retain edge protections, and test the real
  ingress-to-origin chain in an authorized controlled environment.
- TLS authenticates and protects a transport hop; it does not replace coherent HTTP
  parsing. Potentially disruptive desynchronization probes are not routine production
  checks.

## Verification

- [ ] Production startup rejects missing or unsafe required configuration.
- [ ] Effective public/client configuration, secrets, identities, filesystem, network,
      proxy, headers, and privileged reachability are inspected in the deployed path.
- [ ] Health/readiness behavior has no contradictory transport or ingress claim.
- [ ] Migration, rollback, and recovery behavior are tested or explicitly reported as
      unverified.
- [ ] HTTP parsing and translation controls are evaluated across the real chain where
      relevant and authorized.

## Current external references

- [RFC 9113, HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html), especially Sections
  8.1.1, 8.2, and 10.3, requires strict malformed-message and field handling and
  describes intermediary translation risk.
- [RFC 9112, HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112.html) defines the
  message-framing semantics that intermediaries must handle coherently.
- Recheck platform-specific deployment and transport behavior against current primary
  documentation before implementation.
