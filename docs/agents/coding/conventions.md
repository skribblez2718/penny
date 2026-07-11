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

## Frontend UI & CSS defaults

For web application projects, **build UIs as custom [Lit](https://lit.dev) web components styled with [Tailwind CSS](https://tailwindcss.com)** — this is the documented default. Prefer composing small, encapsulated Lit components (reactive properties + scoped styles + declarative templates) over ad-hoc DOM manipulation or a heavyweight SPA framework.

- **UI default:** Lit web components for all new UI work. See [lit/AGENTS.md](lit/AGENTS.md) for the documentation map and `.pi/skills/code/resources/web-ui.md` for patterns and gotchas.
- **CSS default:** Tailwind CSS (v4 — CSS-first `@import "tailwindcss"` + `@theme`, no `tailwind.config.js`). See [tailwind/AGENTS.md](tailwind/AGENTS.md).
- **Lit + Tailwind integration (required pattern):** Lit renders into shadow DOM, which a global Tailwind stylesheet cannot pierce. Compile Tailwind and adopt it into each component's shadow root — import the built CSS with Vite's `?inline`, wrap it in `unsafeCSS()`, and apply it via `static styles` or an `adoptStyles()` mixin. Theme tokens on `:root`/`:host` (Tailwind `@theme`) cross the boundary as CSS custom properties. Only ever pass **trusted, compiled** CSS to `unsafeCSS()`. Details and code in `.pi/skills/code/resources/web-ui.md`.
- **Exceptions** are allowed when a project already standardizes on another framework (React, Vue, etc.) or a hard constraint rules Lit/Tailwind out — state the reason explicitly in the plan.

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
