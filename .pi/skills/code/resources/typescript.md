# TypeScript Coding Standards

Reference for skribble. Always read before writing TypeScript code.

## Project Conventions (Detect First)
Before writing, check these files. If they exist, follow their conventions:
- `package.json` — dependencies, scripts
- `tsconfig.json` — TypeScript config (strict mode, paths)
- `eslint.config.js` — lint rules
- `.prettierrc` — formatting rules

## Package Management (CRITICAL)
- **ALWAYS** use `bun` for package management. NEVER use `npm` or `yarn`.
- **NEVER** install globally.
- Add dependencies: `bun add <package>`
- Dev dependencies: `bun add -d <package>`

## Style
- Follow project's existing style
- If no conventions: strict mode (`"strict": true`), camelCase, explicit return types on public functions
- Prefer `const` over `let`, never `var`
- Use template literals over string concatenation

## Testing (CRITICAL)
- Use `vitest` (project default unless overridden)
- Test files: `*.test.ts` in `tests/` directory
- Write failing test FIRST (RED), then implementation (GREEN), then refactor
- Every public function: ≥1 test
- Use `describe`/`it` blocks for organization

## Type Checking
- Run `tsc --noEmit` — zero errors
- `strict: true` always
- Avoid `any` — use `unknown` and type guards
- Use `zod` for runtime validation of external data

## Linting
- Run `eslint` — zero errors
- Run `bun run format:check` or `prettier --check` — must pass

## Anti-Patterns (AVOID)
- `any` type without explicit justification
- `as` casts (type assertions) unless unavoidable
- Mutable exports
- `console.log` in production code (use structured logger)
- Hardcoded secrets, API keys, or credentials
