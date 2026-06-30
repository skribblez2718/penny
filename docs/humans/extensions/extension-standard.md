# Penny Extensions Standard

This document defines the standard for creating extensions in Penny, following the Pi extension API conventions.

## Overview

Extensions extend Penny's capabilities with:

- **New Tools** - Functions the agent can call
- **Prompt Modifications** - System prompt modifications
- **Event Handlers** - React to session events
- **Context Providers** - Inject information into prompts

## Universal Coding Standards

**All TypeScript/JavaScript must have:**

- **Lint passes** (`ruff check` or `eslint`)
- **Unit tests** - Test individual functions
- **Integration tests** - Test extension integration with Pi
- **Type safety** - Full TypeScript types

**TDD for ALL coding.** No exceptions.

## Directory Structure

```
extensions/
└── extension-name/
    ├── index.ts           # Required: Extension entry point
    ├── tsconfig.json      # Required: TypeScript config for lint/IDE (noEmit: true)
    ├── README.md           # Required: Documentation
    ├── package.json        # Required: Scripts, metadata, and dependencies
    ├── tests/
    │   ├── vitest.config.ts             # Required: Unit test config
    │   ├── vitest.integration.config.ts  # Required: Integration test config
    │   ├── unit/                        # Required: Unit tests
    │   │   └── *.test.ts
    │   └── integration/                  # Required: Integration tests
    │       └── *.test.ts
```

### Why package.json Is Mandatory

Every extension **must** have its own `package.json`, even if it has zero dependencies. Without it:

- `bun run <script>` walks up to the workspace root and resolves to the workspace-level script
- The workspace `test:unit` script loops through all extensions calling `bun run test:unit` in each
- An extension without `package.json` recurses back into the workspace loop → **infinite recursion**
- This caused the `questionnaire` extension to hang indefinitely when running the test suite

A `package.json` makes each extension a **self-contained unit** that can be tested, linted, and formatted independently without relying on parent resolution.

## Workspace Registration

Every extension **must** be added to the root `package.json` `workspaces` array. Without it:

- `bun install` will not manage the extension's dependencies
- The extension's `node_modules` won't be linked through the workspace
- `bun run test:unit` won't run tests for that extension
- Missing workspace entries cause `bun install` to fail with `Workspace not found`

### Workspace Addition Checklist

When creating a new extension, add it to the root `package.json` workspaces **immediately** after creating the extension directory and `package.json`:

1. Open `/package.json`
2. Add `".pi/extensions/<extension-name>"` to the `workspaces` array
3. Keep the list alphabetically sorted for consistency
4. Run `bun install` from the project root to verify all workspaces resolve

**Example:**

```json
{
  "workspaces": [
    ".pi/extensions/caido",
    ".pi/extensions/compaction",
    ".pi/extensions/cve-lookup",
    ".pi/extensions/environment",
    ".pi/extensions/javascript",
    ".pi/extensions/jsluice",
    ".pi/extensions/memory",
    ".pi/extensions/observability",
    ".pi/extensions/pdf2markdown",
    ".pi/extensions/playwright",
    ".pi/extensions/questionnaire",
    ".pi/extensions/resume",
    ".pi/extensions/semgrep",
    ".pi/extensions/skill",
    ".pi/extensions/statusline",
    ".pi/extensions/subagent",
    ".pi/extensions/youtube"
  ]
}
```

### Why This Is Part of Extension Creation

Workspace registration is not optional cleanup; it is a **load-bearing step** in creating a functional extension. An extension that is not in `workspaces` may appear to work locally because the user manually ran `npm install` inside its directory, but it will fail for other developers and CI because Bun will not treat it as part of the monorepo. Therefore, **"add to workspaces"** is part of the standard extension creation procedure, not a separate follow-up task.

### Standard package.json Template

```json
{
  "name": "@penny/<extension-name>-extension",
  "version": "1.0.0",
  "main": "index.ts",
  "description": "What this extension does",
  "type": "module",
  "scripts": {
    "test:unit": "vitest run --config tests/vitest.config.ts",
    "test:integration": "vitest run --config tests/vitest.integration.config.ts"
  },
  "dependencies": {
    // Runtime dependencies here
  },
  "devDependencies": {
    "@sinclair/typebox": "^0.34.49",
    "typescript": "^6.0.3",
    "vitest": "^4.1.7"
  }
}
```

### Workspace Registration

Every extension **must** be added to the root `package.json` `workspaces` array. This is documented as part of the agent-facing creation procedure in `docs/agents/extensions/extension-creation-procedure.md`.

### Why tsconfig.json Is Mandatory

Every extension **must** have its own `tsconfig.json` with `noEmit: true`. Without it:

