---
description: Goal, Bitter-Lesson, measurement, eval, regression, and proxy-drift audit of a project
argument-hint: "<project-path> [audit-output-directory] [additional details...]"
---

# Project Audit Prompt

Audit the project at **`$1`** as a whole. Determine what outcome it ultimately exists to produce, find project parts that work against that outcome, identify every supported Bitter-Lesson engineering violation, define what “better” means, build outcome-faithful eval and regression checks, find proxy drift, and produce a comprehensive upgrade plan that remains useful as models improve.

This prompt is self-contained. Do not assume the project is Penny, an AI harness, or any particular technology. Derive project-specific goals and criteria from the caller and the target itself.

## Inputs and branch behavior

- **Target project:** `$1`
- **Audit-output directory:** `$2`
- **Additional details:** `${@:3}`

If the target argument is absent, does not exist, or is unreadable, stop and ask for a valid project path.

The output directory and the additional details are both optional. If `$2` is supplied but is plainly
not an output-directory path — prose, guidance, or requirements — treat it as the first additional
detail and use the default output location below.

### Additional details

Additional details are caller-supplied context and requirements this audit cannot infer from the project itself: background, constraints, known history, emphasis, or extra deliverables. When they are empty, run exactly as if none were supplied; their absence is never a blocker.

Honor them wherever they do not conflict with this prompt's own obligations. They may add requirements, supply context, set emphasis or priority, and request additional analysis. They may **not** waive or weaken the evidence and anti-fabrication rules, the coverage ledger's bounds on exhaustive claims, the side-effect contract, the stopping branches, or any required artifact, status-honesty, or verification obligation.

A detail that narrows scope is treated as a scope narrowing: mark the omitted surfaces user-narrowed in the coverage ledger and make no whole-project or exhaustive claim. A detail that only sets emphasis does not shrink the declared corpus.

If a detail conflicts with an obligation above, or is too ambiguous to apply, report it — and ask when it blocks the audit — rather than silently following or silently ignoring it. Record the details verbatim in the report together with how each was applied, deferred, or refused.

If no output directory is supplied, use the house convention: create
`$PROJECT_ROOT/audits/<project-name>-audit-<the current date, YYYY-MM-DD>/`, where `<project-name>` is
the target project's directory name. Creating `audits/` and the dated bundle directory when absent is
permitted. If that directory already exists, append `-2`, `-3`, ... rather than overwriting or merging
into a prior audit. Every artifact this audit produces goes inside that one bundle directory,
organized per the required output bundle below; write nothing outside it. Print its absolute path at
completion.

### Goal-unclear branch

Before substantive findings, decide whether one governing project outcome can be supported by target evidence or a direct user statement.

If the goal is absent, ambiguous, or contradicted by project sources:

1. stop the audit;
2. quote or cite the concrete ambiguity or both sides of each conflict;
3. ask targeted questions that would resolve the objective and what better/worse mean; and
4. do not invent a North Star, apply a generic project goal, classify Bitter-Lesson violations, or build evals against a guessed objective.

Resume only after the user establishes enough objective clarity. If the goal is clear, continue without unnecessary questions.

## Side-effect contract

The project under audit is **read-only**. Do not modify product code, project tests, configuration, documentation, dependencies, git state, or generated outputs. Do not install dependencies into the target.

The only permitted writes are the audit report and evaluation/regression artifacts inside the audit-output directory. Build standalone checks there against the target. If a check can only work after target integration, create an unapplied patch or integration specification in the output directory and label it **NOT BUILT**; do not claim that specification satisfies the build requirement. Prefer checks that can run against the target without modifying it.

Read-only commands and existing project test/eval commands may be run when safe. Record every command and exit status. Do not perform destructive, deployment, production, credential-using, or state-mutating operations.

## Required audit outcomes

These are required output properties, not a mandated sequence of reasoning.

### 1. Establish the real desired value

Infer the project's ultimate outcome from authoritative evidence such as its stated purpose, user-facing behavior, requirements, decisions, and actual execution—not merely from filenames, task lists, architecture, or current metrics.

Deliver:

- a concise **ultimate outcome** statement;
- the evidence supporting that interpretation;
- an operational definition of **better** and **worse** in terms of the outcome; and
- any unresolved tradeoff or assumption that could change the interpretation.

A feature count, commit count, test count, velocity number, line count, model score, or completed checklist is not automatically the outcome.

