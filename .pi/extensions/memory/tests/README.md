# Memory Extension Tests

All memory-extension tests are hermetic. They exercise the imported `platform-memory` client/policy through injected `fetch` implementations or an in-process fake HTTP MCP endpoint; no test opens, queries, or mutates a palace. Cross-harness and clean-machine lifecycle conformance lives with the generic package under `apps/platform-memory/tests/`.

## Suites

- `unit/mcp-client.test.ts`: JSON-RPC request IDs, bearer auth, timeout, cancellation, safe-read retry, write no-retry, malformed responses, and typed errors.
- `unit/policy-config.test.ts`: deny-only role markers, primary bundles, hub-only mode, and owner-only token references.
- `unit/result-budget-continuation.test.ts`: giant/multibyte/exact and broad-result REQ-028 fixtures, complete-envelope measurement, cursor binding, expiry, staleness, and byte-exact reassembly.
- `unit/kg-policy.test.ts`: versioned predicate allowlist and supersede mapping.
- `integration/registered-tools-budget.test.ts`: actual registered Pi tool execution, budget enforcement, and exact continuation reassembly.
- `integration/auto_diary.test.ts`: direct/parallel/chain/skill worker shutdown makes zero memory calls; primary diary remains duplicate-safe and bounded.
- `integration/mempalace.test.ts`: real HTTP POST against an in-process fake `/mcp` server.

## Commands

```bash
cd $PROJECT_ROOT/.pi/extensions/memory
bun run test:unit
bun run test:integration
bun run test:all
```
