---
description: Create or capability-preservingly revise any self-contained audit prompt using the 13-attribute audit framework
argument-hint: "<create|revise> <audit-domain-or-existing-prompt-path> [output-path] [additional requirements...]"
---

# Audit Prompt Creator

Create a new audit prompt or revise an existing one so it implements the consolidated 13-attribute audit framework **without sacrificing target-specific quality**.

## Invocation

- **Mode:** `$1` — must be `create` or `revise`
- **Audit domain or existing prompt path:** `$2`
  - in `create` mode: a domain/object description, such as `architecture`, `documentation`, `security-program`, or `data-pipeline`;
  - in `revise` mode: the path to the existing audit prompt.
- **Optional output path:** `$3`
- **Additional caller requirements:** `${@:4}`

If mode or target is missing or invalid, stop and ask for the missing value. If critical design information cannot be inferred safely, ask targeted questions before drafting. Do not invent the audit object's goal, target-specific quality criteria, permitted side effects, or output location.

## Governing principle: consistent capabilities, not identical prose

Consistency means that every generated audit prompt:

- establishes the real desired outcome;
- bounds its coverage and evidence claims;
- applies the same source-faithful Bitter-Lesson lens;
- evaluates future model/compute scaling;
- ties “better” to faithful measures, concrete evals, regression checks, and proxy-drift analysis; and
- verifies those obligations through a traceability contract.

Consistency does **not** mean identical phases, headings, checklists, taxonomies, output files, or side-effect rules. Preserve domain-specific mechanisms that improve audit quality. Do not force all audits into one procedural shape or replace a strong target-specific control merely to make wording uniform.

The framework is a **minimum capability and traceability contract**, not a maximum. Existing audit prompts may contain valuable requirements beyond it.

## Mode behavior

### Create mode

1. Determine what object the requested audit will inspect and what evidence can authoritatively establish its objective.
2. Determine the target-specific corpus, relevant component types, user-visible outcome, model/compute applicability, side-effect mode, output form, and eval/regression execution environment.
3. Ask only for decisions that are genuinely blocking. Otherwise make explicit, reversible choices and label them as creator decisions rather than source-framework requirements.
4. Produce a self-contained prompt that implements every AF attribute below and adapts each one to the requested domain.

### Revise mode

Read the existing prompt in full before drafting. Treat it as a working capability bundle, not disposable prose.

First produce a **capability-preservation ledger** covering every existing:

- target-specific scope or dependency rule;
- goal/North-Star statement;
- branch and stopping condition;
- evidence, anti-fabrication, or confidence rule;
- safety, security, or machine-interface exception;
- positive-alignment or fully-aligned behavior;
- edge-case treatment;
- output and side-effect contract;
- verification obligation;
- domain-specific rubric, coverage surface, or completion criterion; and
- useful prioritization, risk, reversibility, or capability-ratchet rule.

For each current capability, mark:

- **PRESERVE AS-IS**;
- **PRESERVE, REPHRASE**;
- **GENERALIZE WITHOUT LOSS**;
- **REPLACE — capability protected by [specific mechanism/eval]**; or
- **REMOVE — caller-authorized reason**.

Then assess AF-01 through AF-13 as **CAPTURED**, **PARTIALLY CAPTURED**, or **MISSING**. Revise only where needed to close a gap, resolve an internal contradiction, or satisfy an explicit caller requirement.

Do not:

- regenerate from a blank slate;
- delete an out-of-framework strength merely because other audit prompts lack it;
- replace target-specific evidence rules with generic wording;
- silently change read/write permissions;
- turn answer/output constraints into arbitrary method constraints;
- overwrite the source prompt unless the caller explicitly requests that exact path and confirms replacement; or
- claim consistency improved if a current capability regressed.

If a framework requirement conflicts with an existing prompt's purpose or side-effect contract, name the tradeoff and ask or choose an additive design. For example, a read-only target can remain read-only while eval/regression artifacts are built in a separate output directory. If the caller prohibits all writes, AF-11 and AF-12 cannot be fully satisfied; report that incompatibility rather than weakening “build” to “recommend.”

## House argument convention for generated audit prompts

Every generated audit prompt must accept a **final optional free-form additional-details argument** after its required and optional positional arguments — `${@:3}` when the prompt already takes a target and an output directory, `${@:2}` when it takes only a target, and so on. Declare it in `argument-hint` as a trailing `[additional details...]`, and define it in the prompt body as caller-supplied context and requirements the audit cannot infer from the target: background, constraints, known history, emphasis, or extra deliverables.

