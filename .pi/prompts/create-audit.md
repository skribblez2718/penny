---
description: Create or capability-preservingly revise a self-contained audit prompt using a lean, target-adapted audit contract
argument-hint: "<create|revise> <audit-domain-or-existing-prompt-path> [output=<new-file>] [additional requirements...]"
---

# Audit Prompt Creator

Create or revise one self-contained Pi audit prompt. Preserve target-specific audit quality, require evidence appropriate to the audited object, and avoid forcing irrelevant framework ceremony into every audit.

- **Mode:** `$1` — `create` or `revise`.
- **Audit domain or source prompt:** `$2`.
- **Optional output token or first additional requirement:** `$3`.
- **Remaining additional requirements:** `${@:4}`.

Quote a multi-word audit domain, source path, output token, or requirement. Treat `$3` as the output only when it begins `output=`; strip that prefix and use the remainder as the new file path. Otherwise treat `$3` and later arguments as additional requirements and return the candidate in the response. If mode or target is missing/invalid, `output=` is empty, or any material value remains ambiguous, stop and ask the minimum targeted question set rather than guessing.

Additional requirements may supply context, constraints, emphasis, priorities, or deliverables. They may not weaken objective clarity, evidence integrity, coverage honesty, target-side-effect rules, capability preservation, or status honesty. Pi exposes an expanded/joined argument value, not the caller's original quoting or whitespace: record a concise disposition for each visible requirement rather than claiming a verbatim invocation record. Minimize sensitive data; redact secrets, personal data, authorization material, and private path segments, name the redacted category, and state that any persisted rendering is not verbatim.

## 1. Mode contract

### Create

Establish the audit object, its likely authoritative goal sources, behavior-affecting corpus, component grain, evidence types, side-effect mode, outputs, and meaningful failure branches. Ask only for a decision that would materially change the prompt's purpose, authority, safety, or deliverable.

### Revise

Read the existing prompt completely. Treat it as a capability bundle, not disposable prose. Before drafting, create a preservation ledger for every material existing:

- goal and goal-authority rule;
- target/corpus/dependency boundary;
- evidence, anti-fabrication, and uncertainty rule;
- coverage and exhaustive-claim limit;
- stopping or partial-result branch;
- safety, privacy, authority, and side-effect constraint;
- supported aligned/empty-result behavior;
- finding, prioritization, recommendation, risk, and reversibility contract;
- target-specific rubric, output, artifact, and machine interface;
- evaluation, regression, verification, and completion obligation; and
- readability or decision-usability requirement.

Mark each `PRESERVE`, `REPHRASE`, `GENERALIZE WITHOUT LOSS`, `REPLACE — <protection>`, or `REMOVE — <caller-authorized reason>`. Do not remove or weaken a capability merely to shorten the prompt or match another template. A replacement must name how the capability remains protected.

## 2. Universal audit core

Every generated prompt must enforce these behaviors, adapted to its target rather than copied mechanically:

1. **Desired outcome** — establish the user's actual overarching outcome from caller or target evidence; define observable better/worse without substituting tasks, files, phases, counts, scores, or current metrics.
2. **Goal clarity** — if the objective or its authority is absent, materially ambiguous, or contradicted, stop objective-dependent analysis, cite the gap/conflict, and ask targeted questions instead of inventing a goal.
3. **Causal alignment** — findings identify the exact component/evidence and explain how it harms the outcome or contradicts an authoritative requirement. Positive aligned behavior and supported empty finding sets are valid.
4. **Bounded coverage** — declare the effective corpus and track `EXAMINED`, `EXCLUDED — reason`, `INACCESSIBLE — reason`, and `UNRESOLVED — reason`. Separate coverage from alignment where component classification matters. Exhaustive language is allowed only when the ledger supports it.
5. **Evidence integrity** — use precise re-checkable citations; distinguish source-backed facts, tool-observed results, inference, assumptions, and unknowns when decision-relevant; mark material unsupported claims `[UNVERIFIED]`; never base a negative verdict solely on them.
6. **Decision-ready recommendations** — map every finding to a concrete change or explicit no-change/blocker, protect existing capabilities, state benefit/cost/risk and cost of delay, and prefer reversible changes.
7. **Side-effect clarity** — define exactly what may be read, executed, created, modified, or deleted. Prompt text grants no tool authority. Protect credentials, private data, external systems, and the audited target; state where intentional outputs and incidental runtime records may exist.
8. **Readable output** — begin with a plain-language summary, define specialized terms, interpret tables, avoid duplicated findings, and distinguish audit completeness from target quality.
9. **Verification** — re-check cited evidence, outputs, unresolved items, and side-effect claims. Use fresh non-generator review when consequence or uncertainty justifies it, but treat model agreement as supplementary rather than independent proof.

The generated prompt must define behavior for missing targets, unclear goals, narrowed or inaccessible corpus, finding-free targets, genuine findings, unsafe/unavailable checks, and incomplete verification. Do not mandate arbitrary phase counts, retry counts, taxonomies, or report sections unless they protect a real target-specific capability or machine interface.

