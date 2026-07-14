# Cognitive Frame Standards for the Universal Cognitive Frame (SYSTEM.md)

Standards for writing and maintaining the universal cognitive frame that applies to every interaction regardless of domain or agent.

## What the Cognitive Frame Is

The Cognitive Frame is the **universal cognitive frame** — the reasoning protocol that never changes. It lives in `.pi/SYSTEM.md` and is present in every interaction, whether Penny is in direct conversation or delegating to a subagent.

It defines **how the model thinks**, not **what it thinks about**. Domain-specific content belongs in Domain Guidance. Task-specific content belongs in Invocation Context.

## Core Principle

Cognitive Frame must be **process-shaped**, not output-shaped. The difference:

- **Output-shaped**: "Be helpful, be accurate, be thorough" — tells the model what the result should look like
- **Process-shaped**: "RESTATE the goal, IDENTIFY the category, LIST constraints" — tells the model what steps to follow

Output-shaped prompts let the model fill the process gap with probability. Process-shaped prompts constrain the path, not just the destination. Every section in the Cognitive Frame must define a thinking step, not a desired output quality.

## Required Sections

Every SYSTEM.md must include these sections in this order:

### 1. `<system_directives>` — Security (Authored)

This section contains the immutable security rules. It is authored in SYSTEM.md — Pi uses the custom prompt verbatim without XML parsing. Do not duplicate these rules elsewhere.

### 2. `<system_context>` — The Cognitive Frame

The authored Cognitive Frame. Every subsection is lean, universal reasoning and carries **no file paths**. Current sections:

| Subsection                            | Purpose                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Who You Are**                        | Identity and reasoning stance (reversible over irreversible, name tradeoffs, truth over agreement)                 |
| **The Operating Bet**                  | The Bitter-Lesson disposition: leverage computation, ratchet on capabilities not implementations, the add-side gate, knobs over procedure, measure scaffolding |
| **What Done Requires**                 | The outcome contract: criteria before work, evidence-backed completion, honest exhaustion, strategy change on retry, prior work first, independent checks |
| **Instruction Hierarchy**              | Conflict resolution for competing rules                                                                            |
| **Signal Your Certainty**              | Calibrated certainty — "verified" ≠ "likely" ≠ "need to check"                                                    |
| **Ask vs. Act**                        | When to clarify before acting and when to escalate mid-work (names the clarification protocol; path resolves via the index) |
| **Reach for Skills and Agents First**  | The delegation decision (skill / agent / direct), by capability reasoning not keyword-matching                     |
| **Tools & Boundaries**                 | Lean core-tool list + the always-on "no output files in the project tree" rule                                     |
| **Deliver**                            | Answer-first structure; a response must add information or progress                                                |
| **On-Demand Protocols**                | Trigger→action for KG linking and compaction resume (names each; paths resolve via the index)                      |

Sections consolidate over time — the invariant is not a fixed list but that every subsection is universal reasoning with no reference paths. Structural changes ship through the prompt-efficacy gate (see Change Protocol below), so this table describes the canonical structure as of its last update; the frame file is authoritative.

### 3. Tools and guidelines (Authored)

Only the lean core-tool list and the one always-on output-file constraint are authored inline (Pi does not inject tool definitions when a custom prompt is present). Detailed tool-usage tactics and Pi documentation references are NOT in the frame — they live in `docs/penny/tool-usage.md` and the root `AGENTS.md`, resolved on demand through the index chain.

## What Belongs in the Cognitive Frame

- **Identity**: Who Penny is (human-facing name for warmth, process role for reasoning)
- **The operating bet**: How the system improves as models improve (the Bitter-Lesson disposition)
- **The outcome contract**: What "done" requires — evidence, honest exhaustion, strategy change on retry
- **Instruction hierarchy**: Priority table for conflict resolution
- **Certainty discipline**: How to signal what is verified vs. likely vs. unchecked
- **Ask/escalate conditions**: When to clarify before acting; when to escalate mid-work
- **Delegation rule**: Reach for skills and agents first, chosen by capability reasoning
- **Consequence boundaries**: The always-on tool/output constraints

## What Does NOT Belong in the Cognitive Frame

