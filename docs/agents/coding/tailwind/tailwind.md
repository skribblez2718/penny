# Tailwind CSS — Documentation Lookup

> **Hybrid lookup.** The table below is a self-healing cache of known-good URLs.
> Fetch the URL for your concept; if it 404s or drifts, repair the row per
> [../library-docs.md](../library-docs.md). Fetch the live page for current API.

- **Canonical docs:** https://tailwindcss.com/docs
- **URL scheme:** `https://tailwindcss.com/docs/<page>` (no browsable root index —
  use the table below or search)
- **Version:** confirm from `package.json`. **v3 → v4 changed a lot** (CSS-first
  `@import "tailwindcss"` + `@theme`, no `tailwind.config.js`, automatic content
  detection, `@tailwindcss/vite`). Fetch docs for the installed major version.

## Concept → URL table (self-healing cache)

`Verified`: `✓ <date>` = confirmed live that date · `seed` = curated, confirm on
first use (a failed fetch self-heals and dates the row).

| Concept                                     | URL                                                            | Verified     |
| ------------------------------------------- | -------------------------------------------------------------- | ------------ |
| Install (Vite)                              | https://tailwindcss.com/docs/installation/using-vite           | seed         |
| Install (PostCSS)                           | https://tailwindcss.com/docs/installation/using-postcss        | seed         |
| v3 → v4 upgrade guide                       | https://tailwindcss.com/docs/upgrade-guide                     | ✓ 2026-07-10 |
| Utility-first basics                        | https://tailwindcss.com/docs/styling-with-utility-classes      | seed         |
| States & variants (hover/focus)             | https://tailwindcss.com/docs/hover-focus-and-other-states      | seed         |
| Responsive design                           | https://tailwindcss.com/docs/responsive-design                 | seed         |
| Dark mode                                   | https://tailwindcss.com/docs/dark-mode                         | ✓ 2026-07-10 |
| Theme tokens (`@theme`)                     | https://tailwindcss.com/docs/theme                             | seed         |
| Colors                                      | https://tailwindcss.com/docs/colors                            | seed         |
| Adding custom styles (`@utility`, `@apply`) | https://tailwindcss.com/docs/adding-custom-styles              | seed         |
| Functions & directives                      | https://tailwindcss.com/docs/functions-and-directives          | ✓ 2026-07-10 |
| Content detection (`@source`)               | https://tailwindcss.com/docs/detecting-classes-in-source-files | seed         |
| Preflight (base reset)                      | https://tailwindcss.com/docs/preflight                         | seed         |
| Editor setup / IntelliSense                 | https://tailwindcss.com/docs/editor-setup                      | seed         |

## Using Tailwind with Lit when that stack is selected

When a caller selects both Tailwind and Lit, Tailwind's global stylesheet does **not**
cross Lit's shadow boundary. Build an integration from the current documentation and
adopt only trusted, compiled CSS into each component's shadow root. Theme tokens
expressed as CSS custom properties can cross that boundary when the selected design
uses them.

Use the [Lit documentation map](../lit/AGENTS.md) to fetch the current styles API before implementing this integration; do not rely on a frozen code sample.

> **Security:** `unsafeCSS()` must only ever receive **trusted, compiled** CSS —
> never user input. See [../security/configuration.md](../security/configuration.md)
> (CSP / inline styles), [../security/browser-security.md](../security/browser-security.md), and [../security/xss.md](../security/xss.md).
