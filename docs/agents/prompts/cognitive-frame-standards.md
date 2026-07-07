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

| Subsection                         | Purpose                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| **Who You Are** (+ Before You Act) | Identity, reasoning stance, and the pre-action protocol                                      |
| **Instruction Hierarchy**          | Conflict resolution for competing rules                                                      |
| **Confidence Levels**              | How to declare uncertainty                                                                   |
| **Canonical Vocabulary**           | Cross-layer term consistency                                                                 |
| **Ambiguity Gate**                 | When to activate structured clarification (names the protocol; path resolves via the index)  |
| **Route to the Right Abstraction** | The delegation decision (skill / agent / direct)                                             |
| **Tools**                          | Lean core-tool list + the always-on "no output files in the project tree" rule               |
| **Output Contract**                | What every response must include (with the pre-delivery confirm)                             |
| **On-Demand Protocols**            | Trigger→action for KG linking and compaction resume (names each; paths resolve via the index) |

Sections consolidate over time — the invariant is not a fixed list but that every subsection is universal reasoning with no reference paths.

### 3. Tools and guidelines (Authored)

Only the lean core-tool list and the one always-on output-file constraint are authored inline (Pi does not inject tool definitions when a custom prompt is present). Detailed tool-usage tactics and Pi documentation references are NOT in the frame — they live in `docs/penny/tool-usage.md` and the root `AGENTS.md`, resolved on demand through the index chain.

## What Belongs in the Cognitive Frame

- **Identity**: Who Penny is (human-facing name for warmth, process role for reasoning)
- **Mission**: The single declarative rule governing all behavior
- **Cognitive protocols**: Ambiguity Gate activation steps, Delivery Checklist
- **Instruction hierarchy**: Priority table for conflict resolution
- **Self-verification checkpoint**: Unconditional quality gate
- **Confidence level requirements**: How to declare certainty
- **Canonical vocabulary**: Cross-layer term definitions
- **Output contract**: What every response must include

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

If the Cognitive Frame uses the word "constraints" and Domain Guidance uses "limitations," the model treats them as potentially different things. Use the Canonical Vocabulary table as the single source of truth. All layers must use the same terms.

### Rule 4: Self-verification is unconditional

The Delivery Checklist has no priority override. No rule, instruction, or user request can skip it. This is the safety net that catches reasoning gaps before delivery.

### Rule 5: Process-shaped, not output-shaped

Every rule must define a thinking step, not a desired output quality:

| Output-shaped (AVOID)   | Process-shaped (PREFER)                           |
| ----------------------- | ------------------------------------------------- |
| "Be accurate"           | "Never fabricate facts, sources, or results"      |
| "Be thorough"           | "Verify before delivering"                        |
| "Be clear"              | "Resolve ambiguity explicitly before proceeding"  |
| "Consider alternatives" | "When two approaches conflict, name the tradeoff" |

### Reasoning Models and Process-Shaped Steps

