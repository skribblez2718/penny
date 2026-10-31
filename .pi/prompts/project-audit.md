---
description: Audit any project against its own outcome, evidence, measures, and model-scaling risks (target read-only; writes an audit bundle)
argument-hint: "<project-path> [output-root=<directory>] [additional details...]"
---

# Project Outcome Audit

Audit the project at **`$1`** against the outcome it actually exists to produce. This command is for an arbitrary project; use `/harness-audit` for Penny itself and `/skill-audit` for one Penny skill.

- **Target project:** `$1`
- **Optional output-root token or first additional detail:** `$2`

**Remaining additional details:**

${@:3}

If the target is missing, nonexistent, unreadable, or not a project directory, stop and ask for a valid path. Treat `$2` as the output root only when it begins `output-root=`; strip that prefix and use the remainder as the parent under which the collision-safe bundle will be created. Otherwise treat `$2` and later arguments as additional details. Quote tokens containing spaces. If `output-root=` is empty or a material value remains ambiguous, ask the minimum targeted question set before writing anything.

Additional details may supply context, constraints, emphasis, priorities, scope narrowing, or deliverables. They may not weaken evidence integrity, coverage honesty, stop conditions, target-read-only behavior, artifact-status honesty, or verification. Pi exposes expanded/joined argument values, not original invocation quoting or whitespace. Record a concise disposition for each visible detail; persist only a safe rendering, redact sensitive content by category, and do not claim a verbatim invocation record.

## 1. Establish the project's outcome

Derive one concise governing user-visible or real-world outcome—or an explicit hierarchy/tradeoff set when several outcomes are legitimately co-equal—from direct caller statements and current human-authored project evidence: purpose/requirements, product behavior, decisions, interfaces, and governing documentation. Explain the authority relationship. Human-authored intent does not become true runtime behavior merely because it is documented, and implementation drift does not silently redefine the goal.

If the goal, its authority, or a decision-relevant priority among outcomes is absent, materially ambiguous, or contradicted, stop objective-dependent work. Cite the gap or both sides of the conflict, ask only the questions needed to establish the outcome, and create no bundle. Do not infer a business model, persona, success criterion, or generic project goal.

Define observable **better** and **worse** in terms of the real outcome, evidence, reliability, effort, risk, and affected users—not feature count, tasks closed, files produced, test count, schedule, model score, or other activity unless evidence establishes it as outcome-faithful.

## 2. Effective corpus and classification

Inventory the live project-authored, behavior-affecting tree. Adapt the corpus to the project's technology and purpose while normally covering, where present:

- purpose, requirements, decisions, interfaces, examples, and documentation;
- source, architecture, scripts, hooks, workflows, and build/deploy/operations configuration;
- tests, evals, regressions, metrics, telemetry, feedback, and optimization loops;
- AI agents, prompts, models/providers, skills, tools, memory, orchestration, or automation;
- manifests, lockfiles, dependencies, integration boundaries, and shipped generated assets; and
- dead, deprecated, placeholder, contradictory, unreachable, or non-functioning project-authored material.

Inventory but normally exclude dependency trees, caches, local builds, vendored source, secrets, personal/private data, and ignored work-in-progress. Record private exclusions only by safe category and reason. Include a dependency or generated artifact only when it materially controls current behavior; state the boundary.

Choose disjoint, reproducible component units appropriate to the target—for example one package, service, application, prompt/agent/skill, top-level source or script subsystem, documentation tree, workflow, or configuration group. Classify each once and record cross-cutting relationships separately.

For every unit, write to `project-component-alignment.tsv`:

`component ID | component/path(s) | coverage | alignment | one-line evidence-backed reason | finding ID`

Use:

- **Coverage:** `EXAMINED`, `EXCLUDED — reason`, `INACCESSIBLE — reason`, or `UNRESOLVED — reason`.
- **Alignment:** `ALIGNED`, `MISALIGNED`, or `NEUTRAL/UNKNOWN — reason`.

