# Scaffold Prompt — Caido Project Setup

## Mission

Create the project structure at `~/projects/caido-plugins/<plugin-name>` based on the design. Set up all config files, install dependencies, and verify the scaffold builds successfully (even with empty implementations).

## Scaffold Requirements

### All Extension Types
- `package.json` with scripts: `build`, `test`, `lint`, `typecheck`, `check`
- DevDependencies: `@caido-community/dev`, `vitest`, `eslint`, `typescript`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`
- `vitest.config.ts`: `environment: "node"`, `globals: true`
- `eslint.config.mjs`: TypeScript rules, ignore dist/ and node_modules/
- `.gitignore`: node_modules/, dist/, *.zip
- `README.md`: plugin-specific docs with install instructions

### Backend Plugins
- `caido.config.ts` with backend plugin entry: `kind: "backend"`, `runtime: "javascript"`, `root: "backend"`
- `backend/tsconfig.json`: ES2022, bundler resolution, strict
- `backend/src/index.ts`: exports `init(sdk)`, type-only imports from `caido:plugin` and `caido:utils`

### Frontend Plugins
- `caido.config.ts` with frontend plugin entry: `kind: "frontend"`, `root: "frontend"`, `backend: { id }`
- Vite config: `@vitejs/plugin-vue`, externalize `@caido/frontend-sdk`
- `frontend/tsconfig.json`
- `frontend/src/index.ts`: exports `init(sdk)`
- `frontend/src/style.css`: empty (implement phase fills it)

### Full-Stack Plugins
- Both backend and frontend configs
- Backend linked to frontend via `backend: { id }`

### Workflows
- `workflow/definition.json` with skeleton node graph

## Post-Scaffold Verification

After scaffolding:
1. `npm install` — must succeed
2. `npx caido-dev build` — must produce `dist/plugin_package.zip`
3. `npx vitest run` — must pass (even with 0 tests or placeholder)
4. `npx eslint '**/*.ts'` — must pass

## Constraints

- All plugins live at `~/projects/caido-plugins/<plugin-name>`
- Never hand-write `manifest.json`
- Follow `resources/reference.md` for naming conventions

## Output

Return a SUMMARY with files created and verification status:
```
SUMMARY:{"files_created":<n>,"npm_install":"ok|fail","build":"ok|fail","scaffold_complete":true|false}
```
