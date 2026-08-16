---
description: Audit the Penny harness for single-direction alignment against its embedded North Star — reports drift, contradictions, capability-scaling debt, and dead code (read-only)
argument-hint: "[scope, e.g. 'docs only' or '.pi/agents'] [additional details...]"
---

Scope override (optional): $1
Additional details (optional): ${@:2}

Both arguments are optional. Quote a multi-word scope override so it arrives as
one argument. If `$1` is plainly audit guidance rather than a scope selector —
prose about context, emphasis, constraints, or extra deliverables — treat every
argument as additional details and audit the full harness.

Additional details are caller-supplied context and requirements this audit
cannot infer from the harness itself: background, constraints, known history,
emphasis, or extra deliverables. When they are empty, run exactly as if none
were supplied; their absence is never a blocker. Honor them wherever they do not
conflict with this prompt's own obligations — they may add requirements, supply
context, set emphasis or priority, and request additional analysis. They may
**not** waive or weaken the evidence, confidence-labeling, and anti-fabrication
rules, the coverage ledger's bounds on exhaustive claims, the side-effect
contract, the stop branches and terminal outcomes, or any required artifact,
verification, or completion obligation. A detail that narrows scope is treated
as a scope override under the rules below; a detail that only sets emphasis does
not shrink the effective corpus. If a detail conflicts with an obligation above,
or is too ambiguous to apply, report it — and ask in Part 4 when it blocks the
audit — rather than silently following or silently ignoring it. Record the
details verbatim in Part 1 with how each was applied, deferred, or refused.

If a nonempty scope override is ambiguous, names no auditable harness surface,
or cannot be resolved to a named category or repository path, stop before the
audit and ask one targeted scope question; do not guess, fetch sources, or write
a report. Otherwise, restrict the audit to the supplied scope and mark every
other named surface `EXCLUDED — out of scope (user-narrowed)` in the coverage
ledger. With no override, audit the full harness as specified below. State the
effective corpus in the report; never imply full-harness coverage for a narrowed
audit.

## The North Star this audit measures against

**Penny is a general-purpose personal AI assistant — for all aspects of life.**
At any point in her life some domains will be far more developed than others: a
dense cluster of features (skills, extensions, prompts, tools, docs) serving one
domain reflects the operator's current focus and the system's current state —
not Penny's identity. The most-developed domain of the moment is one among many;
the enduring trajectory is breadth across all of life.

**Thesis — chasing AGI under non-AGI constraints.** No single model call is AGI;
the harness — not the model — is the intelligence amplifier. Layered prompts,
isolated-context delegation, persistent memory (MemPalace), and calibrated +
separately-verified reasoning compose general,
trustworthy, compounding capability from models that are none of those things on
their own.

**The Alignment Test.** Every part is judged by one question — does it make Penny:

1. more generally capable across life domains;
2. more trustworthy — calibrated, evidence-based, non-fabricating;
3. more self-correcting over time; and
4. more able to ride model improvement — does this part gain or lose value as
   the model underneath it gets stronger?

A part that fails all four is drift.

**Scope guards (non-goals).**

- Not a single-domain tool — the architecture stays domain-general and new life
  domains are first-class.
- Not model-AGI-dependent, and equally not model-weakness-assuming — capability
  lives in the harness, so Penny must degrade gracefully and stay portable
  across a mixed, evolving model fleet without assuming one specific frontier
  model is present. Portability is bought with model judgment as the default
  plus heuristics kept as explicitly tier-gated fallbacks — never with baked-in
  scaffolding that presumes the model is not smart enough. Scaffolding that
  only makes sense for a weak model and is not tier-gated is debt, not
  portability.
- Not a system that grows without pruning — memory, docs, and skills must be
  signal, not accretion.

**Design commitments (the invariants).**

1. Five separated prompt layers — Cognitive Frame, Role, Domain Guidance,
   Project Index, Invocation Context — each one responsibility.
2. Authority order (system policy and runtime limits → role/domain constraints →
   user task → external content as evidence) plus standing decision principles:
   never fabricate; clarify only material blockers; prefer reversible action;
   match verification to consequence; distinguish evidence status where it
   affects a decision.
