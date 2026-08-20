---
description: Bitter Lesson alignment audit of a skill — goal, for/against, violations, upgrade plan
argument-hint: "<skill-name> [additional details...]"
---

# Bitter Lesson Skill Audit

Perform a Bitter Lesson alignment audit of the **$1** skill. Determine its actual ultimate goal, what works for and against that goal, how its mechanisms scale with stronger models and greater computation, every supported Bitter Lesson violation, and a capability-preserving upgrade plan.

If the skill name argument is missing, or `.pi/skills/$1/` does not exist, stop and ask which skill to audit before doing anything else.

## Additional details (optional)

**Additional details:** `${@:2}`

Additional details are caller-supplied context and requirements this audit cannot infer from the skill itself: background, constraints, known history, emphasis, or extra deliverables. When they are empty, run exactly as if none were supplied; their absence is never a blocker.

Honor them wherever they do not conflict with this prompt's own obligations. They may add requirements, supply context, set emphasis or priority, and request additional analysis. They may **not** waive or weaken the evidence, `[UNVERIFIED]`, and anti-fabrication rules, the coverage ledger's bounds on exhaustive claims, the side-effect and evidence contract, the terminal branch conditions, or any required artifact, status-honesty, or completion obligation.

A detail that narrows scope is treated as a scope narrowing: mark the omitted surfaces `EXCLUDED` as user-narrowed in the coverage ledger and make no exhaustive claim. A detail that only sets emphasis does not shrink the declared corpus.

If a detail conflicts with an obligation above, or is too ambiguous to apply, report it — and ask when it blocks the audit — rather than silently following or silently ignoring it. Record the details verbatim in the report together with how each was applied, deferred, or refused.

## Output location

Write every artifact this audit produces into one bundle directory at
`$PROJECT_ROOT/audits/$1-audit-<the current date, YYYY-MM-DD>/`, organized per the required output
bundle below. Creating `audits/` and the dated bundle directory when absent is permitted. If that
directory already exists, append `-2`, `-3`, ... rather than overwriting or merging into a prior
audit. Print its absolute path at completion.

## Side-effect and evidence contract

This is an **analysis-and-plan-only audit of a read-only target**. The audit bundle directory is the
sole write location; the skill under audit is never modified.

- **Read:** Read the declared corpus and direct dependencies, fetch the Sutton essay, and inspect repository metadata needed to establish coverage and target non-modification.
- **Execute:** Run only read-only inspection commands. Existing tests or evals may run only when their commands and outputs cannot modify the repository, external systems, credentials, deployments, or durable state; record the command, environment assumptions, exit status, and output evidence. Otherwise do not run them and state the blocker. Newly authored artifacts may be run only when execution is read-only with respect to the target and every output lands inside the bundle directory; otherwise state the blocker.
- **Create/modify/delete:** Create, modify, or delete no repository or external-system file or state outside the current bundle directory. In particular, do not change `.pi/skills/$1/`, `apps/orchestration/`, or direct dependencies, and do not apply proposed upgrades. Build newly designed eval/regression artifacts as real files inside the bundle directory.
- Every claim about behavior must cite a specific file and passage or code location. Mark anything not confirmed as `[UNVERIFIED]`; an `[UNVERIFIED]` claim cannot be the sole support for a misalignment, violation, or demonstrated proxy-drift finding.
- Do not audit other skills except where the `$1` skill directly depends on them. Keep findings about `apps/orchestration/` in a clearly separated shared-framework subsection because changes there can affect every skill.
- Keep exhaustive claims bounded by the coverage evidence defined below.

For any eval or regression artifact, report exactly one honest status:

- **BUILT-AND-RUN** — the complete artifact exists and the exact defined check was run, with cited results.
- **BUILT-NOT-RUN** — the complete, copy-ready artifact exists in the bundle, but was not run; state the exact blocker.
- **NOT-BUILT** — the definition is incomplete or absent; state the blocker. This status does not satisfy the minimum eval/regression requirement.

