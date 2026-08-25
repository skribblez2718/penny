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

The authored frame. Every subsection is lean, universal policy and carries **no file paths**. Current sections:

| Subsection                 | Purpose                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Identity and Objective** | Who Penny is; how appended role guidance narrows (never expands) identity and permissions; optimize for progress, prefer reversible decisions, name tradeoffs                                    |
| **Work Policy**            | Task authority (stated request is the goal), assumption/clarification balance, simplest-sufficient path, state inspection, conditional retrieval, freshness handling, evidence-status discipline |
| **Completion**             | Success criteria at smallest useful scope, evidence-backed completion claims, failures as evidence, honest partial results, independent evidence preference                                      |
| **Memory and Improvement** | Value-conditional memory retrieval and storage; the capability ratchet (outcomes over implementations, remove scaffolding that stops earning its cost)                                           |
| **Files and Delivery**     | Requested changes in the project tree; scratch in `/tmp/`/mempalace; answer-first delivery                                                                                                       |
| **On-Demand Protocols**    | Parent-only routing (lowest-complexity path), clarification trigger, compaction-resume trigger, KG-linking trigger (names each; paths resolve via the index)                                     |

Sections consolidate over time — the invariant is not a fixed list but that every subsection is universal policy with no reference paths. This table describes the canonical structure as of its last update; the frame file is authoritative.

**The `# On-Demand Protocols` heading is a wire format.** The agent runner strips exactly that section before passing the frame to subagents. Parent-only guidance must live under that exact heading; renaming it is an implementation-breaking change unless the runner and tests change with it.

### 4. Tool and boundary content

The frame names capabilities by trigger, not by inventory. Detailed tool-usage tactics and Pi documentation references are NOT in the frame — they live in `docs/penny/tool-usage.md` and the root `AGENTS.md`, resolved on demand through the index chain. (As of the pinned Pi version, Pi does not inject tool definitions when a custom prompt is present; treat that as version-specific behavior to regression-test on Pi upgrades, not a permanent guarantee.)

## What Belongs in the Cognitive Frame

- **Identity**: Who Penny is and how appended guidance narrows it
- **Trust and action boundaries**: What each content source is authoritative for; the approval rule for consequential actions
- **The outcome contract**: What "done" requires — evidence, honest exhaustion, strategy change when retries add no information
- **Ambiguity policy**: When to clarify versus proceed on stated assumptions
- **Execution-path selection**: The lowest-complexity-sufficient routing principle (parent-only section)
- **Memory discipline**: Value-conditional retrieval and storage
- **The capability ratchet**: Outcomes over implementations; scaffolding is disposable

## What Does NOT Belong in the Cognitive Frame

- **Domain-specific checklists** (CREST tables, planning checklists) → Domain Guidance
- **Agent role definitions** (Echo is READ-ONLY, Piper is DOMAIN-AGNOSTIC) → Role Definition
- **Task-specific instructions** (goals, constraints, run IDs, exact artifact IDs/paths) → Invocation Context
- **Mandated reasoning scripts** (step sequences, fixed orderings) → keep procedures that need state or gates in skills; everything else is the model's choice
- **Narrative descriptions** ("assumptions are the enemy of accuracy") → Use declarative rules instead
- **File paths / references to additional knowledge** (docs to read, protocol file locations, Pi doc paths) → the **AGENTS.md index chain** (root `AGENTS.md` → sub-index → leaf). SYSTEM.md names a protocol by its _trigger_ ("run the clarification protocol"), never its path; the always-in-context root `AGENTS.md` resolves trigger → index → file. **Path references are the primary Cognitive-Frame bloat vector — keep them out.**

## Writing Rules

### Rule 1: Declarative, not narrative

❌ **Don't**: "The agent should try to understand constraints before making a plan."
✅ **Do**: "State material assumptions."

Narrative descriptions are aspirations. Declarative rules are instructions. The model follows instructions more reliably than aspirations.

### Rule 2: Make implicit things explicit — for outcomes, not methods

Every _boundary or outcome_ assumption left unstated is a gap the model fills with probability: state what must be true, what needs approval, what counts as evidence. Do not extend this to methods — an unstated method is the model's freedom, not a gap.

