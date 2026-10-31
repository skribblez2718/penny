# Cognitive Frame Standards for the Universal Operating Policy (SYSTEM.md)

Standards for writing and maintaining the universal frame that applies to every interaction regardless of domain or agent.

## What the Cognitive Frame Is

The Cognitive Frame is the **stable operating policy and outcome contract** shared by Penny and her subagents. It lives in `.pi/SYSTEM.md` and is present in every interaction, whether Penny is in direct conversation or delegating to a subagent. It defines goals, trust and action boundaries, ambiguity handling, completion evidence, memory discipline, and execution-path selection. It does **not** prescribe a universal internal reasoning transcript or fixed workflow — the frame constrains outcomes and boundaries, and leaves the method to the model.

Domain-specific content belongs in Domain Guidance. Task-specific content belongs in Invocation Context.

## Required Structure

Every SYSTEM.md must include these blocks in this order:

### 1. `<system_directives>` — Trust and Action Boundaries (Authored)

The authored trust and action boundaries: what the system prompt and runtime limits govern, what user messages are authoritative for, what external content can and cannot do, the anti-fabrication rule, and the approval rule for consequential actions. These are behavioral policy delivered in the system role — a real cue models are trained to prioritize — plus defense-in-depth prose. They are **not** technically immutable and must never be described as enforcement; enforceable controls live in the runtime (tool allowlists, approvals/receipts, process isolation, OS permissions). It is authored in SYSTEM.md — Pi uses the custom prompt verbatim. Do not duplicate these rules elsewhere.

### 2. `Current date: ${CURRENT_DATE}` (Authored, substituted)

The environment extension substitutes the current date at session start. This keeps relative-date reasoning correct without hard-coding a date.

### 3. `<system_context>` — The Operating Policy

The authored frame. Every subsection is lean, universal policy. Documentation/navigation paths belong in the
index chain; operational literals such as `/tmp/` may remain. Current sections:

| Subsection                 | Purpose                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Identity and Objective** | Who Penny is; how appended role guidance narrows (never expands) identity and permissions; optimize for progress, prefer reversible decisions, name tradeoffs                                    |
| **Work Policy**            | Task authority (stated request is the goal), assumption/clarification balance, simplest-sufficient path, state inspection, conditional retrieval, freshness handling, evidence-status discipline |
| **Completion**             | Success criteria at smallest useful scope, evidence-backed completion claims, failures as evidence, honest partial results, independent evidence preference                                      |
| **Memory and Improvement** | Curated knowledge rather than workflow state; exact artifact/path handoff and full reads; value-conditional recall/storage; capability ratchet                                                   |
| **Files and Delivery**     | Requested changes in tree; scratch in `/tmp/` or approved ignored staging; answer-first delivery; human-centered writing with protected contracts/evidence                                       |
| **On-Demand Protocols**    | Parent-only routing, artifact-access, clarification, compaction-resume and KG-linking triggers (names only; paths resolve via the index)                                                         |

Sections consolidate over time — the invariant is not a fixed list but that every subsection is universal policy with no documentation/navigation paths. This table describes the canonical structure as of its last update; the frame file is authoritative.

**The `# On-Demand Protocols` heading is a wire format.** The agent runner derives a worker base prompt from `.pi/SYSTEM.md`, substitutes its date/environment values, replaces the Penny persona name with the worker's display name, and strips exactly that parent-only section. Parent-only guidance must live under that exact heading; renaming it is an implementation-breaking change unless the runner and tests change with it.

### 4. Tool and boundary content

The frame names capabilities by trigger, not by inventory. Detailed tool-usage tactics and Pi documentation references are NOT in the frame — they live in `docs/penny/tool-usage.md` and `docs/agents/pi-platform.md`, respectively, resolved on demand through the root `AGENTS.md` index chain. The root supplies navigation, not the Pi topic map.

