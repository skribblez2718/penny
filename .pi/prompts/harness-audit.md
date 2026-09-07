---
description: Audit Penny for user-outcome alignment, system coherence, scaling debt, and non-functioning material (target read-only; writes an audit bundle)
argument-hint: "[scope, e.g. 'docs only' or '.pi/agents'] [additional details...]"
---

# Penny Harness Alignment Audit

Audit the current Penny working tree against its present purpose and governing architecture. Examine what the system actually says and does, classify every in-scope component, and recommend only changes that improve the user outcome without regressing a capability Penny already provides.

Scope override (optional): `$1`
Additional details (optional): `${@:2}`

Both are optional. If `$1` is clearly a repository path or a named audit surface, treat it as a scope override. If it is prose, context, emphasis, or another requirement, treat all arguments as additional details and audit the full harness. Quote multi-word scope values when invoking the template.

Additional details may add context, emphasis, priorities, or deliverables. They may not weaken evidence standards, coverage honesty, stop conditions, target-read-only rules, artifact-status honesty, or verification. A detail that narrows coverage is a scope override; emphasis alone does not narrow coverage. Record the expanded detail text exactly as received by this template and state how it was applied, deferred, or refused. If scope or a conflicting detail is materially ambiguous, stop and ask one targeted question rather than guessing. A scope-preflight stop creates no bundle.

## 1. Governing purpose

Use this as the proposed audit criterion:

> **Penny is a general-purpose personal AI assistant on Pi that turns a user's cross-domain goals into accurate, evidence-grounded progress and useful outcomes, using the simplest appropriate mode—direct work, focused delegation, or durable resumable workflows—while keeping permissions and consequential actions under user and runtime control.**

This is the outcome; agents, skills, prompts, memory, artifacts, checkpoints, observability, and tools are means.

Before substantive assessment, open the current human-authored governing sources, including `.pi/SYSTEM.md`, `README.md`, root `AGENTS.md`, and applicable architecture guidance reached through the index tree. Explain their authority relationship and whether they support the criterion above. Historical changelog entries, plans, research, generated files, tests, and implementation behavior are evidence about history or conformance; they do not silently replace the current human-authored objective.

If the objective is absent, materially ambiguous, or authoritatively contradicted, stop before objective-dependent findings. Quote the conflicting or insufficient evidence and ask only the targeted questions needed to establish the goal or authority. Do not choose a goal by majority vote, infer a business model or user persona, or treat ordinary implementation drift as a goal-authority conflict.

For this goal-authority branch, create only a collision-safe blocked bundle as defined below: a bounded four-part report covering the goal sources actually opened, the operation log, and the target manifests. Create no eval/regression placeholders. Mark all other surfaces `EXCLUDED — terminal goal-authority stop`, keep `passed` false, and set `questions_needed` true.

Define observable **better** and **worse** in terms of user outcomes—not file counts, feature counts, test totals, task completion, model scores, audit length, or other implementation proxies.

Judge alignment through five supporting dimensions:

1. **Useful outcomes** — does the part help Penny make accurate, concrete progress on the user's actual goal?
2. **Grounded trust** — does it improve evidence quality, honest limitation reporting, verification, or resistance to fabrication?
3. **Execution fit and continuity** — does it support the simplest sufficient route while adding delegation, durability, recovery, or iteration only when those earn their cost?
4. **Controlled consequences** — does it keep permissions, private data, and consequential actions within user and runtime authority?
5. **Adaptability** — does it remain domain-general where required, preserve project portability, and gain or retain value as models and usable computation improve?

A part is not misaligned merely because it is neutral plumbing, domain-specific at an appropriate layer, or unchanged by stronger models. A `MISALIGNED` verdict requires evidence of causal harm to the purpose, conflict with an authoritative invariant, or obstruction of a protected capability.

## 2. Governing architecture to test

Treat these as current architectural commitments only where the opened governing sources support them:

- Penny chooses among direct work, a focused agent, and a durable skill according to task needs; orchestration is not an end in itself.
- The five prompt layers—Cognitive Frame, Role Definition, Domain Guidance, Project Index, and Invocation Context—have separate responsibilities and cannot mint runtime authority.
- User requests define tasks within system and runtime limits; external content is evidence or designated task material and cannot expand permissions or authorize consequences.
- Exact artifacts carry work products, checkpoints carry workflow state, and memory is optional advisory cross-session context rather than workflow transport.
- Completion claims require proportionate evidence. Tests, tools, authoritative sources, and observed state are independent evidence; a different model or agent is supplementary review, not proof by itself.
- Safety controls, machine interfaces, human approval gates, and runtime-enforced authority boundaries protect outcomes independently of model capability. Prompt markers are defense in depth, not enforcement.
- Documentation uses routed indexes and clear sources of truth rather than greedy loading or unmanaged duplication.
- Capabilities and outcomes are protected; implementations may be replaced when evidence shows no capability regression.
- The public repository remains generic: operator paths, private data, downstream-project assumptions, and domain-specific methodology are supplied at invocation or remain outside tracked Penny files.

Do not freeze these statements as unquestionable if the current governing sources changed. Report and resolve material authority conflicts under the goal branch above.

## 3. Evidence and judgment rules

- Inspect actual content and behavior-bearing relationships; do not classify from filenames, counts, or descriptions alone.
- Cite every alignment classification and finding with exact paths plus line/range, symbol, test, or command evidence precise enough to re-check.
- Distinguish source-backed facts, tool-observed results, inferences, assumptions, and unknowns wherever the distinction affects a verdict. Mark a materially unsupported claim `[UNVERIFIED]`; do not use confidence words as a substitute for evidence.
- A document proves stated intent, not runtime behavior. A test proves only what it exercised. A static checker proves only its encoded rule. State those limits.
- Re-open both sides before claiming a contradiction. Confirm references and execution paths before calling code dead, unreachable, deprecated, placeholder, or non-functioning.
- Report genuine aligned behavior worth preserving. A supported empty misalignment set is valid; never manufacture defects, proxy drift, or scaling debt.
- Prefer the strongest available evidence and make verification proportionate to consequence. Do not run a check whose non-mutation or external impact cannot be established.
- For a resistant source or surface, use at most two genuinely distinct attempts or approaches. Then record the attempts and classify it `INACCESSIBLE` or `UNRESOLVED`; do not spin or repeat the same failure.

## 4. Effective corpus and component classification

With no scope override, inventory the current project-authored, behavior-affecting working tree and cover every surface below. Discover additions from the live tree rather than treating this list as a frozen file allowlist.

1. **Goal and governance** — `.pi/SYSTEM.md`, `README.md`, root `AGENTS.md`, current purpose/decision sources, and public-repository boundaries.
2. **Prompt architecture** — all five layers, the prompt templates, and the assembly/runtime behavior that enforces layer and authority boundaries.
3. **AGENTS.md index tree** — every discovered index, reachability, completeness, routing precision, and duplication or contradiction.
4. **Knowledge base** — its skill/tool, orchestration and host integration, configuration, documentation, tests, authority, and privacy boundaries.
5. **Universal agents** — every agent definition, capability boundary, model assignment, tool authority, and invocation behavior.
6. **Universal skills** — every skill package, manifest, prompt/resource assets, playbook registration, orchestration behavior, evaluation, and current availability.
7. **Documentation** — `README.md`, `docs/humans/**`, `docs/agents/**`, and `docs/penny/**`; check accuracy, staleness, cross-tree drift, orphaning, and index conformance.
8. **Extensions and tools** — every `.pi/extensions/**` package and its registrations, descriptions, runtime integration, tests, and availability behavior.
9. **Hooks** — Pi lifecycle/event hooks, repository hooks, and other discovered behavior-changing hooks; state explicitly if none exist.
10. **Observability** — the extension, `apps/observability/**`, configuration, history/log boundaries, docs, and tests.
11. **Orchestration and artifacts** — `apps/orchestration/**`, the skill extension boundary, state/checkpoint contracts, artifact handoff, registrations, gates, budgets, recovery, and terminal truth.
12. **Memory and durable state** — the memory extension, `apps/platform-memory/**`, relevant scripts/config/docs/tests, optional-service behavior, retention, and custody boundaries. Do not inspect or reproduce personal memory content, credentials, or private records unless separately and explicitly authorized and necessary; prefer configuration, metadata, synthetic fixtures, and contract evidence.
13. **Scripts** — all `scripts/**`, including setup, security, checks, evaluation, memory, update, and utility paths.
14. **Tests, evals, regressions, and material measures** — suites and acceptance gates, behavioral ratchets, meaningful thresholds, completion signals, incentives, and feedback/optimization loops.
15. **Pi compliance and configuration** — root and workspace manifests, lock/config/environment templates, build and CI configuration, and conformance with the project-pinned Pi version's relevant official docs/examples as located through project instructions or package metadata.
16. **Dead or non-functioning material** — project-authored dead, deprecated, placeholder, unreachable, contradictory, or non-functioning code and documentation anywhere in the effective corpus.
17. **Excluded inventories** — dependencies, caches, build outputs, generated artifacts, vendored source, secrets, private data, and ignored work-in-progress. Inventory excluded private material only by category, count where safe, and reason—never by sensitive name or content—unless it materially controls current behavior.