- The root `eslint.config.js` uses `parserOptions.project: true`, which requires `eslint` to find a `tsconfig.json` relative to each `.ts` file for type-aware lint rules
- Without a per-extension `tsconfig.json`, eslint cannot parse extension files and fails with: `Parsing error: project was set to 'true' but couldn't find any tsconfig.json`
- Editors (VS Code, etc.) cannot provide IntelliSense, go-to-definition, or type checking

Pi's runtime uses **jiti** to load extensions, which does NOT use `tsconfig.json` — it transpiles `.ts` on the fly. The `tsconfig.json` is purely for development tooling: lint, type-check, and editor support.

### Standard tsconfig.json Template

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "declaration": false,
    "sourceMap": false,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Key settings:

- `noEmit: true` — lint/typecheck only, never produces compiled output
- `module: "NodeNext"` — matches how Pi/jiti resolves ESM imports (`.js` extensions)
- `isolatedModules: true` — required for esbuild/jiti compatibility
- `include` — covers source files and test files for eslint

### Directory Purposes

| File                        | Purpose                                       | Required |
| --------------------------- | --------------------------------------------- | -------- |
| `index.ts`                  | Extension entry point, registers tools        | Yes      |
| `tsconfig.json`             | TypeScript config for lint/IDE (noEmit: true) | Yes      |
| `README.md`                 | Extension documentation                       | Yes      |
| `tests/unit.test.ts`        | Unit tests for extension                      | Yes      |
| `tests/integration.test.ts` | Integration tests with Pi                     | Yes      |
| `package.json`              | Extension metadata, scripts, and dependencies | Yes      |

## Environment Variables

### The Race Condition Problem

Pi loads and evaluates all extension **module code** before calling any extension's factory function. If an extension reads `process.env` at module scope (top level), it captures values **before** the `environment` extension has a chance to load `.env` into `process.env`.

This creates a silent race condition that happens to work when extensions load in alphabetical order (`environment` → `observability`), but breaks if:
- Pi ever parallelizes extension loading
- Directory ordering changes on a different filesystem
- A new extension reads env vars before `environment` loads

### The Standard Pattern

**Never** read `process.env` at module scope. **Always** read environment variables inside the factory function body.

**Incorrect (fragile):**
```typescript
// BAD — evaluated at module import time, before .env is loaded
const CONFIG = {
  url: process.env.MY_EXT_URL || "http://localhost:8080",
  apiKey: process.env.MY_EXT_API_KEY || "",
};

export default function (pi: ExtensionAPI) {
  // CONFIG was already locked in above
}
```

**Correct (robust):**
```typescript
// GOOD — evaluated inside factory, after .env is loaded
interface MyExtConfig {
  url: string;
  apiKey: string;
}

let config: MyExtConfig;

export default function (pi: ExtensionAPI) {
  config = {
    url: process.env.MY_EXT_URL || "http://localhost:8080",
    apiKey: process.env.MY_EXT_API_KEY || "",
  };

  // Rest of extension uses `config`
}
```

### Why This Works

1. Pi imports the module (declares functions, sets up `let config` binding)
2. Pi evaluates the `environment` extension's factory first (loads `.env` → `process.env`)
3. Pi evaluates your extension's factory (reads fresh `process.env` values)
4. Module-level functions capture the `config` variable binding, not a snapshot

### Static Values Are Fine

Hardcoded constants that do **not** read `process.env` can stay at module scope:

```typescript
const DEFAULT_TIMEOUT_MS = 30000; // OK — no env read
const MAX_RETRIES = 5;            // OK — no env read
```

### Verification Checklist Addition

Add to the validation checklist:

- [ ] No `process.env` reads at module scope (inside `const` declarations or immediately-executed code)
- [ ] All `process.env` reads happen inside the factory function or runtime callbacks
- [ ] Module-level functions reference a `let` binding that is assigned in the factory

## Extension Template

```typescript
/**
 * Extension Name
 * Brief description of what this extension does
 *
 * Handles:
 * - Tool 1: Description
 * - Tool 2: Description
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Tool parameter schemas using TypeBox
const MyToolParams = Type.Object({
  param1: Type.String({ description: "First parameter" }),
  param2: Type.Optional(Type.Number({ description: "Optional parameter" })),
});

// Static constants can live at module scope
const DEFAULT_TIMEOUT_MS = 30000;

export default function (pi: ExtensionAPI) {
  // Read environment variables inside the factory, never at module scope
  const apiKey = process.env.MY_EXT_API_KEY || "";

  // Register tool
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does. When to use it.",
    parameters: MyToolParams,
    execute: async (params) => {
      // Tool implementation
      const { param1, param2 } = params;

      // Do something

      return {
        success: true,
        result: "Tool output",
      };
    },
  });

  // Register event handler (optional)
  pi.on("session_start", async () => {
    // Initialization logic
  });
}
```

## Tool Registration

### Parameter Schemas

Use TypeBox for parameter validation:

