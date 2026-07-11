# Web UI Integration Checklist

For any project that includes a frontend UI, the implement agent MUST consult
this reference.

**Default UI approach:** Build UIs as custom **Lit** web components, styled with
**Tailwind CSS** (see `docs/agents/coding/lit/` and `docs/agents/coding/tailwind/`
for the documentation maps, and `docs/agents/coding/conventions.md` for the
default-selection policy). Lit is the documented default for this project's web
application work; Tailwind is the default styling layer — see **§6** for the
required Lit shadow-DOM integration. Other frameworks (React, Next.js, Vue,
Svelte, HTMX) may appear in existing code — the framework-agnostic rules below
apply to all of them, with Lit-specific guidance called out first.

## 1. CSS Selector Hygiene

Framework-generated DOM and shadow DOM are NOT flat, hand-authored DOM. Avoid
naive selectors.

### Lit (default)

Lit renders into **shadow DOM** by default. The shadow boundary is a hard wall:
outside CSS and `document`-level queries do not reach inside a component.

| ❌ Don't Use | ✅ Use Instead | Why |
|-------------|---------------|-----|
| Global CSS reaching into a component (`my-el .title { … }`) | The component's own `static styles`, or expose `::part(title)` (with `part="title"` in the template) | Outside selectors do not pierce the shadow boundary; only `::part` and inherited custom properties cross it. |
| `document.querySelector('.child')` for a shadow child | `this.renderRoot.querySelector(...)` or the `@query('.child')` decorator | Shadow children are invisible to `document`-level queries. |
| Theming by overriding a child's internal colors | Themeable `--custom-properties` the component reads via `var(--x)` | Custom properties inherit **through** the shadow boundary; hard-coded overrides do not. |
| Positional selectors (`:nth-child`) in tests | `data-testid` / `aria-*` attributes placed in the template | Template order shifts as reactive state changes. |

### General Rules for All Frameworks

1. **Prefer `data-testid` and `aria-label` attributes** — they are the most stable selectors.
2. **When targeting custom classes**: use attribute selectors (`[class*="prefix"]`) over direct class selectors (`.prefix-*`) because generated suffixes vary.
3. **Never use positional selectors** (`:nth-child`, `:first-child`) unless the structure is fully under your control.
4. **Test selectors in the actual browser** — what looks right in the source does not always match the DOM after framework processing (or shadow-DOM projection).

## 2. Theme System Interaction

Lit components are themed with **CSS custom properties** and `color-scheme` —
these are the levers that cross the shadow boundary. Reflect a `theme` property
to the host so CSS can key off it.

| ❌ Anti-Pattern | ✅ Correct Pattern | Rationale |
|----------------|-------------------|-----------|
| Hard-coding colors deep inside each component | Expose `--custom-properties` (and/or `::part`) and read them with `var(--x, fallback)` | Only custom properties and `::part` cross the shadow boundary; hard-coded values can't be re-themed. |
| Injecting light-mode colors unconditionally | Drive theme via a **reflected host attribute** + `color-scheme`; default to a fixed theme | Lets one toggle re-theme the whole tree; `color-scheme` fixes native controls/scrollbars. |
| Assuming system preference == user preference | Default to a fixed theme (dark or light), provide a toggle; optionally seed once from `prefers-color-scheme` | OS dark mode ≠ user wants dark mode in YOUR app. Explicit is better. |
| Theme toggle at the bottom of a long nav | Place the theme toggle at the TOP of the nav/sidebar | "Set and forget" controls should be visible without scrolling. |

### Lit Theme Setup

```ts
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-root")
export class AppRoot extends LitElement {
  // reflect: true → CSS can target :host([theme="dark"])
  @property({ reflect: true }) theme: "light" | "dark" = "dark";

  static styles = css`
    :host {
      color-scheme: dark;        /* default to a fixed theme */
      --bg: #0e1116;
      --fg: #e6edf3;
      background: var(--bg);
      color: var(--fg);
    }
    :host([theme="light"]) {
      color-scheme: light;
      --bg: #ffffff;
      --fg: #0e1116;
    }
  `;

  private _toggle() {
    this.theme = this.theme === "dark" ? "light" : "dark";
  }

  render() {
    return html`
      <button @click=${this._toggle}>
        ${this.theme === "dark" ? "☀︎ Light" : "🌙 Dark"}
      </button>
    `;
  }
}
```

**Key rule:** child components should read theme tokens as `var(--bg)` /
`var(--fg)` rather than defining their own colors, so a single host-level toggle
re-themes the entire tree.

## 3. State Synchronization

Lit uses **reactive properties** (`@property` / `@state`) — there is no global
session store. Assigning a reactive property triggers an automatic re-render.

### Reactive State Patterns

```ts
// ❌ DANGEROUS: unconditional replacement on fetch
this.items = await api.getItems();   // if API returns [], everything is wiped

// ✅ SAFE: defensive merge
const next = await api.getItems();
if (next.length) this.items = next;  // only replace if the fetch produced data
```

> **Lit gotcha:** mutating an array/object **in place** does NOT trigger a
> re-render. Assign a *new* reference (`this.items = [...this.items, x]`) or call
> `this.requestUpdate()`.

### Loading States

Every asynchronous operation needs a loading state:

```ts
@state() private loading = false;

async load() {
  this.loading = true;               // ✅ show feedback
  try {
    this.data = await api.fetchSlow();
  } finally {
    this.loading = false;
  }
}

render() {
  return this.loading
    ? html`<p>🔄 Loading…</p>`
    : html`${/* render this.data */ ""}`;
}
```

## 4. User Interaction Patterns

### Destructive Actions

```ts
@state() private confirming = false;

render() {
  return this.confirming
    ? html`<button @click=${() => this._delete()}>🗑 Confirm</button>`
    : html`<button @click=${() => (this.confirming = true)}>✕</button>`;
}
```

### Empty States

Every list that can be empty needs an explicit empty-state message:

```ts
${this.items.length === 0
  ? html`<p class="muted">Nothing here yet. Create something!</p>`
  : this.items.map((i) => this._renderItem(i))}
```

### Search/Filter

Add a filter input when lists exceed 5 items:

```ts
@state() private query = "";

private get _filtered() {
  const q = this.query.toLowerCase();
  return q ? this.items.filter((i) => i.name.toLowerCase().includes(q)) : this.items;
}

render() {
  return html`
    ${this.items.length > 5
      ? html`<input
          placeholder="Filter…"
          @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
        />`
      : ""}
    ${this._filtered.map((i) => this._renderItem(i))}
  `;
}
```

## 5. Framework-Specific Gotchas

### Lit

| Gotcha | Fix |
|--------|-----|
| Mutating arrays/objects in place doesn't re-render | Assign a new reference (`this.items = [...this.items, x]`) or call `this.requestUpdate()`. |
| `static styles` is scoped to the shadow root | Global/theme values must be passed via CSS custom properties or `::part` — they don't leak in or out. |
| `render()` returning `undefined` | Always return a template; conditional branches must yield `html\`…\`` or `nothing`, never `undefined`. |
| Custom events don't escape the shadow DOM | Dispatch with `{ bubbles: true, composed: true }` so parents outside the shadow root can listen. |
| Manually adding listeners to template nodes | Use `@event=${handler}` bindings — Lit adds/removes them for you across re-renders. |
| Browser-only APIs at module top level break SSR/tests | Access `window`/`document` in `firstUpdated()` / `connectedCallback()`, not at import time. |

### React

| Gotcha | Fix |
|--------|-----|
| useEffect double-fire in strict mode | Idempotent setup/teardown. |
| State updates batching | Use functional updates: `setCount(c => c + 1)`. |
| CSS-in-JS class volatility | Use `data-` attributes, not generated class names. |

## 6. Styling with Tailwind CSS (default)

Tailwind CSS (v4) is the default styling layer. Lit renders into **shadow DOM**,
and a global Tailwind stylesheet does **not** cross the shadow boundary — utility
classes on elements inside a component are unstyled unless Tailwind is adopted
into that component's shadow root.

### Required integration pattern (shadow DOM)

Compile Tailwind once and adopt it into each component. Import the built CSS as a
string (Vite `?inline`), wrap it with `unsafeCSS()`, and share it via a mixin:

```ts
// tailwind-mixin.ts
import { adoptStyles, unsafeCSS, type LitElement } from "lit";
import tailwind from "./tailwind.global.css?inline"; // @import "tailwindcss" + @theme

const sheet = unsafeCSS(tailwind);
type Ctor<T> = new (...args: any[]) => T;

export const TW = <T extends Ctor<LitElement>>(Base: T) =>
  class extends Base {
    connectedCallback() {
      super.connectedCallback();
      if (this.shadowRoot) adoptStyles(this.shadowRoot, [sheet]);
    }
  };
```

```ts
// my-card.ts
const TwLitElement = TW(LitElement);

@customElement("my-card")
export class MyCard extends TwLitElement {
  render() {
    return html`<div class="flex gap-4 rounded-xl bg-zinc-100 p-4">…</div>`;
  }
}
```

Lit uses constructable stylesheets, so the single adopted sheet is shared
(deduplicated) across all component instances.

### Tailwind v4 config (CSS-first)

```css
/* tailwind.global.css */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *)); /* manual dark mode */

@theme {
  --color-primary: oklch(0.62 0.19 256);
  --font-sans: "Inter", system-ui, sans-serif;
}
```

- v4 has **no `tailwind.config.js`** by default — configure with `@theme` in CSS.
- Content detection is automatic; add `@source "…"` if component files sit outside the scanned root.
- **Theme tokens cross the shadow boundary:** values on `:root`/`:host` (Tailwind `@theme`) are CSS custom properties visible inside shadow roots, so one host-level theme drives every component.

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Relying on a global Tailwind `<link>` to style shadow-DOM content | Adopt the compiled sheet into each component (mixin above) |
| `@apply` inside a component's `static styles` | Put utility classes in the `html` template; reserve `static styles` for `:host` / `::slotted()` |
| Concatenating class strings (`'btn ' + (x ? 'on' : '')`) | Use a `cn()` helper (clsx + tailwind-merge) |
| `unsafeCSS()` on anything but your **compiled, trusted** CSS | Never pass user input to `unsafeCSS()` — it can exfiltrate data (see `docs/agents/coding/security/xss.md`) |