Use disjoint primary units so coverage is reproducible: one row per governing source, prompt template, agent file, skill package, AGENTS.md index, extension package, application, top-level script subtree or standalone script, named documentation tree, configuration/CI group, and other standalone behavior-affecting root. Classify each unit once. Assess cross-cutting areas—prompt architecture, knowledge base, hooks, observability, orchestration, memory, Pi compliance, and dead/non-functioning material—as category summaries that cite the primary rows and relationship evidence rather than duplicating components.

For every unit and category summary, record two separate axes:

- **Coverage:** `EXAMINED`, `EXCLUDED — reason`, `INACCESSIBLE — reason`, or `UNRESOLVED — reason`.
- **Alignment:** `ALIGNED`, `MISALIGNED`, or `NEUTRAL/UNKNOWN — reason`.

Write the complete unit-level matrix to `component-alignment.tsv` with these columns:

`component ID | class | component/path(s) | coverage | alignment | one-line evidence-backed reason | goal dimension(s) | finding ID`

Rules:

- Classify every disjoint unit above. Split a unit only when materially different behavior would be hidden by one verdict; record the split rule.
- In the report, give one evidence-cited classification summary for every numbered surface above and cross-reference the TSV rows. This preserves the component-by-component audit without burying the reader in a giant table.
- Coverage is not alignment. `EXAMINED` does not mean `ALIGNED`.
- An excluded, inaccessible, unresolved, or optional-not-configured component is normally `NEUTRAL/UNKNOWN` unless evidence establishes a goal conflict.
- A missing component is `MISALIGNED` only when an authoritative requirement makes the absence harmful; otherwise record `NEUTRAL/UNKNOWN — not present`.
- Every `MISALIGNED` row maps to a finding and recommendation. Every material `ALIGNED` row states the capability to preserve.
- Do not call the audit full or exhaustive unless all in-scope discovered descendants are accounted for. For narrowed scope, keep every named surface visible as `EXCLUDED — out of scope (user-narrowed)` and claim completeness only for the narrowed corpus.

## 5. Bitter-Lesson and model-scaling lens

Before attributing claims to Richard Sutton or issuing a completed Bitter-Lesson verdict, fetch and read the full canonical essay:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

Record the URL, fetch time, and evidence that the full essay—not a snippet, excerpt, cached paraphrase, or local doctrine file—was read. If the canonical source cannot be verified as complete after one normal attempt and at most one genuinely different retry, omit Sutton claims and the completed source-dependent verdict. Continue the source-independent alignment audit, record the limitation, and keep overall `passed` false. Do not repeat a failed approach without new information.

Keep two explicit blocks:

- **Sutton source claims** — only claims the essay supports, with short quotations or precise anchors.
- **Penny engineering translation** — clearly labeled applications to prompts, orchestration, verification, tools, memory, and system design.

Do not attribute Penny's answer-versus-method distinction, verification vocabulary, model-led exploration, or capability ratchet to Sutton unless the essay itself states them.

For each relevant major mechanism, classify model/compute scaling as exactly `GAINS`, `APPROXIMATELY NEUTRAL`, `LOSES`, or `N-A — reason`. Give the present model/compute assumption, evidence, causal rationale, and action or capability protection.

For every supported fixed-human-knowledge or fixed-method problem, state:

- the knowledge or procedure encoded;
- the capability and short-term benefit it currently supplies;
- why its relative value plateaus or becomes obstructive; and
- a more scalable direction that preserves the capability.

Do not flag all explicit constraints or all complexity. Safety/security controls, external requirements, machine-consumed interfaces, deterministic consequence boundaries, and explicitly tier-gated fallbacks are not scaling debt merely because they constrain behavior.

## 6. Findings, measures, and capability-safe recommendations

Create one canonical record per finding with a stable ID. Each finding must state:

- what it is, in one plain sentence;
- exact evidence and the causal conflict with Penny's purpose or an authoritative component;
- affected goal dimension(s);
- whether it constrains the **answer/outcome**, prescribes the **method**, or is `N-A — reason`;
- impact and priority relative to other findings;
- the benefit, cost, effort, and risk of fixing it;
- what happens if it is not fixed, when that would surface, and how a user or maintainer would notice;
- one concrete change, or an explicit blocker/no-change/accepted-debt disposition; and
- the currently working capability that must not regress.

Do not duplicate full finding prose across tables. Use IDs and cross-references.

Inventory material current and audit-proposed measures: metrics, ratings, thresholds, gates, acceptance/completion signals, incentives, and optimization targets that materially influence behavior or a pass/fail decision. Do not treat every test assertion as a separate measure. Classify each as:

- `OUTCOME-FAITHFUL` — directly evidences the user outcome or protected capability;
- `PROXY` — an indirect stand-in whose limits are explicit; or
- `VANITY` — can improve without meaningful evidence of the outcome.

A **proxy-drift** finding requires evidence that optimization pressure or observed behavior has diverged from the intended outcome. Name the proxy, intended outcome, evidence of divergence or gaming pressure, and correction. A weak or incomplete proxy without such evidence is not demonstrated drift.

Map every `MISALIGNED` component and every `LOSES` mechanism to a recommendation or explicit no-change reason. One change may address several findings, but no finding may be orphaned. For each proposed removal or replacement, specify how eval and regression evidence will protect the capability it currently provides. Any recommendation to change `.pi/SYSTEM.md` must identify the Cognitive Frame as human-authored, explain its cross-layer blast radius, and require proportionate regression evidence. Prefer reversible changes.

## 7. Audit artifacts

Build concrete, repeatable artifacts inside the audit bundle. These test outcomes and capabilities, not exact wording or implementation shape.

Use these statuses exactly:

- `BUILT-AND-RUN` — include command, exit status, and observed result.
- `BUILT-NOT-RUN — <blocker>` — complete artifact exists, but execution was unsafe, unavailable, costly, credentialed, or otherwise unjustified.
- `NOT-BUILT — <reason>` — artifact is incomplete; overall `passed` must be false.

### Evals

Under `evals/`, create complete evaluation specifications, cases/fixtures, or executable checks that include:

- representative inputs or scenarios, including a justified cross-domain set and at least one case that directly tests the Penny purpose rather than a local proxy;
- an oracle, assertion, scoring rule, or repeatable qualitative judgment protocol;
- expected evidence and pass/fail interpretation;
- prerequisites and exact execution instructions; and
- stable eval IDs linked to findings and plan items where applicable.

