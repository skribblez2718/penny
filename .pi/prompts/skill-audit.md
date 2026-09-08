---
description: Audit one Penny skill against its local outcome, Penny's purpose, and model-scaling doctrine (target read-only; writes an audit bundle)
argument-hint: "<skill-name> [additional details...]"
---

# Penny Skill Audit

Audit the Penny skill named **`$1`**. Determine whether its complete package and direct execution path produce the intended user-visible outcome, support Penny's broader purpose, and remain trustworthy and adaptable as models improve. Recommend changes only when evidence supports them, and preserve every capability that already works.

Additional details (optional): `${@:2}`

## 1. Inputs and stopping rules

`$1` must be the basename of a discovered directory under `.pi/skills/`, not a path, pattern, or value containing separators or `..`. If it is missing, invalid, nonexistent, or ambiguous, stop and ask for one valid skill name. Do not create a bundle.

Additional details may add context, emphasis, priorities, or deliverables. They may not weaken evidence rules, coverage honesty, stop conditions, target-read-only behavior, artifact-status honesty, or verification. A detail that narrows scope must be reflected as user-narrowed coverage; emphasis alone does not narrow scope. Record the expanded detail text exactly as received by this template and state how it was applied, deferred, or refused. Ask a targeted question only when an unresolved detail would materially change the goal, scope, authority, or safety.

Use this broader project purpose as the parent constraint:

> **Penny is a general-purpose personal AI assistant on Pi that turns a user's cross-domain goals into accurate, evidence-grounded progress and useful outcomes, using the simplest appropriate mode—direct work, focused delegation, or durable resumable workflows—while keeping permissions and consequential actions under user and runtime control.**

Infer the audited skill's **local goal** from current human-authored skill evidence: `SKILL.md`, README, prompt/resource assets, public tool description, contracts, examples, and applicable governing docs. Express it as the user-visible outcome—not phases, files, scores, or implementation activity—and explain how it contributes to Penny's parent purpose.

If one local goal is absent, materially ambiguous, or contradicted by authoritative skill sources, stop before findings. Cite the conflicting or insufficient evidence, ask only the questions needed to establish the goal, and create no bundle. Do not let tests or current implementation silently override human-authored intent; ordinary implementation drift is a finding, not a goal-authority conflict.

Define observable **better** and **worse** for the skill in terms of outcome quality, evidence, reliability, effort, risk, and user control. Current metrics are possible evidence, not automatically the objective.

## 2. Effective corpus

Audit the skill package and only the dependencies needed to understand its real execution:

1. Every file under `.pi/skills/$1/`.
2. Its active registration, playbook, contracts, flow description, gates, budgets, repair/recovery paths, and tests under `apps/orchestration/`.
3. Skill-extension discovery, ingress, composition, artifact delivery, and tests directly governing this skill.
4. Every agent role, tool, child skill, prompt layer, configuration value, schema, script, or document the skill directly invokes or explicitly depends on.
5. Existing tests, evals, regression checks, measures, and completion signals that claim to protect the skill's outcome.
6. Current repository state needed to determine whether the skill is available, disabled, candidate-only, stale, or contradicted by documentation.

Do not expand into unrelated skills or whole-harness review. If a shared mechanism affects the audited skill, inspect only the relevant path and label any resulting issue **SHARED-FRAMEWORK** with its blast radius; otherwise label it **SKILL-OWNED**.

Inventory dependencies, generated output, caches, private data, and vendor trees but exclude them unless they materially govern current behavior. Record private exclusions only by safe category and reason, never by sensitive filename or content. Never inspect or reproduce credentials or personal memory content.

For every discovered skill file and every direct dependency unit, record:

- **Coverage:** `EXAMINED`, `EXCLUDED — reason`, `INACCESSIBLE — reason`, or `UNRESOLVED — reason`.
- **Alignment:** `ALIGNED`, `MISALIGNED`, or `NEUTRAL/UNKNOWN — reason`.

Write the complete matrix to `skill-component-alignment.tsv` with:

`component ID | ownership | component/path(s) | coverage | alignment | one-line evidence-backed reason | finding ID`

Coverage is not alignment. Split materially mixed components rather than averaging them. Missing optional machinery is not a defect unless an authoritative contract requires it. Every `MISALIGNED` row must map to a finding and plan disposition; every material `ALIGNED` row must name the capability to preserve. Use exhaustive wording only when the ledger accounts for the full effective corpus.

