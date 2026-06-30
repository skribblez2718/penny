# Implement Prompt — Caido Extension Logic

## Mission

Implement the Caido extension logic per the design document. All constraints from `resources/reference.md` are **hard rules** — violating any will cause known failures.

## Hard Constraints (DO NOT VIOLATE)

These are injected from `resources/reference.md` and MUST be followed:

1. **RPC Registration**: `sdk.api.register("name", callback)` — NEVER `sdk.api.name = fn`
2. **RPC Callbacks**: `fn(sdk: SDK<API>, ...args)` — sdk is first parameter
3. **Frontend Pages**: `navigation.addPage` + `sidebar.registerItem` — NEVER `settings.addToSlot`
4. **Components**: `.ts` with `defineComponent({ setup() { return () => h(...) } })` — NEVER `.vue` SFCs
5. **CSS**: Explicit dark colors (`#1e1e2e`, `#e0e0e0`, `#444`) — NEVER Caido CSS variables, NEVER Tailwind
6. **Imports**: `createApp`, `h`, `defineComponent` from `vue` (bundled by Vite)
7. **ComponentDefinition**: `{ component: YourComponent }` format for slots/definitions
8. **Props**: Caido passes `sdk` as a prop — use `defineComponent({ props: { sdk: ... } })` or `defineProps`

## Implementation Guidelines

### Backend
- Extract pure logic functions for testability
- Export with `_` prefix: `export { fn as _fn }`
- `onUpstream`: always log with `sdk.console.log()` for debugging
- `onUpstream`: return `undefined` when no modifications needed
- API type: `export type API = DefineAPI<{ ... }>`

### Frontend
- Create a wrapper component with `createApp` from Vue
- Mount to a `document.createElement("div")` root
- Use `h()` to build DOM elements with explicit class names
- Button click handlers: `onClick: () => handler()` (NOT `@click` templates)
- Input binding: `value: row.value, onInput: (e) => row.value = e.target.value`
- Style: Match CSS class names between component and `style.css`

### Full-Stack
- Backend `DefineAPI` type must match frontend `sdk.backend.*` calls exactly
- On frontend mount: load from storage, push to backend via RPC
- On save: persist to storage first, then push to backend

### Workflow
- JS node: `export async function run({ request, response }, sdk) { ... }`
- Use `request.toSpec()` to create mutable copy
- Use `spec.setHeader(name, value)` to add headers
- Use `sdk.requests.send(spec)` to resend modified request

## Output

Return a SUMMARY with files implemented:
```
SUMMARY:{"files_created":<n>,"files_modified":<n>,"implement_complete":true}
```