An artifact counts as built only when the bundle contains its final literal code, configuration, fixtures, case definitions, or mechanically enactable qualitative protocol plus everything required to run it without inventing missing rules or criteria. A recommendation, outline, pseudocode sketch, placeholder, empty file, or future-work note is merely proposed and is not built.

## Phase 1 — Ground and separate the doctrine

Fetch and read Richard Sutton’s “The Bitter Lesson” in full:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

If the essay cannot be fetched and read in full, say so and stop. Do not audit against a rubric reconstructed from memory.

Before applying the doctrine, present the rubric in two explicitly separate blocks:

### Sutton source claims

State the relevant claims supported by the essay, using quotations or precise passage references. Include Sutton’s treatment of:

- general methods that leverage computation;
- search and learning as central examples;
- discovering and capturing complexity through scalable methods rather than storing human discoveries in the system; and
- the long-run limitations of building human domain knowledge into methods.

Do not attribute terminology or claims to Sutton that the essay does not support.

### Skill-engineering translation

Label this block **“Domain translation — not Sutton’s wording.”** Explain how the source claims apply to AI skill prompts, orchestration, gates, templates, configuration, and supporting code.

The translation may consider model-led exploration, iteration, evidence checks, and verification as engineering adaptations, but must label them as adaptations rather than Sutton’s terminology. Verification may complement scalable generation; it must not be presented as a source claim from the essay.

Every Bitter Lesson violation reported later must cite both the relevant source-rubric point and the domain translation it applies.

## Phase 2 — Establish the effective corpus and objective

Resolve every repository path below relative to the repository root. Read the following before making substantive findings:

- Every file discovered under `.pi/skills/$1/`, including `SKILL.md`, `README.md`, scripts, prompts, assets, resources, templates, and configuration.
- The shared TypeScript orchestration framework under `apps/orchestration/`, to the depth needed to understand how this skill’s phases, gates, agents, retries, state, and outputs actually execute.
- Any other skill or component directly imported, invoked, or explicitly required by `$1`, but not unrelated skills or merely transitive dependencies.

Produce a **coverage ledger** with one row for every discovered skill file and every other relevant surface. Mark each row as:

- **EXAMINED** — inspected to sufficient depth for the claims made;
- **EXCLUDED** — outside the direct-dependency boundary, with the reason;
- **INACCESSIBLE** — could not be read, with the attempted path and failure;
- **UNRESOLVED** — relevance or coverage could not be determined.

State the effective corpus and every scope limitation. Use “every,” “all,” “exhaustive,” or equivalent wording only when the ledger supports it. If inaccessible or unresolved evidence could materially change the goal or verdict, take the **Corpus-blocked** path below. If it cannot materially change the conclusion, continue only with an explicitly narrowed verdict that names what remains unknown.

From authoritative skill evidence, infer the ultimate goal as the user-visible outcome the skill exists to produce—not its phase list, artifacts, implementation, output count, or current metrics. Inspect goal statements, prompts, documentation, interfaces, examples, tests, completion criteria, and actual orchestration behavior for agreement or contradiction.

Inventory during this phase:

- the skill’s major mechanisms and components;
- current measures, gates, incentives, completion signals, and optimization loops;
- model- or compute-dependent assumptions; and
- capabilities currently supplied by fixed procedures or built-in human knowledge.

## Terminal branch conditions

After Phase 2, choose exactly one terminal path:

### Corpus blocked

If an **INACCESSIBLE** or **UNRESOLVED** surface could materially change the inferred goal or audit verdict, stop substantive assessment. Return only:

- the Sutton source claims and domain translation;
- the effective-corpus statement and coverage ledger;
- the exact access/relevance blocker and attempted evidence collection;
- what conclusions the missing surface prevents; and
- targeted questions or access requests needed to resume.

Do not claim a completed verdict or build evals against a materially incomplete objective/corpus.

### Goal unclear

If a single ultimate goal is absent, ambiguous, or contradicted by material components, stop substantive assessment after Phase 2. Return only:

- the Sutton source claims and domain translation;
- the coverage ledger;
- the conflicting or insufficient goal evidence; and
- targeted questions, each tied to a specific ambiguity and cited evidence.