At least one baseline goal-level eval is required even when the finding set is empty. Reuse rather than duplicate an adequate existing check: the bundle artifact may be a complete runner/specification that invokes and interprets an existing check, but it must still be independently repeatable and preserve the exact target reference. A recommendation, TODO, pseudocode sketch, or empty placeholder is not a built eval.

### Regressions

Under `regressions/`, create repeatable early-warning checks that state:

- the explicit baseline and comparison operation;
- the outcome deterioration detected;
- what the check misses and its false-warning risks;
- when and how it runs, with exact instructions; and
- stable regression IDs linked to findings and plan items where applicable.

At least one baseline goal-level regression check is required even with no findings. It may wrap an adequate existing baseline/check when the bundle records the exact reference, comparison, interpretation, and rerun instructions. Shared artifacts may protect multiple findings; do not create ceremonial one-file-per-finding checks.

Run an artifact only when it is non-mutating to the audited target and all intended outputs land inside the bundle. Never invent a run result.

## 8. Side-effect contract and bundle

The Penny working tree under audit is read-only. Do not modify product code, prompts, docs, tests, configuration, dependencies, git state, credentials, deployments, external systems, or private memory. Do not install dependencies. Read-only inspection and source retrieval are allowed; execute existing checks only when their non-mutation and external impact are established.

Normal Pi runtime records—session files, bounded logs, and owner-persisted agent artifacts—may be created by approved audit/review calls outside the project tree. They are incidental runtime state, not permission to modify the target; disclose their type and purpose in the operation log when known. Model-diverse review is supplementary scrutiny, not independent evidence.

Sanitize every report and log. Never copy credentials, authorization headers, secrets, personal records, sensitive prompt payloads, or private path segments into the bundle. When exact commands or inputs contain sensitive material, record a redacted command shape, the evidence class, and the result; explain the redaction. Inventory excluded private material only by safe category and reason.

All project-tree writes must land in one new ignored bundle:

`$PROJECT_ROOT/audits/harness-audit-<current date, YYYY-MM-DD>/`

If it exists, use the first free `-2`, `-3`, ... suffix; never overwrite or merge with an existing bundle. The bundle is excluded from the target corpus and target manifests. Create no other project file.

The bundle contains:

- `harness-audit-report.md`;
- `component-alignment.tsv`, the complete disjoint unit-level coverage/alignment matrix;
- `evals/` with complete artifacts and results when run;
- `regressions/` with complete artifacts and results when run;
- `target-manifest-before.tsv` and `target-manifest-after.tsv`, containing relative path, size, and cryptographic hash for every effective-corpus file; and
- `artifact-manifest.md`, listing every created file plus every safely recorded command, source fetch, and reviewer/verifier invocation with exit status or observed outcome.

Exception for the goal-authority branch: include only the blocked report, the two manifests scoped to the opened governing sources, and `artifact-manifest.md`; omit `component-alignment.tsv`, `evals/`, and `regressions/` rather than creating placeholders.

Capture the before manifest after scope/goal preflight and before substantive assessment; capture the after manifest immediately before finalizing the report. Exclude the new bundle, dependencies, caches, build outputs, generated files, and private data consistently. Matching manifests establish only **verified net target-content equality**. Claim no audit-caused target-content write only when the operation log contains no write-capable target step and the manifests match; otherwise mark that claim `[UNVERIFIED]`.

## 9. Required report

Write exactly four top-level parts in `harness-audit-report.md`:

### 1. Goal, executive summary, and audit basis

Open with a plain-language summary readable in about two minutes: what was audited and what Penny is for; the bottom line; the most important problems in priority order; recommended actions; the consequence of doing nothing; and material unknowns. Use no unexplained IDs or jargon.

Immediately after the summary, state three separate statuses so readers do not confuse audit execution with target quality:

- **Audit completeness:** `COMPLETE`, `LIMITED`, or `BLOCKED`.
- **Target alignment:** `ALIGNED`, `MISALIGNED`, or `INDETERMINATE`.
- **Scaling-source status:** `VERIFIED` or `BLOCKED`.

