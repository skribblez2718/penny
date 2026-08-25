# TypeScript Coding Standards — Contracts and authoritative gates

## Scope and authority

This standard applies to every Penny-owned `.ts`, `.tsx`, and `.d.ts` file under
`.pi/extensions/`, `.pi/lib/`, `apps/observability/`, `apps/orchestration/`, and
`apps/platform-memory/`: runtime source, tests, fixtures, helpers, smoke tests, configuration
source, and declarations.

The inventory is discovered from the live filesystem, including non-ignored untracked files; it is
not a frozen allowlist or count assertion. The current tree reports **426 owned files**, all 426 with
type-aware ESLint and strict-program coverage, plus 210/210 test or smoke files reachable from a
package `test:all`. A new file must be discovered automatically and must acquire the same coverage.

## Authoritative root commands

| Command                           | Contract                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typescript:inventory`    | Discovers the five owned roots; verifies effective type-aware ESLint, strict-program membership, declaration checking, syntax, and runner mapping.                                                       |
| `bun run typescript:architecture` | Applies the full AST, suppression, SDK, registration, package, and extension-runtime policy to that inventory.                                                                                           |
| `bun run typescript:guard-tests`  | Runs generated positive and negative tests for every guard detector and verifies temporary-fixture cleanup.                                                                                              |
| `bun run lint`                    | Runs inventory, architecture, then the sequential type-aware ESLint runner with zero warnings.                                                                                                           |
| `bun run typecheck`               | Runs inventory, architecture, then every extension, library, application, orchestration test, and orchestration smoke project.                                                                           |
| `bun run test:typescript`         | Runs inventory, architecture, shared-library tests, then every distinct Vitest config reachable from package `test:all` scripts.                                                                         |
| `bun run format:check`            | Checks TypeScript, JavaScript, JSON, and Markdown formatting without writing.                                                                                                                            |
| `make verify-publication`         | Runs frozen Bun/uv installs; format, lint, strict checks, guards, mapped TypeScript and root tests, builds, Make checks, and staged secret scan—without staging, remote access, or live-model execution. |

`bun run lint` does not launch one repository-wide type-aware ESLint process. After the two guards,
`scripts/system/checks/typescript-lint.mjs` assigns each live TypeScript file to exactly one configured
tsconfig partition and runs those partitions **sequentially** with `--max-warnings=0` and
`--report-unused-disable-directives`; JavaScript is linted in a final partition. Missing projects,
unmatched files, multiply matched files, and empty configured partitions fail before delivery. Use
`bun run lint:fix` only when a requested code change authorizes edits; it runs the same sequential
runner with `--fix`, then reruns inventory and architecture.

Normal root commands pass no migration baseline. Do not create, check in, or rely on a TypeScript debt
baseline: any current finding fails the applicable command, and a baseline-aware migration pass is not
full compliance.

## Canonical type-aware ESLint matrix

Every owned file resolves every rule below to `error`:

| Rule                                           |
| ---------------------------------------------- |
| `@typescript-eslint/no-explicit-any`           |
| `@typescript-eslint/no-non-null-assertion`     |
| `@typescript-eslint/no-unsafe-assignment`      |
| `@typescript-eslint/no-unsafe-argument`        |
| `@typescript-eslint/no-unsafe-call`            |
| `@typescript-eslint/no-unsafe-member-access`   |
| `@typescript-eslint/no-unsafe-return`          |
| `@typescript-eslint/no-unsafe-enum-comparison` |
| `@typescript-eslint/no-unsafe-unary-minus`     |
| `@typescript-eslint/no-unsafe-type-assertion`  |

The architecture guard independently rejects explicit `any`, postfix non-null expressions,
definite-assignment assertions, unsafe single/double assertions, broad ESLint disables,
contract-rule suppressions outside the exact test-host registry, unused disables, `@ts-nocheck`, and
`@ts-ignore`. A used `@ts-expect-error` is allowed only in test/smoke/fixture source with a
same-line description identifying a negative compile/type contract, or for an upstream typing defect
whose same-line description includes `removal condition:`. Missing/short descriptions, other purposes,
and unused directives fail.

## Strict project vector

Every owned file must be an actual member of an invoked no-emit project whose effective compiler
options make all of these `true`:

- `strict`
- `noImplicitAny`
- `strictNullChecks`
- `strictFunctionTypes`
- `strictBindCallApply`
- `strictPropertyInitialization`
- `useUnknownInCatchVariables`
- `noImplicitThis`
- `alwaysStrict`
- `noEmit`

A child config or CLI flag may not downgrade the vector. Owned declarations must be checked in a
qualifying project without hiding their diagnostics behind `skipLibCheck`. Production build configs
may emit only when a separate invoked strict/no-emit project covers the same owned source.

## Contracts and boundaries

- Give durable state, public/cross-module results, and mutually exclusive variants named types or
  schema-derived discriminated unions.
- Treat JSON, HTTP, filesystem, database, environment, process, dynamic-import, and host/plugin data
  as `unknown` at entry. Validate once with a TypeBox schema, parser, or type guard, then pass a precise
  domain type inward.
- Explicit `any`, postfix `!`, and definite-assignment `!:` are prohibited in all owned source,
  including tests and fixtures.
- Avoid `as` assertions. Assertions that narrow or escape the source type and `as unknown as` bridges
  fail unless they are one of the exact central test-host seams below.
- Test doubles use `Pick`, small local interfaces, typed factories, `Parameters`, `ReturnType`,
  `satisfies`, or fail-fast narrowing. Malformed fixtures stay `unknown` until the real parser handles
  them. Never use optional chaining or defaults to turn an absent expected value into a false-green
  test.

## Exact partial-host test seams

There are exactly **five** centrally registered partial-host sites. This is a closed registry, not a
pattern authors may copy:

| Path                                                   | Exact asserted expression                          | Guard rule         |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------ |
| `apps/orchestration/tests/kb-loader-policy.test.ts`    | `unusedContextHost as unknown as ExtensionContext` | `DOUBLE_ASSERTION` |
| `.pi/extensions/powerpoint/tests/helpers/contracts.ts` | `guardedHost as ExtensionAPI`                      | `UNSAFE_ASSERTION` |
| `.pi/extensions/questionnaire/tests/helpers.ts`        | `guardedHost as ExtensionAPI`                      | `UNSAFE_ASSERTION` |
| `.pi/extensions/questionnaire/tests/helpers.ts`        | `guardedTui as TUI`                                | `UNSAFE_ASSERTION` |
| `.pi/extensions/questionnaire/tests/helpers.ts`        | `guardedTheme as Theme`                            | `UNSAFE_ASSERTION` |

Each record binds one path, exact AST site, guard rule, immediately preceding
`eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion`, rationale, removal condition,
and exact focused-test name. Matching local documentation and the focused test must exist. A moved,
renamed, duplicated, undocumented, or newly added site fails. New partial-host assertions are
prohibited unless the central policy and focused contract evidence are deliberately changed together.

## Pi extension and package contract

- Import host APIs only from the supported packages: `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`.
- Import TypeBox from `typebox`, never `@sinclair/typebox`; derive reusable static types with
  `Static<typeof Schema>`.
- Pass the exact schema to `registerTool` from `.pi/lib/pi-tool-registration.ts`. It is the sole raw
  `pi.registerTool` compatibility seam and preserves schema-derived callback parameters.
- In an extension manifest, every used Pi package and `typebox` belongs in `peerDependencies` with the
  exact range `"*"`, not in extension `dependencies` or `devDependencies`. The root pins every used Pi
  SDK package, `typebox`, and TypeScript to exact versions for workspace typechecking.
- Every extension has its own manifest, workspace registration, strict/no-emit `tsconfig.json`,
  `typecheck` script, and `test:all` that runs typecheck before its test commands. `package-lock.json`
  is prohibited; use Bun and `bun.lock`.
- Extension runtime code uses the shared logger instead of `console.log`, `console.warn`, or
  `console.error`, and reads `process.env` only inside the factory or a runtime callback.

## Test execution and the live-model gate

Test coverage is configuration-derived, not inferred from filenames alone. Inventory fails any test
or smoke file not matched by a real Vitest configuration reachable from its package `test:all`.
`bun run test:typescript` then discovers those reachable configurations and runs each distinct config
through one package script.

The one live-model config,
`apps/orchestration/vitest.kb-model-smoke.config.ts`, is permanently routed through
`test:kb-model-smoke:aggregate`. It skips with a clear message unless
`PENNY_KB_MODEL_SMOKE=1`; setting that variable opts into the predeclared live KB model cohort and
requires separate authorization for its external/costly model use. Offline/default TypeScript gates
do not silently run it.

## Delivery checklist

- [ ] Focused tests prove the changed behavior.
- [ ] `bun run format:check` passes for the changed files.
- [ ] `bun run lint` passes with zero warnings and direct, no-baseline compliance.
- [ ] `bun run typecheck` passes all strict projects.
- [ ] `bun run test:typescript` passes; any live-model skip is reported honestly.
- [ ] Package, schema, boundary, assertion, and exact test-host policies remain satisfied.
- [ ] Run `make verify-publication` when the requested scope requires the aggregate local publication gate.
