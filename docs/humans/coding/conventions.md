# Penny Coding Conventions

Coding conventions are the shared rules that every Penny-generated file follows before it is considered complete. They exist so that code stays readable, testable, and safe across many authors — human and agent alike.

## Why Conventions Matter

Generated code can move fast. Without a quality gate, that speed becomes technical debt: untested logic, inconsistent formatting, hidden constants, and dead branches. Conventions slow delivery just enough to prevent regressions that slow everything down later.

The benefits are cumulative:

- **Predictability** — every file looks and behaves the way the next reader expects.
- **Trust** — tests, types, and lint give reviewers evidence instead of promises.
- **Safety** — dead code and magic numbers are where bugs hide; conventions surface them before merge.
- **Maintainability** — the person debugging the file six months from now is usually future you.

## The Pre-Generation Rules

Before any code is delivered, it must pass six universal checks. These rules are independent of language or framework.

| Rule | What it means | Why it matters |
| --- | --- | --- |
| **Test-first** | Write a failing test that describes the desired behavior, then write the code to make it pass. | Tests become a specification. They also make refactorings safer and catch regressions early. |
| **Lint clean** | Code must pass the project's linter with zero errors. | Linters catch style violations, suspicious patterns, and common bugs that humans miss. |
| **Format clean** | Code must pass the formatter. | Consistent formatting removes pointless diff noise and lets reviewers focus on logic. |
| **Type-check clean** | TypeScript must pass `tsc --noEmit`; Python must pass `mypy`. | Static types turn whole classes of runtime errors into compile-time errors. |
| **No dead code** | Remove commented-out blocks, unused imports, and unreachable branches. | Dead code confuses readers, inflates diffs, and can accidentally be reactivated. |
| **No magic numbers** | Every constant must be named and documented. | Bare numbers have no meaning. Named constants explain intent and make changes safer. |

These rules are the floor, not the ceiling. Language-specific guides — such as the [Python](python.md) and [TypeScript](typescript.md) references — add idioms on top of them. Cross-cutting standards apply on top regardless of language: [accessibility](accessibility.md) (WCAG 2.2 AA for every interface Penny renders) and the [security overview](security-overview.md).

## Severity Levels

Not every convention violation has the same weight. Severity makes it clear what must be fixed immediately and what can be documented as an exception.

| Severity | Meaning | Typical Action |
| --- | --- | --- |
| **BLOCKER** | A pre-generation rule is violated: tests fail, lint fails, format fails, type-check fails, or unsafe dynamic execution is present. | Fix before delivery. No exceptions. |
| **CRITICAL** | A quality rule is violated: dead code, magic numbers, hardcoded secrets, or unvalidated security boundaries. | Fix or document a deliberate exception with justification. |
| **WARN** | A best-practice deviation that does not block correctness or security. | Fix when practical; document if deferred. |

BLOCKER items are non-negotiable because they undermine the verification that the rest of the system relies on. CRITICAL items are negotiable only with explicit rationale, because they are where subtle failures tend to accumulate.

## How Conventions Are Enforced

Enforcement is part of the delivery workflow, not an afterthought.

1. **Before generation** — the agent loads the relevant language and security conventions.
2. **During generation** — the agent applies them incrementally: naming, types, tests, and validation.
3. **Before summary** — the agent runs the verification checklist: tests, lint, format, type-check, dead-code scan, and magic-number scan.
4. **At review** — human reviewers can rely on the checklist to focus on design rather than style.

This means the responsibility for quality sits with the generator, not the reviewer. Reviewers validate design decisions; they should not have to clean up formatting or add missing tests.

## Domain-Specific Conventions

Some conventions apply only to specific kinds of work. The most prominent example in this project is the **multi-GPU standard** for AI applications:

- Both GPUs must be visible to PyTorch, but the application must still work on one GPU, many GPUs, or CPU.
- Every model in a single application shares one device, chosen at startup by a shared helper.
- No hardcoded `cuda`, `cuda:0`, or `cpu` strings in model-loading paths.

The rule exists because splitting small models across GPUs is both wasteful and brittle: tensor operations crash when submodules live on different devices. Pinning everything to one device keeps behavior predictable across hardware configurations.

## Trade-offs

Conventions add overhead. A one-line fix might require a test, a type annotation, and a lint pass. That cost is intentional, but it is not infinite.

| When conventions help most | When conventions can be relaxed |
| --- | --- |
| New code that will be read or modified later | Truly throwaway exploration (still not in production) |
| Code that crosses trust boundaries | Early spikes that will be rewritten before review |
| Code that multiple agents or humans touch | Documentation-only changes with no executable impact |

The default stance is strict. If a task is too small to justify the full pipeline, that is usually a signal to execute it directly rather than generate a file.

## Relationship to Other Guides

- [Python coding style](python.md) — idiomatic Python specifics.
- [TypeScript coding style](typescript.md) — idiomatic TypeScript specifics.
- [Security overview](security-overview.md) — security conventions that sit on top of these rules.
- Agent reference: `docs/agents/coding/conventions.md` — the machine-readable pre-generation checklist.