For a resistant source or dependency, use at most two genuinely distinct attempts or approaches. Then record the attempts and classify it `INACCESSIBLE` or `UNRESOLVED`. If the missing evidence could materially change the local goal or verdict, stop, report the blocker and targeted access question in the response, and create no bundle.

## 3. What to assess

Apply these evidence rules globally:

- Cite every behavioral, alignment, scaling, measure, and finding claim with a precise path and line/range, symbol, test, command result, or source anchor that can be re-checked.
- Distinguish source-backed facts, tool-observed results, inference, assumptions, and unknowns where it affects a verdict. State what each evidence type does and does not prove.
- Mark materially unsupported claims `[UNVERIFIED]`. They may describe a limitation but cannot be the sole support for a misalignment, scaling violation, or proxy-drift finding.

Assess outcomes and interfaces rather than rewarding architectural ceremony. At minimum determine whether:

- the manifest, README, tool description, prompts/resources, runtime registration, and actual completion contract agree on the local goal;
- every phase or mechanism earns its complexity and contributes causally to the outcome;
- tool authority, agent roles, prompt layers, exact artifact handoff, and host-private boundaries match current Penny contracts;
- evidence and completion gates can distinguish genuine success from plausible-looking output;
- retries change strategy, budgets end honestly, interruptions resume correctly, and blocked/high-consequence work escalates appropriately where applicable;
- outputs are complete, usable, and delivered through the declared interface;
- optional services fail honestly without becoming hidden workflow dependencies;
- docs and examples describe current availability and behavior;
- tests/evals exercise the user-visible outcome rather than only schemas, phases, or file presence; and
- shared-framework behavior has a demonstrated effect on the named skill, with existing evidence and the plausible wider blast radius stated separately. Do not claim absence of cross-skill regressions without broader evidence.

Classify each supported finding against the applicable outcome dimensions:

- **Local outcome** — usefulness and fitness for the skill's own goal.
- **Grounded trust** — evidence, verification, honest limits, and resistance to fabrication.
- **Execution fitness** — appropriate complexity, reliability, durability, and recovery.
- **Controlled consequences** — permissions, private data, and user/runtime authority.
- **Adaptability** — model/provider portability and value as models or usable computation improve.

A domain-specific criterion inside Domain Guidance is not drift merely because it is specialized. A safety control, external requirement, machine interface, or deterministic consequence boundary is not method debt merely because it constrains behavior.

## 4. Bitter-Lesson and model-scaling analysis

Before attributing claims to Richard Sutton or issuing a completed Bitter-Lesson verdict, fetch and read the full canonical essay:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

Record the URL, fetch time, and evidence that the full essay—not a snippet, excerpt, remembered summary, or local doctrine file—was read. If it cannot be verified as complete after one normal attempt and at most one genuinely different retry, omit Sutton claims and the completed source-dependent verdict. Continue only the source-independent skill audit, record the limitation, and mark the audit incomplete. Do not repeat a failed approach without new information.

Keep two explicit blocks:

- **Sutton source claims** — only claims supported by the essay, with short quotations or precise anchors.
- **Skill-engineering translation** — clearly labeled applications to skill prompts, orchestration, search, learning, verification, and model-led work.

Do not attribute Penny's answer-versus-method distinction, verification vocabulary, model-led exploration, or capability ratchet to Sutton unless the essay states them.

For every relevant major mechanism, classify scaling as `GAINS`, `APPROXIMATELY NEUTRAL`, `LOSES`, or `N-A — reason`. State the current model/compute assumption, evidence, causal rationale, and required action or capability protection.

Every fixed-method/Bitter-Lesson finding and every `LOSES` classification must cite three things separately: the exact target evidence, a specific Sutton quotation or source anchor, and the named skill-engineering translation being applied.

For each fixed-human-knowledge or fixed-method finding, identify the encoded knowledge/procedure, its current benefit, why its relative value plateaus or obstructs stronger models, and a more scalable direction that preserves the capability. Do not manufacture violations from explicit structure alone.

## 5. Findings, measures, and plan

Create one canonical record per finding with a stable ID. State:

- `SKILL-OWNED` or `SHARED-FRAMEWORK` and the exact evidence;
- what the problem is and how it causally harms the local goal, Penny's parent purpose, or an authoritative contract;
- affected outcome dimension(s);
- whether it constrains the **answer/outcome**, prescribes the **method**, or is `N-A — reason`;
- impact and priority relative to other findings;
- the benefit, effort, cost, and risk of fixing it;
- what happens if it is not fixed and how that would be noticed;
- one concrete change or explicit blocker/no-change/accepted-debt disposition; and
- the working capability that must not regress.

