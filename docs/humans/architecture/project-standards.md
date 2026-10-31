# Project Standards: Why Penny Has One Right Way

## What It Is

Project standards are the approved implementations for common concerns in Penny's codebase. For each concern — state management, memory, agent tooling, extensions, user input, TypeScript, package management — there is exactly one approved choice. Custom alternatives are not allowed.

| Concern          | The Approved Choice                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State management | Shared TypeScript orchestration engine (`apps/orchestration/`) — durable Node SQLite checkpointer keyed by `run_id`; each skill is a registered playbook with no executable delegate                                                            |
| Workflow handoff | Exact immutable artifact IDs with direct `artifact_read` and non-expiring `next_range`                                                                                                                                                          |
| Memory           | Primary-owned writes/lifecycle plus optional owner-granted bounded worker read through one supervised MemPalace 3.7.1 HTTP hub; no raw fallback                                                                                                 |
| Agent tooling    | `.pi/agents` local catalog frontmatter; remote presence in the harness/service registry                                                                                                                                                         |
| Extensions       | Pi discovery for the primary runtime. Workers normally pair `--no-extensions` with explicit `-e` paths for every resolved project extension; if inventory resolution/enumeration fails, discovery stays on and compaction is loaded explicitly. |
| User input       | The `questionnaire` extension                                                                                                                                                                                                                   |
| TypeScript       | A `tsconfig.json` per extension with `noEmit: true`                                                                                                                                                                                             |
| Package manager  | `bun`                                                                                                                                                                                                                                           |

These choices are not preferences. They are constraints. If a skill or extension needs to do one of these things, it uses the standard implementation.

## Why Standardization Matters

Without canonical standards, every contributor invents their own pattern. That seems harmless at first, but it creates three problems:

1. **Fragmentation.** A state machine in one skill, a JSON file in another, and ad-hoc booleans in a third means no one can read the codebase and know how flow is controlled.
2. **Silent failures.** Custom caches and hand-rolled tooling lists look simple until they break in ways the rest of the system does not expect.
3. **Cognitive load.** Every new pattern is something every future maintainer must learn. A small set of well-known patterns keeps the codebase legible.

The standards also ensure Pi compatibility. Penny runs on the Pi agent runtime, and Pi expects extensions, skills, and prompts to follow specific shapes. Deviating from those shapes risks runtime failures that are hard to diagnose.

## Simplicity Within the Standards

Binding outcomes and explicit standards are not the same as a model's chosen implementation.
Choose the simplest sufficient design for the task and its actual risks. Added machinery
must justify its operating cost and maintenance burden against simpler alternatives,
including any safety benefit—even when labeled “security.” Prior model/reviewer approval and sunk
implementation effort do not establish necessity. Reviews should challenge unsupported
additions as well as check compliance, without waiving binding standards or granting authority.
The agent-side [proportionality rule](../../agents/architecture/project-standards.md#proportionality-outcomes-before-mechanisms)
owns this distinction; it adds no new form or approval process.

## How the Standards Are Enforced

The enforcement is mostly procedural, not technical:

- Code review checks for custom alternatives.
- Any deviation from Pi's reference implementation requires documented rationale, a risk analysis, and an entry in the relevant `AGENTS.md` file.
- Deprecation warnings are treated as pre-breakage errors and fixed immediately.

The goal is not bureaucracy. It is to make the right choice the easy choice.

## The Task Completion Protocol

Before a feature or fix is called complete, apply the checks required by its changed contracts and scope. Record why a check is inapplicable; a smaller task cannot waive a feature standard's required evidence. Review and planning report evidence and gaps rather than claiming unrun work passed.

| #   | Check               | What It Means                                                                                                                                        |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lint clean          | The code passes `flake8` or `bun run lint`                                                                                                           |
| 2   | Unit tests          | Changed public behavior and boundaries have appropriate checks                                                                                       |
| 3   | Integration tests   | Multi-module interactions are tested                                                                                                                 |
| 4   | E2E tests           | Full lifecycle is mandatory for lifecycle, orchestration, custody, gate, recovery or delivery changes, and wherever the feature contract requires it |
| 5   | Regression tests    | Applicable suites pass; owned regressions and unrelated existing failures are distinguished                                                          |
| 6   | Human docs          | `docs/humans/` is accurate and up to date                                                                                                            |
| 7   | Agent docs          | `docs/agents/` is accurate and up to date                                                                                                            |
| 8   | `AGENTS.md` index   | The feature is indexed in the right place                                                                                                            |
| 9   | Prompt architecture | Token budgets are respected and domain content stays out of the Cognitive Frame                                                                      |
| 10  | False claims audit  | No inflated test counts or overstated coverage                                                                                                       |

For an implementation, applicable checks must pass before completion is claimed. For review,
diagnosis, or planning, the work identifies applicable checks and evidence gaps rather than
claiming an implementation changed or an unrun check passed. Security is invariant-first:
changes must identify affected authority, boundary, resource, secret, and recovery properties
and map them to evidence or an approved exception.

## What This Means for Contributors

- Reach for the standard implementation first. If you think you need something else, you probably need to reframe the problem.
- Required lifecycle E2E exercises the real affected path, including applicable refusal, cancellation, restart and adversarial cases. Stubs alone do not prove lifecycle behavior; deterministic model fixtures prove engine conformance, not a live deployment.
- Failed applicable checks block an unqualified completion claim. Fix owned regressions and rerun affected checks; revert only authorized, safely reversible task-owned changes when appropriate. Preserve other work, and obtain separate approval for destructive/external rollback. Report unrelated failures and the verification they prevent.
- Documentation is part of the feature, not an afterthought.
- If you find a standard that genuinely does not fit, document why and get approval before deviating.

## Related Documents

- Agent docs: `docs/agents/architecture/project-standards.md`
- Python standards: `docs/agents/coding/python.md`
- TypeScript standards: `docs/agents/coding/typescript.md`
- Extension creation: `docs/agents/extensions/extension-creation-procedure.md`
