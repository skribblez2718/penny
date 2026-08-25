# Dependency Management

## JavaScript and TypeScript: one Bun workspace

Run dependency operations from the repository root so the root `bun.lock` remains authoritative:

```bash
bun install
(cd .pi/extensions/<name> && bun add <package>)
(cd .pi/extensions/<name> && bun add --dev <package>)
```

Do not use npm or Yarn and do not create an extension-local `package-lock.json`. Every extension is a
root workspace package with its own `package.json`, even when it has no dependencies. The manifest
prevents package commands from walking up to the workspace root and recursively invoking a root loop.

## Extension manifests

Each extension manifest provides at least:

```json
{
  "name": "@penny/<name>-extension",
  "private": true,
  "type": "module",
  "main": "index.ts",
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

The exact script names after `typecheck` vary with the suites a package actually owns. The permanent
requirements are:

- `test:all` runs typecheck before tests;
- every test/smoke file is matched by a real Vitest configuration reachable from `test:all`;
- every used supported Pi package and `typebox` appears in `peerDependencies` with the exact range
  `"*"`;
- those Pi/TypeBox peer packages do not also appear in the extension's `dependencies` or
  `devDependencies`;
- extension-owned runtime dependencies may remain in `dependencies`;
- root `devDependencies` pin every used Pi SDK package, `typebox`, and TypeScript to exact versions for
  workspace typechecking.

The supported Pi packages are `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. Import TypeBox from `typebox`, never
`@sinclair/typebox`.

The dynamic architecture guard checks imports, manifest placement, peer ranges, root pins,
strict/no-emit projects, typecheck-first `test:all`, workspace files, and prohibited package locks.
See the [Extension Standard](extension-standard.md) for the complete authoring contract.

## Verification

```bash
bun run typescript:inventory
bun run typescript:architecture
bun run lint
bun run typecheck
bun run test:typescript
```

These commands discover the live owned TypeScript inventory; there is no static file count or normal
migration baseline. Use `make verify-publication` for the aggregate local publication gate.

## Python: uv

Use `uv` and the repository lock/configuration for Python dependency management:

```bash
uv venv .venv
uv sync --extra dev
source .venv/bin/activate
```

Add or remove Python packages through `pyproject.toml`, then refresh `uv.lock` with `uv`. Do not install
project packages globally or maintain parallel `requirements.txt` state unless a separately supported
distribution surface requires it.
