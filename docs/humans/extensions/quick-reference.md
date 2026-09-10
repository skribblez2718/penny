# Extension Quick Reference

This reference targets Penny's pinned Pi 0.85.1 SDK. Recheck the installed
`@earendil-works/pi-coding-agent` types, `docs/extensions.md`, and examples when
the pin changes.

## Required Package Shape

```text
.pi/extensions/<name>/
├── index.ts
├── README.md
├── package.json
├── tsconfig.json
└── tests/
    ├── vitest.config.ts
    └── unit/
```

A package may add integration, E2E, or feature-specific suites when its behavior
requires them. Every test or smoke file must match a real configuration reachable
from package `test:all`; directory names alone do not prove coverage.

## Tool Template

Penny registers tools through its project adapter. The callback still implements
Pi's full five-argument execute signature and returns Pi `content` plus optional
`details`.

```typescript
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { registerTool } from "../../lib/pi-tool-registration.js";

const MyToolParams = Type.Object({
  action: StringEnum(["read", "summarize"] as const),
  input: Type.String({ description: "Text to process" }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "Maximum returned items" })
  ),
});

export default function (pi: ExtensionAPI) {
  registerTool(pi, {
    name: "my_tool",
    label: "My Tool",
    description: "Process supplied text. Use when the caller requests this bounded operation.",
    parameters: MyToolParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: { cwd: ctx.cwd },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Working…" }],
        details: { cwd: ctx.cwd },
      });

      return {
        content: [{ type: "text", text: `${params.action}: ${params.input}` }],
        details: { cwd: ctx.cwd, limit: params.limit ?? 10 },
      };
    },
  });
}
```

Pi's raw `registerTool` treats a resolved callback as successful and marks a
thrown callback as failed. Penny's adapter additionally translates an explicit
project result `isError: true` through Pi's supported `tool_result` middleware
while preserving content and details.

## Parameter Schemas

```typescript
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

Type.String({ description: "A string" });
Type.Optional(Type.String());
Type.Array(Type.String());
Type.Object({ required: Type.String() });
StringEnum(["a", "b"] as const);
```

Use `StringEnum` for provider-compatible string enums. Derive parameter types
from the schema rather than maintaining a parallel handwritten interface.

## Event Handlers

Handlers receive `(event, ctx)`. Use current lifecycle and message event names:

```typescript
pi.on("session_start", async (event, ctx) => {
  ctx.ui.setStatus("my-extension", `started: ${event.reason}`);
});

pi.on("session_shutdown", async (_event, ctx) => {
  ctx.ui.setStatus("my-extension", undefined);
});

pi.on("tool_call", (event, _ctx) => {
  if (event.toolName === "bash") {
    // Inspect or return { block: true, reason: "..." }.
  }
});

pi.on("tool_result", (event, _ctx) => {
  // Inspect or return a partial content/details/isError/usage patch.
});

pi.on("input", (_event, _ctx) => ({ action: "continue" }));

pi.on("message_end", (event, _ctx) => {
  // event.message is the finalized user, assistant, or tool-result message.
});
```

There is no `session_end`, `user_message`, or `assistant_message` event in the
pinned API. Use `session_shutdown`, `input`, and the message lifecycle events.

## System Prompt Changes

Use `before_agent_start` for a per-turn dynamic change:

```typescript
pi.on("before_agent_start", (event) => ({
  systemPrompt: `${event.systemPrompt}\n\nAdditional bounded guidance for this turn.`,
}));
```

Use `.pi/SYSTEM.md` for Penny's audited project-wide system prompt. Pi also
supports `APPEND_SYSTEM.md` in a configuration directory, but Penny deliberately
uses the replacement prompt instead. The pinned `ExtensionAPI` has no
`appendSystemPrompt` method.

## Environment and Lifecycle

- Read `process.env` inside the extension factory or a runtime callback, never at
  module scope.
- An extension factory may be async; Pi awaits it before startup continues.
- Start processes, sockets, watchers, and timers only from `session_start` or the
  operation that needs them.
- Close session-scoped resources in an idempotent `session_shutdown` handler.
- Extensions run with the user's OS permissions; review third-party code before
  loading it.

## Verification Checklist

- [ ] `index.ts`, `README.md`, `package.json`, and strict/no-emit `tsconfig.json` exist.
- [ ] The root workspace and package dependency declarations follow the extension standard.
- [ ] Tool schemas use `typebox`; string enums use `StringEnum`.
- [ ] Tool callbacks implement `(toolCallId, params, signal, onUpdate, ctx)` and return Pi result content.
- [ ] Event names and `(event, ctx)` handlers exist in the pinned `ExtensionAPI` types.
- [ ] No module-scope environment read or unsupported `appendSystemPrompt` call exists.
- [ ] Every test file is mapped to a runner reachable from package `test:all`.
- [ ] Focused `bun run typecheck` and `bun run test:all` pass for the package.
- [ ] Applicable root format, lint, typecheck, and aggregate test gates pass.