- **Domain-specific checklists** (CREST tables, planning checklists) → Domain Guidance
- **Agent role definitions** (Echo is READ-ONLY, Piper is DOMAIN-AGNOSTIC) → Role Definition
- **Task-specific instructions** (session IDs, mempalace rooms, specific goals) → Invocation Context
- **Narrative descriptions** ("assumptions are the enemy of accuracy") → Use declarative rules instead
- **Process details that vary by domain** → Domain Guidance via CREST
- **File paths / references to additional knowledge** (docs to read, protocol file locations, Pi doc paths) → the **AGENTS.md index chain** (root `AGENTS.md` → sub-index → leaf). SYSTEM.md names a protocol by its *trigger* ("run the clarification protocol"), never its path; the always-in-context root `AGENTS.md` resolves trigger → index → file. **Path references are the primary Cognitive-Frame bloat vector — keep them out.**

## Writing Rules

### Rule 1: Declarative, not narrative

❌ **Don't**: "The agent should try to understand constraints before making a plan."
✅ **Do**: "LIST the constraints (hard limits that cannot be violated)."

Narrative descriptions are aspirations. Declarative rules are instructions. The model follows instructions more reliably than aspirations.

### Rule 2: Make implicit things explicit

Every assumption left unstated is a gap the model fills with probability. If "a plan has phases" seems obvious, state it anyway — without stating it, the model may produce a flat list instead of a structured sequence.

### Rule 3: Consistent vocabulary across all layers

If the Cognitive Frame uses the word "constraints" and Domain Guidance uses "limitations," the model treats them as potentially different things. Use one term per concept across all layers. Two tiers: **wire formats** (the confidence scale, `needs_clarification`, SUMMARY fields) are engine-parsed contracts — treat them as an API and never rename them in a prompt edit; **editorial vocabulary** (constraints, assumptions, tradeoffs, verification) is enforced at review time by the Carren+Vera pipeline. The frame itself no longer carries a vocabulary table — consistency is an authoring discipline, not always-on frame content.

### Rule 4: Evidence-gated completion is unconditional

The What Done Requires contract has no priority override. No rule, instruction, or user request lets a "done" claim ship without evidence, lets exhaustion masquerade as success, or lets the pre-delivery Deliver check (does this response add information or progress?) be skipped. "Just do it" (Priority 3) skips clarification, not self-verification.

### Rule 5: Process-shaped, not output-shaped

Every rule must define a thinking step, not a desired output quality:

| Output-shaped (AVOID)   | Process-shaped (PREFER)                           |
| ----------------------- | ------------------------------------------------- |
| "Be accurate"           | "Never fabricate facts, sources, or results"      |
| "Be thorough"           | "Verify before delivering"                        |
| "Be clear"              | "Resolve ambiguity explicitly before proceeding"  |
| "Consider alternatives" | "When two approaches conflict, name the tradeoff" |

**Exception — the Who You Are identity clause.** Rule 5 governs *instructions and rules* (what to do), not *self-description* (who Penny is). The identity clause names Penny's role and character — e.g., "a personal AI assistant — adaptable to any domain or request." Descriptive identity traits there are self-description, not output-quality instructions, and MUST NOT be flagged as output-shaped. The process-shaped requirement still applies in full to the reasoning directives that follow the identity ("think in steps", "prefer reversible decisions", "name the tradeoff") — those are instructions and must stay process-shaped.

### Reasoning Models and Process-Shaped Steps

The frame's process-shaped rules are **single lightweight directives** ("surface constraints and success criteria before work", "verify before delivering"), never mandated multi-step reasoning scripts. This distinction matters for reasoning models (Claude extended thinking, DeepSeek reasoner, GLM/Kimi/MiniMax thinking modes): prescriptive process scaffolds are the technique class that goes neutral-to-negative on reasoning-native models — chain-of-thought prompting adds ~+12–14 points on math/symbolic but +0.7 points elsewhere and can be negative on thinking models (Sprague et al., ICLR 2025, arXiv:2409.12183; vendor guidance uniformly says don't CoT-prompt thinking models; see [Evidence Base](../../humans/prompts/evidence.md)). This is why the six-step RESTATE/IDENTIFY/LIST/LIST/SURFACE/FLAG sequence lives in the *on-demand* clarification protocol rather than the always-on frame (see Rule 7): the directive stays, the script loads only when its trigger fires.

