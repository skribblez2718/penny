# Untrusted Execution

## Applies when

Code runs caller-influenced code, expressions, templates, plugins, subprocesses, workers, or compute jobs.

## Security properties

- Caller-controlled computation cannot access secrets, metadata, host files/processes, unrestricted network, or platform control surfaces beyond its explicit capability set.
- Escapes, failure, and resource exhaustion are contained.

## Requirements

- Prefer a narrowly specified grammar/AST or declarative model over general-purpose evaluation.
- Isolate execution with independently enforced filesystem, process, identity, network, metadata, time, memory, CPU, output, and concurrency controls.
- Use ephemeral state, explicit input/output contracts, least privilege, and a separate trust boundary from the control plane.
- Treat templates, plugins, subprocesses, and workers as execution surfaces even when they are not named `eval`.

## Failure modes

- Replacing `eval` with another dynamic interpreter without isolation.
- Giving a worker application credentials, host mounts, container/cluster control access, or unrestricted outbound network.
- Assuming a timeout alone makes an evaluator safe.

## Verification

- Attempt policy-escape, secret/file/network/metadata access, process-spawn, resource-exhaustion, output, and cleanup tests in a controlled environment.
- Inspect actual sandbox and network policy, not only application-side validation.

## Related guidance

- [Injection prevention](injection.md) covers code/data separation.
- [Resource limits](resource-limits.md), [SSRF and egress](ssrf-egress.md), [secrets](secrets.md), and [incident response](incident-response.md) cover related controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
