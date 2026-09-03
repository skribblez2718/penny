# Security Overview for Generated Code

Generated code has the same authority and failure modes as hand-written code. Penny's
security guidance therefore starts with properties that must remain true, then routes to
specialized practices and evidence.

## The invariant baseline

For every code-affecting task, the security baseline requires:

- server-enforced authority and default deny for protected actions and data;
- separation of untrusted data from executable languages and protocol structure;
- bounded input, computation, storage, fan-out, time, and downstream cost;
- server-verifiable identity, session, state-transition, browser, and offline behavior;
- confined egress, trusted origins, secrets, dependencies, build artifacts, and browser
  execution;
- fail-closed behavior plus useful, privacy-respecting auditability and recovery; and
- evidence for every affected property.

A statement such as “secure,” “validated,” or “rate-limited” is not evidence. Each
affected invariant is either evidenced, blocks completion, or has an approved exception
with residual risk and a removal condition.

## Focused guides

The detailed guidance separates neighboring responsibilities: authentication proves
identity; authorization grants access; session security preserves authenticated state;
and CSRF protects browser-driven mutations. It also covers API surfaces, validation,
injection, browser/XSS/PWA behavior, files, SSRF/egress, resource limits, caller-driven
execution, automation abuse, configuration, secrets, cryptography, dependencies, supply
chain, monitoring, errors, incident response, and security verification.

This breadth does not mean every task reads every guide. A small internal refactor may
need only the baseline; a browser-facing endpoint or upload may activate several guides.

## How verification works

Implementation work runs appropriate adversarial tests, analysis, and configuration checks.
Review and diagnosis inspect available evidence and identify gaps. Planning describes what
must be verified without claiming the controls already exist. The current external coverage
spine is OWASP ASVS 5.0.0; it informs verification without replacing a task-specific design.

## Learn more

The agent-side [secure-coding index](../../agents/coding/security/AGENTS.md) contains the
full task-triggered guidance. The [deployment conventions](deployment-conventions.md)
explain how these properties carry into a running system.