Coverage is not alignment. Split mixed units rather than averaging them. Missing optional machinery is not a defect unless an authoritative requirement makes its absence harmful. Every `MISALIGNED` row maps to a finding and plan disposition; every material `ALIGNED` row names the capability to preserve. Claim whole-project or exhaustive coverage only when every in-scope unit is accounted for at the declared component grain.

If the caller narrows scope, represent omitted authored surfaces by discovered top-level group or safe category as `EXCLUDED — out of scope (user-narrowed)` and make no whole-project claim. For resistant evidence, use at most two genuinely distinct approaches, then record `INACCESSIBLE` or `UNRESOLVED`. If the gap could materially change the goal or verdict, stop the affected analysis and ask for access/clarification. Preserve a `LIMITED` bundle when useful supported work exists and the output root is valid; otherwise return a response-only `BLOCKED` result.

## 3. Evidence and findings

Apply these rules globally:

- Cite every behavioral, alignment, scaling, measure, and finding claim with a precise path and line/range, symbol, executed result, or source anchor.
- Distinguish source-backed facts, tool-observed results, inference, assumptions, and unknowns where it affects a verdict. State what each evidence type proves.
- Mark material unsupported claims `[UNVERIFIED]`; they cannot be the sole support for a misalignment, scaling violation, or proxy-drift finding.
- Documents prove stated intent, tests prove only exercised behavior, and static checks prove only encoded rules.
- Re-open both sides before alleging a contradiction and confirm references/execution paths before calling material dead.
- Report positive aligned behavior and supported empty finding sets; never manufacture defects.

Create one canonical record per finding. State the problem in plain language, exact evidence, causal harm to the project outcome, impact/priority, benefit and cost of fixing, cost of delay, one concrete change or no-change/blocker, risk/reversibility, and the working capability that must not regress. Benefit, effort, and delay cost may be qualitative, immaterial, or unknown with a reason; never invent precision.

### Plain-English decision guide

The primary report must contain one easy-to-find decision guide for every supported fixable `MISALIGNED` item. Write for a reasonably educated reader who has no prior knowledge of the project, its code, or the audit vocabulary. Keep each decision together in one place and answer: **What is wrong? What does it mean in normal operation? Who or what is affected and why does it matter? What happens if nothing changes? What behavioral change is recommended? What will improve, and what tradeoffs, compatibility effects, costs, or new failure modes can the change introduce? Why does the change better serve the project’s governing outcome? What working capability must remain intact? What is the next decision/action and what evidence would prove the fix worked? What evidence supports the finding, what did the audit actually run, what remains untested or unknown, and has the proposed fix been implemented and tested?**

Use those questions as headings unless equally clear project-specific wording is better. The executive summary must point readers directly to this guide. Give a concrete scenario when it improves understanding. Put paths, symbols, IDs, and test references after the everyday-language explanation. A summary table may help prioritize work, but it may not replace these explanations. Do not force readers to assemble a decision from separate finding, plan, matrix, and appendix sections. Deep traceability belongs in a linked technical evidence subsection or appendix. If there are no supported fixable misalignments, state that plainly and distinguish it from unexamined or unresolved areas.

## 4. Model/compute scaling when applicable

First decide whether the target contains AI/model behavior, human-coded procedures intended to substitute for model judgment, or mechanisms whose relative value meaningfully changes with stronger models or more computation. If not, record `Scaling-source status: N-A — reason` and do not force the analogy.

If applicable, fetch and read Richard Sutton's full canonical essay before attributing source claims:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

Record URL, fetch time, and evidence that the full essay—not a snippet, cached paraphrase, or remembered summary—was read. After one normal attempt and at most one genuinely different retry, source failure blocks only Sutton/source-dependent conclusions: continue source-independent project analysis, record `Scaling-source status: BLOCKED`, and mark the audit `LIMITED`.