### Plain-English decision guide

The primary report must contain one easy-to-find decision guide for every supported fixable `MISALIGNED` item. Write for a reasonably educated reader who has no prior knowledge of the skill, Penny internals, or audit vocabulary. Keep each decision together in one place and answer: **What is wrong? What does it mean in normal use? Who or what is affected and why does it matter? What happens if nothing changes? What behavioral change is recommended? What will improve, and what tradeoffs, compatibility effects, cross-skill consequences, costs, or new failure modes can the change introduce? Why does the change better serve the skill’s local goal and Penny’s parent purpose? What working capability must remain intact? What is the next decision/action and what evidence would prove the fix worked? What evidence supports the finding, what did the audit actually run, what remains untested or unknown, and has the proposed fix been implemented and tested?**

Use those questions as headings unless equally clear skill-specific wording is better. The executive summary must point readers directly to this guide. Give a concrete user or maintainer scenario when useful. Put paths, symbols, IDs, and tests after the everyday-language explanation. A summary table may help prioritize work, but it may not replace these explanations. Do not force the reader to assemble a decision from finding, plan, matrix, and appendix sections. Put deep traceability in a linked technical evidence subsection or appendix. If there are no supported fixable misalignments, state that plainly and distinguish it from unexamined or unresolved areas.

Report positive aligned behavior and supported empty finding sets. Do not duplicate full findings across secondary tables; use IDs and cross-references while retaining one complete human decision block per item.

Inventory material current and proposed measures—metrics, gates, thresholds, scores, completion signals, incentives, and optimization targets that influence acceptance or behavior. Classify each as `OUTCOME-FAITHFUL`, `PROXY`, or `VANITY`, with the link to observable better/worse and the measure's limits. Do not treat every test assertion as a separate measure.

Claim **proxy drift** only with evidence that optimization pressure or observed behavior diverges from the intended outcome. Name the proxy, intended outcome, divergence/gaming evidence, and correction. A weak proxy without divergence evidence is not demonstrated drift.

Produce a standalone capability-safe plan. Every `MISALIGNED` component and every `LOSES` mechanism must map to a concrete change or explicit no-change reason, the outcome improvement, protected capability, effort/cost, cost of delay, risk/reversibility, and linked eval/regression IDs. Keep shared-framework changes separate and state their cross-skill blast radius. No finding may be orphaned.

## 6. Outcome evals and regressions

Build concrete, repeatable assurance artifacts in the bundle. They protect the local outcome and working capabilities, not exact wording, phase count, or implementation shape.

Use exactly:

- `BUILT-AND-RUN` — include command, exit status, and observed result.
- `BUILT-NOT-RUN — <blocker>` — complete artifact exists, but execution was unsafe, unavailable, costly, credentialed, or unjustified.
- `NOT-BUILT — <reason>` — incomplete artifact; the audit cannot be complete.

Under `evals/`, build at least one goal-level eval with a stable `EVAL-#` ID, representative inputs, an oracle/assertion or repeatable qualitative judgment rule, expected evidence, pass/fail interpretation, prerequisites, and exact execution instructions. Add or reuse enough coverage to protect every capability affected by the plan. A bundle artifact may invoke an adequate existing check when it records the exact target reference and interpretation. A recommendation, TODO, or pseudocode outline is not built.

Under `regressions/`, build at least one early-warning check with a stable `REG-#` ID, an explicit baseline, comparison operation, deterioration signal, missed degradation, false-warning risks, trigger, and exact instructions. It may wrap an adequate existing check if the bundle makes the baseline and interpretation reproducible. Shared artifacts may cover several findings; avoid ceremonial one-file-per-finding checks.

Run artifacts only when they cannot mutate the audited target or external state and every intended output lands inside the bundle. Never invent results.

## 7. Side effects and output bundle

The skill and all inspected dependencies are read-only. Do not modify source, prompts, docs, tests, configuration, dependencies, git state, credentials, deployments, external systems, or private memory. Do not install dependencies. Run existing checks only when their non-mutation and external impact are established.

Normal Pi session, log, and owner-persisted artifact records may be created by approved audit/reviewer calls outside the project tree. Disclose their type and purpose when known; they do not authorize target changes. A different model or agent is supplementary review, not independent evidence.

