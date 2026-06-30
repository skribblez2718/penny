# Caido Plugin Development — Constraints & Reference

> Compiled from the header-injector plugin development session. Use these as hard constraints when implementing Caido extensions.

## Scaffolding & Build

- **Project location**: All plugins live at `~/projects/caido-plugins/<plugin-name>`.
- **Source of truth**: `caido.config.ts`. Never hand-write `manifest.json`.
- **Build**: `npx caido-dev build` produces `dist/plugin_package.zip` with validated manifest.
- **ZIP structure**: `manifest.json` at root, code at `<plugin-id>/index.js`.
- **Backend build**: tsup. `runtime: "javascript"` required for backend plugins.
- **Frontend build**: Vite. Add `@vitejs/plugin-vue` if using Vue. Externalize `@caido/frontend-sdk`.
- **Manifest validation**: Build runs Caido's official schema validator automatically.

## Backend — RPC API

- **Register with**: `sdk.api.register("methodName", callback)` — NOT property assignment.
- **Callback signature**: Must include `sdk` as first parameter: `fn(sdk: SDK<API>, ...args)`.
- **Type**: `APICallback<T> = (sdk: SDK, ...args: Parameters<T>) => ReturnType<T>`.
- **Type definition**: Import `DefineAPI` from `caido:plugin` (virtual module). Types from `@caido/sdk-backend` npm package.

## Backend — Event Hooks

### onUpstream (v0.55+)
- Fires **before** request is sent to target. Can modify request synchronously.
- **Requires explicit domain rules**: Settings → Network → Upstream Plugins.
- `*` wildcard may not work for all domains — test with explicit domains.
- Returns: `RequestSpec` (modified), `undefined` (pass-through), `Connection`, or `{ connection, request }`.
- HTTP History shows **original** (intercepted) request, not modified version. Verify with httpbin.org/get.
- SDK for programmatic upstream rule creation: NOT YET AVAILABLE (issue #2067).

### onInterceptRequest
- Fires for **every** proxied request automatically — no upstream rules needed.
- **Cannot modify** the request in place (async callback). Use `sdk.requests.send()` to resend modified copy.
- Resending creates a duplicate request in history.

### onInterceptResponse
- Fires for every proxied response.

## Frontend — Pages

### Navigation Page (proven, working)
```ts
const root = document.createElement("div");
const app = createApp(YourComponent);
app.mount(root);
sdk.navigation.addPage("/path", { body: root });
sdk.sidebar.registerItem("Label", "/path", { icon: "fas fa-icon" });
```

### Settings Slot (broken in v0.56)
- `sdk.settings.addToSlot("plugins-section", ...)` — feature incomplete (issue #2021, still open).
- **DO NOT USE**. Use navigation pages instead.

## Frontend — Components

- **Use `.ts` with `defineComponent` + `h()`** — NOT `.vue` SFCs.
- `.vue` SFCs without `<template>` break Vite. `<script setup>` may cause silent handler failures.
- **ComponentDefinition**: `{ component: VueComponent, props?, events? }`.
- **Props**: Caido passes `sdk` as a prop to settings/command palette components.

## Frontend — CSS

- **Do NOT use Caido CSS variables**: `var(--caido-*)` renders invisible in dark theme.
- **Do NOT use Tailwind**: Caido doesn't include Tailwind by default.
- **Use explicit dark-mode colors**: `background: #1e1e2e`, `color: #e0e0e0`, `border: 1px solid #444`.
- Custom CSS file with class selectors matching component class names.

## Frontend — SDK

- `sdk.storage.get()/set()` — persist data across sessions.
- `sdk.backend.methodName()` — call backend RPC endpoints.
- `sdk.window.showToast("msg", { variant: "success"|"error"|"warning"|"info" })`.
- `sdk.ui.button({ variant, label, size })` — Caido-styled buttons.
- `sdk.ui.card({ header, body, footer })` — layout container.

## Testing

- **Mock virtual modules**: `vi.mock("caido:plugin")`, `vi.mock("caido:utils")`.
- **Export pure logic**: `export { fn as _fn }` — tests call with null SDK parameter.
- **Avoid jsdom**: Hangs vitest. Use `environment: "node"` + minimal `globalThis.document` mock in `beforeAll`.
- **Mock SDK**: `api.register`, `events.onUpstream`, `storage.get/set`, `backend.*` as `vi.fn()`.
- **Pipeline**: lint → typecheck → unit tests → build. All must pass.

## Extension Types

| Type | Backend | Frontend | Workflow | Use Case |
|------|---------|----------|----------|----------|
| Backend-only | ✅ | ❌ | ❌ | Request modification, API hooks |
| Frontend-only | ❌ | ✅ | ❌ | UI enhancements, custom pages |
| Full-stack | ✅ | ✅ | ❌ | Configurable tools with UI |
| Workflow | ❌ | ❌ | ✅ | Automated sequences, resend logic |

## Reference Docs

- [Plugin Architecture](https://developer.caido.io/concepts/package.html)
- [onUpstream Hook](https://developer.caido.io/guides/plugin_upstream.html)
- [Backend SDK Reference](https://developer.caido.io/reference/sdks/backend)
- [Frontend SDK Reference](https://developer.caido.io/reference/sdks/frontend/)
- [Creating Pages](https://developer.caido.io/guides/components/page.html)
- [manifest.json Reference](https://developer.caido.io/reference/manifest.html)
- [Configure Package](https://developer.caido.io/guides/config.html)
- [Plugin Manifest Validator](https://github.com/caido/plugin-manifest)
- [Workflow Tutorial](https://docs.caido.io/tutorials/add_header)
- [Reference: plugin-demo](https://github.com/caido-community/plugin-demo)
- [Reference: authmatrix](https://github.com/caido-community/authmatrix)
- [Issue #2021 — Settings SDK](https://github.com/caido/caido/issues/2021)
- [Issue #2067 — Upstream SDK](https://github.com/caido/caido/issues/2067)
