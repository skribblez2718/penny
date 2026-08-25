# TypeScript Testing, Quality, and Publication Gates

Penny's TypeScript quality certificate is rooted in live discovery. A file is not covered merely
because a glob appears broad, and a test is not covered merely because it typechecks. The guards
inspect the effective ESLint project, actual TypeScript program membership, and real Vitest runner
mapping for every owned file.

## Owned scope and current report

The dynamic inventory walks `.pi/extensions/`, `.pi/lib/`, `apps/observability/`,
`apps/orchestration/`, and `apps/platform-memory/`, including non-ignored untracked TypeScript. The
current report is 426/426 files with type-aware lint and strict-program coverage, plus 210/210 test or
smoke files reachable from package `test:all`. Neither number is hardcoded; new files must be
discovered and covered automatically.

## Root command map

| Command                           | Purpose                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typescript:inventory`    | Check live file discovery, effective lint coverage, qualifying strict projects, declarations, syntax, and test-runner mapping.                  |
| `bun run typescript:architecture` | Check assertions, directives/suppressions, SDK and tool seams, extension packages, logging, and environment-read policy.                        |
| `bun run typescript:guard-tests`  | Exercise every detector with generated positive/negative fixtures and verify cleanup.                                                           |
| `bun run lint`                    | Run inventory, architecture, and sequential type-aware ESLint with zero warnings.                                                               |
| `bun run typecheck`               | Run inventory, architecture, and all extension/library/application plus orchestration test/smoke projects.                                      |
| `bun run test:typescript`         | Run inventory, architecture, shared-library tests, and every distinct Vitest config reachable from package `test:all`.                          |
| `bun run format:check`            | Check TypeScript, JavaScript, JSON, and Markdown formatting.                                                                                    |
| `bun run test:all`                | Run root TypeScript/Python typecheck, lint, format checks, aggregate TypeScript tests, and Python tests.                                        |
| `make verify-publication`         | Run frozen Bun/uv installs; format, lint, strict checks, guards, mapped TypeScript and root tests, builds, Make checks, and staged secret scan. |

`make verify-publication` is the installed aggregate local publication gate. It installs frozen
dependencies and runs the complete offline-safe check set, but does not stage files, create a commit,
or contact a Git remote. It never opts into a live model itself; with `PENNY_KB_MODEL_SMOKE` unset,
the live config prints its skip. Candidate-tree, range, and remote verification remain explicit
Phase-5 procedures.

## Sequential type-aware lint

Root `bun run lint` first executes inventory and architecture. It then uses
`scripts/system/checks/typescript-lint.mjs` to assign each TypeScript file to exactly one configured
tsconfig partition and launch ESLint over those partitions one at a time. Every invocation uses
`--max-warnings=0` and unused-disable reporting. JavaScript runs in a final partition.

The coordinator fails before delivery when a configured project is absent, a live TypeScript file
matches no partition or multiple partitions, or a configured partition has no inventory files. This
keeps lint type-aware without constructing one memory-heavy repository-wide TypeScript program.

Every owned file must resolve the complete canonical matrix to `error`:

- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/no-non-null-assertion`
- `@typescript-eslint/no-unsafe-assignment`
- `@typescript-eslint/no-unsafe-argument`
- `@typescript-eslint/no-unsafe-call`
- `@typescript-eslint/no-unsafe-member-access`
- `@typescript-eslint/no-unsafe-return`
- `@typescript-eslint/no-unsafe-enum-comparison`
- `@typescript-eslint/no-unsafe-unary-minus`
- `@typescript-eslint/no-unsafe-type-assertion`

The architecture guard also catches definite-assignment assertions, double assertions,
`@ts-nocheck`, `@ts-ignore`, invalid/unused `@ts-expect-error`, broad or unused ESLint disables,
contract-rule suppressions outside the exact five-site test-host registry, raw Pi registration outside
the adapter, unsupported imports, invalid package placement, extension runtime console calls, and
module-scope `process.env` reads. A used `@ts-expect-error` needs the checker's same-line negative
compile/type-contract description or upstream-defect removal condition.