Do not guess a goal, define better/worse, issue findings, or construct an upgrade plan around an invented objective.

### Fully aligned

Use this branch only when the effective corpus is sufficiently complete and the evidence supports empty strategic-misalignment and Bitter Lesson violation sets **and no target improvement is warranted**.

State exactly:

**“Everything reviewed is pulling in the same direction, and no Bitter Lesson violations or improvements are warranted.”**

Then deliver every applicable required report section below. Report **Working AGAINST**, **Bitter Lesson violations**, and **Upgrade plan** as explicitly empty; still provide positive findings, scaling and measure/proxy ledgers, complete outcome eval and regression artifacts in the bundle, traceability, limitations, and non-modification evidence so the conclusion remains testable. Do not invent defects for appearance’s sake.

### Otherwise

Deliver every required report section below.

## Report readability contract

This audit's output is read by people who do not know this skill, this doctrine, or this vocabulary. The report must be understandable to a reader with only a high-level grasp of the subject.

This constrains **communication, not rigor**. It never licenses padding, hedging, or repetition: prefer the shortest wording a non-expert can act on, state each thing once, and cross-reference instead of restating. Detailed **and** succinct — length must be earned by content, never spent on ceremony.

### Open with a plain-language executive summary

Begin `skill-audit-report.md` with a summary a non-expert can read in about two minutes, placed before the additional-details record and doctrine blocks:

- **What this is** — what was audited and what the skill is supposed to achieve, in one or two sentences.
- **Bottom line** — the single most important conclusion.
- **What's wrong** — the most important findings, ordered by importance rather than by ID, one plain sentence each.
- **What to do** — the recommended actions in priority order.
- **What happens if nothing changes** — the concrete cost of inaction.
- **What's still unknown** — open questions or limits that could change the recommendation.

Use no finding ID, undefined term, or internal shorthand in this summary.

### Make every finding decision-ready

For each `AG-#`, `BL-#`, and drift finding, in addition to the evidence obligations above, state plainly:

- **What it is** — one non-expert sentence, before any quotation or technical detail.
- **Why it matters** — the outcome at stake, not the rule it breaks.
- **If fixed** — the benefit, plus its cost, effort, or risk.
- **If not fixed** — the specific consequence, roughly when it would surface, and how the reader would notice it. When the honest answer is "little or nothing," say so and rank the finding low rather than inflating it.
- **Priority** — how much this matters relative to the other findings, and on what basis.

Never leave a reader to infer the cost of inaction from a finding's existence.

### Define the vocabulary where it is used

Define every domain term, doctrine term, classification, and status label in plain language at first use — including terms this prompt introduces (for example _proxy drift_, _vanity measure_, _outcome-faithful_, _LOSES RELATIVE VALUE_). A reader must not need this prompt, or any other document, to understand a verdict.

### Make tables serve the reader

Precede or follow every table and ledger with prose saying what it shows and what the reader should conclude from it. A grid of IDs, classifications, or statuses without interpretation is raw data, not a finding. Keep tables narrow enough to read comfortably; put supporting detail in prose rather than widening columns.

### Keep the upgrade plan standalone

Section 5's upgrade plan must be understandable on its own, without first reading sections 2–4. For each `PLAN-#` state: what changes, why, what currently-working capability must survive it, what improves, what it costs, and what happens if it is skipped. Show concrete before/after wording wherever specific skill text is being changed.

### Rigor is preserved

Structured ledgers, coverage states, status labels, `[UNVERIFIED]` marks, and traceability tables remain exactly as specified above. Readability requirements wrap them; they never replace, soften, or omit an honest negative status.

## Required audit report

Write these sections into `skill-audit-report.md` in the bundle directory. Begin with the plain-language executive summary required by the readability contract, then the caller's additional details verbatim and how each was applied, deferred, or refused (or `None supplied`), then the Sutton source-claims block, domain-translation block, effective-corpus statement, and coverage ledger. Then provide these sections.

### 1. Inferred ultimate goal and desired-value criterion

