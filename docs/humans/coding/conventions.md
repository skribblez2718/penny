# Penny Coding Conventions

Coding conventions are shared quality and evidence rules for code-affecting work. They
make implementation claims testable and make review, diagnosis, and planning honest about
what was and was not verified.

## Core expectations

Implementation work should preserve the changed contract with appropriate tests or checks,
then run applicable lint, formatting, type, and project verification. Types and runtime
validation make data and boundary assumptions explicit; dead code and unexplained constants
make those assumptions harder to review.

Not every code-affecting task writes code:

- **Implementation** changes behavior and supplies appropriate evidence.
- **Review/diagnosis** evaluates existing code and evidence, identifying violations or gaps.
- **Recommendation/planning** identifies requirements and needed evidence without claiming
  proposed controls already exist.

## Security is invariant-first

Every code-affecting task begins with the security baseline and then reads the guides
triggered by its trust boundaries. The key outcomes are server-enforced authority,
code/data separation, bounded input and resources, secure identity/session handling,
egress and client confinement, secret and supply-chain protection, fail-closed behavior,
and evidence-backed completion.

An affected security invariant must be satisfied with evidence, block completion, or have
an explicitly approved exception with a rationale, residual risk, compensating control,
verification gap, owner, and removal condition. An agent cannot approve its own exception.

## Interfaces and selected technologies

User-facing interfaces must meet the accessibility standard. Framework and styling choices
come from the caller or the existing project; when a selected stack includes Lit or
Tailwind, use the matching agent guidance. Browser, XSS, API, session, and service-worker
security are loaded when their features are present, not because one UI framework is
universally required.

## Related documents

- [Accessibility](accessibility.md) — user-interface requirements.
- [Security overview](security-overview.md) — why the invariant model matters.
- Agent reference: `docs/agents/coding/conventions.md`.
