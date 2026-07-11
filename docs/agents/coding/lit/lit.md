# Lit — Documentation Lookup

> **Hybrid lookup.** The table below is a self-healing cache of known-good URLs.
> Fetch the URL for your concept; if it 404s or drifts, repair the row per
> [../library-docs.md](../library-docs.md). It is an entry point, not a data
> source — fetch the live page for current, version-correct API.

- **Canonical docs:** https://lit.dev/docs/
- **URL scheme:** `https://lit.dev/docs/<section>/<page>/` (trailing slash)
- **Version:** confirm from the project's `package.json` (`lit` — currently
  v3.x). Lit v2 → v3 changed decorators and imports; fetch docs for the
  installed major version.

## Concept → URL table (self-healing cache)

`Verified`: `✓ <date>` = confirmed live that date · `seed` = curated, confirm on
first use (a failed fetch self-heals and dates the row).

| Concept | URL | Verified |
|---|---|---|
| Getting started | https://lit.dev/docs/getting-started/ | seed |
| Components overview | https://lit.dev/docs/components/overview/ | ✓ 2026-07-10 |
| Defining a component | https://lit.dev/docs/components/defining/ | seed |
| Rendering | https://lit.dev/docs/components/rendering/ | seed |
| Reactive properties | https://lit.dev/docs/components/properties/ | seed |
| Styles (scoped, static styles) | https://lit.dev/docs/components/styles/ | seed |
| Lifecycle | https://lit.dev/docs/components/lifecycle/ | seed |
| Shadow DOM | https://lit.dev/docs/components/shadow-dom/ | seed |
| Events | https://lit.dev/docs/components/events/ | seed |
| Decorators | https://lit.dev/docs/components/decorators/ | seed |
| Templates overview | https://lit.dev/docs/templates/overview/ | ✓ 2026-07-10 |
| Template expressions | https://lit.dev/docs/templates/expressions/ | seed |
| Conditionals | https://lit.dev/docs/templates/conditionals/ | seed |
| Lists | https://lit.dev/docs/templates/lists/ | seed |
| Built-in directives | https://lit.dev/docs/templates/directives/ | seed |
| Reactive controllers | https://lit.dev/docs/composition/controllers/ | seed |
| Mixins | https://lit.dev/docs/composition/mixins/ | seed |
| Context (shared data) | https://lit.dev/docs/data/context/ | seed |
| React integration | https://lit.dev/docs/frameworks/react/ | seed |
| Server rendering (SSR) | https://lit.dev/docs/ssr/overview/ | seed |
| Testing | https://lit.dev/docs/tools/testing/ | seed |
| Building for production | https://lit.dev/docs/tools/production/ | seed |
| API: LitElement | https://lit.dev/docs/api/LitElement/ | seed |
| API: Styles (adoptStyles, css, unsafeCSS) | https://lit.dev/docs/api/styles/ | ✓ 2026-07-10 |
| API: Decorators | https://lit.dev/docs/api/decorators/ | seed |

## Styling (Tailwind integration)

Tailwind CSS is this project's default styling layer. Because Lit renders into
shadow DOM, a global Tailwind stylesheet does not reach component internals —
compile Tailwind and `adoptStyles()` it into each component's shadow root. See
the [Tailwind documentation map](../tailwind/AGENTS.md) and the required
integration pattern (Vite `?inline` + `unsafeCSS()` + a `TW` mixin) in
`.pi/skills/code/resources/web-ui.md`.

## Secure Coding (project standards)

Lit auto-escapes text and attribute bindings, but several APIs bypass that and
form the main client-side risk surface. Consult the project's secure-coding docs
(`docs/agents/coding/security/`) when building Lit UIs:

- [XSS](../security/xss.md) — **Most relevant.** `unsafeHTML`, `unsafeSVG`, the `unsafeStatic`/`html` helpers from `static-html`, and binding to `.innerHTML` bypass Lit's auto-escaping. Never pass untrusted data to them; sanitize first.
- [Input Validation](../security/input-validation.md) — Validate and constrain user input at the component boundary before use or dispatch.
- [Secrets](../security/secrets.md) — Never embed API keys or tokens in client-side bundles; anything in the JS ships to the browser.
- [Authentication](../security/authentication.md) — Browser token/session storage (avoid `localStorage` for sensitive tokens; prefer httpOnly cookies).
- [API Security](../security/api-security.md) — Components call APIs; guard against IDOR and excessive data exposure server-side.
- [Configuration](../security/configuration.md) — CORS, security headers, and CSP. `unsafeCSS()`/inline styles interact with CSP — only ever pass trusted, compiled CSS to `unsafeCSS()`.
- [Dependencies](../security/dependencies.md) — Vet npm packages in the Lit / Tailwind toolchain (supply-chain risk).

See [security/AGENTS.md](../security/AGENTS.md) for the full secure-coding index.