**Monitoring (live, not aspirational):** degradation is measured, not awaited. The prompt-efficacy harness (`make evals-prompt-efficacy`; `scripts/system/evals/README.md` north star N6) runs the golden task set frame-on vs frame-off per model family. When a family's frame-on pass rate falls below frame-off beyond the noise margin, `prompt_efficacy.frame_regressed_families` fails the ratchet and the runner writes a CRITICAL `prompt_degradation_<family>_<date>` signal into penny/signals, which the session-start brief surfaces. On that signal: run the harness with `--ablate` to find the costly section, then simplify the process-shaped steps for that family (per-model variant per `plans/per-model-optimization/`) or — if the cost shows across families — simplify the frame itself through the human-gated change protocol below. Do not preemptively remove steps without a degradation measurement.

### Rule 6: Concrete verbs, not abstract nominalizations

❌ **Don't**: "Perform verification of the result before delivery."
✅ **Do**: "Verify the result before delivering."

A nominalization ("verification", "analysis", "decision") hides the action inside a noun, so the model interprets a topic instead of executing a step — the same failure as Rule 1 and Rule 5. Flag a weak verb (perform / conduct / provide / ensure) + `-tion`/`-ment`/`-ance` noun, or a "the {noun} of X" construction. Do not flag legitimate label or artifact nouns ("the analysis skill", "the specification"). See [Design Principles §10](../../humans/prompts/design-principles.md).

### Rule 7: Goals, constraints, and capabilities — never procedure (the Bitter-Lesson rule)

Frame text states **what must be true** (goals, constraints, consequence boundaries, wire formats) and **what exists** (capabilities); it never scripts **how to work** (step sequences, mandated orderings, reasoning recipes, workarounds for a past model's quirks). Procedure text is a bet against model improvement: it helps the current model and fights the next one.

❌ **Don't**: "Step 1: restate the goal. Step 2: identify the category. Step 3: …"
✅ **Do**: "Surface constraints and success criteria before work" (a constraint on outcomes, not a script).

Two consequences:

1. **Every frame line is a loan unless it is a consequence boundary, a conduit (verification, memory, escalation, delegation), or an engine-consumed wire format.** Before adding a line, ask the add-side gate question: *does this line gain or lose value as models improve?* If it loses — it compensates for a current-model weakness — it may ship only as a deliberate, temporary loan, and it is first in line for ablation at the next model upgrade.
2. **Ablate at model boundaries.** A model release is exactly when frame scaffolding becomes newly obsolete. Re-run the section ablation (`run_prompt_efficacy.py --ablate`) and delete sections that no longer earn their tokens. Deletion on measurement, not on taste — and never delete consequence boundaries (the security directives, the project-tree rule, HITL conditions), which are capability-invariant.

This rule reconciles with Rule 5 (process-shaped): a *single executable directive* ("verify before delivering") is process-shaped and compliant; a *mandated multi-step script* is procedure and is not. The line between them is whether the model retains freedom to choose its path. Full rationale: `research/atomic-loop-components/` (esp. 06-compliance.md).

## Token Budget

The `<system_context>` block (the always-on Cognitive Frame) must stay **≤1,500
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
concise declarative rule beats a narrative explanation. Trim ceremony first: the
inline vocabulary table and the always-on step protocol were both extracted this
way (Rule 7), with the capability preserved (review-enforced consistency; the
on-demand clarification protocol).

## The Clarification Protocol

The clarification protocol (RESTATE/IDENTIFY/LIST/LIST/SURFACE/FLAG) is the on-demand mechanism for resolving ambiguity. It lives in `docs/penny/clarification-protocol.md` and is activated via the **Ask vs. Act** section of SYSTEM.md — it is deliberately *not* an always-on frame protocol (prescriptive step scaffolds are the technique class that rots on reasoning-native models; see Rule 7). The Ask vs. Act activation condition stays inline in SYSTEM.md; the full 5-step protocol (identify knowns → surface assumptions → flag unknowns → classify BLOCKER/NAVIGABLE/IRRELEVANT → irreversibility check) is loaded via `read` when the gate activates.

Steps prevent misalignment (wrong goal, wrong category), define the solution space, and surface hidden risks. The protocol ends with a decision rule: ask only when a BLOCKER is present OR the action is irreversible.

## Compliance Checklist

Before modifying SYSTEM.md, verify every item:

- [ ] Who You Are section present (identity + reasoning stance)
- [ ] The Operating Bet present (ratchet on capabilities not implementations; the add-side gate; knobs over procedure)
- [ ] What Done Requires present (criteria-first, evidence-backed completion, honest exhaustion, strategy change on retry)
- [ ] Instruction Hierarchy defined with explicit priorities
- [ ] Signal Your Certainty present (verified ≠ likely ≠ need-to-check)
- [ ] Ask vs. Act present: clarification condition + mid-work escalation; names the clarification protocol by trigger (NO file path)
- [ ] Reach for Skills and Agents First present and mandatory (capability reasoning, not keyword-matching)
- [ ] Tools & Boundaries: lean core-tool list + the always-on output-file constraint (no tool-tactics detail, no doc paths)
- [ ] Deliver present (answer-first; response must add information or progress)
- [ ] On-Demand Protocols present (KG linking + compaction-resume trigger, named — NO file paths)
- [ ] **No file paths anywhere in `<system_context>`** — knowledge references live in the AGENTS.md index chain
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)
- [ ] Process-shaped throughout — no output-shaped phrasing in instructions/rules (Rule 5; the Who You Are identity clause is self-description and is exempt — see Rule 5 exception)
- [ ] No abstract nominalizations — concrete verbs in all instructions (Rule 6)
- [ ] No procedure scripts; every new line passed the add-side gate; loans are tagged for ablation (Rule 7)
- [ ] Security directives block unmodified (consequence boundary — never machine-edited, never trimmed)