The generated prompt must bound that argument with these rules:

- when it is empty, the audit runs exactly as if it were not supplied; it is never required and never a stopping condition on its own;
- it may add requirements, supply context, set emphasis or priority, and request additional analysis, and the audit must honor it wherever it does not conflict with the prompt's own obligations;
- it may not waive or weaken the evidence and anti-fabrication rules, the coverage ledger and its bounds on exhaustive claims, the side-effect contract, the stopping/branch conditions, or any required artifact, status-honesty, or verification obligation;
- a detail that narrows scope is treated as a scope narrowing — recorded in the coverage ledger with the omitted surfaces marked user-narrowed and no exhaustive claim — while a detail that only sets emphasis does not shrink the declared corpus;
- a detail that conflicts with an obligation above, or that is too ambiguous to apply, must be reported (and asked about where it blocks the audit) rather than silently followed or silently ignored; and
- the detail text must be recorded verbatim in the audit report along with how each was applied, deferred, or refused, so findings and coverage claims stay interpretable.

Where positional ambiguity is possible — prose supplied in the position of an optional path argument — the generated prompt must state a disambiguation rule that resolves it from the argument's content rather than from position alone. Where a multi-word leading argument must arrive as one value, the generated prompt must say so.

The generated prompt's completion or verification obligations must include a check that any supplied details were recorded and honored without waiving an audit obligation.

## House output convention for generated audit prompts

Unless the caller specifies a different location, every generated audit prompt must default its output to a single bundle directory:

```
$PROJECT_ROOT/audits/<target-name>-audit-<the current date, YYYY-MM-DD>/
```

where `<target-name>` is the audited object's name derived from the prompt's own target argument. The generated prompt must:

- accept an optional caller-supplied output directory that overrides this default, where the prompt's argument shape leaves an unambiguous slot for one (a prompt with no such slot may rely on the deterministic default alone);
- permit creating `audits/` and the dated bundle directory when absent;
- append `-2`, `-3`, ... when a bundle for that date already exists, rather than overwriting or merging into a prior audit;
- treat that bundle directory as the sole write location, keeping the audited target read-only;
- organize the bundle as a main `<kind>-audit-report.md`, an `evals/` directory, a `regressions/` directory, and an `artifact-manifest.md` listing every created file and every executed command with exit status, adding domain-specific files (such as a revised-target proposal) as needed;
- forbid empty placeholder files and forbid fabricating a bundle when a stopping branch fires; and
- print the bundle's absolute path at completion.

Write the path as `$PROJECT_ROOT/audits/...` — never a hardcoded absolute or home-relative path — so the generated prompt stays portable. This convention governs where artifacts land; it does not override AF-11/AF-12's requirement that artifacts be genuinely built rather than recommended. If the caller's domain genuinely requires a different output location or a stricter no-write contract, name the tradeoff and record the deviation as an explicit creator decision.

## The 13 required framework attributes

Every generated prompt must enforce each attribute substantively—not merely mention its ID. An attribute may be marked not applicable only where the framework permits that decision and the generated prompt requires a concrete reason.

### AF-01 — Desired-value criterion

Require the auditor to identify the user's actual overarching outcome and define observable better/worse relative to it. The outcome must not be a restatement of components, tasks, milestones, phases, output counts, or current metrics. Require target or user evidence.

### AF-02 — Objective legibility and elicitation

Require a goal-clarity branch. If the objective is absent, ambiguous, or contradicted, the auditor must stop substantive assessment, cite the ambiguity/conflict, and ask targeted questions rather than guess.

### AF-03 — Component-to-objective alignment

Require each supported misalignment to name the component/evidence and explain causally how it works against the outcome or contradicts another component. Permit a supported empty result; never require findings for appearance's sake.

### AF-04 — Audit coverage boundary

Require a declared effective corpus and a coverage ledger that marks relevant surfaces as examined, excluded with reason, inaccessible, or unresolved. Narrowed scope must be visible. Exhaustive wording is allowed only when the ledger supports it.

### AF-05 — Doctrine-to-domain translation

Require the auditor to fetch and read Richard Sutton's “The Bitter Lesson” in full at:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

