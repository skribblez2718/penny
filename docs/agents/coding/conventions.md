# Coding Conventions — Universal pre-generation rules for all code

## What

Every agent that generates code must apply these rules before producing output. They are universal — language, framework, and domain agnostic.

## Why

Without pre-generation rules, agents produce inconsistent, untested, unverified code. These rules establish the minimum quality bar before any code leaves the agent.

## Rules

1. **TDD required.** Write the test first, see it fail, then write the implementation.
2. **Lint before delivery.** Code must pass lint with zero errors.
3. **Format before delivery.** Code must pass format check.
4. **Typecheck before delivery.** TypeScript: `tsc --noEmit`. Python: `mypy`.
5. **No dead code.** Remove commented-out blocks, unused imports, unreachable branches.
6. **No magic numbers.** All constants must be named and documented.

## Severity

| Severity | Meaning | Action |
|----------|---------|--------|
| **BLOCKER** | Rule 1-4 violation | Must fix before delivery |
| **CRITICAL** | Rule 5-6 violation | Must fix or document exception |

## Constraints

- **These rules apply to ALL generated code.** No exceptions.
- **Agents must verify compliance before returning SUMMARY.**

## Verification

- [ ] Tests written and passing
- [ ] Lint passes
- [ ] Format passes
- [ ] Typecheck passes
- [ ] No dead code or magic numbers