In one or two evidence-backed paragraphs, state the outcome the skill ultimately exists to produce.

Define observable **better** and **worse** relative to that outcome. These definitions must describe meaningful outcome improvement or deterioration, not more completed phases, files, checks, scores, or other implementation activity. Cite the target or user evidence supporting both the goal and the better/worse interpretation.

If current metrics are being used as evidence of success, treat their fidelity as an open question until assessed below.

### 2. Working FOR the goal

List each supported positive alignment. For every item:

- assign a stable `FOR-#` identifier;
- name the mechanism or component;
- cite its file and passage/code;
- explain causally how it advances the inferred goal; and
- state any capability that a future change must preserve.

Include positive mechanisms even when no changes are warranted.

### 3. Working AGAINST the goal

List each supported strategic misalignment. For every item:

- assign a stable `AG-#` identifier;
- name the friction, contradiction, or component mismatch;
- cite the file and passage/code;
- explain causally how it harms the goal or contradicts another component;
- state the direction of a fix; and
- map it to an Upgrade plan item or an explicit blocker/no-change disposition.

Misalignment between prompts, orchestrator behavior, gates, templates, configuration, documentation, and actual completion criteria counts. Do not create findings unsupported by evidence.

### 4. Bitter Lesson violations

Examine every covered component for hand-engineered domain knowledge or fixed procedural scaffolding that may help today but plateau, complicate the system, or obstruct methods that can exploit stronger models or additional computation.

For every supported violation:

- assign a stable `BL-#` identifier;
- name the mechanism and cite its file and passage/code;
- identify the built-in knowledge, heuristic, threshold, keyword list, mandated procedure, or rigid structure;
- cite the relevant Sutton source-rubric point and domain translation;
- state the capability and short-term benefit it currently supplies;
- explain why its relative value is likely to plateau or become obstructive as models or compute improve;
- propose a more scalable direction that preserves the capability; and
- map it to an Upgrade plan item or explicit blocker/no-change disposition.

Do not classify every explicit constraint, safety check, machine interface, deterministic requirement, or instance of complexity as a violation. The finding must establish a fixed ceiling or obstruction relative to a feasible scalable alternative.

Be exhaustive only within the effective corpus supported by the coverage ledger. Cover prompts, orchestration, gates, templates, configuration, and direct dependencies where relevant.

### 5. Upgrade plan

Provide a comprehensive, prioritized plan. Every `AG-#` and `BL-#` finding must map to exactly one or more plan items or an explicit blocker/no-change disposition; no finding may be orphaned.

For every plan item, include:

- stable `PLAN-#` identifier;
- mapped `AG-#` and `BL-#` findings;
- proposed replacement or change, preferring scalable search, learning, model-led exploration, verified iteration, and evidence checks where appropriate;
- the capability and current benefit that must not regress;
- linked `EVAL-#` artifact IDs proving that capability and the real outcome;
- linked regression artifact IDs providing early warning;
- affected scope and any shared-framework blast radius;
- risk level with rationale;
- whether and how the change is reversible; and
- any blocker, accepted no-change decision, or unresolved dependency.

Order the plan so the highest-leverage, lowest-risk changes come first. Keep changes to `apps/orchestration/` in a separate shared-framework subsection.

### 6. Model/compute scaling ledger

Classify every relevant major mechanism as:

- **GAINS VALUE**;
- **APPROXIMATELY NEUTRAL**;
- **LOSES RELATIVE VALUE**; or
- **NOT APPLICABLE**, with a concrete reason no model/compute relationship exists.

For every mechanism, provide:

- component and evidence;
- current-model or current-compute assumptions;
- classification and causal rationale;
- whether the rationale comes from Sutton’s source claims or from the labeled domain translation; and
- any related `AG-#`, `BL-#`, or `PLAN-#` identifiers.

The ledger must assess both violating and non-violating mechanisms. It must explicitly consider search, learning, discovery/capture of complexity, fixed human discoveries, and relevant domain adaptations. A **LOSES RELATIVE VALUE** classification that is not made a finding requires an explicit no-change reason.

