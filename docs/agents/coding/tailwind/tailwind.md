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

| Concept | URL | Verified |
|---|---|---|
| Install (Vite) | https://tailwindcss.com/docs/installation/using-vite | seed |
| Install (PostCSS) | https://tailwindcss.com/docs/installation/using-postcss | seed |
| v3 → v4 upgrade guide | https://tailwindcss.com/docs/upgrade-guide | ✓ 2026-07-10 |
| Utility-first basics | https://tailwindcss.com/docs/styling-with-utility-classes | seed |
| States & variants (hover/focus) | https://tailwindcss.com/docs/hover-focus-and-other-states | seed |
| Responsive design | https://tailwindcss.com/docs/responsive-design | seed |
| Dark mode | https://tailwindcss.com/docs/dark-mode | ✓ 2026-07-10 |
| Theme tokens (`@theme`) | https://tailwindcss.com/docs/theme | seed |
| Colors | https://tailwindcss.com/docs/colors | seed |
| Adding custom styles (`@utility`, `@apply`) | https://tailwindcss.com/docs/adding-custom-styles | seed |
| Functions & directives | https://tailwindcss.com/docs/functions-and-directives | ✓ 2026-07-10 |
| Content detection (`@source`) | https://tailwindcss.com/docs/detecting-classes-in-source-files | seed |
| Preflight (base reset) | https://tailwindcss.com/docs/preflight | seed |
| Editor setup / IntelliSense | https://tailwindcss.com/docs/editor-setup | seed |

## Using Tailwind with Lit (shadow DOM)

Tailwind's global stylesheet does **not** cross Lit's shadow boundary, so a
compiled Tailwind sheet must be adopted into each component's shadow root
(Vite `?inline` → `unsafeCSS()` → `adoptStyles()`/`static styles`, via a shared
`TW` mixin). Theme tokens declared on `:root`/`:host` (via `@theme`) are CSS
custom properties and **do** cross the boundary, so one host-level theme drives
every component.

The step-by-step procedure and full code live in **one** place —
`.pi/skills/code/resources/web-ui.md` (§6). This doc deliberately does not
restate them, so the pattern has a single source of truth.

> **Security:** `unsafeCSS()` must only ever receive **trusted, compiled** CSS —
> never user input. See [../security/configuration.md](../security/configuration.md)
> (CSP / inline styles) and [../security/xss.md](../security/xss.md).