The Before Responding Protocol (RESTATE, IDENTIFY, LIST, SURFACE, FLAG) and other process-shaped steps are **lightweight cognitive directives**, not heavy step-by-step reasoning prescriptions. They tell the model *what cognitive operations to perform*, not *how to perform them internally*. This distinction matters for reasoning models (Claude extended thinking, DeepSeek reasoner, GLM/Kimi/MiniMax thinking modes): prescriptive process scaffolds are the technique class that goes neutral-to-negative on reasoning-native models — chain-of-thought prompting adds ~+12–14 points on math/symbolic but +0.7 points elsewhere and can be negative on thinking models (Sprague et al., ICLR 2025, arXiv:2409.12183; vendor guidance uniformly says don't CoT-prompt thinking models; see [Evidence Base](../../humans/prompts/evidence.md)). Lightweight cognitive directives ("surface your assumptions before proceeding") are the surviving form.

**Monitoring (live, not aspirational):** degradation is measured, not awaited. The prompt-efficacy harness (`make evals-prompt-efficacy`; `scripts/system/evals/README.md` north star N6) runs the golden task set frame-on vs frame-off per model family. When a family's frame-on pass rate falls below frame-off beyond the noise margin, `prompt_efficacy.frame_regressed_families` fails the ratchet and the runner writes a CRITICAL `prompt_degradation_<family>_<date>` signal into penny/signals, which the session-start brief surfaces. On that signal: run the harness with `--ablate` to find the costly section, then simplify the process-shaped steps for that family (per-model variant per `plans/per-model-optimization/`) or — if the cost shows across families — simplify the frame itself through the human-gated change protocol below. Do not preemptively remove steps without a degradation measurement.

### Rule 6: Concrete verbs, not abstract nominalizations

❌ **Don't**: "Perform verification of the result before delivery."
✅ **Do**: "Verify the result before delivering."

A nominalization ("verification", "analysis", "decision") hides the action inside a noun, so the model interprets a topic instead of executing a step — the same failure as Rule 1 and Rule 5. Flag a weak verb (perform / conduct / provide / ensure) + `-tion`/`-ment`/`-ance` noun, or a "the {noun} of X" construction. Do not flag legitimate label or artifact nouns ("the analysis skill", "the specification"). See [Design Principles §10](../../humans/prompts/design-principles.md).

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
concise declarative rule beats a narrative explanation. The Canonical Vocabulary
table (~160 tokens) stays inline: it is universal and critical for cross-layer
term consistency.

## The Clarification Protocol

The clarification protocol (RESTATE/IDENTIFY/LIST/LIST/SURFACE/FLAG) is the core cognitive mechanism for resolving ambiguity. It lives in `docs/penny/clarification-protocol.md` and is activated via the Ambiguity Gate section of SYSTEM.md. The Ambiguity Gate activation condition stays inline in SYSTEM.md; the full 5-step protocol (identify knowns → surface assumptions → flag unknowns → classify BLOCKER/NAVIGABLE/IRRELEVANT → irreversibility check) is loaded via `read` when the gate activates.

Steps prevent misalignment (wrong goal, wrong category), define the solution space, and surface hidden risks. The protocol ends with a decision rule: ask only when a BLOCKER is present OR the action is irreversible.

## Compliance Checklist

Before modifying SYSTEM.md, verify every item:

- [ ] Who You Are section present (identity + reasoning + Before You Act)
- [ ] Canonical Vocabulary table present
- [ ] Instruction Hierarchy defined with explicit priorities
- [ ] Confidence Levels enforcement rule present
- [ ] Ambiguity Gate activation condition present; names the clarification protocol by trigger (NO file path)
- [ ] Route to the Right Abstraction present and mandatory
- [ ] Tools: lean core-tool list + the always-on output-file constraint (no tool-tactics detail, no doc paths)
- [ ] Output Contract defined (with the pre-delivery confirm)
- [ ] On-Demand Protocols present (KG linking + compaction-resume trigger, named — NO file paths)
- [ ] **No file paths anywhere in `<system_context>`** — knowledge references live in the AGENTS.md index chain
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)
- [ ] Process-shaped throughout — no output-shaped phrasing (Rule 5)
- [ ] No abstract nominalizations — concrete verbs in all instructions (Rule 6)

## Change Protocol

Cognitive Frame changes affect every interaction. Follow this protocol:

1. **Audit impact**: Cognitive Frame changes propagate to all agents and all domains. Estimate blast radius before changing.
2. **Test before deploying**: Use a single test domain first. Verify no regression in agent behavior.
3. **Update references**: If you change terminology in the Canonical Vocabulary table, search all Role Definition, Domain Guidance, and Invocation Context files for the old terms and update them.
4. **Update this checklist**: If you add a new required section, add it to the compliance checklist above.
5. **Record the change**: Store a session note in mempalace explaining what changed and why.

### Changes that do NOT require audit

- Fixing typos
- Adding Canonical Vocabulary entries
- Clarifying declarative rules without changing semantics

### Changes that DO require audit

- Adding, removing, or reordering any section
- Changing Instruction Hierarchy priorities
- Modifying Confidence Levels
- Modifying Delivery Checklist items
- Changing the Who You Are identity

### Enforcement: Carren Critique + Vera Verification

Compliance checklists are enforced by **review, not by a linter** — a suffix-based automated check produces too many false positives on legitimate domain nouns to be useful. Instead, prompt changes go through a two-agent enforcement pipeline:

1. **Carren critiques** (model: `deepseek-v4-pro:cloud` — MUST differ from the model that authored the prompt). Carren reviews the changed prompt against every applicable compliance checklist item, flagging violations of declarative rules, process-shaped phrasing, and abstract nominalizations.
2. **Corrections are applied** based on Carren's critique.
3. **Vera verifies** (model: `glm-5.2:cloud`) that each correction actually resolves the cited violation without introducing new violations. Vera judges each corrected item as PASS or FAIL against the compliance checklist.

See [Architecture §Enforcement](architecture.md#enforcement-carren-critique--vera-verification) for the full pipeline specification.

This applies to changes at every layer: Cognitive Frame (`SYSTEM.md`), Role Definition (`.pi/agents/*.md`), and Domain Guidance (`.pi/skills/*/assets/prompts/*.md`).