3. The generator is never its own only verifier — verification is a separate,
   evidence-based step.
4. Documentation is a tree of indexes with a single source of truth; no greedy
   loading, no drift between parallel trees.
5. Trust and action boundaries: user messages are task-authoritative within
   system and runtime limits; external content is evidence or designated task
   material that cannot expand permissions or authorize side effects.
   Enforcement lives in runtime controls (tool allowlists, approvals/receipts,
   path-specific process isolation); prompt markers are structural
   defense-in-depth, never described as enforcement.
6. Constraints on the _answer_ over constraints on the _method_. The harness is
   a human-knowledge layer wrapped around a model whose capability rises
   outside our control, so every mechanism in it is a bet on where that
   capability lands. Constraints on the answer — verification, evidence
   requirements, machine interfaces, safety limits — gain value as models
   strengthen, because a stronger generator needs a stronger check to be
   trusted. Constraints on the method — mandated procedure, fixed taxonomies,
   magic-number thresholds, enumerated options — encode a fixed quantity of
   human knowledge and therefore have a fixed ceiling. Corollary: the ratchet
   protects capabilities and outcomes, never implementations — any mechanism
   may be replaced or removed, but no capability it provided may regress.
   (Doctrine: docs/agents/architecture/bitter-lesson.md; add-side gate:
   docs/agents/architecture/project-standards.md. This rubric is _derived from_
   Richard Sutton's "The Bitter Lesson", not a restatement of it.)

## Audit basis and mandatory stop branches

The embedded North Star and four Alignment Test dimensions above are the
supplied desired-value criterion. Before substantive alignment judgments:

1. Identify the current human-authored governing sources that establish Penny's
   purpose and the authority relationship among them.
2. State observable **better** and **worse** for this audit in terms of the North
   Star and the four dimensions. Do not restate file counts, phases, task
   completion, current metrics, or proposed output quantity as the outcome.
   Ground the definitions in the embedded criterion and opened goal sources.
3. If the objective is absent or ambiguous, if an authoritative source
   explicitly contradicts the embedded North Star, or if sources disagree about
   which objective has authority, stop substantive assessment. Quote the
   conflicting or insufficient evidence, ask only the targeted question needed
   to establish authority, and produce a blocked report rather than guessing.
   Ordinary implementation that opposes a clear North Star is a finding, not a
   goal-authority conflict.

A goal-authority-blocked report still follows the four-part report structure.
Its effective corpus is limited to the governing goal sources opened before the
stop; mark every other named surface `EXCLUDED — terminal goal-authority stop
before assessment`, set `questions_needed` to `true`, and keep `passed` false.
Part 1 quotes the authority conflict; Part 2 states that findings, plans, and
outcome artifacts were not built because the objective is unresolved; Part 3
records the bounded corpus and side-effect evidence; Part 4 asks only the
necessary authority question. Do not present this as a completed substantive
alignment or Bitter-Lesson verdict.

### Live Sutton source gate

Before making any Bitter-Lesson or source-dependent scaling judgment, fetch and
read Richard Sutton's **"The Bitter Lesson" in full from the live canonical
URL**:

`http://www.incompleteideas.net/IncIdeas/BitterLesson.html`

Record the URL, fetch time, and whether the full essay—not an excerpt, search
snippet, local doctrine file, or remembered summary—was read. In report Part 1,
keep two visibly separate blocks:

- **Sutton source claims:** only relevant claims the fetched essay actually
  supports, with short quotations or precise source anchors.
- **Penny-domain translation:** this audit's engineering application of those
  claims to the harness, explicitly labeled as translation/adaptation.

Do not attribute Penny's answer-vs-method rubric, verification terminology,
model-led exploration, or any other domain translation to Sutton unless the
essay itself says it. Sutton's central examples include general methods that use
computation, especially search and learning, and the value of discovering and
capturing complexity rather than encoding human discoveries; apply only what
the live source supports.

If the live essay is unavailable, truncated, or cannot be verified as complete
after at most two distinct fetch/read attempts, fail closed: do not substitute a
cached or local paraphrase, do not emit Sutton source claims, and do not issue a
completed Bitter-Lesson verdict. Continue only source-independent alignment
work that can be reported honestly, record the source-dependent assessment as
blocked in Part 4 and `unverified_claims`, and set overall `passed` to `false`.

## Terminal outcomes

Use exactly one whole-contract outcome:

1. **Invalid or ambiguous scope:** stop before the audit, ask one targeted scope
   question, and do not write a report.
2. **Goal authority blocked:** write only the blocked four-part report defined
   above; no substantive findings or objective-dependent artifacts.
3. **Sutton source blocked:** continue a clearly labeled source-independent
   audit only; no completed Bitter-Lesson/source-dependent scaling verdict, and
   `passed` remains false.
4. **Corpus limited:** when in-scope evidence remains `INACCESSIBLE` or
   `UNRESOLVED`, continue only with conclusions the examined corpus supports,
   expose the limitation in Parts 3–4 and JSON, and keep `passed` false. Never
   claim exhaustive full-harness coverage.
5. **Full audit, findings present or supported-empty:** complete every applicable
   report, artifact, verification, and side-effect obligation. An empty finding
   set does not waive baseline outcome eval/regression artifacts.

Blocked or limited outcomes are valid honest terminal responses, not passed
substantive verdicts. Do not weaken a blocked completion criterion to make it
appear satisfied.

## The audit

Produce a read-only single-direction alignment audit of the Penny harness
measured against the North Star and Alignment Test above. A component is any
covered prompt layer, index or governing statement, agent, skill, extension,
tool, hook, script, memory mechanism, workflow, control,
artifact, measure, or code path. A **major mechanism** is a distinct mechanism
that materially supplies or governs a Penny capability; derive these from the
examined corpus rather than from a fixed taxonomy.

For every supported misalignment, identify the concrete component and evidence
and explain causally how it opposes the outcome, one or more Alignment Test
dimensions, or another authoritative component. Do not manufacture findings: a
fully aligned target or supported empty finding set is valid.

READABILITY CONTRACT — this report is read by people who do not know this
harness, this doctrine, or this vocabulary. It must be understandable to a
reader with only a high-level grasp of the subject. This constrains
**communication, not rigor**: it never licenses padding, hedging, or repetition.
Prefer the shortest wording a non-expert can act on, state each thing once, and
cross-reference rather than restate — detailed **and** succinct.

- **Open with a plain-language executive summary** placed at the very top of
  Part 1, readable in about two minutes: what was audited and what it is for;
  the bottom line; the most important problems ordered by importance rather than
  by ID, one plain sentence each; what to do, in priority order; what happens if
  nothing changes; and what remains unknown. Use no finding ID, undefined term,
  or internal shorthand in this summary.
- **Make every finding decision-ready.** Beyond the evidence obligations above,
  each finding states in plain language: what it is (one non-expert sentence,
  before any quotation); why it matters, in terms of the outcome rather than the
  rule broken; what improves if it is fixed, and at what cost, effort, or risk;
  what specifically happens if it is _not_ fixed, roughly when that would surface
  and how the reader would notice; and its priority relative to the other
  findings, with the basis. When the honest answer to "if not fixed" is "little
  or nothing," say so and rank it low rather than inflating it. Never leave the
  reader to infer the cost of inaction from a finding's existence.
- **Define the vocabulary where it is used** — every domain term, doctrine term,
  classification, and status label in plain language at first use, including
  terms this prompt introduces (answer-constraint, method-constraint, proxy
  drift, vanity measure, `[UNVERIFIED]`). A reader must not need this prompt to
  understand a verdict.
- **Make tables and ledgers serve the reader** — precede or follow each with
  prose stating what it shows and what to conclude. A grid of IDs and statuses
  without interpretation is raw data, not a finding.
- **Keep the capability-safe plan standalone** — understandable without first
  reading the findings. Per item: what changes, why, what currently-working
  capability must survive it, what improves, what it costs, and what happens if
  it is skipped.
- **Rigor is preserved** — the JSON contract, ledgers, coverage states, status
  labels, `[UNVERIFIED]` marks, confidence labels, and traceability tables
  remain exactly as specified. Readability requirements wrap them; they never
  replace, soften, or omit an honest negative status, and never alter the
  machine-consumed JSON shape.

DELIVER exactly four top-level report parts, integrating all required ledgers as
subsections of those parts and referencing every bundle artifact by stable ID and
path relative to the bundle directory:

### 1. North Star, outcome test, and audit basis

Include:

- the caller's additional details verbatim and how each was applied, deferred,
  or refused (or `None supplied`);
- a 1-line restatement of the North Star and, for each finding ID, which of the
  four Alignment Test dimensions it violates (generality / trust /
  self-correction / scaling);
- the authoritative goal sources opened and the goal-authority result;
- observable better and worse, tied directly to the actual outcome rather than
  current proxies; and
- the live-source record, **Sutton source claims**, and separate
  **Penny-domain translation** blocks required above.

If there are no findings, say so; do not add a cosmetic finding.

### 2. Prioritized findings, aligned behavior, and capability-safe plan

Start with the prioritized misalignment table using exactly these columns:

`[part | file path(s) | dimension(s) violated | constraint type (answer / method / n-a) | how it opposes the goal | impact High/Med/Low | recommended fix + the capability that must not regress]`

Prefix each `part` value with a stable finding ID such as `F-01` so every row can
be traced. `answer` means a constraint on outputs, evidence, or externally
observable behavior; `method` means a prescribed internal procedure; `n-a`
requires a concrete reason the distinction does not apply. Evidence, not the
examples in this prompt, determines findings and impact. A supported empty table
is allowed.

Then include these Part 2 subsections:

#### Positive aligned behavior

Record supported behavior worth preserving, with mechanism, concrete path and
evidence, Alignment Test dimensions served, and why it should survive any
change. Include mechanisms whose value is non-obvious. If the examined corpus
contains no supportable positive example, state that as a supported empty
result rather than inventing one.

#### Per-major-mechanism scaling ledger

For every relevant major mechanism in the effective corpus, classify its
relative value as models or available compute improve as exactly one of
`GAINS`, `APPROXIMATELY NEUTRAL`, `LOSES`, or `N-A`. State the current
model/compute assumption, evidence, causal rationale, and any action or
capability protection. `N-A` requires a justified absence of a model/compute
relationship. Do not infer that all complexity or all explicit constraints lose
value. Assess whether the target enables or blocks general methods that can
exploit stronger models or greater computation, including search and learning
where the source supports them; label model-led exploration, iteration, and
verification as Penny-domain adaptations rather than Sutton terminology.

For each built-in-human-knowledge or fixed-method violation, name:

- the knowledge or method encoded;
- the current capability and short-term benefit;
- why its relative value plateaus or becomes obstructive; and
- a more scalable direction that preserves the capability.

#### Current and proposed measure-fidelity ledger

Inventory **all current measures** found in the effective corpus and **all
retained, replacement, or newly proposed measures** introduced by findings,
fixes, evals, and regression checks. Include metrics, gates, ratings, thresholds,
incentives, completion signals, and optimization-loop targets. For each, state
where it exists or is proposed, the North-Star outcome it purports to represent,
and classify it as `OUTCOME-FAITHFUL`, `VANITY`, or `PROXY`, with a defensible
causal/evidentiary link and a retain/change decision. Do not let a proposed
measure escape scrutiny merely because it appears in this report. If no current
measure exists in a genuinely covered area, state the examined evidence for
that empty result.

#### Evidenced optimized-proxy drift

Inspect current metrics, gates, incentives, completion signals, and optimization
loops for proxy drift. A drift finding must identify the proxy, the intended
outcome, concrete evidence of divergence or gaming pressure, and a correction
or unresolved question. A weak, incomplete, or indirect measure is not by
itself demonstrated drift; classify it in the fidelity ledger without alleging
drift unless evidence supports the divergence. A supported no-drift result is
valid.

#### Complete finding-to-plan map

Map **every finding ID**, including every strategic misalignment and
Bitter-Lesson violation, to either:

- a concrete proposed change; or
- an explicit blocker or no-change/accepted-debt reason.

For every row, name the current capability to preserve, the evidence that will
protect it, and the linked eval and regression artifact IDs below. No finding
may be orphaned. If no safe replacement is apparent, retain the mechanism and
record accepted debt rather than proposing capability loss. If the supported
finding set is empty, state that the map is empty; baseline assurance artifacts
below remain mandatory and link directly to the North Star rather than to a
cosmetic finding.

#### Literal eval artifacts written to the bundle

Build concrete, repeatable eval artifacts as real files under `evals/` in the
audit bundle directory defined in SAVE THE BUNDLE below, and reference them
from the report by ID and relative path. Names, TODOs, pseudocode, prose
recommendations, or links to artifacts that do not exist are not enough; an
artifact counts as built only when its complete literal contents exist on disk.
At least one baseline artifact must test the North Star even when there are no
findings. Each artifact must have a stable ID, link to finding/plan rows when
applicable, and specify:

- exact inputs or scenarios, including at least one case that tests the real
  North-Star outcome rather than only a local proxy;
- an oracle, assertion, scoring rule, or fully specified repeatable judgment
  protocol;
- expected evidence and pass/fail interpretation;
- exact execution/materialization instructions and prerequisites; and
- status: `BUILT-AND-RUN`, `BUILT-NOT-RUN — <blocker>`, or
  `NOT-BUILT — <reason>`.

Run an artifact when running it is read-only with respect to the harness under
audit and every output lands inside the bundle directory; record the command,
exit status, and result file. Otherwise mark it
`BUILT-NOT-RUN — <exact blocker>`. Never invent execution results or relabel a
recommendation as built. A qualitative outcome may use a repeatable judgment
protocol, but the bundle must contain the actual cases, rubric/oracle, evidence
capture, and comparison procedure—not advice to create them later.

#### Literal regression early-warning artifacts written to the bundle

Write complete literal contents for repeatable regression checks as real files
under `regressions/` in the bundle, also with stable IDs. At least one baseline
check tied directly to the North Star is mandatory even when there are no
findings; link additional checks to the finding-to-plan map when applicable.
Each must state the explicit baseline, comparison operation, outcome
deterioration it detects, what it misses, false-warning risks, when/how it runs,
exact execution instructions, and current result only if actually run. It must
expose outcome deterioration early enough to avoid relying on informal user
discovery. Use the same honest status vocabulary and the same run-when-safe rule
as eval artifacts.

### 3. Coverage ledger

Declare the effective corpus, including any scope override, then give every
named SCOPE surface exactly one of these four states:

- `EXAMINED` — opened and assessed, with concrete evidence of what was covered;
- `EXCLUDED` — outside the effective corpus, with a reason (including
  `out of scope (user-narrowed)` where applicable);
- `INACCESSIBLE` — could not be opened after at most two distinct attempts, with
  attempts and error recorded; or
- `UNRESOLVED` — opened but could not be assessed after at most two distinct
  approaches, with the uncertainty recorded.

Account for discovered descendants and additions under each named surface; do
not mark a parent `EXAMINED` if relevant children were silently skipped. Any
claim of exhaustive or full-harness coverage is permitted only when the ledger
supports it. A narrowed audit may claim completeness only for its declared
effective corpus.

Add a **target-side-effect evidence** subsection containing:

- the operation log for every command, tool, source fetch, and verifier used;
- before/after read-only manifests for every repository file in the effective
  corpus, with path, size, and cryptographic content hash; and
- the audit bundle directory as the sole authorized write location, explicitly
  excluded from the target manifest.

Describe matching manifests only as **verified net target-content equality**.
They do not prove that no transient or reverted write occurred. Claim no
audit-caused target-content write only when the operation log contains no
write-capable target step and the target manifests match; otherwise mark that
claim `[UNVERIFIED]`. The authorized writes inside the audit bundle directory,
including creation of `audits/` and the dated bundle directory, must appear in
the operation log.

### 4. Blocking questions

List only questions genuinely needed to resolve goal authority, unavailable
source evidence, inaccessible/unresolved coverage, or a capability-safe plan.
Quote the evidence that makes each question necessary. If none exist, state
`None`.

SCOPE — examine each surface and record it in the coverage ledger:

- Cognitive Frame: .pi/SYSTEM.md
- Prompt layers + index chain: root AGENTS.md and every nested AGENTS.md
- Agents: .pi/agents/\*.md (roles and model assignments)
- Skills: .pi/skills/\*/ (SKILL.md, assets/prompts, orchestrate delegates)
- Extensions / tools / hooks: .pi/extensions/\*
- System scripts + memory: scripts/system/\* — evals, behavioral ratchet,
  tiered memory, and any later additions — plus current MemPalace state
- Docs — every docs/\* tree (e.g. docs/agents/ = HOW, docs/humans/ = WHAT/WHY,
  docs/penny/ = protocols): check for staleness, doc-vs-doc contradiction,
  orphaned/unindexed files, and cross-tree duplication drift
- Dead, deprecated, placeholder, or non-functioning code anywhere in the tree

BIAS THE LENS TOWARD GENERALITY: flag any part that bakes a single-domain
assumption into a layer that must stay domain-general (Cognitive Frame, agents,
memory), and any part that assumes one specific model or
provider. A cluster of features serving one domain is expected and healthy —
treat it as drift only when it constrains a layer that should stay general,
never merely for being domain-specific.

BIAS THE LENS TOWARD SCALING (commitment 7): flag any part that constrains the
method where a constraint on the answer plus evidence would do the same job —
mandated procedure, fixed taxonomies, keyword routers, magic-number thresholds,
rigid phase sequences, enumerated option lists, hard-coded world-knowledge
tables. The list above is illustrative, not exhaustive: apply commitment 7 as
the generative rule and flag anything that fits it, whether or not it resembles
a listed example. Per flag, name the capability the mechanism currently
provides and why that capability gets cheaper for the model to supply itself as
models improve. A mechanism that passes today's tests is not thereby exempt —
passing now is what makes this debt invisible.

Legitimate exceptions — do NOT flag these as method-constraint debt: safety and
security controls, machine interfaces (a schema some program consumes), and
fallbacks explicitly gated by model tier. Explicit constraints outside these
categories may still be aligned when evidence shows they protect the answer or
an outcome more effectively than a scalable replacement; classify from function
and evidence, not syntax.

SIDE-EFFECT CONTRACT:

- **Read:** the declared harness corpus, repository metadata needed for coverage
  and manifests, current MemPalace state, the local doctrine references, and the
  live Sutton source.
- **Execute:** only read-only inspection commands and independent-review calls
  that cannot mutate the repository, external systems, credentials,
  deployments, or durable state. Record each invocation, assumptions, exit
  status, and evidence. Do not run a command when non-mutation cannot be
  established; record the blocker instead.
- **Create:** the collision-safe audit bundle directory is the sole permitted
  write location. Creating `audits/` and the dated bundle directory when absent
  is permitted. Inside the bundle, create the report, `evals/`, `regressions/`,
  and `artifact-manifest.md` as real files. Create no file anywhere outside the
  bundle directory.
- **Modify/delete:** modify or delete no existing file or external state outside
  the current bundle directory, and do not refactor, apply, or execute any
  recommended fix. Existing same-day bundles are immutable and receive a new
  suffix rather than being overwritten.

Capture the initial effective-corpus content manifest before substantive
assessment and the final manifest immediately before saving the report. Every
file-content write must land inside the bundle directory; bundle and parent
directory creation is permitted and must be logged.

COMPLETION CRITERIA (each answerable yes/no):

- Goal authority is clear, or the audit stopped and asked a targeted question
  without guessing?
- Observable better and worse are grounded in the North Star and opened goal
  evidence rather than components, tasks, or current metrics?
- The full live Sutton essay was fetched and source claims were separated from
  Penny-domain translation, or the source-dependent verdict failed closed?
- Every finding names the Alignment Test dimension(s) it violates?
- Every named scope surface has exactly one coverage state, and every in-scope,
  accessible surface is marked EXAMINED?
- Every misalignment names concrete file path(s), not a general area?
- Every misalignment carries an impact rating and a recommended fix or explicit
  blocker/no-change reason?
- Every finding is classified as answer-constraint, method-constraint, or n-a
  with a reason where required?
- Every method-constraint finding names the capability it currently provides
  and why that capability gets cheaper as models improve?
- Every relevant major mechanism has an evidenced scaling classification,
  current-model assumption, and justified n-a where applicable?
- Every recommended fix that removes a mechanism names the capability that must
  not regress and how that would be verified after the change?
- Every finding maps to a change or explicit no-change reason, capability
  protection, eval artifact, and regression artifact?
- All current and proposed measures are classified for fidelity to the actual
  outcome?
- Every proxy-drift finding includes evidence of divergence or gaming pressure,
  not merely a weak proxy?
- Positive aligned behavior and supported empty results are reported without
  forcing findings?
- Does the report satisfy the readability contract — plain-language executive
  summary at the top of Part 1; every finding stating what-it-is, why-it-matters,
  if-fixed, if-not-fixed, and priority; terms defined at first use; every table
  and ledger interpreted in prose; and the capability-safe plan readable
  standalone?
- Concrete literal eval and regression artifacts exist as files in the bundle
  with complete instructions, outcome coverage, honest status, and no invented
  results?
- Every non-CERTAIN claim carries an explicit confidence label (a controlled
  reporting vocabulary, not a calibration claim) and every inaccessible fact is
  reported rather than inferred?
- Any caller additional details are recorded verbatim in Part 1 with how each
  was applied, deferred, or refused, and none waived an evidence, coverage,
  side-effect, artifact, or stopping obligation?
- The operation log and manifests support an accurately bounded claim of no
  audit-caused target-content write, and every file-content write landed inside
  the audit bundle directory?

ANTI-CRITERIA (failure even if the above pass):

- Any invented file, tool, or contradiction not opened and confirmed.
- Any recommendation to change .pi/SYSTEM.md's universal layer without flagging
  it human-authored-only.
- Any contradiction claimed without quoting both conflicting sources.
- Treating a domain-specific skill or tool as drift merely for being
  domain-specific.
- Flagging a safety control, a machine interface, or an explicitly tier-gated
  fallback as method-constraint debt.
- Presenting the answer-constraint / method-constraint distinction as a
  quotation from Sutton's essay — it is a rubric derived from it, and must
  never be attributed as the essay's own wording.
- Recommending removal of a method-constraint without naming the capability it
  provided and how that capability stays protected.
- Silently choosing a North Star when authoritative goal sources conflict.
- Issuing a completed Bitter-Lesson verdict without a verified full live fetch,
  or blending source claims and Penny-domain translation.
- Claiming exhaustive coverage beyond the four-state coverage evidence.
- Requiring a finding for appearance's sake or suppressing positive aligned
  behavior.
- Treating every weak measure as evidenced proxy drift.
- Treating caller additional details as authorization to waive an evidence,
  coverage, side-effect, artifact, or stopping obligation, or silently ignoring
  a supplied detail instead of recording its disposition.
- Leaving any finding without a mapped change/no-change reason and concrete
  capability-protection evidence.
- Calling an eval or regression artifact built when the bundle contains only a
  recommendation, placeholder, pseudocode, empty file, or missing referenced
  content.
- Claiming an artifact ran, or reporting results, without execution evidence.

EDGE CASES to handle explicitly:

- A file is referenced by docs but missing, or present but unreachable from the
  index chain -> record as a misalignment, do not skip.
- A part looks dead but is referenced by a live skill -> confirm usage before
  calling it dead.
- A part serves generality/trust/self-correction/scaling in a way that is not
  obvious -> keep it; record it under positive aligned behavior and note why.
- A part scores well on generality, trust, or self-correction but poorly on
  scaling (e.g. a hand-maintained table that works on every model) -> record it
  as a scaling misalignment with the conflict stated, do not net it out to
  "aligned." Dimensions are reported separately, never averaged.
- A method-constraint cannot be removed without losing a capability and no
  answer-constraint replacement is apparent -> keep it, record it as accepted
  debt with the blocking reason, do not recommend a fix you cannot specify.
- A fully aligned surface or audit with no supported misalignments -> report the
  positive evidence and an empty findings result; framework completeness is not
  the same as a finding-free target.
- A measure is indirect but no divergence or gaming pressure is evidenced ->
  classify it as a proxy, not as demonstrated proxy drift.
- An outcome is qualitative -> write a repeatable judgment artifact with fixed
  scenarios, evidence capture, oracle/rubric, and comparison procedure rather
  than downgrading the requirement to a recommendation.
- A scope override excludes most surfaces -> preserve all named ledger rows as
  EXCLUDED with `out of scope (user-narrowed)` and make no full-harness claim.

LOOP & STOP:

- Verify every claim against file contents before writing it; quote the specific
  lines for any contradiction or dead-code claim.
- Stop substantive assessment immediately on an unresolved North-Star authority
  contradiction; do not spend the audit budget optimizing against a guessed
  objective.
- Stop when all applicable completion criteria are yes and all named surfaces
  are accounted for; a blocked criterion must remain visibly no rather than be
  weakened.
- If a surface or source resists assessment, use at most two genuinely distinct
  attempts or approaches. Then mark it INACCESSIBLE or UNRESOLVED with the
  reason and move on — do not spin or repeat the same failing approach.
- Account for the full effective scope, but do not repeat settled surfaces to
  satisfy a pass count; revisit only resistant items with a materially different
  approach.

VERIFICATION (separate step, after drafting):

1. Re-open each cited source and re-check every misalignment, contradiction,
   dead-code claim, coverage state, measure classification, finding-to-plan
   link, and bundle artifact. Mark any claim you cannot confirm from a file as
   `[UNVERIFIED]` with confidence `UNCERTAIN` and never present it as fact; if a
   source cannot be found or read, say so rather than inferring it.
2. Give the draft and its cited evidence to a genuinely separate agent, model,
   or verification tool for an independent semantic check. Record verifier
   identity/type, scope, result, and evidence in Part 3. A self-review, repeated
   pass by the same generator, or unsupported assertion of independence does
   not satisfy design commitment 3. If no independent verifier is available,
   state that blocker and keep `passed` false.
3. Re-check the operation log and before/after manifests and report only what
   they establish about side effects.

After the four report parts, emit a separate valid JSON object with no Markdown
comments and exactly the existing four top-level keys:

```json
{
  "passed": false,
  "unexamined_surfaces": [],
  "unverified_claims": [],
  "questions_needed": false
}
```

Populate arrays and booleans from evidence. Encode non-examined coverage entries
inside `unexamined_surfaces` as strings that include the ledger state and path,
for example `"INACCESSIBLE — docs/example.md — permission denied"`; record all
other machine-relevant detail in the four report parts rather than changing this
machine interface. `passed` may be `true` only when goal authority is clear, the
live source gate passed, every in-scope surface was examined, no unsupported or
orphaned claim remains, all required measure and artifact obligations are
satisfied, an independent verifier passed, target-side-effect evidence is
accurately bounded, and all applicable completion criteria are yes. `passed`
means the audit contract was satisfied, not that the harness had no findings.

SAVE THE BUNDLE: write every artifact this audit produces into one bundle
directory at
`$PROJECT_ROOT/audits/harness-audit-<the current date, YYYY-MM-DD>/`, organized
as:

- `harness-audit-report.md` — the completed four-part report followed by the
  separate verification JSON, as Markdown;
- `evals/` — the eval artifacts, their fixtures/cases, execution instructions,
  and result files when run;
- `regressions/` — the baselines, repeatable checks, execution instructions, and
  result files when run;
- `artifact-manifest.md` — every file created and every command executed, with
  exit status.

The bundle directory is the only location you may create or write. Creating
`audits/` and the dated bundle directory when absent is permitted. The harness
under audit stays read-only. If a bundle for the current date already exists,
append `-2`, `-3`, ... to the directory name rather than overwriting or merging
into it. Do not create empty placeholders. After writing, print the absolute
path of the bundle directory.
