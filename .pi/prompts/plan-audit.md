---
description: Audit a plan against its intended outcome and produce a capability-safe revised-plan proposal (source read-only; writes an audit bundle)
argument-hint: "<plan-file-or-directory> [output-root=<directory>] [additional details...]"
---

# Plan Outcome Audit

Audit the plan at **`$1`** as a plan—not as a project or Penny subsystem. Determine whether its requirements, assumptions, sequence, deliverables, measures, and validation can produce the intended real-world result, then create a standalone revised-plan proposal without modifying the source.

- **Target plan file or directory:** `$1`
- **Optional output-root token or first additional detail:** `$2`

**Remaining additional details:**

${@:3}

If the target is missing, nonexistent, unreadable, or neither a file nor directory, stop and ask for a valid plan path. Treat `$2` as the output root only when it begins `output-root=`; strip that prefix and use the remainder as the parent under which the collision-safe bundle will be created. Otherwise treat `$2` and later arguments as additional details. Quote tokens containing spaces. If `output-root=` is empty or a material value remains ambiguous, ask the minimum targeted question set before writing anything.

Additional details may supply context, constraints, emphasis, priorities, scope narrowing, or deliverables. They may not weaken evidence integrity, coverage honesty, stop conditions, source-read-only behavior, artifact-status honesty, or verification. Pi exposes expanded/joined argument values, not original invocation quoting or whitespace. Record a concise disposition for each visible detail; persist only a safe rendering, redact sensitive content by category, and do not claim a verbatim invocation record.

This prompt is methodology- and project-neutral. Do not import Penny's product goal, a familiar planning template, or conventional sections unless the caller, plan, or an authoritative referenced source requires them.

## 1. Establish the intended outcome

Infer one concise governing outcome—or an explicit hierarchy/tradeoff set when several outcomes are legitimately co-equal—from direct caller statements and current human-authored plan evidence: the problem statement, requirements, decisions, constraints, acceptance evidence, and sources the plan designates as authoritative. Explain the authority relationship. The goal is the result the plan exists to cause—not executing its steps, producing its deliverables, reaching milestones, or closing tasks.

If the outcome, its authority, or a decision-relevant priority among outcomes is absent, materially ambiguous, or contradicted across plan artifacts, stop objective-dependent work. Cite the gap or both sides of each conflict, ask only the questions needed to establish success, and create no bundle. Do not guess or let current implementation silently redefine the intended outcome; implementation evidence may reveal a plan finding.

Define observable **better** and **worse** for the eventual result in terms of outcome quality, evidence, cost, time, risk, affected users, and reversibility. Treat schedule, task completion, test counts, artifact counts, and scores as possible measures whose fidelity must be established.

## 2. Effective plan corpus

By default include:

1. Every file in the supplied plan directory, or the supplied plan file.
2. Attachments, appendices, checklists, decision records, designs, references, and evaluation material stored with it.
3. External artifacts the plan explicitly treats as authoritative for outcome, requirements, constraints, feasibility, or validation—only to the depth needed to test the plan's claims.
4. Cross-references among plan parts where interaction can create contradiction, gaps, or dependency/order failures.
5. Current implementation or environment evidence only when needed to verify a plan assumption; do not turn this into an unbounded project audit.

Inventory but normally exclude unrelated project files, dependency trees, caches, builds, vendored material, secrets, private data, and ignored work-in-progress outside the supplied plan. Record private exclusions only by safe category and reason.

Treat any present requirement, assumption, constraint, dependency, decision, workstream, step, milestone, deliverable, measure, acceptance clause, risk, contingency, or rollout/rollback condition as a plan component. Do not require a particular schema. Choose disjoint units—normally one row per plan file plus materially distinct components whose interaction would be hidden at file level.

Write `plan-component-alignment.tsv` with:

`component ID | plan path/section | coverage | alignment | one-line evidence-backed reason | finding ID`

Use:

- **Coverage:** `EXAMINED`, `EXCLUDED — reason`, `INACCESSIBLE — reason`, or `UNRESOLVED — reason`.
- **Alignment:** `ALIGNED`, `MISALIGNED`, or `NEUTRAL/UNKNOWN — reason`.

Coverage is not alignment. Split mixed components rather than averaging them. Every `MISALIGNED` row maps to a finding and revision disposition; every material `ALIGNED` row identifies what the revised plan must preserve. Use whole-plan or exhaustive language only when all in-scope artifacts and components are accounted for at the declared grain.