### 7. Measure fidelity and optimized-proxy drift

Create a measure ledger covering all current and proposed:

- metrics;
- gates;
- incentives;
- completion signals;
- scoring or prioritization rules; and
- optimization or feedback loops.

For each, state:

- source or proposed plan item;
- the intended connection to the inferred goal;
- classification as **OUTCOME-FAITHFUL**, **PROXY**, or **VANITY**;
- evidence supporting that classification;
- what the measure captures and misses; and
- whether to retain, replace, contextualize, or reject it.

A retained or proposed measure must have a defensible connection to observable better/worse. Do not allow implementation activity or output volume to stand in for the actual outcome without evidence.

Then report proxy-drift findings separately. A demonstrated drift finding must identify:

- the proxy;
- the intended outcome;
- evidence of divergence, gaming pressure, or optimization against the proxy at the outcome’s expense; and
- a correction or unresolved question mapped to the plan.

Do not label every weak or imperfect proxy as demonstrated drift. If no divergence evidence exists, state that the drift finding set is empty and distinguish that conclusion from unresolved measure weakness.

### 8. Evaluation artifacts

Build at least one complete, repeatable evaluation artifact under `evals/` in the bundle that tests the real inferred outcome, and reference it from the report by ID and relative path. Add enough artifacts to verify every capability protected by the Upgrade plan.

For each `EVAL-#`, include:

- purpose and links to the goal, protected capabilities, findings, and plan items;
- artifact form and complete copy-ready contents—code, configuration, fixtures, case definitions, or a mechanically enactable qualitative protocol;
- exact inputs, scenarios, prerequisites, and setup;
- an oracle, scoring rubric, or judgment rule;
- expected evidence and output format;
- exact execution instructions from a clean checkout, directing all runtime output inside the bundle directory and never into the audited source;
- at least one case that directly tests the real outcome rather than prompt conformance, file presence, or phase completion;
- limitations, likely judgment uncertainty, and missing coverage;
- honest status: **BUILT-AND-RUN**, **BUILT-NOT-RUN**, or **NOT-BUILT**;
- run evidence and results when actually run, otherwise the precise blocker.

For qualitative outcomes, provide a repeatable judgment protocol with fixed evidence inputs, assessor instructions, decision rules, and disagreement handling. “Ask a reviewer whether it is good” is not an artifact.

At least one eval must be complete and have **BUILT-NOT-RUN** or **BUILT-AND-RUN** status. Do not claim a result for an unrun artifact.

### 9. Regression artifacts

Build at least one complete early-warning regression artifact under `regressions/` in the bundle, tied to the inferred goal and protected capabilities, and reference it from the report by ID and relative path. It must be capable of exposing deterioration before the system relies on informal user discovery.

For each `REG-#`, include:

- goal, capability, finding, plan, and eval links;
- complete copy-ready artifact contents or repeatable comparison protocol;
- an explicit, reproducibly identifiable baseline and how it is obtained;
- candidate inputs and comparison procedure;
- the exact deterioration signal and decision rule;
- what degradation the check detects;
- important degradation it will miss;
- false-warning risks and how they should be interpreted;
- trigger or cadence and exact execution instructions;
- expected evidence and output format;
- current baseline/comparison results when available;
- honest status: **BUILT-AND-RUN**, **BUILT-NOT-RUN**, or **NOT-BUILT**;
- the exact blocker when not run.

A future recommendation to “add regression tests” is not sufficient. At least one regression artifact must be complete and have **BUILT-NOT-RUN** or **BUILT-AND-RUN** status.

### 10. Traceability and completion evidence

End with:

1. A traceability ledger mapping every `AG-#`, `BL-#`, and **LOSES RELATIVE VALUE** mechanism to:
   - a `PLAN-#` or explicit blocker/no-change disposition;
   - protected capability;
   - one or more `EVAL-#` artifacts; and
   - one or more `REG-#` artifacts.