Keep separate:

- **Sutton source claims** — only claims supported by quotations or precise anchors.
- **Project-engineering translation** — labeled applications to this target.

Do not attribute verification terminology, model-led exploration, answer-versus-method framing, or capability ratchets to Sutton unless the essay states them.

Classify every relevant major mechanism as `GAINS`, `APPROXIMATELY NEUTRAL`, `LOSES`, or `N-A — reason`, with the model/compute assumption, target evidence, Sutton anchor, named translation, causal rationale, and action/protection. For fixed-human-knowledge or fixed-method findings, identify the encoded knowledge/procedure, current benefit, scaling limit, and a capability-preserving alternative. Do not flag safety controls, external requirements, machine interfaces, or deterministic consequence boundaries merely because they constrain behavior.

## 5. Measures, proxy drift, and capability-safe plan

Inventory material current and proposed metrics, gates, thresholds, scores, completion signals, incentives, and optimization targets. Classify each as:

- `OUTCOME-FAITHFUL` — directly evidences the project outcome or protected capability;
- `PROXY` — an indirect stand-in whose limits are explicit; or
- `VANITY` — can improve without meaningful outcome evidence.

Claim **proxy drift** only with evidence that optimization pressure or observed behavior diverges from the intended outcome. Name the proxy, intended outcome, divergence/gaming evidence, and correction. A weak proxy alone is not demonstrated drift. Scrutinize measures proposed by the audit too.

Produce a self-contained capability-safe improvement plan in the report. Map every supported finding—including each `MISALIGNED` component and `LOSES` mechanism—to a concrete change or explicit no-change reason, outcome improvement, protected capability, qualitative or evidenced effort/cost, cost of delay, risk/reversibility, and linked eval/regression IDs. One plan item may address several findings; none may be orphaned.

## 6. Outcome evals and regressions

Build complete, repeatable assurance artifacts in the bundle. They must test the real project outcome and protected capabilities rather than file presence, task completion, or implementation shape.

Use exactly:

- `BUILT-AND-RUN` — command, exit status, and observed result included.
- `BUILT-NOT-RUN — <blocker>` — complete artifact exists, but execution was unsafe, unavailable, costly, credentialed, or unjustified.
- `NOT-BUILT — <reason>` — incomplete artifact; the audit cannot be complete.

Under `evals/`, build at least one stable `EVAL-#` goal-level artifact with representative cases, oracle/assertion or repeatable qualitative judgment, expected evidence, pass/fail interpretation, prerequisites, exact instructions, and individual results rather than only an aggregate. Include a case that can distinguish completed work from genuine outcome success. Reuse or wrap an adequate existing check when the bundle records the exact target reference and interpretation.

Under `regressions/`, build at least one stable `REG-#` early-warning artifact with an explicit baseline, comparison operation, deterioration signal, missed degradation, false-warning risks, trigger/cadence, and exact instructions. It may wrap an adequate existing check. Shared artifacts may cover multiple findings; avoid ceremonial one-file-per-finding checks.

Run only when the target remains unmodified, external impact is absent or explicitly authorized, and every intended output lands inside the bundle. Never invent results.

## 7. Side effects and bundle

The target project is read-only. Do not create or modify anything within its resolved directory tree, including source, prompts, docs, tests, configuration, dependencies, git state, credentials, deployments, or audit output. Do not install dependencies or mutate external systems/private data. Existing checks may run only when their non-mutation and external effects are established.

All intentional audit artifacts, scratch files, and command output must land in one external bundle. Normal Pi session/log/owner-persisted artifact records from approved reviewer calls may exist outside the target; disclose their type and purpose. They do not authorize target changes. Sanitize all logs and outputs; redact secrets, authorization headers, private path segments, personal records, and sensitive payloads.

Use the supplied `output-root` as the parent directory. Otherwise use `$PROJECT_ROOT/audits/`. Resolve the target, output root, and final bundle paths before any write. The output root must be writable or safely creatable and must not be inside the target; if the default or supplied root overlaps the target, stop and request an external `output-root`.

