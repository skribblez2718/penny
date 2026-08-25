# Penny Extensions Standard

This document defines the standard for creating extensions in Penny, following the Pi extension API conventions.

## Overview

Extensions extend Penny's capabilities with:

- **New Tools** - Functions the agent can call
- **Prompt Modifications** - System prompt modifications
- **Event Handlers** - React to session events
- **Context Providers** - Inject information into prompts

## Universal Coding Standards

**All owned TypeScript must have:**

- zero-warning, type-aware root lint coverage;
- membership in an invoked strict/no-emit TypeScript project;
- focused tests that prove changed behavior;
- real runner mapping for every test or smoke file;
- no migration baseline or unregistered assertion exception.

## Directory Structure

```text
.pi/extensions/<name>/
├── index.ts             # Required extension entry point
├── tsconfig.json        # Required strict/no-emit project
├── README.md            # Required extension documentation
├── package.json         # Required scripts, metadata, and dependency contract
└── tests/
    ├── vitest.config.ts # At least one real runner config
    ├── unit/            # Typical, not a required universal layout
    └── integration/     # Add only when the extension owns this suite
```

Every test/smoke file must match a real Vitest config reachable from package `test:all`; no fixed
directory or test-level checklist substitutes for that dynamic mapping.

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

Add the new path to the existing array; do not copy a frozen workspace list from documentation:

```json
{
  "workspaces": [".pi/extensions/<extension-name>"]
}
```

### Why This Is Part of Extension Creation

Workspace registration is not optional cleanup; it is a **load-bearing step** in creating a functional extension. An extension that is not in `workspaces` may appear to work locally because the user manually ran `npm install` inside its directory, but it will fail for other developers and CI because Bun will not treat it as part of the monorepo. Therefore, **"add to workspaces"** is part of the standard extension creation procedure, not a separate follow-up task.

### Standard package.json Template

```json
{
  "name": "@penny/<extension-name>-extension",
  "version": "1.0.0",
  "private": true,
  "main": "index.ts",
  "description": "What this extension does",
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

List only packages actually imported. Every used supported Pi package and `typebox` belongs in
`peerDependencies` with the exact range `"*"`, not in extension `dependencies` or `devDependencies`.
Root `devDependencies` pin the used Pi SDK packages, `typebox`, and TypeScript to exact versions. Add
integration or E2E scripts only when those suites exist, and make them reachable from `test:all` after
typecheck.

### Workspace Registration

Every extension **must** be added to the root `package.json` `workspaces` array. This is documented as part of the agent-facing creation procedure in `docs/agents/extensions/extension-creation-procedure.md`.

### Why tsconfig.json Is Mandatory

Every extension has its own invoked strict/no-emit project. The root sequential lint coordinator maps
each live TypeScript file to exactly one configured tsconfig partition; inventory independently proves
that every file is in at least one qualifying typecheck program. A missing project, unmatched file,
multiple lint partitions, or compiler-option downgrade fails.

### Standard tsconfig.json Template

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false,
    "isolatedModules": true
  },
  "include": ["**/*.ts", "**/*.tsx", "**/*.d.ts"],
  "exclude": ["node_modules", "dist", "build", "coverage"]
}
```

The effective check-only vector requires `strict`, `noImplicitAny`, `strictNullChecks`,
`strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`,
`useUnknownInCatchVariables`, `noImplicitThis`, `alwaysStrict`, and `noEmit`. A child config or CLI
flag may not downgrade it, and owned declarations may not have their diagnostics hidden by
`skipLibCheck`.

## Environment Variables

### The Race Condition Problem

Pi loads and evaluates all extension **module code** before calling any extension's factory function. If an extension reads `process.env` at module scope (top level), it captures values **before** the `environment` extension has a chance to load `.env` into `process.env`.

This creates a silent race condition that happens to work when extensions load in alphabetical order (`environment` → `observability`), but breaks if:

- Pi ever parallelizes extension loading
- Directory ordering changes on a different filesystem
- A new extension reads env vars before `environment` loads

### The Standard Pattern

**Never** read `process.env` at module scope. Read environment variables inside the factory function
or a runtime callback.

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
const MAX_RETRIES = 5; // OK — no env read
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerTool } from "../../lib/pi-tool-registration.js";

// Tool parameter schemas using TypeBox
const MyToolParams = Type.Object({
  param1: Type.String({ description: "First parameter" }),
  param2: Type.Optional(Type.Number({ description: "Optional parameter" })),
});

