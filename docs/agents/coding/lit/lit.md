# Lit — Documentation Lookup

> **Hybrid lookup.** The table below supplies cached entry points. Fetch the URL
> for your concept; follow [library lookup](../library-docs.md) for version/content
> verification and failures. Repair rows only within authorized documentation
> maintenance. It is an entry point, not a data source — fetch the live page for
> current, version-correct API.

- **Canonical docs:** https://lit.dev/docs/
- **URL scheme:** `https://lit.dev/docs/<section>/<page>/` (trailing slash)
- **Version:** confirm `lit` from the project's `package.json` / lockfile;
  fetch docs for the installed major version, including decorator and import guidance.

## Concept → URL table (cached entry points)

`Verified`: `✓ <date>` = confirmed live that date · `seed` = curated, confirm on
first use. Dates change only after live verification in authorized maintenance.

| Concept                                   | URL                                           | Verified     |
| ----------------------------------------- | --------------------------------------------- | ------------ |
| Getting started                           | https://lit.dev/docs/getting-started/         | seed         |
| Components overview                       | https://lit.dev/docs/components/overview/     | ✓ 2026-07-10 |
| Defining a component                      | https://lit.dev/docs/components/defining/     | seed         |
| Rendering                                 | https://lit.dev/docs/components/rendering/    | seed         |
| Reactive properties                       | https://lit.dev/docs/components/properties/   | seed         |
| Styles (scoped, static styles)            | https://lit.dev/docs/components/styles/       | seed         |
| Lifecycle                                 | https://lit.dev/docs/components/lifecycle/    | seed         |
| Shadow DOM                                | https://lit.dev/docs/components/shadow-dom/   | seed         |
| Events                                    | https://lit.dev/docs/components/events/       | seed         |
| Decorators                                | https://lit.dev/docs/components/decorators/   | seed         |
| Templates overview                        | https://lit.dev/docs/templates/overview/      | ✓ 2026-07-10 |
| Template expressions                      | https://lit.dev/docs/templates/expressions/   | seed         |
| Conditionals                              | https://lit.dev/docs/templates/conditionals/  | seed         |
| Lists                                     | https://lit.dev/docs/templates/lists/         | seed         |
| Built-in directives                       | https://lit.dev/docs/templates/directives/    | seed         |
| Reactive controllers                      | https://lit.dev/docs/composition/controllers/ | seed         |
| Mixins                                    | https://lit.dev/docs/composition/mixins/      | seed         |
| Context (shared data)                     | https://lit.dev/docs/data/context/            | seed         |
| React integration                         | https://lit.dev/docs/frameworks/react/        | seed         |
| Server rendering (SSR)                    | https://lit.dev/docs/ssr/overview/            | seed         |
| Testing                                   | https://lit.dev/docs/tools/testing/           | seed         |
| Building for production                   | https://lit.dev/docs/tools/production/        | seed         |
| API: LitElement                           | https://lit.dev/docs/api/LitElement/          | seed         |
| API: Styles (adoptStyles, css, unsafeCSS) | https://lit.dev/docs/api/styles/              | ✓ 2026-07-10 |
| API: Decorators                           | https://lit.dev/docs/api/decorators/          | seed         |

## Styling with a caller-selected utility system

When the caller-selected stack combines Lit with Tailwind CSS, a global utility sheet
does not cross Lit's shadow boundary. Compile the sheet and adopt only trusted,
compiled CSS into the component's shadow root. See the [Tailwind documentation
map](../tailwind/AGENTS.md) and fetch the current Lit styles API before implementing
an integration. Other selected styling systems need their own documented boundary.

## Secure Coding

Use the mandatory security baseline and positive triggers in the
[security index](../security/AGENTS.md); this section adds Lit-specific reminders,
not a second guide selector.

- Lit's normal escaping does not make raw rendering safe. `unsafeHTML`, `unsafeSVG`,
  the `unsafeStatic`/`html` helpers from `static-html`, and `.innerHTML` are privileged
  sinks. Never pass untrusted values without an explicit, reviewed sanitization
  boundary and tests under [XSS](../security/xss.md).
- Validate and constrain user input at the component boundary before use or dispatch;
  client validation does not replace server-side validation or authorization.
- Never embed API keys or tokens in client-side bundles; bundled JavaScript is public
  to the browser.
- `unsafeCSS()`/inline styles interact with CSP. Only trusted, compiled CSS may reach
  `unsafeCSS()`; never user input. Verify actual rendering and browser-policy behavior.
