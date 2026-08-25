# Extension Creation Procedure — Adding a Penny extension

## What

Create a Pi extension under `.pi/extensions/<name>/` with one schema-preserving registration seam,
strict TypeScript coverage, a self-contained Bun package, mapped tests, and provider-visible tool
guidance.

## Required files and registration

1. Create `.pi/extensions/<name>/`.
2. Add `index.ts` with a default factory that receives the supported Pi `ExtensionAPI`.
3. Add a strict/no-emit `tsconfig.json` using `module: "NodeNext"`. Every owned source, test,
   fixture/helper, and TypeScript config file must belong to an invoked project with the complete
   strict vector in [TypeScript Coding Standards](../coding/typescript.md#strict-project-vector).
4. Add `package.json`, even when the extension has no dependencies. Include `name`, `version`,
   `main: "index.ts"`, `type: "module"`, `typecheck`, and `test:all`; `test:all` runs typecheck before
   every test command.
5. Add the package to the alphabetically sorted root `workspaces` array and run `bun install` from the
   repository root.
6. Add `README.md` for tools, commands, events, and configuration.
7. Add Vitest configuration and tests under `tests/`. Every test or smoke file must match a real
   configuration reachable from the package `test:all`.
8. Write provider-visible tool descriptions according to the
   [Tool Description Standard](tool-description-standard.md). Do not use `promptGuidelines` in Penny
   runtime source.

A typical package skeleton is:

```json
{
  "name": "@penny/<name>-extension",
  "version": "1.0.0",
  "private": true,
  "main": "index.ts",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test:unit": "vitest run --config tests/vitest.config.ts",
    "test:all": "bun run typecheck && bun run test:unit"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

List only packages the extension imports. Add integration/E2E scripts and configurations only when
those suites exist, and make each one reachable from `test:all`.

## Package and SDK contract

- Import Pi APIs only from `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, or `@earendil-works/pi-tui`.
- Import TypeBox from `typebox`, never `@sinclair/typebox`.
- Put each used Pi package and `typebox` in extension `peerDependencies` with the exact range `"*"`.
  Do not duplicate those packages in the extension's `dependencies` or `devDependencies`.
- Root `devDependencies` provide exact version pins for every used Pi SDK package, `typebox`, and
  TypeScript. Do not add a looser extension-local compiler/SDK pin.
- Use Bun and the root `bun.lock`. Never add `package-lock.json` or use an extension-local npm install
  to make workspace resolution appear green.
- A package manifest is mandatory even with zero dependencies: without it, a package command can walk
  up to the workspace root and recurse into root loops.

## Tool and runtime contract

- Define TypeBox parameter schemas and derive reusable types with `Static<typeof Schema>`; never
  maintain a hand-written parameter interface beside a schema.
- Register tools through `registerTool` from `.pi/lib/pi-tool-registration.ts`. Raw
  `pi.registerTool` is allowed only inside that adapter.
- Keep gateway/consequential routing and nearest anti-cases in the tool description; keep argument
  semantics and bounds in parameter descriptions.
- Use `createLogger` from `../../lib/logger/logger.js`; extension runtime
  `console.log`/`console.warn`/`console.error` calls fail architecture checks.
- Read `process.env` only inside the extension factory or a runtime callback, never at module scope.
- Use typed test hosts. New partial-host assertions are prohibited; the only five allowed sites are
  the closed central registry in
  [TypeScript Coding Standards](../coding/typescript.md#exact-partial-host-test-seams).

## Verification

From the extension while iterating:

```bash
bun run typecheck
bun run test:all
```

Before delivery from the repository root:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run typescript:guard-tests
bun run test:typescript
```

`bun run lint` and `bun run typecheck` dynamically discover the extension's files through inventory
and architecture before running their normal checks. No hardcoded file count or migration baseline is
accepted. Use `make verify-publication` when the requested scope requires the aggregate local
publication gate; its live-model smoke remains opt-in through `PENNY_KB_MODEL_SMOKE=1`.

## Checklist

- [ ] Manifest exists, package is registered in root workspaces, and `bun install` succeeds.
- [ ] Used Pi/TypeBox packages have `"*"` peer dependencies and exact root pins.
- [ ] Strict/no-emit project covers runtime, tests, fixtures/helpers, and configs.
- [ ] `test:all` runs typecheck first and reaches every configured test suite.
- [ ] Tool schemas derive callback types and use the sole registration adapter.
- [ ] No raw Pi registration, unsupported import, explicit `any`, non-null/definite assertion, or new partial-host cast exists.
- [ ] No runtime console call, module-scope environment read, or `promptGuidelines` exists.
- [ ] Focused tests and all root gates above pass; any live-model skip is reported honestly.