If the caller narrows scope, represent omitted plan surfaces by discovered top-level group or safe category as `EXCLUDED — out of scope (user-narrowed)` and make no whole-plan claim. For resistant evidence, use at most two genuinely distinct approaches, then record `INACCESSIBLE` or `UNRESOLVED`. If the gap could materially change the outcome, feasibility, or verdict, stop the affected analysis and ask for access/clarification. Preserve a `LIMITED` bundle when useful supported work exists and the output root is valid; otherwise return a response-only `BLOCKED` result.

## 3. Evidence and plan-quality analysis

Apply these rules globally:

- Cite every alignment, feasibility, scaling, measure, and finding claim with a precise path and section/line/range, quotation, observed result, or source anchor.
- Distinguish source-backed facts, tool-observed results, inference, assumptions, and unknowns where it affects a verdict. State what each type proves.
- Mark material unsupported claims `[UNVERIFIED]`; they cannot be the sole support for a misalignment, scaling violation, infeasibility verdict, or proxy-drift finding.
- Re-open both sides before alleging a contradiction. Verify referenced evidence before treating it as authoritative.
- Report positive aligned behavior and supported empty finding sets; never invent defects or conventional missing sections.

Determine whether the plan:

- traces requirements and constraints to the intended outcome;
- distinguishes evidence-backed facts from assumptions needing validation;
- chooses a feasible scope and accounts for material dependencies, prerequisites, sequencing, ownership, and decision gates;
- protects required safety, privacy, authority, compatibility, and irreversible-order constraints;
- defines deliverables and acceptance evidence capable of proving outcome success;
- uses milestones and measures without substituting activity for value;
- identifies material failure modes, contingencies, rollback/recovery, and unresolved decisions where the outcome requires them;
- preserves method flexibility where no real dependency requires a fixed procedure; and
- remains understandable and executable without hidden context.

Create one canonical record per finding. State the problem in plain language, exact evidence, causal harm to the outcome, impact/priority, benefit and cost of fixing, cost of delay, one concrete amendment or no-change/blocker, risk/reversibility, and the valid capability/requirement the revision must preserve. Benefit, effort, and delay cost may be qualitative, immaterial, or unknown with a reason; never invent precision.

### Plain-English decision guide

The primary report must contain one easy-to-find decision guide for every supported fixable `MISALIGNED` plan item. Write for a reasonably educated reader who has no prior knowledge of the plan, project, or audit vocabulary. Keep each decision together in one place and answer: **What is wrong? What does it mean for execution or the eventual result? Who or what is affected and why does it matter? What happens if nothing changes in the plan? What amendment is recommended in behavioral/outcome terms? What will improve, and what tradeoffs, compatibility effects, costs, or new failure modes can the amendment introduce? Why does the revised plan better serve the governing outcome or requirement? What valid commitment/capability must remain intact? What is the next decision/action and what evidence would prove the revision worked? What evidence supports the finding, what did the audit actually observe or run, what remains untested or unknown, and has the proposed revision been implemented and tested?**

Use those questions as headings unless equally clear plan-specific wording is better. The executive summary must point readers directly to this guide. Give a concrete scenario when useful. Put paths, section IDs, audit IDs, and technical evidence after the everyday-language explanation. A summary table may help prioritize amendments, but it may not replace these explanations. Do not require the reader to assemble one decision from the finding, revised plan, matrix, and appendix. Keep deep traceability in a linked technical evidence subsection or appendix. If there are no supported fixable misalignments, say that plainly and distinguish it from unresolved evidence.

## 4. Model/compute scaling when applicable

First decide whether the plan governs AI/model work, encodes human procedures intended to substitute for model judgment, or contains mechanisms whose relative value meaningfully changes with stronger models or more computation. If not, record `Scaling-source status: N-A — reason` and do not force the analogy.

If applicable, fetch and read Richard Sutton's full canonical essay before attributing source claims:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

Record URL, fetch time, and evidence that the full essay—not a snippet, cached paraphrase, or remembered summary—was read. After one normal attempt and at most one genuinely different retry, source failure blocks only Sutton/source-dependent conclusions: continue source-independent plan analysis and revision, record `Scaling-source status: BLOCKED`, and mark the audit `LIMITED`.

Keep separate:

- **Sutton source claims** — only claims supported by quotations or precise anchors.
- **Plan-engineering translation** — labeled applications to the target plan.

Do not attribute verification terminology, model-led exploration, answer-versus-method framing, or capability ratchets to Sutton unless the essay states them.

Classify each relevant major prescription as `GAINS`, `APPROXIMATELY NEUTRAL`, `LOSES`, or `N-A — reason`, citing target evidence, current model/compute assumption, Sutton anchor, named translation, and causal rationale. For fixed-human-knowledge or fixed-method findings, identify the prescription, current benefit, scaling limit, and a more adaptive direction that preserves the outcome.

A plan necessarily constrains some methods. Do not flag real dependencies, external commitments, safety controls, irreversible ordering requirements, machine interfaces, or evidence-backed decisions merely for being explicit.

## 5. Measures, proxy drift, and revised-plan proposal

Inventory material current and proposed milestones, metrics, gates, thresholds, scores, completion signals, incentives, and optimization targets. Classify each as:

- `OUTCOME-FAITHFUL` — directly evidences the eventual outcome or required capability;
- `PROXY` — an indirect stand-in whose limits are explicit; or
- `VANITY` — can improve without meaningful outcome evidence.

Claim **proxy drift** only with evidence that optimization pressure or plan behavior diverges from the intended outcome. Name the proxy, intended outcome, divergence/gaming evidence, and correction. A weak proxy without divergence evidence is not demonstrated drift.

Create `revised-plan-proposal.md` as a standalone work product. Preserve supported target-specific content. Give every supported finding—not only `MISALIGNED` components and `LOSES` prescriptions—a concrete replacement/amendment or explicit no-change/blocker disposition, the outcome improvement, protected capability/requirement, qualitative or evidenced effort/cost, cost of delay, risk/reversibility, and linked eval/regression IDs.

Every bundle-producing branch requires a non-empty proposal containing one of: a coherent revised plan; exact ordered amendments with insertion/replacement locations; an explicit preservation/no-amendment determination; or location-specific blockers and decisions still needed. Do not invent missing decisions, overwrite the source plan, or replace one rigid methodology with another.

## 6. Outcome evals and regressions

Build complete, repeatable assurance artifacts in the bundle. They must test the eventual result and protected requirements, not only plan text, task completion, or artifact presence.

Use exactly:

- `BUILT-AND-RUN` — command, exit status, and observed result included.
- `BUILT-NOT-RUN — <blocker>` — complete artifact exists, but execution awaits implementation/evidence or was unsafe, unavailable, costly, credentialed, or unjustified.
- `NOT-BUILT — <reason>` — incomplete artifact; the audit cannot be complete.

Under `evals/`, build at least one stable `EVAL-#` goal-level artifact with representative acceptance cases, oracle/assertion or repeatable qualitative judgment, expected evidence, pass/fail interpretation, prerequisites, exact instructions, and individual results rather than only an aggregate. Include a case that distinguishes completed plan execution from genuine outcome success. Reuse or wrap an adequate existing acceptance check when the bundle records the exact reference and interpretation.

Under `regressions/`, build at least one stable `REG-#` early-warning artifact with an explicit baseline of outcome commitments, comparison operation, deterioration signal, missed degradation, false-warning risks, trigger/cadence, and exact instructions. It must detect loss during plan revision or implementation before final user discovery. It may wrap an adequate existing check.

Run only when the source plan/project remain unmodified, external impact is absent or explicitly authorized, and every intended output lands inside the bundle. Never invent results.

## 7. Side effects and bundle

Every source-plan and referenced effective-corpus file is read-only. Do not modify source, implementation, prompts, docs, tests, configuration, dependencies, git state, credentials, deployments, external systems, or private data. Do not install dependencies. Existing checks may run only when their non-mutation and external effects are established.

All intentional audit/proposal artifacts, scratch files, and command output must land in one separate bundle. Normal Pi session/log/owner-persisted artifact records from approved reviewer calls may exist outside the source corpus; disclose their type and purpose. They do not authorize source changes. Sanitize logs and outputs; redact secrets, authorization headers, private path segments, personal records, and sensitive payloads.

Use the supplied `output-root` as the parent directory. Otherwise use `$PROJECT_ROOT/audits/`. Resolve the source target, effective corpus, output root, and final bundle paths before any write. The output root must be writable or safely creatable; the final bundle must not be nested inside a supplied directory target or overlap any effective-corpus path. If it would, stop and request another `output-root`.