### 2. Bound and cover the whole project

Define the effective corpus before claiming a full audit. By default, inventory all project-authored, behavior-affecting material, including where present:

- purpose, requirements, decisions, instructions, prompts, and documentation;
- source code and architecture boundaries;
- scripts, hooks, workflows, build/deploy/operations configuration;
- skills, agents, tools, model/provider configuration, or AI integration surfaces;
- tests, evals, regression checks, metrics, telemetry, and feedback loops;
- manifests, lockfiles, dependency/integration boundaries; and
- project-authored generated or vendored material that ships or affects behavior.

Do not read caches, dependency trees, build outputs, or third-party vendored source as though they were project-authored design. Inventory them and state why they are excluded unless they materially control behavior under audit.

Maintain a coverage ledger with one of:

- **EXAMINED** — content inspected sufficiently to support findings;
- **EXCLUDED — reason** — outside the declared authored/behavioral corpus;
- **INACCESSIBLE — reason**; or
- **UNRESOLVED — reason**.

A narrowed scope is allowed only when the user requests it. Mark all omitted surfaces as user-narrowed and do not call the result a whole-project or exhaustive audit. “Every violation” is a valid claim only when the ledger accounts for the full declared corpus.

### 3. Test component-to-goal alignment

For every supported misalignment, state:

- the component and exact project path/evidence;
- the project outcome it conflicts with;
- how it works against that outcome or pulls another component in a contradictory direction; and
- the correction direction.

Inspect cross-component contradictions, not only local flaws. If no part is supported as working against the goal, say so explicitly; do not invent findings to make the audit look comprehensive.

### 4. Ground and apply the Bitter Lesson

Fetch and read Richard Sutton's “The Bitter Lesson” in full:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

If it cannot be read, stop before making Bitter-Lesson classifications. Report the source failure and do not substitute a rubric from memory.

State two separate blocks before applying the lens:

1. **Sutton's source claims:** general methods that leverage growing computation ultimately dominate hand-engineered domain knowledge; search and learning are his central examples; built-in knowledge may help short-term yet complicate methods, plateau, and inhibit progress; meta-methods should discover/capture complexity rather than merely contain human discoveries.
2. **Project-engineering translation (derived, not Sutton's wording):** judge whether project mechanisms let stronger models or more computation perform search, learning, exploration, or adaptation, versus freezing current human assumptions into fixed methods. Iteration and outcome verification may complement scalable generation, but do not attribute those engineering terms to Sutton.

Do not force the analogy onto components with no meaningful model/compute relationship. Mark them **NOT APPLICABLE — reason** while still assessing their goal alignment and measurements.

For each Bitter-Lesson violation, report:

- the mechanism and exact evidence;
- the derived rubric point it violates;
- the human knowledge, fixed method, or current-model assumption it encodes;
- the capability and short-term benefit it currently supplies;
- why its relative value plateaus, complicates the system, or blocks scalable discovery as models/compute improve; and
- a more model/compute-flexible replacement direction.

Examine the full covered corpus. Typical shapes may include fixed taxonomies, keyword routers, magic thresholds, enumerated world knowledge, rigid procedure, provider/model assumptions, or scaffolding fitted to a weak model—but those are examples, not an exhaustive checklist or automatic violations. Do not flag a constraint merely because it is explicit; determine whether it represents an external requirement or a fixed human solution that inhibits scalable methods.

Also identify mechanisms that already provide compute-scalable discovery/adaptation and explain how their value changes with stronger models. This positive context prevents the upgrade plan from accidentally removing leverage.

### 5. Judge model-evolution flexibility

For every relevant major mechanism, state whether it is expected to:

- gain value as models or usable computation improve;
- remain approximately neutral; or
- lose relative value / become obstructive.

Name assumptions tied to present model limits. The final judgment must characterize whether the project can absorb future model improvements without redesigning around each new capability step. For non-AI projects, apply this to any AI-assisted engineering/operations harness and mark genuinely unrelated product mechanisms as not applicable rather than fabricating debt.

### 6. Define faithful measures and detect proxy drift

Inventory the measures, gates, incentives, dashboards, completion signals, and optimization loops the project currently uses **and every replacement or new measure proposed by this audit**.

For each current or proposed measure, classify and justify:

- **OUTCOME-FAITHFUL:** provides evidence about the ultimate outcome;
- **VANITY:** looks favorable or is easy to increase without demonstrating the outcome;
- **PROXY — NOT SHOWN DRIFTING:** indirectly represents the outcome, with no supported divergence yet; or
- **PROXY DRIFT:** optimization pressure or observed behavior is pulling it away from the actual outcome.

For every supported proxy-drift finding, show:

- the proxy being optimized;
- the intended outcome;
- evidence of divergence, gaming pressure, or goal displacement; and
- the corrected measurement direction or unresolved user question.

Do not call every imperfect measure “drift.” Distinguish a weak measure from evidence that optimization has already made it diverge.

### 7. Build outcome evals

Create concrete evaluation artifacts inside `<audit-output>/evals/` that operationalize the definition of better.

At minimum, build:

- an evaluation specification mapping the ultimate outcome to representative inputs/scenarios;
- the expected evidence, oracle, or judgment rule for each scenario;
- instructions and an entry point for repeating the evaluation;
- a result format that preserves individual outcomes rather than hiding them only in an aggregate; and
- at least one usable evaluation case that directly tests the real outcome rather than a vanity measure.

Use executable checks when the project permits them without target modification. For inherently qualitative outcomes, a versioned case set plus an explicit, repeatable judgment protocol is a built evaluation; vague advice or a metric wish list is not.

Run the evaluation when safe and feasible. Mark every artifact as one of:

- **BUILT AND RUN** — include command and observed result;
- **BUILT, NOT RUN** — include the concrete blocker; or
- **NOT BUILT** — incomplete, with what remains.

Do not claim AF-11-equivalent completion if all artifacts are merely proposed.

### 8. Build early-warning regression checks

Create concrete regression artifacts inside `<audit-output>/regressions/`.

They must:

- record an explicit baseline or explain why a trustworthy baseline cannot yet be captured;
- rerun or compare outcome-faithful evals over time;
- identify what deterioration they detect and what they do not detect;
- state false-warning risks and how a reviewer should resolve them;
- define the repeat trigger or command; and
- surface degradation before reliance on informal user experience alone.

Run them when safe and feasible and record the result. A generic “run the test suite” recommendation is insufficient unless the existing suite is shown to test the ultimate outcome. Avoid ungrounded thresholds: derive any decision boundary from target evidence, user tolerance, or evaluator behavior and document the rationale.

### 9. Produce a comprehensive upgrade plan

Map every component-to-goal misalignment, Bitter-Lesson violation, measure-fidelity defect, missing eval/regression capability, and proxy-drift finding to:

- the finding(s) addressed;
- the proposed change or adaptive replacement direction;
- the existing capability that must be preserved;
- the outcome-faithful eval/regression evidence that would show the change is better and has not regressed that capability; and
- an explicit blocker when no defensible change can yet be specified.

The plan must cover the full finding set. Do not remove a mechanism solely because it looks overengineered if its capability has no protected replacement. Improve and ratchet outcomes, not a favored implementation.

## Report readability contract

This audit's output is read by people who do not know this project, this doctrine, or this vocabulary. The report must be understandable to a reader with only a high-level grasp of the subject.

This constrains **communication, not rigor**. It never licenses padding, hedging, or repetition: prefer the shortest wording a non-expert can act on, state each thing once, and cross-reference instead of restating. Detailed **and** succinct — length must be earned by content, never spent on ceremony.

### Open with a plain-language executive summary

Begin `project-audit-report.md` with a summary a non-expert can read in about two minutes:

- **What this is** — what was audited and what the project is supposed to achieve, in one or two sentences.
- **Bottom line** — the single most important conclusion.
- **What's wrong** — the most important findings, ordered by importance rather than by ID, one plain sentence each.
- **What to do** — the recommended actions in priority order.
- **What happens if nothing changes** — the concrete cost of inaction.
- **What's still unknown** — open questions or limits that could change the recommendation.

Use no finding ID, undefined term, or internal shorthand in this summary.

### Make every finding decision-ready

For each finding, in addition to the evidence obligations above, state plainly:

- **What it is** — one non-expert sentence, before any quotation or technical detail.
- **Why it matters** — the outcome at stake, not the rule it breaks.
- **If fixed** — the benefit, plus its cost, effort, or risk.
- **If not fixed** — the specific consequence, roughly when it would surface, and how the reader would notice it. When the honest answer is "little or nothing," say so and rank the finding low rather than inflating it.
- **Priority** — how much this matters relative to the other findings, and on what basis.

Never leave a reader to infer the cost of inaction from a finding's existence.

### Define the vocabulary where it is used

Define every domain term, doctrine term, classification, and status label in plain language at first use — including terms this prompt introduces (for example _proxy drift_, _vanity measure_, _outcome-faithful_). A reader must not need this prompt, or any other document, to understand a verdict.

### Make tables serve the reader

Precede or follow every table with prose saying what it shows and what the reader should conclude from it. A grid of IDs, classifications, or statuses without interpretation is raw data, not a finding. Keep tables narrow enough to read comfortably; put supporting detail in prose rather than widening columns.

### Keep the upgrade plan standalone

The comprehensive upgrade plan must be understandable on its own, without first reading the findings sections. For each proposed change state: what changes, why, what currently-working capability must survive it, what improves, what it costs, and what happens if it is skipped. Show concrete before/after detail wherever specific text or configuration is being changed.

### Rigor is preserved

Structured verification blocks, ledgers, coverage states, status labels, and traceability tables remain exactly as specified above. Readability requirements wrap them; they never replace, soften, or omit an honest negative status.

## Required output bundle

Write only inside the audit-output directory:

1. **`project-audit-report.md`** containing:
   - a plain-language executive summary per the readability contract;
   - the caller's additional details verbatim and how each was applied, deferred, or refused (or `None supplied`);
   - ultimate outcome and definition of better/worse;
   - effective-corpus definition and coverage ledger;
   - component-to-goal misalignments;
   - Sutton source summary and labeled project-engineering translation;
   - Bitter-Lesson violations and scalable mechanisms;
   - model-evolution flexibility judgment;
   - measure-fidelity and proxy-drift analysis;
   - eval and regression artifact status/results;
   - comprehensive upgrade plan; and
   - unresolved questions and limitations.
2. **`evals/`** containing the built evaluation specification, cases, entry point/instructions, and results when run.
3. **`regressions/`** containing the baseline, repeatable comparison/check, instructions, and results when run.
4. **`artifact-manifest.md`** listing every created file and every command executed.

Do not create empty placeholder files. If the goal-unclear or source-unavailable branch stops the audit, ask/report in the response and do not fabricate a completed bundle.

## Completion and verification

After drafting, re-check every finding against its cited project evidence and verify the output bundle. End `project-audit-report.md` with this exact structured block:

```text
VERIFICATION:
- AF-01 Desired-value criterion: PASS / FAIL — [evidence]
- AF-02 Objective legibility and elicitation: PASS / FAIL — [evidence or branch]
- AF-03 Component-to-objective alignment: PASS / FAIL — [evidence]
- AF-04 Audit coverage boundary: PASS / FAIL — [coverage counts and limitations]
- AF-05 Doctrine-to-domain translation: PASS / FAIL — [source-read evidence]
- AF-06 Compute-scalable meta-method leverage: PASS / FAIL — [evidence]
- AF-07 Built-in human-knowledge constraint: PASS / FAIL — [evidence]
- AF-08 Model-evolution flexibility: PASS / FAIL — [evidence]
- AF-09 Upgrade-plan completeness: PASS / FAIL — [finding-to-plan mapping]
- AF-10 Measure fidelity: PASS / FAIL — [evidence]
- AF-11 Evaluation embodiment: PASS / FAIL — [built artifact paths and run status]
- AF-12 Regression early warning: PASS / FAIL — [baseline/check paths and run status]
- AF-13 Optimized-proxy drift: PASS / FAIL — [findings or supported empty result]
- AF-14 Report readability: PASS / FAIL — [executive summary present; every finding states if-fixed, if-not-fixed, and priority; terms defined at first use; tables interpreted]
- Caller additional details recorded verbatim and honored without waiving any audit obligation: YES / NO / N-A — [evidence]
- All declared corpus surfaces accounted for: YES / NO — [notes]
- Every finding re-verified against cited evidence: YES / NO — [notes]
- Target project remained unmodified: YES / NO — [baseline/comparison evidence]
- Overall audit complete: YES / NO — [unmet items]
```

“PASS” means the attribute's required output exists and is supported; it does **not** mean the project has no findings. If any required attribute fails, any declared corpus surface is unaccounted for, evals/regressions are only proposed, or the target changed, do not claim complete success. Report exactly what was achieved and what remains.
