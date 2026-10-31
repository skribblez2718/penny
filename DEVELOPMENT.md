# Development

This contributor-local guide is intentionally ignored by Git. It contains the development and runtime-verification material extracted from the public README.

```bash
make doctor            # Read-only core readiness check (never initializes state)
make state-status      # Read-only canonical state and persistence check
make verify-runtime    # Rebuild, then check retained invocation state (no model calls)
make memory-status     # Read-only supervised/authenticated hub check
make setup-browser     # Explicitly provision optional Playwright Chromium
make setup-dev         # Install development/check dependency extras
make test              # Run default fast tests and repository guards
make test-integration  # Include heavier integration, network, slow, and end-to-end tests
make lint              # Run lint and formatting checks
make format            # Format supported files
make clean             # Remove code dependencies but preserve memory data
bun run pi:update      # Validate and update Pi safely
```

After orchestration changes, run `make verify-runtime` before declaring the installation ready for agent or skill calls. Run it when workflow workers and tests using the compiled runtime are stopped: the build replaces `dist`, and separate build processes are not serialized. It uses the shared frozen/offline build path, then checks the actual retained checkpoint, artifact, and receipt state against that build. It fails on missing or incompatible state without initializing, upgrading, or repairing it. A successful build or isolated test suite is not evidence that an existing installation's state is compatible. This check makes no model calls; provider execution and complete workflow behavior still need separately authorized live smoke tests.

After changing Node versions, restart Pi and any long-running services: changing a shell's PATH does not upgrade an already-running process. Database health checks use SQLite-managed read transactions; SQLite may maintain WAL/SHM sidecars and access timestamps, but checks do not write application data or repair damaged stores. Exact artifact operations check the selected metadata and bytes rather than rescanning every database. Startup/readiness and explicit state status perform full database health checks.

For `STATE_DATABASE_CORRUPT` or `ARTIFACT_STORE_CORRUPT`, preserve the database and its WAL, stop writers, and recover into a separate validated database before any approved replacement. These errors are not missing-configuration errors; do not reset state or bypass checks.

For `STATE_SCHEMA_INCOMPATIBLE`, stop active workflow writers and follow the [readiness and schema-upgrade runbook](docs/humans/state-management/state-management.md#readiness-and-schema-upgrade-runbook) with a caller-selected private backup directory outside both the project and state roots. Then rerun `make verify-runtime`. Do not reset retained state or change its version marker by hand to bypass the error.

Use `bun run pi:update` instead of running `pi update` directly from this repository. The updater checks the published Pi package in a clean temporary project, tests the candidate against Penny, and changes the global installation only when those checks pass. It does not add missing upstream dependencies or commit files.

For each frozen baseline and staged candidate, the updater runs architecture once, then the compiler-only `typecheck:all`, runtime compatibility tests, and extension loading. Architecture already includes inventory findings; calling root `typecheck` here would repeat the expensive guard. Type-aware ESLint suppression audits run in fresh sequential children so their parser caches do not accumulate alongside the architecture checker. Normal updates do not require a heap-size override.

Runtime compatibility includes `bun run test:pi-harness`: SDK-backed API/tool fixtures and the registration adapter run against each dependency graph. The shared host derives SDK shape through Vitest's real-module loader, keeps unmodeled capabilities fail-closed, and uses disposable in-memory state without model prompts. Plain narrowing helpers remain independent of Vitest for real subprocess fixtures.

Validation binds `PROJECT_ROOT` and `PENNY_SKILLS_DIR` to this checkout for both dependency graphs, Penny-loading smoke checks, and rollback builds. No shell exports are needed, and stale inherited roots cannot select another checkout's skills. Orchestration's default Vitest config also selects `.pi/skills` relative to its own location, so package-local compatibility tests work independently of the updater. Missing or mismatched skill packages still refuse registration; the clean-consumer preflight remains independent of Penny's resource paths.

A `BASELINE_FAILED` result means the existing dependency graph failed before candidate staging; it is not evidence that the candidate is incompatible. Command errors distinguish exit status, signal termination, timeout, and spawn failure. Investigate the named stage rather than bypassing checks or enabling blocked postinstalls. If candidate validation fails, the updater restores the captured manifests and lockfile, reinstalls the frozen graph, and rebuilds orchestration before returning failure; it does not update global Pi.

Normal startup only compares the running Pi version with the version pinned in this repository. It does not install packages or contact a package registry. See the [environment extension guide](.pi/extensions/environment/README.md) for details.
