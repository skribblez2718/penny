# Deployment and Environment Security

Deployment security is about preserving the application's security properties after it
leaves a development environment. The agent-facing requirements live in
[Deployment and Environment Security](../../agents/coding/deployment-conventions.md).

## The important boundaries

A safe deployment makes environment behavior, public configuration, secret handling,
trusted proxies, ingress, privileged surfaces, runtime identity, storage, network access,
and recovery explicit. Production should fail closed when required settings or controls
are missing, rather than silently falling back to a permissive mode.

No one server, provider, container runtime, database, or command is universally required.
Those are caller and project decisions. What matters is that the chosen path has
least-privilege identities, intentional public versus privileged reachability, protected
transport, safe health/readiness behavior, and observable configuration drift.

## HTTP and health checks

HTTP/2 framing reduces some HTTP/1.1 framing ambiguity on an individual hop, but it does
not eliminate request smuggling or desynchronization. Protocol translation, permissive
parsing, malformed fields, and intermediary disagreement still matter, so the actual
request path must be tested where authorized.

TLS protects a transport hop; it does not replace coherent HTTP parsing. If an origin is
described as TLS-only, it cannot expose a network-reachable cleartext application listener.
A distinct cleartext health listener is acceptable only when it is isolated from application
ingress and contains no sensitive data; otherwise the health check uses the protected
listener.

## Verification and recovery

A release should verify the effective deployed configuration—not merely source templates—
including ingress, proxy trust, public/client configuration, secrets, headers, privileged
reachability, migrations, rollback, and recovery. When a check was not run, report that
limitation rather than treating a configuration file as proof.
