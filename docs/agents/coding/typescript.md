# TypeScript Coding Standards — Strict mode, types, validation, patterns

## What

All TypeScript code in this project follows these conventions. Applies to extensions, tools, and test files.

## Why

Consistent TypeScript style ensures extensions are type-safe, lint-clean, and maintainable across the workspace.

## Rules

1. **Lint passes.** `bun run lint` — zero errors.
2. **Format passes.** `bun run format:check` — zero issues.
3. **`tsconfig.json` in every extension directory.** `noEmit: true`, `module: "NodeNext"`, `strict: true`.
4. **Use `@sinclair/typebox` for tool parameter schemas.** Not raw TypeScript types.
5. **Use the shared logger.** `import { createLogger } from "../../lib/logger/logger.js"`. Never `console.log`.
6. **Read `process.env` inside factory functions, never at module scope.** Prevents race condition with environment extension.
7. **Use `bun` for package management.** No `npm install`, no `package-lock.json`.

## Extension Structure

```
.pi/extensions/<name>/
├── index.ts           # Entry point, exports default factory
├── tsconfig.json      # noEmit: true
├── package.json       # name, version, main, type: module
├── README.md
└── tests/
    ├── vitest.config.ts
    ├── vitest.integration.config.ts
    ├── unit/
    └── integration/
```

## Testing

- **vitest** for all TypeScript tests
- **Unit tests** in `tests/unit/`
- **Integration tests** in `tests/integration/`
- **Run:** `bun run test:unit` / `bun run test:integration`

## Constraints

- **No `console.log`, `console.error`, `console.warn`.** Use the shared logger.
- **No `process.env` at module scope.** Read inside factory function.
- **No `any` without justification.** Prefer `unknown` and type narrowing.

## Verification

- [ ] `bun run lint` passes
- [ ] `bun run format:check` passes
- [ ] `tsconfig.json` exists with `noEmit: true`
- [ ] No `console.*` calls in extension code

## Files

| File | Purpose |
|------|---------|
| `eslint.config.js` | ESLint config |
| `.prettierrc` | Prettier config |
| `docs/agents/extensions/extension-creation-procedure.md` | Extension creation procedure |