### Rule 3: Consistent vocabulary across all layers

If the Cognitive Frame uses the word "constraints" and Domain Guidance uses "limitations," the model treats them as potentially different things. Use one term per concept across all layers. Two tiers: **wire formats** (the agent-contract confidence scale, `needs_clarification`, SUMMARY fields) are engine-parsed contracts — treat them as an API and never rename them in a prompt edit; **editorial vocabulary** (constraints, assumptions, tradeoffs, verification) is enforced at review time by the Carren+Vera pipeline. The frame itself no longer carries a vocabulary table — consistency is an authoring discipline, not always-on frame content.

### Rule 4: Evidence-gated completion is unconditional

The Completion contract has no override. No rule, instruction, or user request lets a "done" claim ship without evidence appropriate to the task, lets exhaustion masquerade as success, or waives the requirement to state what was not verified. "Just proceed" authorizes reasonable assumptions, not unverified completion claims.

### Rule 5: Outcome-shaped directives, not reasoning scripts (the Bitter-Lesson rule)

Prefer clear goals, observable constraints, and lightweight execution directives. Do not mandate multi-step reasoning scripts unless a measured task-specific failure justifies them, and keep procedures that require state, gates, or resumability in skills.

| Vague aspiration (AVOID) | Executable directive (PREFER)             | Reasoning script (AVOID)                         |
| ------------------------ | ----------------------------------------- | ------------------------------------------------ |
| "Be accurate"            | "Never invent facts, sources, or results" | "Step 1: restate. Step 2: categorize. Step 3: …" |
| "Be thorough"            | "Claim completion only with evidence"     | Mandated N-step verification sequence            |
| "Be clear"               | "State material assumptions"              | Fixed clarification transcript                   |

The dividing line is whether the model retains freedom to choose its path. A single executable directive ("verify before delivering") constrains the outcome; a mandated step sequence constrains the method and is a bet against model improvement — it helps the current model and fights the next one. This matters most on reasoning-native models: prescriptive process scaffolds are the technique class that goes neutral-to-negative there (Sprague et al., ICLR 2025, arXiv:2409.12183; vendor guidance uniformly says don't CoT-prompt thinking models; see [Evidence Base](../../humans/prompts/evidence.md)). This is why the multi-step clarification procedure lives in the _on-demand_ clarification protocol rather than the always-on frame.

**Exception — the identity clause.** This rule governs _instructions_ (what to do), not _self-description_ (who Penny is). Descriptive identity traits are not output-quality instructions and must not be flagged.

**Every frame line is a loan unless it is a consequence boundary, a conduit (verification, memory, escalation, delegation), or an engine-consumed wire format.** Before adding a line, ask the add-side gate question: _does this line gain or lose value as models improve?_ If it loses — it compensates for a current-model weakness — it may ship only as a deliberate, temporary loan, and it is first in line for review at the next model upgrade.

### Rule 6: Concrete verbs, not abstract nominalizations

❌ **Don't**: "Perform verification of the result before delivery."
✅ **Do**: "Verify the result before delivering."

A nominalization ("verification", "analysis", "decision") hides the action inside a noun, so the model interprets a topic instead of executing a step — the same failure as Rule 1. Flag a weak verb (perform / conduct / provide / ensure) + `-tion`/`-ment`/`-ance` noun, or a "the {noun} of X" construction. Do not flag legitimate label or artifact nouns ("the analysis skill", "the specification"). See [Design Principles §10](../../humans/prompts/design-principles.md).

### Rule 7: Routing is lowest-complexity-sufficient

The frame's routing rule (parent-only, under `# On-Demand Protocols`) is: choose the lowest-complexity path expected to succeed — direct work when current context and tools suffice; a subagent when specialization, isolated context, parallel exploration, or separate review pays; a skill when durable state, approval gates, retries, or resume semantics pay. Never write a skills-and-agents-first mandate into the frame: as models improve, more work becomes cheap to do directly, and a delegation mandate would fight that improvement.

### Rule 8: Evidence status over confidence rhetoric

The frame requires distinguishing source-backed facts, tool-verified results, inferences, assumptions, and unknowns **when the distinction affects a decision** — not a verbal confidence label on every sentence. Do not describe any confidence vocabulary as "calibrated" unless calibration has actually been measured. The `CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN` scale in agent output contracts is an engine-parsed **wire-format compatibility constraint** (see `contracts.py`), not a universal user-facing behavior; it stays until the parser contract is deliberately migrated.

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

The clarification protocol is the on-demand mechanism for resolving blocking ambiguity. It lives in `docs/penny/clarification-protocol.md` and is activated by the frame's trigger ("run the clarification protocol") — it is deliberately _not_ an always-on frame protocol (prescriptive step scaffolds are the technique class that rots on reasoning-native models; see Rule 5). The trigger condition stays inline in SYSTEM.md; the protocol is loaded via `read` when the trigger fires.

## Compliance Checklist

Before modifying SYSTEM.md, verify every item:

- [ ] Trust and Action Boundaries present in `<system_directives>` (authority model, anti-fabrication, approval rule) and described as behavioral policy, never as enforcement
- [ ] `Current date: ${CURRENT_DATE}` present
- [ ] Identity and Objective present (identity + narrowing rule for appended guidance)
- [ ] Work Policy present (task authority, assumption/clarification balance, simplest-sufficient path, conditional retrieval, freshness, evidence-status discipline)
- [ ] Completion present (criteria at smallest useful scope, evidence-backed claims, failures as evidence, independent-evidence preference)
- [ ] Memory and Improvement present (value-conditional retrieval/storage; capability ratchet)
- [ ] Files and Delivery present (requested changes in tree; scratch in `/tmp/`/mempalace; answer-first)
- [ ] On-Demand Protocols present under the exact `# On-Demand Protocols` heading (runner wire format), containing parent-only routing, clarification trigger, compaction-resume trigger, KG-linking trigger — protocols named by trigger, NO file paths
- [ ] Routing is lowest-complexity-sufficient — no delegate-first mandate
- [ ] **No file paths anywhere in `<system_context>`** — knowledge references live in the AGENTS.md index chain
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)
- [ ] No mandated reasoning scripts; every new line passed the add-side gate; loans are tagged for ablation (Rule 5)
- [ ] No abstract nominalizations — concrete verbs in all instructions (Rule 6)
- [ ] No confidence vocabulary described as calibrated without measurement; wire formats untouched (Rule 8)
- [ ] Token budget passes (`check_token_budget.py`)