export default function (pi: ExtensionAPI) {
  // Read environment variables inside the factory, never at module scope.
  const _apiKey = process.env.MY_EXT_API_KEY || "";

  // Register through Penny's sole schema-preserving Pi adapter.
  registerTool(pi, {
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

### Model-visible guidance under Penny's custom prompt

Penny's custom `.pi/SYSTEM.md` does not render Pi's optional `promptGuidelines` into the system prompt. Active tool names, descriptions, and parameter schemas still reach the model through the provider-native tool channel. Penny extensions therefore keep required routing, safety, and usage guidance in `description`, parameter descriptions, or the shared system prompt; runtime extension source does not define `promptGuidelines`.

Extensions may dynamically reduce/load tools for the unmarked primary runtime, but never for a catalog agent: every catalog agent's active set must equal its YAML `tools:` list exactly.

Gateway or consequential tools state what they do, when to use them, and their nearest anti-cases. Narrow primitive tools state the operation plus the discriminator or constraint that helps choose it without adding tautological prose.

### Parameter Schemas

Use TypeBox for parameter validation:

```typescript
import { Type } from "typebox";

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
const SearchMemoryParams = Type.Object({
  query: Type.String({
    description: "Search query in natural language",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 5)",
      minimum: 1,
      maximum: 20,
    })
  ),
});

registerTool(pi, {
  name: "search_memory",
  label: "Search Memory",
  description: [
    "Search stored memories for information.",
    "Use when you need to find previous conversations, decisions, or context.",
    "Returns matching memory entries with timestamps.",
  ].join(" "),
  parameters: SearchMemoryParams,
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
import { Container, Text, Markdown, Spacer } from "@earendil-works/pi-tui";

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
bun run typecheck
bun run test:all
\`\`\`

Document only suite-specific commands that the package manifest actually provides.
```

## Testing

Use Vitest for owned TypeScript tests. A package may have unit, integration, E2E, or feature-specific
configs when its behavior requires them; do not claim a suite exists merely because a conventional
directory name exists. Every test or smoke file must match a real config reachable from `test:all`.

Test fakes use `Pick`, small local interfaces, typed factories, `Parameters`, `ReturnType`,
`satisfies`, or fail-fast narrowing. Explicit `any`, non-null/definite-assignment assertions, and new
partial-host casts are prohibited in tests. Penny's only partial-host assertions are the exact five
central sites in the [TypeScript guide](../coding/typescript.md#the-five-partial-host-test-seams), each
with matching local rationale, removal condition, immediate one-rule suppression, and focused test.

## Verification Checklist

Before submitting an extension:

**Structure and packages:**

- [ ] `index.ts`, `README.md`, strict/no-emit `tsconfig.json`, and `package.json` exist.
- [ ] The extension path is in the sorted root workspace array and `bun install` succeeds.
- [ ] Used Pi packages and `typebox` have `"*"` peer ranges and exact root pins.
- [ ] `test:all` runs typecheck before every test command.
- [ ] Every test/smoke file is runner-mapped; no test level is claimed without a configuration.

**Root gates:**

- [ ] `bun run format:check` passes.
- [ ] `bun run lint` passes the dynamic inventory, architecture, and zero-warning sequential runner.
- [ ] `bun run typecheck` passes every strict project.
- [ ] `bun run typescript:guard-tests` passes when guard behavior changes.
- [ ] `bun run test:typescript` passes; the live-model smoke is separately authorized or reported as skipped.
- [ ] `make verify-publication` passes when the delivery scope requires the aggregate local gate.

**Functionality:**

- [ ] Tool schemas use `typebox`, derive static parameter types, and register through the sole adapter.
- [ ] Tool descriptions keep required guidance provider-visible and do not rely on `promptGuidelines`.
- [ ] README documents actual tools, events, commands, and configuration.
- [ ] Runtime uses the shared logger and has no module-scope `process.env` read.
- [ ] No migration baseline, broad suppression, or new assertion exception is introduced.

## Examples

### Environment Extension (Simple)

```typescript
/**
 * Environment Extension
 * Substitutes ${VAR} placeholders in AGENTS.md and SYSTEM.md
 *
 * Also loads .env values into process.env so other extensions can read them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerTool } from "../../lib/pi-tool-registration.js";

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(/* ... */)),
  chain: Type.Optional(Type.Array(/* ... */)),
});

export default function (pi: ExtensionAPI) {
  registerTool(pi, {
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

**All extension runtime code MUST use the shared structured logger. `console.log`, `console.error`,
and `console.warn` are prohibited in extension runtime files.**

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

| Level      | Use When                                                     |
| ---------- | ------------------------------------------------------------ |
| `debug`    | Internal state transitions, fine-grained diagnostics         |
| `info`     | Normal lifecycle events (extension loaded, tool succeeded)   |
| `warn`     | Degraded but functional (binary not found, deprecated usage) |
| `error`    | Operation failed, recoverable (retry needed, fallback used)  |
| `critical` | Data loss risk, unrecoverable state                          |

### Verification Checklist Addition

- [ ] `console.log`, `console.error`, `console.warn` are not used in extension runtime source
- [ ] `createLogger` is imported from `../../lib/logger/logger.js`
- [ ] A `logger` instance is created with the extension's name
- [ ] All status messages use the logger, not `console.*`

## Best Practices

1. **Clear descriptions** - Tools should describe when to use them
2. **Type safety** - Use TypeBox for all parameter schemas
3. **Error handling** - Return proper error objects, don't throw
4. **Minimal dependencies** - Avoid unnecessary external packages
5. **Documentation** - README should cover all tools and events
6. **Testing** - Add the focused suites the behavior requires and map every test through `test:all`
7. **Environment variables** - Read `process.env` only inside the factory or a runtime callback, never at module scope
