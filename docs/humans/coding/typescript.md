# TypeScript in Penny

Penny treats TypeScript as a design contract. Runtime source, tests, fixtures, helpers, smoke tests,
configuration files, and owned declarations are held to the same strict standard so a green root gate
means the whole owned surface is covered—not merely the easiest subset.

## What the repository covers

The owned roots are:

- `.pi/extensions/`
- `.pi/lib/`
- `apps/observability/`
- `apps/orchestration/`
- `apps/platform-memory/`

The inventory walks those roots dynamically, including non-ignored untracked TypeScript. There is no
frozen file allowlist and no hardcoded pass count. In the current tree,
`bun run typescript:inventory` reports **426 owned files**, with type-aware ESLint and strict-program
coverage for all 426, and 210/210 test or smoke files reachable from package `test:all` scripts. Those
numbers are a live report, not a target embedded in the checker; adding a file must increase the
inventory and acquire the same coverage automatically.

## The command surface

| Command                           | What it proves                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typescript:inventory`    | Every live owned file has effective type-aware ESLint, a qualifying strict project, valid syntax, and—when applicable—a test runner.                                                                     |
| `bun run typescript:architecture` | AST, suppression, Pi SDK, tool registration, package, and extension-runtime architecture rules pass.                                                                                                     |
| `bun run typescript:guard-tests`  | Positive and negative generated fixtures exercise every guard detector and clean up after themselves.                                                                                                    |
| `bun run lint`                    | Inventory and architecture pass, then ESLint runs with zero warnings over sequential type-aware project partitions.                                                                                      |
| `bun run typecheck`               | Inventory and architecture pass, then all extension, library, application, orchestration-test, and orchestration-smoke projects check.                                                                   |
| `bun run test:typescript`         | Inventory and architecture pass, shared-library tests run, then each distinct reachable Vitest configuration runs once.                                                                                  |
| `bun run format:check`            | Prettier checks TypeScript, JavaScript, JSON, and Markdown without rewriting files.                                                                                                                      |
| `make verify-publication`         | Runs frozen Bun/uv installs; format, lint, strict checks, guards, mapped TypeScript and root tests, builds, Make checks, and staged secret scan—without staging, remote access, or live-model execution. |

The root linter is intentionally sequential. A coordinator assigns every TypeScript file to exactly
one configured tsconfig partition, then launches ESLint once per partition with
`--max-warnings=0` and unused-disable reporting. This avoids one memory-heavy repository-wide
TypeScript program while preserving fully type-aware lint. Unmatched files, multiply matched files,
missing projects, and empty configured partitions fail before lint can claim success. JavaScript runs
as a final partition.

The normal commands do **not** pass a migration baseline. Penny has no accepted TypeScript debt
baseline: a current violation fails, and a baseline-aware migration result must never be presented as
full compliance.

## The canonical ESLint contract

Every owned TypeScript file resolves all ten rules below to `error`:

| Rule                                           | What it blocks                                      |
| ---------------------------------------------- | --------------------------------------------------- |
| `@typescript-eslint/no-explicit-any`           | Explicit opt-out from type checking                 |
| `@typescript-eslint/no-non-null-assertion`     | Postfix `value!`                                    |
| `@typescript-eslint/no-unsafe-assignment`      | Assigning values that flow from `any`               |
| `@typescript-eslint/no-unsafe-argument`        | Passing `any` into typed code                       |
| `@typescript-eslint/no-unsafe-call`            | Calling a value whose callable contract is unknown  |
| `@typescript-eslint/no-unsafe-member-access`   | Reading properties through `any`                    |
| `@typescript-eslint/no-unsafe-return`          | Returning `any` from typed code                     |
| `@typescript-eslint/no-unsafe-enum-comparison` | Comparing unrelated enum values through unsafe flow |
| `@typescript-eslint/no-unsafe-unary-minus`     | Applying unary minus to an unsafe value             |
| `@typescript-eslint/no-unsafe-type-assertion`  | Assertions that narrow or escape the source type    |

The architecture guard adds checks ESLint alone does not express completely: definite-assignment
assertions (`field!: T`), double assertions such as `value as unknown as T`, unsupported Pi imports
or ambient shims, raw tool registration outside the adapter, package placement, module-scope
environment reads, and suppression policy.

`@ts-nocheck` and `@ts-ignore` are prohibited. A used `@ts-expect-error` is accepted only in
test/smoke/fixture source with a same-line description identifying a negative compile/type contract,
or for an upstream typing defect whose same-line description includes `removal condition:`.
Missing/short descriptions, unrelated purposes, and unused directives fail. Broad ESLint disables,
unused disables, and mandatory-rule suppressions fail except at the five registered test-host sites
described below.

## Strict projects, not a shared catch-all

Every owned file must actually belong to an invoked no-emit project whose effective option vector has
all of these enabled:

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

A child tsconfig or command-line override cannot turn one of those off. Owned declarations must be
checked without `skipLibCheck` hiding their diagnostics. An application may retain an emitting build
config, but a separate invoked strict/no-emit project must cover its owned source; orchestration uses
dedicated source, test, and live-model-smoke projects.

## Design contracts

### Model states as discriminated unions

Mutually exclusive states should have mutually exclusive shapes:

```typescript
type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: User[] }
  | { status: "error"; message: string };

