# Extension Creation Procedure — Adding a new Penny extension

## What

Procedure for creating a new extension under `.pi/extensions/<name>/`. Extensions register tools, commands, and event handlers with the Pi extension API.

## Why

Consistent extension structure ensures Pi can load and register extensions correctly. Missing `package.json` or `tsconfig.json` causes silent failures.

## Rules

1. **Create directory** under `.pi/extensions/<name>/`.
2. **Add `index.ts`** exporting a default factory function.
3. **Add `tsconfig.json`** with `noEmit: true`, `module: "NodeNext"`, `strict: true`.
4. **Add `package.json`** with `name`, `version`, `main: "index.ts"`, `type: "module"`.
5. **Register in root `package.json` workspaces.** Alphabetically sorted. Run `bun install`.
6. **Add `README.md`** documenting tools, commands, events, configuration.
7. **Add tests** under `tests/` with `vitest.config.ts`.

## Directory Structure

```
.pi/extensions/<name>/
├── index.ts           # Entry point
├── tsconfig.json      # noEmit: true
├── package.json       # Required even with zero dependencies
├── README.md
└── tests/
    ├── vitest.config.ts
    ├── vitest.integration.config.ts
    ├── unit/
    └── integration/
```

## Constraints

- **`package.json` is mandatory** even with zero dependencies. Without it, `bun run test:unit` recurses into workspace root.
- **Workspace registration is part of creation**, not a follow-up. Unregistered extensions fail for other developers and CI.
- **No `console.*` calls.** Use `createLogger` from `../../lib/logger/logger.js`.
- **No `process.env` at module scope.** Read inside factory function.

## Canonical Vocabulary

Extension-specific terms. (The frame no longer carries a system-wide vocabulary table; cross-layer term consistency is review-enforced — see [Cognitive Frame Standards Rule 3](../prompts/cognitive-frame-standards.md).)

| Term | Definition | Code Binding | Do NOT substitute |
|------|-----------|-------------|-------------------|
| **registerTool** | Pi API for registering a tool | `pi.registerTool({ name, parameters, execute })` | addTool, createTool |
| **factory function** | Default export receiving `ExtensionAPI` | `export default function (pi: ExtensionAPI)` | init, setup, main |
| **skillContext** | Domain Guidance injected via `<skill_context>` | `skillContext` parameter in subagent tool | prompt, context, guidance |
| **createLogger** | Shared structured logger | `import { createLogger } from "../../lib/logger/logger.js"` | console.log, console.error |
| **TypeBox** | Parameter schema validation | `import { Type } from "@sinclair/typebox"` | Zod, Joi, manual validation |

## Verification

- [ ] `index.ts` exports default factory function
- [ ] `tsconfig.json` with `noEmit: true`
- [ ] `package.json` with required fields
- [ ] Listed in root `package.json` workspaces
- [ ] `bun install` succeeds
- [ ] No `console.*` calls
- [ ] No `process.env` at module scope

## Files

| File | Purpose |
|------|---------|
| `docs/humans/extensions/extension-standard.md` | Human-facing extension standard |
| `.pi/extensions/` | Existing extensions for reference |
