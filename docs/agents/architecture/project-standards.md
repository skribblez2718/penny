# Project Standards — Canonical implementations, Pi alignment, and coding standards

## What

These are the only approved implementations for state management, memory, agent tooling, extensions, and user input. No custom alternatives. Implementation work must produce and run proportionate lint, format, type, test, and security evidence before claiming completion; review, diagnosis, and planning report available evidence and gaps without claiming an implementation changed.

## Why

Without canonical standards, every skill and extension invents its own patterns. Consistency reduces cognitive load, prevents silent failures, and ensures Pi compatibility.

## Rules

### Proportionality: outcomes before mechanisms

Required outcomes, explicit caller constraints, and governing standards bind the work.
Model-derived design and verification choices remain proposals, not extra requirements.
Inherited generated text, prior model/reviewer approval, and already-implemented machinery
do not establish necessity.

Choose the simplest sufficient design for the concrete task, trust boundary, credible
threat/failure, or measured issue. Justify material added complexity against a simpler
alternative, including its safety benefit, operating cost, and maintenance burden. Reuse,
replacement, and removal are all options; sunk implementation effort is not a reason to
retain machinery. Use ordinary design/review rationale, not a new form or approval workflow.

A security label is not a blanket exception: preserve concrete safety outcomes and binding
standards while scrutinizing the chosen means. Specifications, plans, and reviews should
challenge unsupported additions, not merely compliance with earlier model choices. This
rule neither waives binding requirements nor grants authority. Apply prerequisites at their
actual point of need under [Bounded Work](../agents/bounded-work.md#dependencies-and-composition).

### Canonical Implementations — No Alternatives

| Concern          | Standard                                                                                                                                                                                                                                        | Rejected                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| State management | Shared TypeScript orchestration engine (`apps/orchestration/`) — durable Node SQLite checkpointer keyed by `run_id`                                                                                                                             | Per-skill runtimes/delegates, argv state, temporary session files, custom JSON state                     |
| Memory           | Mempalace (`memory_*` tools)                                                                                                                                                                                                                    | Custom JSON caches, localStorage                                                                         |
| Agent tooling    | [Runtime tool selection](../agents/discovery-and-tools.md#binding-runtime-rule); [profiles](../agents/tool-profiles.md) statically lint the YAML maximum                                                                                        | Task/trust/runtime-selected authority, env-driven filtering, injected/replacement tools                  |
| Extensions       | Pi discovery for the primary runtime; workers normally use `--no-extensions` plus explicit `-e` paths for every resolved project extension. If inventory cannot be resolved/enumerated, discovery stays on and compaction is loaded explicitly. | Cwd-dependent discovery on the normal worker path or `--no-extensions` without the required explicit set |
| User input       | `questionnaire` extension                                                                                                                                                                                                                       | stdin multi-turn, custom UI                                                                              |
| TypeScript       | Per-extension `tsconfig.json` with `noEmit: true`                                                                                                                                                                                               | Shared root tsconfig                                                                                     |
| Package manager  | `bun`                                                                                                                                                                                                                                           | `npm`, `package-lock.json`                                                                               |

### The Bitter-Lesson Gate — before adding scaffolding

Before adding any hard-coded table, keyword list, numeric threshold, fixed taxonomy, or mandated process step, ask: **will this get more or less valuable as the model improves?** If _less_ — can the model do it by reading the artifact instead? If yes, do not hard-code it: give the model the artifact and verify the output with evidence.

Hard-coded world-knowledge (framework/dep tables, auth enums, domain keyword routers) and process-baking (mandated methodologies, fixed step sequences) are **KNOWLEDGE-CONSTRAINT** debt — they help now but age into liabilities and need perpetual hand-maintenance. Prefer **capability-adaptive scaffolding**: model judgment as the default, the heuristic kept only as a tier-gated fallback. This is the _add-side_ complement to the [Bitter-Lesson Doctrine](bitter-lesson.md)'s capability-invariants (the _remove-side_).

Fixed mechanisms can pass the gate when needed for a concrete safety/security outcome,
machine interface (a schema a program consumes), custody/recovery/audit contract, or
explicitly tier-gated fallback. These labels alone do not justify complexity: apply
[proportionality](#proportionality-outcomes-before-mechanisms) and identify the contract,
credible failure, or measurement that warrants the mechanism. This gate does not mandate
replacing registered workflows with model-selected topology.

### Pi Alignment

All extensions follow Pi's reference implementations. Deviations require documented rationale, risk analysis, and AGENTS.md entry.

### Task Completion Protocol

Before claiming an implementation complete, verify the checks applicable to the changed contracts and task scope. Record why a check is inapplicable; a small change does not waive checks required by its owning contract. Review, diagnosis and planning assess available evidence and gaps without claiming unrun work passed. [Coding Conventions](../coding/conventions.md) owns code-quality obligations; [Security Invariants](../coding/security/security-invariants.md) owns affected-boundary evidence and exception approval.

| #   | Check               | Verification                                                                                                                                                        |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lint clean          | Applicable lint, format and type checks for the changed material                                                                                                    |
| 2   | Unit tests          | Changed public behavior, boundaries and failure cases have appropriate executable checks                                                                            |
| 3   | Integration tests   | Affected multi-module interactions and their negative cases                                                                                                         |
| 4   | E2E tests           | Full lifecycle is mandatory for changes to lifecycle behavior, orchestration, custody, gates, recovery or delivery; retain any stricter owning-contract requirement |
| 5   | Regression tests    | Applicable existing suites; distinguish owned regressions from unrelated pre-existing failures                                                                      |
| 6   | Human docs          | Affected `docs/humans/` guidance is accurate                                                                                                                        |
| 7   | Agent docs          | Affected `docs/agents/` guidance is accurate                                                                                                                        |
| 8   | AGENTS.md index     | Changed/new feature routes remain accurate                                                                                                                          |
| 9   | Prompt architecture | Applicable token budgets and layer boundaries; no domain content in Cognitive Frame                                                                                 |
| 10  | False claims audit  | Evidence, counts, coverage and qualification claims match observed checks                                                                                           |

Lifecycle E2E must exercise the real affected engine/owner path, including applicable cancellation, restart, refusal and adversarial cases. Stubs alone cannot establish that lifecycle. Deterministic model fixtures can establish engine conformance, not live-provider or deployment qualification. A localized change that leaves lifecycle contracts untouched may use focused checks, but must still run any E2E required by its feature standard and report the untested boundary. No docs-only check establishes runtime behavior.

## Constraints

- **Deprecation warnings are pre-breakage errors in owned changes.** Fix within the authorized scope; report out-of-scope warnings and their effect rather than editing unrelated work.
- **Required E2E is not optional.** Missing prerequisites or authority are blockers to the corresponding completion claim, not permission to substitute a stub pass.
- **A failed applicable check blocks an unqualified completion claim.** Fix an owned regression and rerun affected checks. Revert only this task's authorized, safely reversible changes when that is the appropriate remedy; preserve other work. Destructive or external rollback needs its own authorization. Report unrelated existing failures separately, including any verification they prevent.
- **No new KNOWLEDGE-CONSTRAINT debt.** New tables, thresholds, keyword routers or mandated process steps must pass the Bitter-Lesson Gate above.

## Verification

- [ ] Applicable completion checks pass; inapplicable checks and unverified boundaries are explicit
- [ ] Required lifecycle and negative/adversarial evidence is present, with fixture/live limits stated
- [ ] Owned regressions are fixed or safely reverted within authorization; unrelated work is preserved
- [ ] No deprecated APIs in owned changes; out-of-scope findings are reported
- [ ] No custom alternatives to canonical implementations
- [ ] Pi deviations documented with rationale
- [ ] Material added complexity satisfies proportionality; fixed mechanisms pass the Bitter-Lesson Gate on their merits, not their labels

## Files

| File                                                     | Purpose                                                 |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `docs/agents/coding/python.md`                           | Python standards                                        |
| `docs/agents/coding/typescript.md`                       | TypeScript standards                                    |
| `docs/agents/coding/security/`                           | Invariant-first secure coding and evidence requirements |
| `docs/agents/extensions/extension-creation-procedure.md` | Extension creation                                      |