```typescript
import { Type } from "@sinclair/typebox";

// String parameter
const StringParam = Type.String({
  description: "Parameter description",
});

// Optional parameter
const OptionalParam = Type.Optional(
  Type.String({
    description: "Optional parameter",
  })
);

// String array
const ArrayParam = Type.Array(Type.String());

// Object with properties
const ObjectParam = Type.Object({
  required: Type.String(),
  optional: Type.Optional(Type.Number()),
});

// Enum
const EnumParam = Type.Union([
  Type.Literal("option1"),
  Type.Literal("option2"),
  Type.Literal("option3"),
]);

// Union type
const UnionParam = Type.Union([Type.String(), Type.Number()]);
```

### Tool Registration Example

```typescript
pi.registerTool({
  name: "search_memory",
  label: "Search Memory",
  description: [
    "Search stored memories for information.",
    "Use when you need to find previous conversations, decisions, or context.",
    "Returns matching memory entries with timestamps.",
  ].join(" "),
  parameters: Type.Object({
    query: Type.String({
      description: "Search query in natural language",
    }),
    limit: Type.Optional(Type.Number({
      description: "Maximum results to return (default: 5)",
      minimum: 1,
      maximum: 20,
    })),
  }),
  execute: async (params) => {
    const { query, limit = 5 } = params;

    // Implementation

    return {
      success: true,
      results: [...],
    };
  },
});
```

## Event Handlers

Register handlers for Pi events:

```typescript
// Session lifecycle
pi.on("session_start", async () => {
  // Called when session starts
  // Good for initialization, context loading
});

pi.on("session_end", async () => {
  // Called when session ends
  // Good for cleanup, saving state
});

// Tool events
pi.on("tool_call", async (toolName, params) => {
  // Called before any tool execution
});

pi.on("tool_result", async (toolName, result) => {
  // Called after tool execution
});

// Message events
pi.on("user_message", async (message) => {
  // Called when user sends a message
});

pi.on("assistant_message", async (message) => {
  // Called when assistant responds
});
```

## Prompt Modifications

### Append to System Prompt

```typescript
pi.appendSystemPrompt(`
You have access to the my_tool function.
Use it when [specific condition].
`);
```

### File-based System Prompt

Create `.pi/SYSTEM.md` in the project:

```markdown
## Extension Context

When using my_tool:

- Always provide param1
- param2 is optional but recommended for [reason]

Examples:

- my_tool(param1="value") - Basic usage
- my_tool(param1="value", param2=42) - With optional param
```

## TUI Components

Extensions can render TUI components:

```typescript
import { Container, Text, Markdown, Spacer } from "@mariozechner/pi-tui";

// Render a status message
pi.renderToolResult(
  Container({
    children: [
      Text({ text: "Extension Status", fg: "accent" }),
      Spacer({ height: 1 }),
      Text({ text: "Operation completed successfully", fg: "success" }),
    ],
  })
);
```

## README.md Requirements

```markdown
# Extension Name

Brief description of what this extension does.

## Overview

- **Purpose**: What problem does this extension solve?
- **Provides**: Tools, events, or modifications
- **Use When**: Specific scenarios

## Tools

### tool_name

**Description**: What this tool does

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| param1 | string | Yes | First parameter |
| param2 | number | No | Optional parameter |

**Returns**: Result format

**Examples**:
\`\`\`typescript
// Example usage
\`\`\`

## Events

| Event         | When           | Handler          |
| ------------- | -------------- | ---------------- |
| session_start | Session begins | Initialize state |

## Configuration

| Variable   | Default | Description   |
| ---------- | ------- | ------------- |
| EXT_OPTION | default | Config option |

## Installation

This extension is bundled with Penny. No installation required.

## Testing

\`\`\`bash

# Unit tests

bun test tests/unit.test.ts

# Integration tests

bun test tests/integration.test.ts
\`\`\`

## Version History

- **1.0.0** - Initial release
```

## Testing

### Unit Tests

```typescript
// tests/unit.test.ts
import { describe, it, expect } from "bun:test";
import { parseEnvFile } from "../index";

describe("Extension Unit Tests", () => {
  it("should parse parameters correctly", () => {
    const result = parseParams({ param1: "value" });
    expect(result.param1).toBe("value");
  });

  it("should handle optional parameters", () => {
    const result = parseParams({});
    expect(result.param2).toBeUndefined();
  });

  it("should validate parameter types", () => {
    expect(() => parseParams({ param1: 123 })).toThrow("Expected string");
  });
});
```

### Integration Tests

```typescript
// tests/integration.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../index";

describe("Extension Integration Tests", () => {
  let mockPi: ExtensionAPI;
  let registeredTools: string[];

  beforeEach(() => {
    registeredTools = [];
    mockPi = {
      registerTool: (tool) => {
        registeredTools.push(tool.name);
      },
      on: () => {},
    } as unknown as ExtensionAPI;
  });

  it("should register tools", () => {
    extension(mockPi);
    expect(registeredTools).toContain("my_tool");
  });

  it("should execute tool correctly", async () => {
    extension(mockPi);
    // Test tool execution
  });
});
```

