# Test Prompt — Caido Extension TDD

## Mission

Write and run tests for the Caido extension. All tests must pass before the build phase. Use Caido-specific test patterns from `resources/reference.md`.

## Test Patterns

### Mocking Caido Runtime Modules
```ts
vi.mock("caido:plugin", () => ({}));
vi.mock("caido:utils", () => ({}));
```
These virtual modules only exist in the Caido runtime — always mock them.

### Testing Backend Logic
- Export pure functions with `_` prefix: `export { setHeaders as _setHeaders }`
- In tests: `const mod = await import("../../backend/src/index")`
- Call with null SDK parameter: `await mod._setHeaders(null as any, { "X-Foo": "bar" })`
- Test: `vi.resetModules()` in `beforeEach` for clean state

### Testing RPC Registration
```ts
const sdk = { api: { register: vi.fn() }, events: { onUpstream: vi.fn() } };
mod.init(sdk);
expect(sdk.api.register).toHaveBeenCalledWith("setHeaders", expect.any(Function));
```

### Testing onUpstream Handler
```ts
const callback = sdk.events.onUpstream.mock.calls[0][0];
const mockRequest = {
  toSpec: () => ({ setHeader: vi.fn() }),
  getHost: () => "example.com",
};
const result = await callback({}, mockRequest);
```

### Testing Frontend Logic
- Extract pure logic to separate files (`headers-logic.ts`)
- Test filtering, parsing, and transformation functions
- For component tests: mock `vue`, mock `@caido/sdk-frontend`, provide minimal `document` mock

### Avoiding jsdom
- jsdom hangs vitest in Caido projects
- Use `environment: "node"` in vitest.config.ts
- Add minimal `globalThis.document` mock in `beforeAll` for component tests

## Required Test Coverage

| Test Type | Minimum | Example |
|-----------|---------|---------|
| setHeaders / getHeaders | Filter empty, null, undefined; overwrite; copy semantics | `_setHeaders(FAKE_SDK, { "X-Keep": "val", "X-Skip": "" })` |
| onUpstream | Inject headers, skip when empty, multiple headers | Test callback directly |
| init registration | All RPC methods registered, all hooks registered | `expect(sdk.api.register).toHaveBeenCalledWith(...)` |
| Frontend pure logic | All exported functions tested with edge cases | Empty input, null input, large input |
| Frontend entry | init function exported, page/sidebar registered | `expect(sdk.navigation.addPage).toHaveBeenCalled()` |

## Pipeline

Run in this order — all must pass:
1. `npx eslint '**/*.ts'` — 0 errors
2. `npx tsc --noEmit` (or per tsconfig) — 0 errors
3. `npx vitest run` — all tests pass
4. `npx caido-dev build` — produces valid ZIP

## Output

```
SUMMARY:{"tests_total":<n>,"tests_passed":<n>,"lint":"ok|fail","typecheck":"ok|fail","test_complete":true|false}
```
