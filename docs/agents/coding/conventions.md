# Coding Conventions

## Applies when

Every code-affecting task. These conventions are language- and framework-neutral
quality obligations; apply the mandatory security route before changing, reviewing,
diagnosing, or recommending executable behavior.

## Requirements

1. Preserve the changed contract with appropriately scoped tests or other executable
   checks when implementing. A test must be capable of detecting a reverted behavior;
   a passing assertion without an oracle is not evidence.
2. Run applicable lint, formatting, type, and project checks before claiming an
   implementation complete. Fix the cause rather than suppressing diagnostics.
3. Model domain data, states, public boundaries, and untrusted input with named,
   machine-checkable types and runtime validation. Narrow uncertainty at boundaries;
   do not use broad assertions or suppression comments to bypass a contract.
4. Remove dead code and make meaningful constants named and documented.
5. Read [Security Invariants](security/security-invariants.md) and every
   task-triggered security guide. Map affected invariants to evidence, an explicit
   blocker, or an approved exception; an agent cannot self-authorize an exception.

## Task modes

- **Implementation:** make the requested change and produce appropriate tests/checks.
- **Review or diagnosis:** inspect available code and evidence, identify violated or
  unverified contracts, and do not claim the implementation was changed or verified.
- **Recommendation or planning:** identify applicable contracts and required evidence;
  distinguish proposed controls from present ones.

## Caller-selected UI and CSS technologies

Use the framework and styling system selected by the caller or existing project. When
that choice is Lit or Tailwind, follow their routes. For any UI, accessibility remains
mandatory and browser/XSS guidance applies when triggered. Only trusted, compiled CSS
may reach privileged CSS APIs such as `unsafeCSS()`.

## Verification

- [ ] The task mode and changed contract are explicit.
- [ ] Relevant tests/checks were run, or their absence and effect are reported.
- [ ] Lint, format, and type checks appropriate to the changed code were run.
- [ ] Untrusted boundaries have a validated runtime contract.
- [ ] Affected security invariants have evidence, a blocker, or an approved exception.
- [ ] No dead code, unjustified suppression, or unexplained constants were introduced.

## Related guidance

- [Accessibility](accessibility.md) is mandatory for user-facing UI changes.
- [Security index](security/AGENTS.md) routes invariant-first secure coding guidance.
- [Library documentation](library-docs.md) governs current upstream API lookup.