## Verification Checklist

Before submitting an extension:

**Format:**

- [ ] `index.ts` exists with extension entry point
- [ ] `tsconfig.json` exists with `noEmit: true` and `module: "NodeNext"`
- [ ] `README.md` is comprehensive
- [ ] `package.json` exists with scripts and metadata (mandatory — even with zero dependencies)
- [ ] Extension path is added to root `package.json` `workspaces` array, sorted alphabetically (see `docs/agents/extensions/extension-creation-procedure.md`)
- [ ] `bun install` at the project root succeeds with no "Workspace not found" errors
- [ ] `tests/vitest.config.ts` exists
- [ ] `tests/vitest.integration.config.ts` exists
- [ ] Unit tests exist in `tests/unit/`
- [ ] Integration tests exist in `tests/integration/`

**Testing:**

- [ ] `bun test tests/unit.test.ts` passes
- [ ] `bun test tests/integration.test.ts` passes
- [ ] `eslint index.ts` passes (or `ruff check`)
- [ ] TypeScript compiles without errors

**Functionality:**

- [ ] Tool parameter schemas use TypeBox
- [ ] Tool descriptions are clear and indicate when to use
- [ ] Error handling returns proper error objects
- [ ] README documents all tools and events
- [ ] No `process.env` reads at module scope (all env reads are inside the factory function or runtime callbacks)

## Examples

### Environment Extension (Simple)

```typescript
/**
 * Environment Extension
 * Substitutes ${VAR} placeholders in AGENTS.md and SYSTEM.md
 *
 * Also loads .env values into process.env so other extensions can read them.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "fs/promises";

export default async function (pi: ExtensionAPI) {
  // Eagerly load .env during factory execution so later extensions
  // see the values when they read process.env inside their own factories.
  const envConfig = await loadEnvFile();
  Object.assign(process.env, envConfig);

  pi.on("before_agent_start", async (event) => {
    // Substitute ${VAR} in system prompt
    event.systemPrompt = substituteEnvVars(event.systemPrompt, envConfig);
  });
}
```

### Subagent Extension (Complex)

```typescript
/**
 * Subagent Extension
 * Delegate tasks to specialized agents with isolated context
 *
 * Modes:
 *   - Single: one agent, one task
 *   - Parallel: multiple agents, multiple tasks
 *   - Chain: sequential execution with {previous} placeholder
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(/* ... */)),
  chain: Type.Optional(Type.Array(/* ... */)),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate tasks to specialized agents...",
    parameters: SubagentParams,
    execute: async (params) => {
      // Handle single, parallel, or chain modes
    },
  });
}
```

## Logging

**All extensions MUST use the shared structured logger. `console.log`, `console.error`, and `console.warn` are PROHIBITED in extension code.**

### Why

- `console.*` output pollutes the user's terminal session with noise at startup
- Structured logs flow to the observability server where they can be queried, filtered, and correlated with session context
- The shared logger automatically injects session IDs and supports severity-based filtering via `PI_LOG_LEVEL`

### Pattern

```typescript
import { createLogger } from "../../lib/logger/logger.js";

const logger = createLogger("extension-name");

// Inside factory function or tool handlers:
logger.info("Tool executed", { param1: "value" });
logger.warn("Deprecated option used", { option: "oldFlag" });
logger.error("Operation failed", { target }, err);
```

### Severity Guidelines

| Level | Use When |
|-------|----------|
| `debug` | Internal state transitions, fine-grained diagnostics |
| `info` | Normal lifecycle events (extension loaded, tool succeeded) |
| `warn` | Degraded but functional (binary not found, deprecated usage) |
| `error` | Operation failed, recoverable (retry needed, fallback used) |
| `critical` | Data loss risk, unrecoverable state |

### Verification Checklist Addition

- [ ] `console.log`, `console.error`, `console.warn` are NOT used anywhere in the extension
- [ ] `createLogger` is imported from `../../lib/logger/logger.js`
- [ ] A `logger` instance is created with the extension's name
- [ ] All status messages use the logger, not `console.*`

## Best Practices

1. **Clear descriptions** - Tools should describe when to use them
2. **Type safety** - Use TypeBox for all parameter schemas
3. **Error handling** - Return proper error objects, don't throw
4. **Minimal dependencies** - Avoid unnecessary external packages
5. **Documentation** - README should cover all tools and events
6. **Testing** - Unit and integration tests required
7. **Environment variables** - Read `process.env` only inside the factory function, never at module scope. This ensures the `environment` extension has populated `process.env` from `.env` before your extension sees the values