## Typecheck projects

Each owned file must be an actual member of an invoked no-emit project whose effective options enable
`strict`, `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`,
`strictPropertyInitialization`, `useUnknownInCatchVariables`, `noImplicitThis`, `alwaysStrict`, and
`noEmit`. Child configs and CLI flags may not downgrade that vector. Owned declarations cannot rely on
`skipLibCheck` to hide diagnostics. Orchestration has separate strict source, test, and live-smoke
projects.

## Package test contract

Every extension package provides a `typecheck` script and a `test:all` script that runs typecheck
before tests. A package may own unit, integration, E2E, or other suites when the feature requires them;
there is no universal claim that every package has every test level or a fixed directory layout. The
contract is that every TypeScript test/smoke file is matched by an actual Vitest configuration
reachable from that package's `test:all`.

`bun run test:typescript` discovers the reachable Vitest configurations and invokes one package
runner for each distinct config. It does not maintain a hardcoded list of test files or suite counts.
A newly added but unmapped test fails inventory rather than silently disappearing from the aggregate.

## Live-model gate

The sole live-model configuration is
`apps/orchestration/vitest.kb-model-smoke.config.ts`. The aggregate TypeScript test coordinator must
route it through the permanent `test:kb-model-smoke:aggregate` script. That script skips with an
explicit message unless `PENNY_KB_MODEL_SMOKE=1`.

Setting `PENNY_KB_MODEL_SMOKE=1` opts into the predeclared live KB model cohort and requires separate
authorization because it can contact an external model and incur cost. Default local and offline gates
do not silently set it. A skipped live cohort is reported as skipped, never counted as an executed
live-model pass. Browser-backed Playwright suites and live YouTube transcript checks are separate
external gates: set `PENNY_PLAYWRIGHT_BROWSER_TESTS=1` or `PENNY_YOUTUBE_NETWORK_TESTS=1` only when
Chromium or network access is deliberately authorized.

## Assertions and partial hosts in tests

Tests use typed factories, small local interfaces, `Pick`, `Parameters`, `ReturnType`, `satisfies`,
and fail-fast narrowing helpers. Explicit `any`, postfix `!`, and definite-assignment `!:` are
prohibited in tests as well as runtime source. Malformed input remains `unknown` until a real parser
handles it; missing required fixture values must fail rather than default.

Only five centrally registered partial-host assertions exist: one orchestration `ExtensionContext`
site, one PowerPoint `ExtensionAPI` site, and three questionnaire sites (`ExtensionAPI`, `TUI`, and
`Theme`). Each registry entry binds an exact path and AST expression to a local rationale, removal
condition, single immediately preceding lint suppression, and named focused test. No package or test
directory receives a broad exemption. The exact sites are listed in the
[TypeScript guide](../coding/typescript.md#the-five-partial-host-test-seams).

## No migration baseline

Normal root scripts pass no TypeScript guard baseline. Current debt cannot be accepted by checking in
an allowlist or running an advisory side command: any inventory or architecture finding fails. The
guards may support external analysis inputs for migration tooling, but those are not part of Penny's
delivery or publication command path and never establish full compliance.

## Delivery checklist

- [ ] Focused package tests pass when behavior changed.
- [ ] Edited files pass `bun run format:check` or a targeted Prettier check.
- [ ] Root `bun run lint` and `bun run typecheck` pass for TypeScript changes.
- [ ] `bun run typescript:guard-tests` passes when guard behavior changes.
- [ ] `bun run test:typescript` executes all mapped offline configs.
- [ ] The live-model cohort is explicitly authorized and run, or honestly reported as skipped.
- [ ] `make verify-publication` passes when the requested scope requires the aggregate local gate.