The generated prompt must require separate blocks for:

1. Sutton's relevant source claims; and
2. the auditor's domain-specific engineering translation.

It must prohibit attributing the translation to Sutton and prohibit a completed Bitter-Lesson verdict if the essay was unavailable.

### AF-06 — Compute-scalable meta-method leverage

Require analysis of where the target enables or blocks general methods that can exploit stronger models or greater computation. Sutton's central examples are search and learning; discovering/capturing complexity rather than storing human discoveries is part of the lens. Domain adaptations such as model-led exploration or iteration must be labeled as adaptations. Verification may complement scalable generation but must not be attributed as Sutton's terminology.

### AF-07 — Built-in human-knowledge constraint

Require examination of all covered components for hand-engineered domain knowledge or procedural scaffolding that helps short-term but has a fixed ceiling, complicates the system, or inhibits scalable methods. Each violation must name:

- the built-in knowledge or fixed method;
- the current capability and short-term benefit;
- why relative value plateaus or becomes obstructive; and
- a more scalable direction that preserves the capability.

Do not equate all complexity or explicit constraints with violations.

### AF-08 — Model-evolution flexibility

Require every relevant major mechanism to be classified as gaining value, remaining approximately neutral, or losing relative value as models/compute improve. Require current-model assumptions and justified non-applicability where no model/compute relationship exists.

### AF-09 — Upgrade-plan completeness

Require every supported strategic misalignment and Bitter-Lesson violation to map to a proposed change or an explicit blocker/no-change reason. Require preservation of the capability currently supplied and link that protection to AF-11/AF-12 evidence. No finding may be orphaned.

### AF-10 — Measure fidelity

Require current **and proposed** measures to be tied to AF-01. The auditor must distinguish outcome-faithful measures, vanity metrics, and proxies. Every retained or replacement measure needs a defensible outcome link.

### AF-11 — Evaluation embodiment

Require concrete, repeatable eval artifacts—not merely recommendations—with inputs/scenarios, an oracle or judgment rule, expected evidence, execution instructions, and at least one case that tests the real outcome. Require accurate status: built-and-run, built-not-run with blocker, or not-built. Proposed-only output does not pass.

### AF-12 — Regression early warning

Require a repeatable comparison against an explicit baseline, what deterioration it detects, what it misses, false-warning risks, how/when it runs, and current results where possible. The check must expose outcome deterioration before reliance on informal user discovery.

### AF-13 — Optimized-proxy drift

Require inspection of current metrics, gates, incentives, completion signals, and optimization loops. A drift finding must show the proxy, intended outcome, evidence of divergence or gaming pressure, and correction/unresolved question. Do not mislabel every weak measure as demonstrated drift; a supported empty result is valid.

## Target adaptation requirements

Adapt the audit framework to the requested object rather than copying generic surfaces mechanically.

The generated prompt must specify:

1. **Audit object and authoritative goal sources** — what is being audited and where its purpose can be established.
2. **Effective corpus** — domain-relevant surfaces and dependency boundaries. Do not import another domain's file list.
3. **Component meaning** — what counts as a component, mechanism, statement, control, workflow, artifact, or measure in this domain.
4. **Bitter-Lesson translation** — how scaling, search/learning, built-in knowledge, and future-model assumptions manifest in this domain; mark genuine non-applicability.
5. **Measurement model** — what evidence could represent the actual outcome and what likely vanity/proxy signals require scrutiny. These are hypotheses to inspect, not predeclared findings.
6. **Eval/regression artifact form** — executable checks where feasible; a concrete repeatable judgment protocol for inherently qualitative outcomes.
7. **Side-effect contract** — exactly what may be read, executed, created, or modified, with one coherent output location. Keep the target read-only unless the caller clearly authorizes mutation.
8. **Branch behavior** — missing target, unclear goal, unavailable Sutton source, narrowed/inaccessible corpus, fully aligned target, genuine findings, and blocked eval execution.
9. **Completion evidence** — how the generated audit will prove coverage, finding traceability, artifact existence, and target non-modification.

Target-specific requirements may come from:

- explicit caller constraints;
- authoritative evidence in the target or its governing standards; or
- clearly labeled creator decisions needed to make the prompt executable.

Do not present generic conventions, existing-prompt details, or creator preferences as concepts from the framework.

## Generated prompt quality requirements

The final audit prompt must:

- be valid Markdown with Pi frontmatter containing `description` and, when it accepts arguments, `argument-hint`;
- use Pi argument syntax correctly (`$1`, `$2`, `$@`, `${N:-default}`, or slicing as needed);
- accept and bound a final optional additional-details argument per the house argument convention above;
- be self-contained at execution time and not require this creator or the framework file;
- define missing/invalid-input behavior;
- enforce all thirteen AF attributes in its body and completion check;
- distinguish source doctrine from domain adaptation;
- prefer outcome/evidence constraints over arbitrary fixed procedures;
- avoid unnecessary phase counts, pass counts, magic thresholds, fixed taxonomies, or enumerated finding lists;
- keep exhaustive claims conditional on coverage evidence;
- permit fully aligned and supported-empty outcomes;
- keep side effects internally consistent;
- default its output location to the house bundle convention above, or record an explicit justified deviation;
- specify concrete eval/regression construction rather than advice-only output;
- preserve existing strengths in `revise` mode;
- label unresolved or unverified claims honestly; and
- state that a framework-complete audit is not the same as a finding-free target.

## Required creator output

Deliver in this order:

### 1. Design decisions

State:

- mode and audit object;
- inferred/supplied purpose of the audit prompt;
- authoritative goal source expected by the generated prompt;
- effective-corpus strategy;
- side-effect and output mode;
- eval/regression artifact strategy;
- blocking assumptions or questions; and
- any target-specific additions with provenance.

### 2. Existing-capability preservation ledger (`revise` mode only)

List every material existing capability and its disposition. A revised candidate cannot pass if a capability is removed or weakened without explicit authorization or a protected replacement.

### 3. Framework traceability matrix

Produce exactly one row for AF-01 through AF-13 with columns:

| ID  | Generated prompt section/clause | Domain adaptation | Verification assertion |
| --- | ------------------------------- | ----------------- | ---------------------- |

No row may rely only on the presence of an AF identifier.

### 4. Candidate audit prompt

Provide the complete self-contained Markdown prompt, including frontmatter. Do not omit sections with “same as framework,” references to this creator, or placeholders that require hidden context.

### 5. Change and risk summary

In `create` mode, list material creator decisions and what would change them.

In `revise` mode, list additions, preserved features, replacements/removals, resolved contradictions, unresolved tradeoffs, and likely quality regression risks. Distinguish **consistency-only** edits from **capability** edits.

### 6. Verification

Check the candidate semantically, not by keyword presence alone. Emit:

```text
VERIFICATION:
- Valid Pi prompt-template format: YES / NO — [evidence]
- Self-contained: YES / NO — [evidence]
- AF-01 through AF-13 substantively enforced: YES / NO — [missing IDs/behaviors]
- Goal-unclear branch stops guessing: YES / NO — [evidence]
- Coverage bounds exhaustive claims: YES / NO — [evidence]
- Sutton claims separated from domain translation: YES / NO — [evidence]
- Every finding maps to upgrade/no-change reason: YES / NO — [evidence]
- Current and proposed measures tested for fidelity: YES / NO — [evidence]
- Concrete eval artifacts required: YES / NO — [evidence]
- Concrete regression artifacts and false-warning risks required: YES / NO — [evidence]
- Proxy drift requires divergence evidence: YES / NO — [evidence]
- Final optional additional-details argument accepted, bounded, and recorded in the report: YES / NO — [evidence]
- Side-effect contract internally consistent: YES / NO — [evidence]
- No target-specific criterion fabricated as framework doctrine: YES / NO — [evidence]
- Existing capabilities preserved (revise mode): YES / NO / N-A — [evidence]
- Overall candidate ready: YES / NO — [unmet items]
```

If any item is `NO`, revise the candidate and re-check it before delivery. If the conflict requires a user decision, stop and ask rather than claiming readiness.

## Write behavior

If `$3` is supplied and does not overwrite the source prompt, write exactly the candidate prompt to that path after verification and print the absolute path. Keep the design decisions, ledgers, traceability matrix, risk summary, and verification in the response unless the caller requests a separate report.

If no output path is supplied, return the candidate in the response and do not write a file.

If `$3` resolves to the source prompt in `revise` mode, do not overwrite it without explicit confirmation after presenting the preservation ledger and candidate diff. Prefer writing a sibling candidate such as `<name>-framework-candidate.md` for review.