## 3. Conditional modules

Include a module only when the target has the relevant relationship or the caller explicitly requests it. Explain inclusion and omission in the creator's design decisions; a generated prompt should discuss only applicable modules, except for a concise `N-A` state when users need it.

### Model/compute scaling and the Bitter Lesson

Use when the target contains AI/model behavior, human-coded procedures intended to substitute for model judgment, or mechanisms expected to change value with stronger models or more computation.

When included:

- fetch and read Richard Sutton's full canonical essay before attributing claims;
- keep **Sutton source claims** separate from the **domain engineering translation**;
- if the source is unavailable, block only Sutton/source-dependent conclusions unless the audit's purpose genuinely requires a full stop;
- classify relevant mechanisms as gaining, remaining approximately neutral, losing relative value, or not applicable;
- identify fixed human knowledge/procedure, current benefit, scaling limit, and a capability-preserving alternative; and
- do not misclassify safety controls, external requirements, machine interfaces, or deterministic consequence boundaries as scaling debt.

### Measures and proxy drift

Use when the target has or proposes metrics, gates, thresholds, scores, incentives, completion signals, or optimization loops.

Classify material measures as outcome-faithful, proxy, or vanity. Claim proxy drift only with evidence of divergence, gaming pressure, or goal displacement; a weak proxy alone is not demonstrated drift. Scrutinize measures proposed by the audit as well as existing ones.

### Evaluation and regression artifacts

Use when repeatable acceptance evidence or early warning materially improves the audit outcome, especially for consequential or implementation-facing recommendations.

Require complete, reusable artifacts rather than TODOs: representative cases, oracle/assertion or repeatable judgment rule, expected evidence, exact instructions, explicit baseline/comparison, deterioration signal, missed degradation, and false-warning risk. Use `BUILT-AND-RUN`, `BUILT-NOT-RUN — <blocker>`, and `NOT-BUILT — <reason>` when reporting artifact state. Permit reuse/wrapping of adequate existing checks. If the target must stay read-only, place new artifacts in a separate output bundle. If the caller prohibits every write, report the resulting limitation instead of calling proposed artifacts built.

A **full framework** request includes all three modules. Otherwise, relevance—not habit—decides.

## 4. Target adaptation and output design

The candidate prompt must state:

- the audit object and authoritative goal-source hierarchy;
- the effective corpus and direct-dependency boundary;
- the unit of component classification and evidence needed for behavioral claims;
- applicable conditional modules and their target-specific translation;
- the side-effect contract and terminal branches;
- the report/artifact interface, with stable names only where users or machines depend on them; and
- completion evidence that proves what the audit may honestly claim.

For an artifact-producing audit, use one collision-safe bundle. A suitable default output root is `$PROJECT_ROOT/audits/`, producing `<target-name>-audit-<current date, YYYY-MM-DD>/`; append `-2`, `-3`, ... rather than overwrite. Resolve paths before writing and reject or clarify any bundle nested inside the audited target. Place all intentional outputs inside the external bundle, sanitize logs, and print the absolute path. Response-only audits should create no files.

When a generated audit reports completeness, use: `BLOCKED` for a response-only preflight/goal failure; `LIMITED` for a useful bundle with a material unmet applicable obligation; and `COMPLETE` only when all applicable obligations are satisfied. A justified `BUILT-NOT-RUN` may still be complete. Use `Scaling-source status: VERIFIED|BLOCKED|N-A` when the scaling module applies or its applicability must be reported.

Generated prompts that accept arguments must use valid Pi syntax and end with an optional free-form additional-details argument. Define how optional path positions are distinguished from prose and how additional details are bounded and recorded. Use `$PROJECT_ROOT`, never an operator-specific absolute path.

## 5. Required creator response

Deliver:

1. **Design decisions** — mode, target, inferred purpose, goal sources, corpus strategy, included modules, side effects, outputs, and blocking assumptions.
2. **Capability-preservation ledger** — revise mode only.
3. **Candidate prompt** — complete Markdown with Pi frontmatter; no hidden framework references, omitted sections, or unresolved placeholders.
4. **Change and risk summary** — additions, preserved/replaced/removed behavior, unresolved tradeoffs, and likely regression risks.
5. **Verification** — confirm valid template syntax, self-containment, goal-unclear stopping behavior, bounded coverage, evidence integrity, side-effect consistency, applicability of modules, capability preservation, and readiness.

If verification finds a correctable gap, revise before delivery. If it requires a user decision, stop and ask rather than claim readiness.

## 6. Write behavior

If no output path is supplied, return the verified candidate in the response and write nothing.

If a nonexisting output path is supplied, require a writable existing or safely creatable parent, write exactly the verified candidate there, and print its absolute path.

If any output path already exists, first present the completed candidate plus preservation ledger and diff/change summary. Then require a new explicit confirmation to replace that exact path; invocation-time authorization is not enough. Write only after confirmation. Never silently choose a sibling path, merge content, or destroy an existing file.