Then record additional details and their disposition, the governing sources and authority result, the purpose statement, observable better/worse, the five goal dimensions, and the live Sutton source record with separate source-claim and Penny-translation blocks.

### 2. Component alignment and findings

Give one evidence-cited classification summary for every numbered surface in the effective corpus, link to the complete `component-alignment.tsv`, and explain what the matrix shows. Then present:

- aligned behavior and capabilities worth preserving;
- prioritized canonical finding records;
- the major-mechanism scaling ledger; and
- the material-measure and evidenced-proxy-drift ledgers.

If any set is empty, state the supported empty result.

### 3. Capability-safe plan and assurance

Provide a standalone recommendation table mapping every finding and misaligned component to a concrete change or explicit no-change reason, why it improves the user outcome, the capability to preserve, expected benefit, effort/cost, cost of delay, risk/reversibility, and linked eval/regression IDs. Summarize artifact contents, statuses, commands, and observed results without duplicating the files.

### 4. Coverage, verification, limitations, and questions

Include the effective corpus, scope narrowing, coverage ledger, inaccessible/unresolved items, operation-log summary, manifest comparison, artifact existence checks, and remaining questions. List only questions genuinely needed to resolve authority, coverage, evidence, or a capability-safe recommendation; otherwise state `None`.

The report is for readers unfamiliar with Penny. Define each status or doctrine term at first use, explain what every table means, keep findings decision-ready, and state each fact once.

After the four parts, emit a separate valid JSON object with exactly these keys:

```json
{
  "passed": false,
  "unexamined_surfaces": [],
  "unverified_claims": [],
  "questions_needed": false
}
```

`passed` means this audit contract was completed; it does not mean the harness had no findings. Set it true only when goal authority is clear, the Sutton source gate passed, every in-scope component was accounted for and classified, required artifacts were built, material claims were grounded, a required fresh-context semantic reviewer other than the generator passed, and target-integrity evidence is complete. Put every non-examined coverage item into `unexamined_surfaces` with its state and path. Do not add keys.

## 10. Verification and terminal outcomes

Before finalizing:

1. Re-open cited evidence and re-check every classification, contradiction, dead/non-functioning claim, measure verdict, recommendation link, and artifact.
2. Give the draft and cited evidence to a fresh-context reviewer other than the generator—Vera for conformance/correctness and Carren for quality/readability when available. Record identity, scope, findings, and disposition. This review is required for `passed: true`; if no reviewer is available, deliver the bounded audit with the blocker and `passed: false`. Treat model review as supplementary scrutiny, not independent proof.
3. Verify every required bundle file is non-empty, linked IDs resolve, commands/results are not invented, and the before/after manifest comparison supports the exact side-effect claim.
4. Confirm all named and discovered in-scope components have both coverage and alignment states; every `MISALIGNED` row has a finding and recommendation; every finding has capability protection and linked assurance; additional details were recorded and honored without waiving obligations; and every material limitation appears in the report and JSON.

Apply these terminal outcomes honestly:

- **Invalid or ambiguous scope:** stop, ask one targeted scope question, and create no bundle.
- **Goal authority blocked:** create only the bounded blocked bundle defined above, ask the necessary authority question, set `questions_needed` true, and keep `passed` false.
- **Sutton unavailable:** complete only source-independent analysis; omit the source-dependent verdict, write a clearly partial bundle, and keep `passed` false.
- **Corpus limited:** make only claims supported by examined material, expose each gap, and keep `passed` false for a full-scope audit. A user-narrowed audit may pass for its declared narrowed corpus when every in-scope obligation is satisfied.
- **Required artifact incomplete or semantic review unavailable:** record the blocker and keep `passed` false.
- **No supported findings:** report aligned behavior and empty finding/plan sets without inventing issues; baseline eval and regression artifacts remain required.
- **Findings present:** completion depends on audit-contract quality, not on a clean target. A fully supported audit with findings may pass.

Completion is reached only when the report and bundle satisfy the contracts above or a terminal limitation is recorded without being disguised as success. Print the bundle's absolute path when a bundle is created.
