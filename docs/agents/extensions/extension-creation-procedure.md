# Extension Creation Procedure — Adding a Penny extension

## What

Create a Pi extension under `.pi/extensions/<name>/` with one schema-preserving registration seam,
strict TypeScript coverage, a self-contained Bun package, mapped tests, and provider-visible tool
guidance. Read [TypeScript Coding Standards](../coding/typescript.md) once for shared
package, strict-project, schema/registration, logger/environment, assertion, test-enrollment,
and delivery contracts. This procedure adds extension-specific setup and integration.
For read-only review, assess requirements and available evidence; setup commands and external
checks are not authorized merely by this route.

## Required files and registration

1. Create `.pi/extensions/<name>/`.
2. Add `index.ts` with a default factory that receives the supported Pi `ExtensionAPI`.
3. Add a strict/no-emit `tsconfig.json` using `module: "NodeNext"`, covering every owned
   source, test, fixture/helper, and TypeScript config under the shared strict-project contract.
4. Add `package.json`, even with no dependencies. Include `name`, `version`, `main: "index.ts"`,
   and `type: "module"`; use the shared `typecheck`/`test:all` and dependency contract.
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

Apply the [TypeScript package/SDK contract](../coding/typescript.md#pi-extension-and-package-contract)
without a second extension-local version matrix. The skeleton above lists only imported
packages; exact root pins, `"*"` peer ranges, Bun workspace resolution, and a manifest even
with zero dependencies remain required.

## Tool and runtime contract

Use the [TypeScript schema/registration and runtime contract](../coding/typescript.md#pi-extension-and-package-contract)
and its [exact test-host seams](../coding/typescript.md#exact-partial-host-test-seams).
Keep extension-specific routing/anti-cases in provider-visible descriptions and argument
semantics in parameter descriptions under the [Tool Description Standard](tool-description-standard.md).
Do not duplicate shared schema-derived types, the sole registration adapter, logger/env rules,
or the closed assertion registry here.

## Verification

While iterating from the extension, run `bun run typecheck` and `bun run test:all`.
Before delivery, complete the [TypeScript delivery checklist](../coding/typescript.md#delivery-checklist)
and run the root `bun run typescript:guard-tests` detector suite. Inventory must discover the
extension and map all test/smoke files dynamically, without a frozen count or migration baseline.

The [external/live-test gates](../coding/typescript.md#test-execution-and-the-live-model-gate)
retain separate opt-ins; a routed or skipped cohort is not qualification evidence.
Use `make verify-publication` only when the requested scope calls for that aggregate gate;
this procedure does not authorize installs, external tests, or publication by itself.

## Checklist

- [ ] Extension factory, README, workspace entry, manifest, strict project, and mapped tests exist.
- [ ] Shared [TypeScript delivery checks](../coding/typescript.md#delivery-checklist) and
      `typescript:guard-tests` pass with no unsupported new test-host seam.
- [ ] Provider-visible descriptions meet their standard; no runtime `promptGuidelines` exists.
- [ ] Report external/live-model skips and any unverified integration boundary honestly.
