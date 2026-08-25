# Coding Conventions — Universal pre-generation rules for all code

## What

Every agent that generates code must apply these rules before producing output. They are universal — language, framework, and domain agnostic.

## Why

Without pre-generation rules, agents produce inconsistent, untested, unverified code. These rules establish the minimum quality bar before any code leaves the agent.

## Rules

1. **Tests that prove the change.** Every change ships with tests that exercise it and fail on a reverted implementation — a pass is backed by an oracle, never asserted. Sequencing (test-first, alongside, or after) is the author's choice; the verified outcome is what matters.
2. **Lint before delivery.** Code must pass lint with zero errors and warnings. Do not suppress warnings; fix their cause before production delivery.
3. **Format before delivery.** Code must pass format check.
4. **Typecheck before delivery.** TypeScript: `bun run typecheck` (or the changed package's `bun run typecheck`). Python: `bun run py:typecheck`. A green test suite never substitutes for a green typecheck.
5. **Treat types as design contracts.** Give domain data, states, results, and public boundaries named machine-checkable types. Validate untrusted data at entry, derive static types from runtime schemas where available, and make invalid states unrepresentable with discriminated unions.
6. **Contain uncertainty.** Use `unknown`/`object` at untrusted boundaries and narrow it immediately. Do not introduce implicit `any`, broad assertions, or suppression comments to evade a compiler error. A necessary interoperability exception is local, documented with a removal condition, and tested.
7. **No dead code.** Remove commented-out blocks, unused imports, unreachable branches.
8. **No magic numbers.** All constants must be named and documented.

## Frontend UI & CSS defaults

For web application projects, **build UIs as custom [Lit](https://lit.dev) web components styled with [Tailwind CSS](https://tailwindcss.com)** — this is the documented default. Prefer composing small, encapsulated Lit components (reactive properties + scoped styles + declarative templates) over ad-hoc DOM manipulation or a heavyweight SPA framework.

- **UI default:** Lit web components for all new UI work. See [lit/AGENTS.md](lit/AGENTS.md) for the live documentation map and project integration guidance.
- **CSS default:** Tailwind CSS (v4 — CSS-first `@import "tailwindcss"` + `@theme`, no `tailwind.config.js`). See [tailwind/AGENTS.md](tailwind/AGENTS.md).
- **Lit + Tailwind integration (required pattern):** Lit renders into shadow DOM, which a global Tailwind stylesheet cannot pierce, so adopt a compiled Tailwind sheet into each component's shadow root; theme tokens on `:root`/`:host` (Tailwind `@theme`) cross the boundary as CSS custom properties. Only pass **trusted, compiled** CSS to `unsafeCSS()`. See the [Lit](lit/AGENTS.md) and [Tailwind](tailwind/AGENTS.md) documentation maps for the current APIs.
- **Exceptions** are allowed when a project already standardizes on another framework (React, Vue, etc.) or a hard constraint rules Lit/Tailwind out — state the reason explicitly in the plan.
- **Accessibility is mandatory (WCAG 2.2 AA).** Every user-facing surface must meet Level AA at build time — semantic HTML, keyboard operability, visible focus, contrast in **both** themes, and no meaning by color alone. This is a delivery gate, not a later audit. See [accessibility.md](accessibility.md) for the full standard + verification checklist (axe + keyboard + screen-reader).

## Severity

| Severity     | Meaning            | Action                         |
| ------------ | ------------------ | ------------------------------ |
| **BLOCKER**  | Rule 1-6 violation | Must fix before delivery       |
| **CRITICAL** | Rule 7-8 violation | Must fix or document exception |

## Constraints

- **These rules apply to ALL generated code.** No exceptions.
- **Agents must verify compliance before returning SUMMARY.**

## Verification

- [ ] Tests written and passing
- [ ] Lint passes
- [ ] Format passes
- [ ] Typecheck passes
- [ ] Types/schemas model the changed contract and external data is validated
- [ ] No implicit `any`, broad assertion, or suppression bypasses the contract
- [ ] No dead code or magic numbers