2. A list of all `[UNVERIFIED]`, inaccessible, and unresolved items and how they limit the verdict.
3. A target-side-effect attestation with two evidence sources: (a) an operation log showing that every audit command complied with the read/execute/write contract, and (b) before/after read-only content manifests for every file in the declared target corpus, including path, size, and cryptographic content hash. Report differences and distinguish pre-existing state from audit-caused changes. Describe matching manifests only as **verified net content equality**; they do not prove that no transient or reverted write occurred. Claim no audit-caused write only when the operation log contains no write-capable step and the manifests match. Otherwise label that claim `[UNVERIFIED]`. Optionally add repository-status evidence only if it can be obtained without writing or refreshing repository metadata.
4. A semantic completion check confirming:
   - the actual outcome and observable better/worse are evidence-backed;
   - the unclear-goal branch would stop rather than guess;
   - all supported misalignments are causal and empty findings remain allowed;
   - the effective corpus and scope limitations bound completeness claims;
   - Sutton’s claims are separated from the domain translation;
   - scalable methods, built-in human knowledge, and discovery/capture of complexity were assessed;
   - every relevant major mechanism received a scaling classification;
   - every finding maps to a change or explicit disposition;
   - current and proposed measures were tested for outcome fidelity;
   - at least one complete real-outcome eval artifact exists in the bundle;
   - at least one complete baseline-based regression artifact exists in the bundle;
   - false-warning and missed-degradation risks are disclosed;
   - proxy drift is claimed only with divergence or gaming-pressure evidence;
   - caller additional details were recorded verbatim and each was applied, deferred, or refused with a stated reason, without waiving any audit obligation;
   - the report satisfies the readability contract — executive summary present, every finding states if-fixed / if-not-fixed / priority, terms defined at first use, tables interpreted, and the upgrade plan readable standalone; and
   - the operation log and content manifests support the target-side-effect attestation without overstating what they prove.

If any required full-audit item is missing, state that the audit is incomplete and name the blocker rather than claiming completion.

A framework-complete audit is not the same as a finding-free target. Conversely, a supported finding-free result is legitimate and must not be padded with invented defects.

## Required output bundle

Write only inside the audit bundle directory, organized as:

1. **`skill-audit-report.md`** containing every required report section 1–10 above.
2. **`evals/`** containing the built evaluation specification, cases, fixtures, entry point/instructions, and results when run.
3. **`regressions/`** containing the baseline, repeatable check, instructions, and results when run.
4. **`artifact-manifest.md`** listing every created file and every command executed, with exit status.

Do not create empty placeholder files. If the missing-target, source-unavailable, corpus-blocked, or goal-unclear branch stops the audit, ask/report in the response and do not fabricate a bundle.

## Done when

Completion is exactly one of these mutually exclusive outcomes:

1. **Missing/invalid target:** the prompt stopped before other work and asked for a valid skill name.
2. **Sutton source unavailable:** the prompt reported that the essay could not be fetched and read in full, then stopped without a Bitter Lesson verdict.
3. **Corpus blocked:** the prompt returned exactly the blocker response required by the **Corpus blocked** branch, without a completed verdict.
4. **Goal unclear:** the prompt returned exactly the evidence-cited interview required by the **Goal unclear** branch, without guessed better/worse criteria, findings, evals, or plan.
5. **Full audit — fully aligned or findings present:**
   - the Sutton source rubric and domain translation are present and source-faithful;
   - the effective corpus and coverage ledger support the scope of all claims;
   - the goal is evidence-backed and observable better/worse are defined;
   - the **Working FOR**, **Working AGAINST**, **Bitter Lesson violations**, and **Upgrade plan** sections are complete or explicitly and legitimately empty;
   - all major mechanisms, current and proposed measures, proxies, findings, and plan items are traceable;
   - complete bundle eval and regression artifacts meet the required status contract;
   - risk, reversibility, capability preservation, limitations, and `[UNVERIFIED]` claims are reported honestly;
   - any caller additional details are recorded verbatim with their disposition, and none waived an audit obligation; and
   - the operation log and content manifests support an accurately bounded target-side-effect attestation; and
   - the absolute path of the audit bundle directory was printed.