Under that root, derive `<project-name>-audit-<current date, YYYY-MM-DD>/` from the target directory basename. Use the first free `-2`, `-3`, ... suffix; never overwrite or merge.

Create:

- `project-audit-report.md`;
- `project-component-alignment.tsv`;
- `evals/` and `regressions/` with complete artifacts/results;
- `target-manifest-before.tsv` and `target-manifest-after.tsv`, containing relative path, size, and cryptographic hash for the effective corpus; and
- `artifact-manifest.md`, listing created files and safely recorded commands, source fetches, and reviewer calls with exit status/outcome.

Matching manifests prove verified net target-content equality, not absence of transient/reverted writes. Claim no audit-caused target write only when the operation log contains no write-capable target step and the manifests match; otherwise mark integrity uncertain and the audit `LIMITED`.

## 8. Report and completion

Cover these four content areas in `project-audit-report.md`; combine sections when that improves readability:

1. **Project goal and executive summary** — target, purpose, bottom line, priority findings/actions, cost of inaction, unknowns, caller-detail dispositions, better/worse, and applicable Sutton source/translation. State `Audit completeness: COMPLETE|LIMITED`, `Target alignment: ALIGNED|MISALIGNED|INDETERMINATE`, and `Scaling-source status: VERIFIED|BLOCKED|N-A`.
2. **Component alignment and findings** — evidence-cited summary by corpus group, link to the TSV, aligned behavior, the plain-English decision guide covering every supported fixable misalignment, canonical technical evidence, scaling classifications when applicable, and measure/proxy-drift analysis.
3. **Capability-safe plan and assurance** — the self-contained improvement plan plus eval/regression inventory, statuses, commands, and observed results.
4. **Coverage, verification, limitations, and questions** — effective corpus, coverage ledger, unresolved items, operation-log summary, manifest comparison, artifact checks, and only genuinely blocking questions; otherwise `None`.

Use `MISALIGNED` when at least one supported material misalignment exists; use `ALIGNED` only when coverage is sufficient and none exists; use `INDETERMINATE` when material unavailable evidence prevents either verdict.

Use plain language for readers unfamiliar with the project. A reasonably educated non-specialist must be able to understand each problem, its meaning for normal operation, the consequences of action and inaction, the alignment improvement, the next decision, and the proof status without reading source code, the TSV, or an appendix. Define necessary terms at first use, interpret tables, and avoid duplicating full findings outside their primary decision blocks.

Before finalizing, re-check every citation, classification, contradiction, measure verdict, plan link, and artifact. When permitted, available, proportionate, and safe for the evidence, use a fresh non-generator reviewer for high-impact, shared-boundary, security/authority, or otherwise consequential recommendations; treat model agreement as supplementary rather than independent evidence. If that review is necessary for a claim but unavailable, mark the audit `LIMITED`. Verify required files are non-empty, IDs resolve, no result is invented, and manifests support the exact side-effect claim.

Terminal outcomes:

- **`BLOCKED`:** response-only preflight failure—invalid target, unclear goal/authority, unsafe or overlapping output path, or inability to establish enough evidence to produce a useful bundle. Ask the minimum targeted question set and write nothing.
- **`LIMITED`:** useful bundle after the goal and output path are established, but a material corpus gap, applicable scaling-source failure, `NOT-BUILT` artifact, necessary review failure, or uncertain target integrity leaves an applicable obligation unmet. Do not make the blocked conclusion.
- **`COMPLETE`:** all applicable obligations are satisfied. A justified `BUILT-NOT-RUN` may still qualify when execution is unnecessary for the audit claim.

Findings affect target alignment, not audit completeness.

A finding-free result must still preserve supported aligned behavior and include baseline eval/regression artifacts. Print the absolute bundle path whenever a bundle is created.
