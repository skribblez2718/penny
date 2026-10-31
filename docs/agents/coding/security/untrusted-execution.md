# Untrusted Execution

## Applies when

Code runs caller-influenced code, expressions, templates, plugins, subprocesses, workers,
or compute jobs. This trigger requires classifying the surface, not assuming arbitrary
caller-code execution.

## Security properties

- Caller-controlled computation cannot access secrets, metadata, host files/processes, unrestricted network, or platform control surfaces beyond its explicit capability set.
- Escapes, failure, and resource exhaustion are contained.

## Classify the execution surface

Identify who controls executable behavior and which capabilities it can exercise. Trusted,
fixed SDK or worker code consuming caller text/audio as data is not automatically arbitrary
caller-code execution. The data remains untrusted: [input validation](input-validation.md),
bounded [file/media processing](file-handling.md), [dependency integrity](dependencies.md),
[injection-safe invocation](injection.md), and applicable authority/egress protections still
apply. Locality or trusted code alone is not a security exemption; parser flaws, dynamic
loading, or excessive authority can warrant stronger isolation.

Caller-supplied executable code, unsafe executable expressions/templates, and untrusted
plugins or executable dependencies require independently enforced containment. Input
validation, prompt instructions, tool allowlists, and timeouts alone do not provide it.

## Requirements

- Prefer a narrowly specified grammar/AST or declarative model over general-purpose evaluation when callers need programmable behavior.
- For untrusted execution, independently enforce capability and resource controls across filesystem, process, identity, network, metadata, time, memory, CPU, output, and concurrency as applicable. Deny capabilities the workload does not need; keep a separate boundary from the control plane, ephemeral state, and explicit input/output contracts.
- Select containment mechanisms for the actual threat and capability boundary under
  [proportionality](../../architecture/project-standards.md#proportionality-outcomes-before-mechanisms).
  This guide does not itself require a particular sandbox/container, PID namespace, cgroup,
  or host-wide quota; [resource limits](resource-limits.md) owns workload-specific budgets.
- Do not infer an immutable copied runtime or independent driver attestation from a generic
  checklist. Require stronger runtime-integrity or independent verification controls when
  a binding contract requires them or a material execution-identity/evidence-integrity
  threat cannot be adequately addressed by simpler checks; justify the selected mechanism
  against that need.
- Treat templates, plugins, subprocesses, and workers as potential execution surfaces even when they are not named `eval`; inspect how caller input reaches executable behavior rather than classifying by name alone.

## Failure modes

- Replacing `eval` with another dynamic interpreter without isolation.
- Giving an untrusted worker application credentials, host mounts, container/cluster control access, or unrestricted outbound network.
- Assuming a timeout alone makes an evaluator safe, or that fixed worker code makes hostile media harmless.

## Verification

- Verify the claimed data/code separation, actual capabilities, input/media limits, and dependency assumptions.
- For containment boundaries, attempt policy-escape, secret/file/network/metadata access, process-spawn, resource-exhaustion, output, and cleanup tests in a controlled environment.
- Inspect the actual isolation and network controls required by the surface, not only application-side validation or the name of a sandbox technology.

## Related guidance

- [Injection prevention](injection.md) covers code/data separation.
- [Resource limits](resource-limits.md), [SSRF and egress](ssrf-egress.md), [secrets](secrets.md), and [incident response](incident-response.md) cover related controls.
