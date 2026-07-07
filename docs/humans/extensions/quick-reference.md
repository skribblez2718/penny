# Extension Quick Reference

## Directory Structure

```
extension-name/
├── index.ts           # Extension entry point
├── README.md          # Documentation
├── package.json       # Dependencies and test scripts
└── tests/
    ├── unit/          # Unit tests (mocked)
    ├── integration/   # Integration tests (real deps)
    └── e2e/           # End-to-end tests (optional)
```

## Extension Template

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MyToolParams = Type.Object({
  param1: Type.String({ description: "First parameter" }),
  param2: Type.Optional(Type.Number({ description: "Optional" })),
});

export default function (pi: ExtensionAPI) {
  // Read env vars inside the factory, never at module scope
  const apiKey = process.env.MY_EXT_API_KEY || "";

  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does. When to use it.",
    parameters: MyToolParams,
    execute: async (params) => {
      return { success: true, result: "Output" };
    },
  });

  pi.on("session_start", async () => {
    /* init */
  });
}
```

## Parameter Schemas (TypeBox)

```typescript
Type.String({ description: "..." }); // String
Type.Optional(Type.String()); // Optional
Type.Array(Type.String()); // String array
Type.Object({ required: Type.String() }); // Object
Type.Union([Type.Literal("a"), Type.Literal("b")]); // Enum
```

## Event Handlers

```typescript
pi.on("session_start", async () => {});
pi.on("session_end", async () => {});
pi.on("tool_call", async (toolName, params) => {});
pi.on("tool_result", async (toolName, result) => {});
pi.on("user_message", async (message) => {});
pi.on("assistant_message", async (message) => {});
```

## System Prompt Modifications

```typescript
pi.appendSystemPrompt("You have access to my_tool.");

// Or use .pi/SYSTEM.md file for file-based prompts
```

## Environment Variables

**Critical:** Read `process.env` only inside the factory function. Module-scope reads happen before `.env` is loaded.

```typescript
// BAD — module scope, captures stale values
const CONFIG = { url: process.env.URL || "default" };

// GOOD — factory scope, sees .env values
let config: { url: string };
export default function (pi: ExtensionAPI) {
  config = { url: process.env.URL || "default" };
}
```

## Verification Checklist

- [ ] `index.ts` exists with entry point
- [ ] `README.md` is comprehensive
- [ ] `tests/unit/` has unit tests
- [ ] `tests/integration/` has integration tests
- [ ] Tool parameter schemas use TypeBox
- [ ] Tool descriptions indicate when to use
- [ ] Error handling returns proper objects
- [ ] `bun run test:all` passes