function render(state: FetchState): string {
  switch (state.status) {
    case "idle":
      return "Ready";
    case "loading":
      return "Loading";
    case "success":
      return `${state.data.length} users`;
    case "error":
      return state.message;
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}
```

### Keep untrusted data `unknown` until validation

JSON, HTTP, filesystem, database, environment, process, dynamic-import, and host/plugin values are
untrusted boundaries. Receive them as `unknown`, validate once, and pass a named type inward.

For Pi tools, TypeBox is both the runtime schema and the static type source:

```typescript
import type { Static } from "typebox";
import { Type } from "typebox";

const UserSchema = Type.Object({
  id: Type.String(),
  role: Type.Union([Type.Literal("admin"), Type.Literal("viewer")]),
});

type User = Static<typeof UserSchema>;
```

Do not maintain a hand-written parameter interface beside the schema. Penny tools pass the exact
schema to the shared `registerTool` adapter so `execute` receives the schema-derived parameter type.

### Prefer narrowing to assertions

An assertion asks the compiler to trust the author. Narrowing proves the condition:

```typescript
const page = pages[pageId];
if (page === undefined) {
  throw new Error(`catalog page '${pageId}' is absent`);
}
usePage(page);
```

Explicit `any`, postfix non-null assertions, and definite-assignment assertions are prohibited across
the complete owned corpus, including tests. Unsafe single assertions and `as unknown as` bridges also
fail unless they are one of the five exact partial-host test seams.

## The five partial-host test seams

Penny has exactly five central exceptions for Pi host types that are much larger than the surface a
focused test exercises:

| Path                                                   | Exact asserted expression                          |
| ------------------------------------------------------ | -------------------------------------------------- |
| `apps/orchestration/tests/kb-loader-policy.test.ts`    | `unusedContextHost as unknown as ExtensionContext` |
| `.pi/extensions/powerpoint/tests/helpers/contracts.ts` | `guardedHost as ExtensionAPI`                      |
| `.pi/extensions/questionnaire/tests/helpers.ts`        | `guardedHost as ExtensionAPI`                      |
| `.pi/extensions/questionnaire/tests/helpers.ts`        | `guardedTui as TUI`                                |
| `.pi/extensions/questionnaire/tests/helpers.ts`        | `guardedTheme as Theme`                            |

This is a closed registry, not a general permission to cast partial fakes. Each entry binds an exact
path and AST expression to one immediately preceding
`eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion`, a matching local rationale,
a removal condition, and a named focused test that fails if the partial host surface is exceeded. A
moved, renamed, duplicated, undocumented, or new assertion fails the architecture guard.

Every other test double should use a small local interface, `Pick`, `Parameters`, `ReturnType`,
`satisfies`, a typed factory, or a fail-fast lookup helper. Malformed fixtures remain `unknown` until
the production parser sees them. Avoid optional chaining and fallback defaults that can turn a
missing expected value into a false-green test.

## Pi extension package contract

Extension packages use Penny's supported SDK boundary:

- Host imports come only from `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, or `@earendil-works/pi-tui`.
- Tool schemas import from `typebox`, never `@sinclair/typebox`.
- Every used Pi package and `typebox` appears in the extension's `peerDependencies` with range `"*"`.
  Those packages do not also appear in that extension's `dependencies` or `devDependencies`.
- Root `devDependencies` pin every used Pi SDK package, `typebox`, and TypeScript to exact versions for
  reproducible workspace typechecking.
- Every extension has a package manifest, root-workspace entry, strict/no-emit `tsconfig.json`,
  `typecheck`, and `test:all`; `test:all` runs typecheck before tests.
- Bun owns dependency resolution and `bun.lock`. Extension `package-lock.json` files are prohibited.
- The shared `.pi/lib/pi-tool-registration.ts` adapter is the only raw `pi.registerTool` site.

See the [extension standard](../extensions/extension-standard.md) and
[dependency-management guide](../extensions/dependency-management.md) for authoring details.

## Tests and the live-model gate

A test is not covered merely because it compiles. Inventory maps every test and smoke file to a real
Vitest configuration reachable from its package `test:all`. `bun run test:typescript` discovers those
reachable configurations and runs each distinct config once after the shared-library suite.

The single live-model config is
`apps/orchestration/vitest.kb-model-smoke.config.ts`. The aggregate runner always routes it through
`test:kb-model-smoke:aggregate`, which prints a skip unless `PENNY_KB_MODEL_SMOKE=1`. Setting that
variable opts into the predeclared live KB model cohort and should be done only with separate
authorization for the external/costly model call. Default and offline gates never silently opt in.

## Delivery checklist

For TypeScript changes:

1. Run focused tests that prove the behavior.
2. Run `bun run format:check`.
3. Run root `bun run lint` and `bun run typecheck`; package-only checks are useful during iteration but
   do not replace the root gates for shared, package, or cross-project changes.
4. Run `bun run test:typescript` for the aggregate mapped TypeScript suites.
5. Report the live-model smoke as skipped unless it was separately authorized and run.
6. Use `make verify-publication` when the delivery scope calls for the aggregate local publication
   gate.
