# Project Standards — Canonical implementations, Pi alignment, and coding standards

## What

These are the only approved implementations for state management, memory, agent tooling, extensions, and user input. No custom alternatives. Implementation work must produce and run proportionate lint, format, type, test, and security evidence before claiming completion; review, diagnosis, and planning report available evidence and gaps without claiming an implementation changed.

## Why

Without canonical standards, every skill and extension invents its own patterns. Consistency reduces cognitive load, prevents silent failures, and ensures Pi compatibility.

## Rules

### Canonical Implementations — No Alternatives

| Concern          | Standard                                                                                                                                                                                                         | Rejected                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| State management | Shared TypeScript orchestration engine (`apps/orchestration/`) — durable Node SQLite checkpointer keyed by `run_id`                                                                                              | Per-skill runtimes/delegates, argv state, temporary session files, custom JSON state             |
| Memory           | Mempalace (`memory_*` tools)                                                                                                                                                                                     | Custom JSON caches, localStorage                                                                 |
| Agent tooling    | YAML `tools:` is the maximum/profile-linted authority; direct paths and subset-absent orchestration use exact equality, while one explicit canonical-registration-bound TypeScript phase may use a strict subset | Hardcoded or task/trust/runtime-selected lists, env-driven filtering, injected/replacement tools |
| Extensions       | Always loaded (`--no-extensions` never used)                                                                                                                                                                     | `--no-extensions` flag                                                                           |
| User input       | `questionnaire` extension                                                                                                                                                                                        | stdin multi-turn, custom UI                                                                      |
| TypeScript       | Per-extension `tsconfig.json` with `noEmit: true`                                                                                                                                                                | Shared root tsconfig                                                                             |
| Package manager  | `bun`                                                                                                                                                                                                            | `npm`, `package-lock.json`                                                                       |

### The Bitter-Lesson Gate — before adding scaffolding

Before adding any hard-coded table, keyword list, numeric threshold, fixed taxonomy, or mandated process step, ask: **will this get more or less valuable as the model improves?** If _less_ — can the model do it by reading the artifact instead? If yes, do not hard-code it: give the model the artifact and verify the output with evidence.

Hard-coded world-knowledge (framework/dep tables, auth enums, domain keyword routers) and process-baking (mandated methodologies, fixed step sequences) are **KNOWLEDGE-CONSTRAINT** debt — they help now but age into liabilities and need perpetual hand-maintenance. Prefer **capability-adaptive scaffolding**: model judgment as the default, the heuristic kept only as a tier-gated fallback. This is the _add-side_ complement to the [Bitter-Lesson Doctrine](bitter-lesson.md)'s capability-invariants (the _remove-side_).

Legitimate exceptions that pass the gate: safety/security controls, machine interfaces (a schema a program consumes), and fallbacks explicitly gated by model tier.

### Pi Alignment

All extensions follow Pi's reference implementations. Deviations require documented rationale, risk analysis, and AGENTS.md entry.

### Task Completion Protocol

Before claiming an implementation complete, verify the applicable checks below. For review, diagnosis, or planning, identify applicable checks and evidence gaps instead of asserting unrun work passed:

| #   | Check               | Verification                                        |
| --- | ------------------- | --------------------------------------------------- |
| 1   | Lint clean          | `flake8` / `bun run lint`                           |
| 2   | Unit tests          | Every public function tested                        |
| 3   | Integration tests   | Multi-module interactions                           |
| 4   | E2E tests           | Full lifecycle (mandatory)                          |
| 5   | Regression tests    | Existing suites still pass                          |
| 6   | Human docs          | `docs/humans/` accurate                             |
| 7   | Agent docs          | `docs/agents/` accurate                             |
| 8   | AGENTS.md index     | Feature indexed                                     |
| 9   | Prompt architecture | Token budgets, no domain content in Cognitive Frame |
| 10  | False claims audit  | No inflated test counts                             |

## Constraints

- **Deprecation warnings are pre-breakage errors.** Fix immediately.
- **E2E tests are mandatory.** Not optional. Stubs are not acceptable.
- **Rollback on any check failure.** Fix, re-run all checks, claim only when all pass.
- **No new KNOWLEDGE-CONSTRAINT debt.** New tables, thresholds, keyword routers, or mandated process steps must pass the Bitter-Lesson Gate (see `bitter-lesson.md`).

## Verification

- [ ] All 10 task completion checks pass
- [ ] No deprecated APIs in owned code
- [ ] No custom alternatives to canonical implementations
- [ ] Pi deviations documented with rationale
- [ ] New heuristics/tables/thresholds pass the Bitter-Lesson Gate (or are justified as safety / interface / tier-gated fallback)

## Files

| File                                                     | Purpose                                                 |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `docs/agents/coding/python.md`                           | Python standards                                        |
| `docs/agents/coding/typescript.md`                       | TypeScript standards                                    |
| `docs/agents/coding/security/`                           | Invariant-first secure coding and evidence requirements |
| `docs/agents/extensions/extension-creation-procedure.md` | Extension creation                                      |
