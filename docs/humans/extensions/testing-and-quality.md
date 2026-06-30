# Extension Testing and Quality Standards

All extension code must pass lint, format, and test checks before committing.

## TypeScript (ESLint + Prettier)

### Configuration Files

- `eslint.config.js` - ESLint rules (TypeScript-focused)
- `.prettierrc` - Prettier formatting rules
- `.prettierignore` - Files to skip formatting

### Commands

```bash
bun run lint           # Lint TypeScript
bun run lint:fix       # Auto-fix lint issues
bun run format         # Format code
bun run format:check   # Check formatting without changes
```

### ESLint Rules

- `@typescript-eslint/no-unused-vars` - Error (allow `_` prefix)
- `@typescript-eslint/no-explicit-any` - Warn
- `@typescript-eslint/no-non-null-assertion` - Warn
- `prefer-const` - Error
- `no-var` - Error

### Prettier Rules

- Semi-colons: required
- Quotes: double
- Tab width: 2 spaces
- Trailing commas: ES5
- Print width: 100 characters
- End of line: LF

## Python (flake8 + black + mypy)

### Configuration Files

- `pyproject.toml` - Black, isort, mypy, pytest config
- `.flake8` - Flake8 linting rules

### Commands

```bash
bun run py:lint            # Lint Python
bun run py:format          # Format Python
bun run py:format:check    # Check formatting
bun run py:typecheck       # Type check
```

### flake8 Rules

- Max line length: 100
- Max complexity: 10
- Ignore: E203, W503/W504

### black Rules

- Line length: 100
- Target: Python 3.12

### mypy Rules

- Python version: 3.12
- Strict mode enabled
- Ignore missing imports

## Test Levels

### Unit Tests (`tests/unit/`)

Tests isolated logic with all dependencies mocked:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));

describe("Feature Unit Tests", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("should validate parameters", () => { ... });
});
```

### Integration Tests (`tests/integration/`)

Tests with real dependencies where safe:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

describe("Feature Integration Tests", () => {
  it("should work with real filesystem", async () => { ... });
});
```

### E2E Tests (`tests/e2e/`)

Tests full extension lifecycle with Pi harness. **E2E tests are mandatory for all extensions** — they validate the complete stack from tool registration through invocation to result rendering. Stubs and placeholders are not acceptable.

Every extension must have at minimum:

- **Tool registration test**: Verify the tool registers and appears in Pi's tool list
- **Invocation test**: Invoke the tool with valid parameters and verify output shape
- **Error handling test**: Invoke with invalid parameters and verify graceful error response

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

// E2E tests spawn actual pi processes to validate full integration
describe("Feature E2E Tests", () => {
  it("should register tool and invoke successfully", async () => {
    // Spawn pi with extension loaded, invoke tool, verify output
  });
});
```

E2E test configuration:

```typescript
// tests/vitest.e2e.config.ts
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 60000, // E2E tests may be slow
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

## Test Commands

```bash
bun test                    # Unit tests only
bun run test:unit           # Unit tests only
bun run test:integration    # Integration tests
bun run test:all            # All tests + lint + format
```

## Vitest Configurations

### Unit Tests (`tests/vitest.config.ts`)

```typescript
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 10000,
  },
});
```

### Integration Tests (`tests/vitest.integration.config.ts`)

```typescript
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

## TDD Workflow

1. **Write failing test first** - Define expected behavior
2. **Run test** - Confirm it fails for the right reason
3. **Run lint/format** - Code must pass quality checks
4. **Write minimal code** - Make test pass
5. **Refactor** - Clean up while keeping tests green
6. **Repeat** - Next feature/fix

```bash
bun run test:watch      # Keep tests running
bun run lint:fix         # Auto-fix lint issues
bun run format           # Format code
```

## Pre-Commit Checklist

```bash
bun run test:all         # All checks
bun run lint              # TypeScript linting
bun run format:check      # Prettier
bun run py:lint           # Python linting
bun run py:format:check   # Black
bun run py:typecheck      # MyPy
bun run test:unit         # Unit tests
```

## Current Extension Test Status

| Extension     | Unit | Integration | E2E | Python |
| ------------- | ---- | ----------- | --- | ------ |
| environment   | ✅   | 📝          | 📝  | -      |
| memory        | ✅   | ✅          | 📝  | ✅     |
| observability | ✅   | 📝          | 📝  | -      |
| search        | ✅   | 📝          | 📝  | -      |
| skill         | ✅   | 📝          | 📝  | -      |
| statusline    | ✅   | 📝          | 📝  | -      |
| subagent      | ✅   | 📝          | 📝  | -      |
| questionnaire | 📝   | 📝          | 📝  | -      |

✅ = Implemented · 📝 = Required (not yet implemented) · - = Not applicable

**Note**: E2E column no longer shows "-" — E2E tests are mandatory for all extensions.