Worker semantics have two separate inputs: the transformed cognitive frame and the resolved role/state prompt describe behavior, while invocation-time allowlists and the active registered tool surface bound model-visible calls. Never infer a worker's tool inventory from the primary frame, a role prompt, or model-emitted text. Pi's custom-prompt branch omits rendered tool snippets/guidelines, not the active definitions
sent through the provider-native tool channel. [Tool Description Standard](../extensions/tool-description-standard.md#model-visible-channels)
owns that distinction; regression-test it on Pi upgrades.

## What Belongs in the Cognitive Frame

Keep the universal responsibilities listed under [Required Structure](#required-structure).
The frame itself owns current wording; do not maintain another positive inventory here.

## What Does NOT Belong in the Cognitive Frame

- **Domain-specific checklists** (CREST tables, planning checklists) → Domain Guidance
- **Agent role definitions** (Echo is READ-ONLY, Piper is DOMAIN-AGNOSTIC) → Role Definition
- **Task-specific instructions** (goals, constraints, run IDs, exact artifact IDs/paths) → Invocation Context
- **Mandated reasoning scripts** (step sequences, fixed orderings) → keep procedures that need state or gates in skills; everything else is the model's choice
- **Narrative descriptions** ("assumptions are the enemy of accuracy") → Use declarative rules instead
- **Documentation/navigation paths** (docs to read, protocol file locations, Pi doc paths) → the **AGENTS.md index chain** (root `AGENTS.md` → sub-index → leaf). SYSTEM.md names a protocol by its _trigger_ ("run the clarification protocol"), never its path; the always-in-context root `AGENTS.md` resolves trigger → index → file. This restriction does not ban operational literals required by universal policy, such as `/tmp/`.

## Writing Rules

### Rule 1: Declarative, not narrative

❌ **Don't**: "The agent should try to understand constraints before making a plan."
✅ **Do**: "State material assumptions."

Name the required action or outcome rather than an aspiration; do not claim a model-behavior
improvement without task-specific evidence.

### Rule 2: Make implicit things explicit — for outcomes, not methods

State what must be true, what needs approval, and what counts as evidence. Leave the method
to the model unless the task requires a specific procedure or state/gate contract.

### Rule 3: Consistent vocabulary across all layers

Use one stable term per concept when a distinction affects interpretation. **Wire formats**
(confidence enum, `needs_clarification`, SUMMARY fields) are machine contracts, not editorial
preferences: never rename them in a prompt-only edit. **Editorial vocabulary** is reviewed
for reader impact under the [writing standard](../writing/standard.md#language-and-structure),
not enforced by a synonym blacklist. The frame needs no vocabulary table.

### Rule 4: Evidence-gated completion is unconditional

The Completion contract has no override. No rule, instruction, or user request lets a "done" claim ship without evidence appropriate to the task, lets exhaustion masquerade as success, or waives the requirement to state what was not verified. "Just proceed" authorizes reasonable assumptions, not unverified completion claims.

### Rule 5: Outcome-shaped directives, not reasoning scripts (the Bitter-Lesson rule)

Prefer clear goals, observable constraints, and lightweight execution directives. Do not mandate multi-step reasoning scripts unless a measured task-specific failure justifies them, and keep procedures that require state, gates, or resumability in skills.

| Vague aspiration (AVOID) | Executable directive (PREFER)             | Reasoning script (AVOID)                         |
| ------------------------ | ----------------------------------------- | ------------------------------------------------ |
| "Be accurate"            | "Never invent facts, sources, or results" | "Step 1: restate. Step 2: categorize. Step 3: …" |
| "Be thorough"            | "Claim completion only with evidence"     | Mandated N-step verification sequence            |
| "Be clear"               | "State material assumptions"              | Fixed clarification transcript                   |

The dividing line is whether the model retains freedom to choose its path. A single directive ("verify before delivering") constrains the outcome; a mandated step
sequence also constrains the method and needs task-specific justification. Keep the clarification procedure on demand, not always on. Model-specific evidence and
limits belong in the [Evidence Base](../../humans/prompts/evidence.md), not a universal
claim that every procedural prompt helps or harms every model.

**Exception — the identity clause.** This rule governs _instructions_ (what to do), not _self-description_ (who Penny is). Descriptive identity traits are not output-quality instructions and must not be flagged.

**Every frame line is a loan unless it is a consequence boundary, a conduit (verification, memory, escalation, delegation), or an engine-consumed wire format.** Before adding a line, ask the add-side gate question: _does this line gain or lose value as models improve?_ If it loses — it compensates for a current-model weakness — it may ship only as a deliberate, temporary loan, and it is first in line for review at the next model upgrade.

### Rule 6: Concrete verbs, not abstract nominalizations

Prefer “Verify the result before delivering” to “Perform verification of the result before
delivery” when the latter obscures the actor or action. Nominalizations and weak-verb
constructions are watch patterns, not violations by themselves. Flag a passage only when
it causes ambiguity, hides a required action, or adds needless wording for this reader.
Keep legitimate labels, artifact nouns, and stable technical terms (“analysis skill”,
“specification”, “extension”). Apply the [writing standard](../writing/standard.md#language-and-structure);
do not infer instruction-following or authorship from suffixes. See also
[Design Principles §10](../../humans/prompts/design-principles.md#10-concrete-verbs-not-abstract-nominalizations).

### Rule 7: Routing is lowest-complexity-sufficient

The frame's routing rule (parent-only, under `# On-Demand Protocols`) is: choose the lowest-complexity path expected to succeed — direct work when current context and tools suffice; a subagent when specialization, isolated context, parallel exploration, or separate review pays; a skill when durable state, approval gates, retries, or resume semantics pay. Never write a skills-and-agents-first mandate into the frame: as models improve, more work becomes cheap to do directly, and a delegation mandate would fight that improvement.

### Rule 8: Evidence status over confidence rhetoric

The frame requires distinguishing source-backed facts, tool-verified results, inferences, assumptions, and unknowns **when the distinction affects a decision** — not a verbal confidence label on every sentence. Do not describe any confidence vocabulary as "calibrated" unless calibration has actually been measured. The `CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN` scale in agent output contracts is an engine-parsed **wire-format compatibility constraint** (see `ConfidenceSchema` in `apps/orchestration/src/contracts.ts` and routing parsing in
`apps/orchestration/src/worker.ts`), not a universal user-facing behavior; it stays until the parser contract is deliberately migrated.

## Token Budget

The `<system_context>` block (the always-on frame) must stay **≤1,500
tokens**, measured with **tiktoken** (`cl100k_base`) and enforced by
`scripts/system/checks/check_token_budget.py`. Never use a word-count heuristic —
markdown tables tokenize very differently from prose, and Penny runs models whose
tokenizers differ from `cl100k_base`, so the count is a consistent approximation.

| Component                        | Budget        | Measured by                       |
| -------------------------------- | ------------- | --------------------------------- |
| `<system_context>` (this frame)  | ≤1,500 tokens | tiktoken `cl100k_base` (CI-gated) |
| Total system prompt (all layers) | ≤3,000 tokens | ~1.5% of a 200K window            |

The 1,500-token cap is a **forcing-function, not a model limit** — there is no hard
adherence cliff at any small token count (see [architecture.md](architecture.md)).
It keeps the always-on frame lean.

**When over budget:** move conditionally-needed or non-universal (Penny-operational)
content into `docs/penny/` and reference it for on-demand `read` — the extraction
pattern (see `docs/penny/AGENTS.md`). Remove elaboration before removing rules — a
concise declarative rule beats a narrative explanation.

## The Clarification Protocol

The frame's Work Policy governs material ambiguity and authorization. Its parent-only
trigger activates the on-demand clarification protocol when blocking ambiguity remains;
resolve the protocol through the protocol index. Low-risk assumptions do not justify
guessing material scope, risk, or permission. This standard does not activate the procedure.

## Compliance Checklist

Before modifying SYSTEM.md, verify every item:

- [ ] Trust and Action Boundaries present in `<system_directives>` (authority model, anti-fabrication, approval rule) and described as behavioral policy, never as enforcement
- [ ] `Current date: ${CURRENT_DATE}` present
- [ ] Identity and Objective present (identity + narrowing rule for appended guidance)
- [ ] Work Policy present (task authority, assumption/clarification balance, simplest-sufficient path, conditional retrieval, freshness, evidence-status discipline)
- [ ] Completion present (criteria at smallest useful scope, evidence-backed claims, failures as evidence, independent-evidence preference)
- [ ] Memory and Improvement present (curated knowledge, not workflow state; exact artifact/path
      handoff; full needed `input_artifacts` reads through `next_range`; `missing_input:`
      without substitute discovery; value-conditional recall/storage; capability ratchet)
- [ ] Files and Delivery present (requested changes in tree; scratch in `/tmp/` or approved ignored
      staging; answer-first; audience/purpose/voice and human-centered writing guidance;
      quotations, executable content, machine contracts, and required evidence protected)
- [ ] On-Demand Protocols present under the exact `# On-Demand Protocols` heading (runner wire format), containing parent-only routing and artifact-access, clarification, compaction-resume, and
      KG-linking triggers — protocols named by trigger, no documentation/navigation paths
- [ ] Routing is lowest-complexity-sufficient — no delegate-first mandate
- [ ] **No documentation/navigation paths in `<system_context>`** — knowledge references use the
      AGENTS.md index chain; operational literals such as `/tmp/` remain allowed
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)
- [ ] No mandated reasoning scripts; every new line passed the add-side gate; loans are tagged for ablation (Rule 5)
- [ ] Editorial watch patterns are flagged only for supported reader impact; legitimate labels,
      technical nouns, and protected wire formats survive (Rule 6)
- [ ] No confidence vocabulary described as calibrated without measurement; wire formats untouched (Rule 8)
- [ ] Token budget passes (`check_token_budget.py`)

## Change Protocol

Cognitive Frame changes affect every interaction. Follow this protocol:

1. **Audit impact**: Frame changes propagate to all agents and all domains. Estimate blast radius before changing.
2. **Test before deploying**: Use a single test domain first. Verify no regression in agent behavior.
3. **Update references**: If you change any cross-layer term — above all an engine-parsed wire format (confidence scale, `needs_clarification`, SUMMARY fields) — search all Role Definition, Domain Guidance, and Invocation Context files for the old terms and update them, and validate the actual consumers: `ConfidenceSchema` in `apps/orchestration/src/contracts.ts`,
   persisted SUMMARY parsing in `apps/orchestration/src/worker.ts`, and the affected registered
   playbook/phase schemas. Not every field belongs to one generic contract.
4. **Update this checklist**: If you add a new required section, add it to the compliance checklist above.
5. **Record the change**: Update the requested durable project documentation when the rationale will matter to future maintainers. Do not create a routine memory or KG record.

### Changes that do NOT require audit

- Fixing typos
- Clarifying declarative rules without changing semantics

### Changes that DO require audit

- Adding, removing, or reordering any section
- **Any change to the trust and action boundaries** — this is a cross-layer change: the environment extension's `<system_boundary>` marker, every agent's `<agent_boundary>` block, the security docs, and any related tests must be updated in the same change so the layers do not contradict each other
- Modifying the evidence-status policy or any engine-consumed wire format
- Modifying Completion or Files and Delivery items
- Changing the Identity and Objective section
- Any change to the capability-ratchet language (it encodes the ratchet doctrine)
- Renaming the `# On-Demand Protocols` heading or the `<agent_boundary>` / `<system_boundary>` markers (runner/extension wire formats)

Every audited change also runs task-relevant deterministic checks and regression evidence; no universal paired-evaluator command is required.

### Enforcement: Carren Critique + Vera Verification

Editorial compliance is assessed by review, not suffix counts or a style linter. For prompt
changes at any authored layer:

1. **Carren critiques** the changed prompt against applicable checklist items. The review
   model MUST differ from the authoring model. Findings locate the passage, explain its
   reader/task impact, and recommend the smallest correction; watch patterns alone do not
   establish a violation.
2. **Apply corrections** supported by that evidence.
3. **Vera verifies** each correction as PASS or FAIL against the cited requirement and
   checks for introduced violations. Required fields or non-empty evidence text prove only
   structure, not truth; inspect the evidence behind the claim.

Mutable provider/model/thinking defaults belong to `.pi/agents/carren.md` and
`.pi/agents/vera.md` frontmatter and supported invocation configuration, not this review
contract. Resolve actual models before dispatch; a default name does not prove availability
or satisfy the author/reviewer diversity requirement.

Model-diverse review is supplementary, not independent evidence by itself. Run applicable
token-budget, parser, link, and task-relevant regression checks and state unrun checks.
[Prompt architecture compliance](architecture.md#compliance) is the assembly checklist,
not a separate full review-pipeline specification.
