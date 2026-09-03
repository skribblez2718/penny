# Security Invariants

## Applies when

Every code-affecting task: one that creates, modifies, reviews, diagnoses, or recommends executable code, tests, dependencies, schemas or migrations, build/deployment/infrastructure configuration, or data flows that affect executable behavior.

## Security properties

1. **Authority:** protected subject, action, object, field, tenant, and administrative decisions are server-enforced and default-deny.
2. **Interpreter separation:** untrusted bytes cannot become executable code, queries, commands, templates, paths, configuration, headers, URLs, or protocol structure without a safe boundary.
3. **Input and resource boundedness:** external input and work have finite representation, size, complexity, CPU, memory, storage, duration, concurrency, output, fan-out, and downstream-cost limits.
4. **Identity and state integrity:** identity and session state are server-verifiable, scoped, revocable, and protected; sensitive mutations add origin, replay, and idempotency controls when applicable.
5. **Egress, client, and origin confinement:** caller-controlled data cannot grant arbitrary server network access; browser and offline state is untrusted; public and privileged surfaces have intentional reachability.
6. **Secret and supply-chain confinement:** secrets stay out of client artifacts, logs, errors, caches, untrusted workloads, and source control; dependencies and artifacts have reviewed identity, integrity, provenance, and vulnerability status appropriate to risk.
7. **Browser execution confinement:** dangerous browser sinks, framing, service-worker scope, and caching are intentionally constrained.
8. **Fail-closed recovery:** malformed, ambiguous, exceptional, partially parsed, or misconfigured behavior cannot silently gain privilege; security events support containment and recovery.
9. **Evidence-backed completion:** each affected invariant is satisfied with appropriate evidence, explicitly blocks completion, or has an approved exception.

## Requirements

- Identify affected trust boundaries and capabilities before implementation: public routes, privileged surfaces, data classes, egress destinations, filesystem/compute capability, dependencies, service-worker scope, and security-header changes.
- Use task-triggered guides for the affected facets; the baseline does not replace their controls.
- An exception must name the invariant, rationale, residual risk, compensating control, verification gap, accountable owner, and removal condition. An agent cannot self-authorize it.
- Distinguish implementation from review/diagnosis/recommendation: implementations run suitable checks; reviews report available evidence and gaps; plans specify required controls and evidence without claiming they exist.

## Failure modes

- Treating an authenticated client, client-side role, hidden field, cache, or offline state as authority.
- Calling a change “secure”, “validated”, or “rate-limited” without test, analysis, inspection, or other evidence.
- Letting a checklist waive a violated invariant, or treating an unapproved exception as completion.
- Assuming an edge control, a framework default, or an absence of known vulnerabilities replaces defense in depth.

## Verification

- Map every affected invariant to tests, static analysis, configuration inspection, operational evidence, or a documented verification gap.
- Run negative/adversarial checks suitable for the trust boundary, not only happy-path tests.
- Report newly added public routes, administrative surfaces, dependencies, egress destinations, filesystem/compute capability, service-worker scope, security-header changes, and unverified invariants.
- Do not declare completion while an affected invariant is unresolved without an approved exception.

## Related guidance

- [Threat modeling](threat-model.md) selects task-specific assets, boundaries, and adversaries.
- [Web and PWA invariants](web-pwa-invariants.md) adds the conditional browser/application baseline.
- [Security verification](security-verification.md) selects evidence appropriate to the change.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is the external coverage spine. Record versioned ASVS identifiers only when they materially clarify a selected control.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
