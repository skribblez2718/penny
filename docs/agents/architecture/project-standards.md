# Project Standards — Canonical implementations, Pi alignment, and coding standards

## What

These are the only approved implementations for state management, memory, agent tooling, extensions, and user input. No custom alternatives. All code must pass lint, format, typecheck, and tests before claiming completion.

## Why

Without canonical standards, every skill and extension invents its own patterns. Consistency reduces cognitive load, prevents silent failures, and ensures Pi compatibility.

## Rules

### Canonical Implementations — No Alternatives

| Concern | Standard | Rejected |
|---------|----------|----------|
| State management | `python-statemachine` in `orchestrate.py` | Custom JSON state files, Pi session files |
| Memory | Mempalace (`memory_*` tools) | Custom JSON caches, localStorage |
| Agent tooling | YAML frontmatter `tools:` field | Hardcoded lists, env vars |
| Extensions | Always loaded (`--no-extensions` never used) | `--no-extensions` flag |
| User input | `questionnaire` extension | stdin multi-turn, custom UI |
| TypeScript | Per-extension `tsconfig.json` with `noEmit: true` | Shared root tsconfig |
| Package manager | `bun` | `npm`, `package-lock.json` |

### Pi Alignment

All extensions follow Pi's reference implementations. Deviations require documented rationale, risk analysis, and AGENTS.md entry.

### Task Completion Protocol

Before claiming any feature complete, verify all 10 checks:

| # | Check | Verification |
|---|-------|-------------|
| 1 | Lint clean | `flake8` / `bun run lint` |
| 2 | Unit tests | Every public function tested |
| 3 | Integration tests | Multi-module interactions |
| 4 | E2E tests | Full lifecycle (mandatory) |
| 5 | Regression tests | Existing suites still pass |
| 6 | Human docs | `docs/humans/` accurate |
| 7 | Agent docs | `docs/agents/` accurate |
| 8 | AGENTS.md index | Feature indexed |
| 9 | Prompt architecture | Token budgets, no domain content in Cognitive Frame |
| 10 | False claims audit | No inflated test counts |

## Constraints

- **Deprecation warnings are pre-breakage errors.** Fix immediately.
- **E2E tests are mandatory.** Not optional. Stubs are not acceptable.
- **False completion claims → outcome ledger MISMATCH entry.**
- **Rollback on any check failure.** Fix, re-run all checks, claim only when all pass.

## Verification

- [ ] All 10 task completion checks pass
- [ ] No deprecated APIs in owned code
- [ ] No custom alternatives to canonical implementations
- [ ] Pi deviations documented with rationale

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/python.md` | Python standards |
| `docs/agents/coding/typescript.md` | TypeScript standards |
| `docs/agents/coding/security/` | Security anti-patterns |
| `docs/agents/extensions/extension-creation-procedure.md` | Extension creation |