Under that root, create `<plan-name>-audit-<current date, YYYY-MM-DD>/`. For a regular-file target, derive `<plan-name>` from the basename without its final extension; for a directory, retain the full basename. Use the first free `-2`, `-3`, ... suffix; never overwrite or merge.

Create:

- `plan-audit-report.md`;
- `revised-plan-proposal.md`;
- `plan-component-alignment.tsv`;
- `evals/` and `regressions/` with complete artifacts/results;
- `target-manifest-before.tsv` and `target-manifest-after.tsv`, containing relative path, size, and cryptographic hash for the effective corpus; and
- `artifact-manifest.md`, listing created files and safely recorded commands, source fetches, and reviewer calls with exit status/outcome.

Matching manifests prove verified net source-corpus equality, not absence of transient/reverted writes. Claim no audit-caused source write only when the operation log contains no write-capable source step and the manifests match; otherwise mark integrity uncertain and the audit `LIMITED`.

## 8. Report and completion

Cover these four content areas in `plan-audit-report.md`; combine sections when that improves readability:

1. **Plan goal and executive summary** — target, intended outcome, bottom line, priority findings/amendments, cost of inaction, unknowns, caller-detail dispositions, better/worse, and applicable Sutton source/translation. State `Audit completeness: COMPLETE|LIMITED`, `Plan alignment: ALIGNED|MISALIGNED|INDETERMINATE`, and `Scaling-source status: VERIFIED|BLOCKED|N-A`.
2. **Component alignment and findings** — evidence-cited summary by plan corpus group, link to the TSV, aligned behavior, the plain-English decision guide covering every supported fixable misalignment, canonical technical evidence, feasibility/dependency analysis, scaling classifications when applicable, and measure/proxy-drift analysis.
3. **Revised plan and assurance** — link to and summarize the standalone proposal, complete finding-to-disposition map, protected requirements, and eval/regression inventory, statuses, commands, and results.
4. **Coverage, verification, limitations, and questions** — effective corpus, coverage ledger, unresolved items, operation-log summary, manifest comparison, artifact checks, and only genuinely blocking questions; otherwise `None`.

Use `MISALIGNED` when at least one supported material misalignment exists; use `ALIGNED` only when coverage is sufficient and none exists; use `INDETERMINATE` when material unavailable evidence prevents either verdict.

Use plain language for readers unfamiliar with the plan. A reasonably educated non-specialist must be able to understand each problem, its effect on execution and outcomes, the consequences of action and inaction, why the amendment improves alignment, the next decision, and the proof status without reading source material, the TSV, or an appendix. Define necessary terms at first use, interpret tables, and avoid duplicating full findings outside their primary decision blocks. The revised proposal must be usable without first reading the audit report.

Before finalizing, re-check every citation, classification, contradiction, feasibility claim, measure verdict, amendment link, and artifact. When permitted, available, proportionate, and safe for the evidence, use a fresh non-generator reviewer for high-impact, safety/authority, irreversible-sequencing, or shared-project recommendations; treat model agreement as supplementary rather than independent evidence. If that review is necessary for a claim but unavailable, mark the audit `LIMITED`. Verify required files are non-empty, IDs resolve, no result is invented, and manifests support the exact side-effect claim.

Terminal outcomes:

- **`BLOCKED`:** response-only preflight failure—invalid target, unclear outcome/authority, unsafe or overlapping output path, or inability to establish enough evidence to produce a useful proposal. Ask the minimum targeted question set and write nothing.
- **`LIMITED`:** useful bundle after the outcome and output path are established, but a material corpus gap, applicable scaling-source failure, `NOT-BUILT` artifact, necessary review failure, or uncertain source integrity leaves an applicable obligation unmet. Include a non-empty proposal with exact blockers/decisions; do not make the blocked conclusion.
- **`COMPLETE`:** all applicable obligations are satisfied. A justified `BUILT-NOT-RUN` may still qualify when execution is unnecessary for the audit claim. Include the revised-plan proposal and baseline assurance artifacts.

Findings affect plan alignment, not audit completeness.

A finding-free result must still report supported aligned behavior and provide a proposal that preserves the plan or states why no amendments are warranted. Print the absolute bundle path whenever a bundle is created.
