# Dependency Management

## Node.js (npm/bun)

Each extension manages its own dependencies:

```bash
# Install dependencies for an extension
cd .pi/extensions/memory
bun install

# Add a dependency
bun install <package>

# Add a dev dependency
bun install -D <package>
```

## Python (uv)

Always use `uv` for Python dependency management:

```bash
# Create virtual environment
uv venv .venv

# Activate virtual environment
source .venv/bin/activate

# Install dependencies
uv pip install -r requirements.txt

# Install dev dependencies
uv pip install -r requirements-dev.txt

# Install a package
uv pip install <package>

# Sync from requirements
uv pip sync requirements.txt
```

### Why uv?

- 10-100x faster than pip
- Deterministic dependency resolution
- Better error messages
- Compatible with pip commands

## package.json (Mandatory)

Every extension **must** have its own `package.json` — even extensions with zero dependencies. This prevents `bun` from walking up to the workspace root and causing infinite recursion in workspace-level loop scripts. See [Extension Standard](extension-standard.md#why-packagejson-is-mandatory) for the full rationale.

Each extension should have these scripts:

```json
{
  "scripts": {
    "lint": "eslint . --ext .ts",
    "lint:fix": "eslint . --ext .ts --fix",
    "format": "prettier --write \"**/*.{ts,js,json,md}\"",
    "format:check": "prettier --check \"**/*.{ts,js,json,md}\"",
    "test": "vitest run --config tests/vitest.config.ts",
    "test:unit": "vitest run --config tests/vitest.config.ts",
    "test:integration": "vitest run --config tests/vitest.integration.config.ts",
    "test:all": "bun run lint && bun run format:check && bun run test:unit",
    "test:watch": "vitest --config tests/vitest.config.ts"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "@sinclair/typebox": "^0.34.0"
  }
}
```
