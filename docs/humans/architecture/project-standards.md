# Project Standards: Why Penny Has One Right Way

## What It Is

Project standards are the approved implementations for common concerns in Penny's codebase. For each concern — state management, memory, agent tooling, extensions, user input, TypeScript, package management — there is exactly one approved choice. Custom alternatives are not allowed.

| Concern | The Approved Choice |
| --- | --- |
| State management | Shared orchestration engine (`apps/orchestration/`) — durable SQLite checkpointer keyed by `run_id`; each skill is a `BasePlaybook` subclass with a ~5-line delegate `orchestrate.py` |
| Memory | Mempalace (`memory_*` tools) |
| Agent tooling | YAML frontmatter `tools:` field |
| Extensions | Always loaded; `--no-extensions` is never used |
| User input | The `questionnaire` extension |
| TypeScript | A `tsconfig.json` per extension with `noEmit: true` |
| Package manager | `bun` |

These choices are not preferences. They are constraints. If a skill or extension needs to do one of these things, it uses the standard implementation.

## Why Standardization Matters

Without canonical standards, every contributor invents their own pattern. That seems harmless at first, but it creates three problems:

1. **Fragmentation.** A state machine in one skill, a JSON file in another, and ad-hoc booleans in a third means no one can read the codebase and know how flow is controlled.
2. **Silent failures.** Custom caches and hand-rolled tooling lists look simple until they break in ways the rest of the system does not expect.
3. **Cognitive load.** Every new pattern is something every future maintainer must learn. A small set of well-known patterns keeps the codebase legible.

The standards also ensure Pi compatibility. Penny runs on the Pi agent runtime, and Pi expects extensions, skills, and prompts to follow specific shapes. Deviating from those shapes risks runtime failures that are hard to diagnose.

## How the Standards Are Enforced

The enforcement is mostly procedural, not technical:

- Code review checks for custom alternatives.
- Any deviation from Pi's reference implementation requires documented rationale, a risk analysis, and an entry in the relevant `AGENTS.md` file.
- Deprecation warnings are treated as pre-breakage errors and fixed immediately.

The goal is not bureaucracy. It is to make the right choice the easy choice.

## The Task Completion Protocol

Before any feature or fix can be called complete, it must pass ten checks. This protocol exists because "it works on my machine" is not enough for a system that other agents and humans rely on.

| # | Check | What It Means |
| --- | --- | --- |
| 1 | Lint clean | The code passes `flake8` or `bun run lint` |
| 2 | Unit tests | Every public function has tests |
| 3 | Integration tests | Multi-module interactions are tested |
| 4 | E2E tests | The full lifecycle is exercised. This is mandatory, not optional |
| 5 | Regression tests | Existing test suites still pass |
| 6 | Human docs | `docs/humans/` is accurate and up to date |
| 7 | Agent docs | `docs/agents/` is accurate and up to date |
| 8 | `AGENTS.md` index | The feature is indexed in the right place |
| 9 | Prompt architecture | Token budgets are respected and domain content stays out of the Cognitive Frame |
| 10 | False claims audit | No inflated test counts or overstated coverage |

If any check fails, the change is rolled back, fixed, and all checks are re-run. Claiming completion with a failed check is itself recorded as a `MISMATCH` in the outcome ledger.

## What This Means for Contributors

- Reach for the standard implementation first. If you think you need something else, you probably need to reframe the problem.
- E2E tests are not a nice-to-have. They are required.
- Documentation is part of the feature, not an afterthought.
- If you find a standard that genuinely does not fit, document why and get approval before deviating.

## Related Documents

- Agent docs: `docs/agents/architecture/project-standards.md`
- Python standards: `docs/agents/coding/python.md`
- TypeScript standards: `docs/agents/coding/typescript.md`
- Extension creation: `docs/agents/extensions/extension-creation-procedure.md`
