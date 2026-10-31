# Security Overview for Generated Code

Generated code has the same authority and failure modes as hand-written code. Penny's
security guidance therefore starts with properties that must remain true, then routes to
specialized practices and evidence.

## The invariant baseline

For every code-affecting task, the security baseline requires:

- authority enforced at the authoritative execution boundary and default deny for protected actions and data;
- separation of untrusted data from executable languages and protocol structure;
- bounded input, computation, storage, fan-out, time, and downstream cost;
- identity and session state verifiable by the authoritative component, with origin/replay controls where applicable and no authority granted by browser or offline state;
- confined egress, trusted origins, secrets, dependencies, build artifacts, and browser
  execution;
- fail-closed behavior plus useful, privacy-respecting auditability and recovery; and
- evidence for every affected property.

A statement such as “secure,” “validated,” or “rate-limited” is not evidence. Each
affected invariant is either evidenced, blocks completion, or has an approved exception
naming the invariant, rationale, residual risk, compensating control, verification gap,
accountable owner, and removal condition. An agent cannot approve its own exception.
The authority boundary may be a local owner, service, or server; client/server systems
still enforce protected decisions server-side.

## Focused guides

The detailed guidance separates neighboring responsibilities: authentication proves
identity; authorization grants access; session security preserves authenticated state;
and CSRF protects browser-driven mutations. It also covers API surfaces, validation,
injection, browser/XSS/PWA behavior, files, SSRF/egress, resource limits, caller-driven
execution, automation abuse, configuration, secrets, cryptography, dependencies, supply
chain, monitoring, errors, incident response, and security verification.

This breadth does not mean every task reads every guide. A small internal refactor may
need only the baseline; a browser-facing endpoint or upload may activate several guides.
Server-only API work does not by itself trigger browser-storage or service-worker rules.
The shared ASVS coverage and primary-source freshness policy live in the mandatory
[security baseline](../../agents/coding/security/security-invariants.md), which must
accompany selected topic guides when supplied without repository access.

## Proportionate controls

Security outcomes bind; a generic checklist does not mandate every named mechanism.
Trusted fixed SDK/worker code consuming caller text or audio is not automatically arbitrary
caller-code execution. Validation, bounded media/parser work, dependency integrity, and
authority protections still apply; local/trusted labels are not exemptions. Genuinely
untrusted code or capabilities need independent containment. Stronger infrastructure must
address an actual boundary or binding contract, not an inherited model choice. The
[execution-surface guide](../../agents/coding/security/untrusted-execution.md#classify-the-execution-surface)
explains how to select those controls.

## How verification works

Implementation work runs appropriate adversarial tests, analysis, and configuration checks.
Review and diagnosis inspect available evidence and identify gaps. Planning describes what
must be verified without claiming the controls already exist. The current external coverage
spine is OWASP ASVS 5.0.0; it informs verification without replacing a task-specific design.
Exploration/component checks, application integration acceptance, and deployment support
different claims. Each prerequisite applies when its risk or dependency begins; final
qualification must not block independent earlier work. Earlier work still needs applicable
safety controls, and component success does not establish integration or deployment safety.

## Learn more

The agent-side [secure-coding index](../../agents/coding/security/AGENTS.md) contains the
full task-triggered guidance. The [deployment conventions](deployment-conventions.md)
explain how these properties carry into a running system.