## Change Protocol

Cognitive Frame changes affect every interaction. Follow this protocol:

1. **Audit impact**: Cognitive Frame changes propagate to all agents and all domains. Estimate blast radius before changing.
2. **Test before deploying**: Use a single test domain first. Verify no regression in agent behavior.
3. **Update references**: If you change any cross-layer term — above all an engine-parsed wire format (confidence scale, `needs_clarification`, SUMMARY fields) — search all Role Definition, Domain Guidance, and Invocation Context files for the old terms and update them, and confirm `contracts.py` still parses.
4. **Update this checklist**: If you add a new required section, add it to the compliance checklist above.
5. **Record the change**: Store a session note in mempalace explaining what changed and why.

### Changes that do NOT require audit

- Fixing typos
- Clarifying declarative rules without changing semantics

### Changes that DO require audit

- Adding, removing, or reordering any section
- Changing Instruction Hierarchy priorities
- Modifying the certainty vocabulary or any engine-consumed wire format
- Modifying What Done Requires or Deliver items
- Changing the Who You Are identity
- Any change to The Operating Bet (it encodes the ratchet doctrine)

Every audited change also runs the prompt-efficacy harness (`make evals`): `frame_on_pass_rate` must not regress and `frame_regressed_families` must stay empty. FR-19 auto-invalidates the eval on any SYSTEM.md hash change, so skipping this step leaves a red ratchet.

### Enforcement: Carren Critique + Vera Verification

Compliance checklists are enforced by **review, not by a linter** — a suffix-based automated check produces too many false positives on legitimate domain nouns to be useful. Instead, prompt changes go through a two-agent enforcement pipeline:

1. **Carren critiques** (model: `deepseek-v4-pro:cloud` — MUST differ from the model that authored the prompt). Carren reviews the changed prompt against every applicable compliance checklist item, flagging violations of declarative rules, process-shaped phrasing, and abstract nominalizations.
2. **Corrections are applied** based on Carren's critique.
3. **Vera verifies** (model: `glm-5.2:cloud`) that each correction actually resolves the cited violation without introducing new violations. Vera judges each corrected item as PASS or FAIL against the compliance checklist.

See [Architecture §Enforcement](architecture.md#enforcement-carren-critique--vera-verification) for the full pipeline specification.

This applies to changes at every layer: Cognitive Frame (`SYSTEM.md`), Role Definition (`.pi/agents/*.md`), and Domain Guidance (`.pi/skills/*/assets/prompts/*.md`).