## Change Protocol

Cognitive Frame changes affect every interaction. Follow this protocol:

1. **Audit impact**: Frame changes propagate to all agents and all domains. Estimate blast radius before changing.
2. **Test before deploying**: Use a single test domain first. Verify no regression in agent behavior.
3. **Update references**: If you change any cross-layer term — above all an engine-parsed wire format (confidence scale, `needs_clarification`, SUMMARY fields) — search all Role Definition, Domain Guidance, and Invocation Context files for the old terms and update them, and confirm `contracts.py` still parses.
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

Every audited change also runs `make evals`.

### Enforcement: Carren Critique + Vera Verification

Compliance checklists are enforced by **review, not by a linter** — a suffix-based automated check produces too many false positives on legitimate domain nouns to be useful. Instead, prompt changes go through a two-agent enforcement pipeline:

1. **Carren critiques** (model: `deepseek-v4-pro:cloud` — MUST differ from the model that authored the prompt). Carren reviews the changed prompt against every applicable compliance checklist item, flagging violations of declarative rules, outcome-shaped phrasing, and abstract nominalizations.
2. **Corrections are applied** based on Carren's critique.
3. **Vera verifies** (model: `glm-5.2:cloud`) that each correction actually resolves the cited violation without introducing new violations. Vera judges each corrected item as PASS or FAIL against the compliance checklist.

Review by a different model is **model-diverse review** — a useful supplementary check, not independent evidence by itself; the deterministic gates (token budget, `make evals`, parser checks) remain the stronger anchors.

See [Architecture §Enforcement](architecture.md#enforcement-carren-critique--vera-verification) for the full pipeline specification.

This applies to changes at every layer: Cognitive Frame (`SYSTEM.md`), Role Definition (`.pi/agents/*.md`), and Domain Guidance (`.pi/skills/*/assets/prompts/*.md`).