Sanitize every artifact and log. Redact secrets, authorization headers, personal records, sensitive prompt payloads, and private path segments. Record a redacted command shape and explain the redaction when exact input is sensitive.

Every intentional audit artifact, scratch file, and command output must land inside one new ignored bundle. The disclosed unavoidable Pi runtime records above are the only exception:

`$PROJECT_ROOT/audits/$1-audit-<current date, YYYY-MM-DD>/`

Use the first free `-2`, `-3`, ... suffix and never overwrite or merge an existing bundle. Exclude the bundle from the target corpus and manifests. Create no other project file.

The bundle contains:

- `skill-audit-report.md`;
- `skill-component-alignment.tsv`;
- `evals/` and `regressions/` with complete artifacts and results when run;
- `target-manifest-before.tsv` and `target-manifest-after.tsv`, with relative path, size, and cryptographic hash for every effective-corpus file; and
- `artifact-manifest.md`, listing created files and safely recorded commands, source fetches, and reviewer calls with exit status or observed outcome.

Capture the before manifest after input/goal preflight and before substantive assessment, and the after manifest immediately before finalizing. Matching manifests prove only verified net target-content equality, not the absence of a transient or reverted write. Claim no audit-caused target write only when the operation log contains no write-capable target step and the manifests match; otherwise mark it `[UNVERIFIED]`.

## 8. Required report and completion

Write four top-level parts in `skill-audit-report.md`:

1. **Skill goal and executive summary** — what was audited, local and parent goals, bottom line, priority issues/actions, cost of inaction, unknowns, observable better/worse, caller details/disposition, and Sutton source/translation blocks. Immediately after the summary, state:
   - **Audit completeness:** `COMPLETE`, `LIMITED`, or `BLOCKED`.
   - **Skill alignment:** `ALIGNED`, `MISALIGNED`, or `INDETERMINATE`.
   - **Scaling-source status:** `VERIFIED` or `BLOCKED`.
2. **Component alignment and findings** — one evidence-cited summary per named corpus group, link to `skill-component-alignment.tsv`, aligned behavior, the plain-English decision guide covering every supported fixable misalignment, canonical technical evidence, scaling ledger, and measure/proxy-drift ledger.
3. **Capability-safe plan and assurance** — standalone plan with shared-framework items separated, plus eval/regression inventory, status, and observed results.
4. **Coverage, verification, limitations, and questions** — effective corpus, coverage ledger, inaccessible/unresolved items, operation-log summary, manifest comparison, artifact checks, and only genuinely blocking questions; otherwise `None`.

Open with plain language suitable for a reader unfamiliar with the skill. A reasonably educated non-specialist must be able to understand each problem, its meaning for normal use, the consequences of action and inaction, why the change improves alignment, the next decision, and the proof status without reading source code, the matrix, or an appendix. Define necessary status and doctrine terms at first use, explain what tables mean, and state each fact once in its primary decision block. `LIMITED` is required when Sutton is unavailable, a non-blocking material corpus gap remains, a required reviewer is unavailable, an assurance artifact is incomplete, or target integrity is uncertain.

Before finalizing:

1. Re-open cited evidence and re-check every classification, contradiction, dead/non-functioning claim, measure verdict, plan link, and artifact.
2. Use a fresh-context reviewer other than the generator for any high-impact, shared-framework, security/authority, or Cognitive Frame recommendation; otherwise use one when it would materially improve the result. Ground consequential claims in independent evidence, not model agreement. Record reviewer identity, scope, findings, and disposition. When review is required but unavailable, deliver the bounded report as `LIMITED`.
3. Verify every required bundle file is non-empty, IDs resolve, no result is invented, manifests support the exact side-effect claim, and every finding has a disposition, capability protection, and assurance link.

Apply these terminal outcomes:

- **Missing/invalid skill or unclear local goal:** ask the targeted question and create no bundle.
- **Material corpus blocker:** report the blocker and access question in the response; create no bundle.
- **Sutton unavailable:** write a source-independent partial bundle with `Audit completeness: LIMITED` and `Scaling-source status: BLOCKED`; issue no completed Bitter-Lesson verdict.
- **Full audit, with or without findings:** write the complete bundle. Findings affect `Skill alignment`, not whether the audit contract was completed.

A finding-free audit must still report supported aligned behavior and include the baseline eval/regression artifacts. Never disguise a limitation as success. Print the bundle's absolute path whenever a bundle is created.
