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

This is the authored authored Cognitive Frame content. Required subsections in order:

| Subsection                           | Purpose                                                |
| ------------------------------------ | ------------------------------------------------------ |
| **Who You Are**                  | Identity + reasoning style merged — who Penny is and how she thinks |
| **Canonical Vocabulary**                          | Cross-layer term consistency                           |
| **Instruction Hierarchy**            | Conflict resolution for competing rules                |
| **Confidence Levels** | How to declare uncertainty                             |
| **Ambiguity Gate** | When to activate structured clarification              |
| **Route to the Right Abstraction** | Routing rule for agent/skill delegation |
| **Available Tools** | Tool inventory |
| **Guidelines** | Operational guidelines for tool usage |
| **Pi Documentation** | Pi docs reference paths |
| **Delivery Checklist**     | Unconditional quality gate before delivery             |
| **Output Contract**                  | What every response must include                       |
| **Knowledge Graph Integration** | Post-task entity linking |

### 3. Tool and Guideline Sections (Authored)

Tool lists, operational guidelines, and Pi documentation references. Authored in SYSTEM.md under relevant section headers. Pi does not inject tool definitions when a custom prompt is present — all tool/guideline content must be authored directly.

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

## Token Budget

| Component                            | Target       | Current         | Status         |
| ------------------------------------ | ------------ | --------------- | -------------- |
| `system_context` section only        | ≤800 tokens  | ~916 tokens     | ⚠️ Over budget |
| Total `<system_context>` tag content | ≤1200 tokens | ~916 tokens     | ✅ Within      |
| Total system prompt (all layers)     | ≤3000 tokens | Varies by agent | ✅ within      |

The 800-token target for `system_context` is based on research showing instruction adherence degrades above ~800 tokens per section. Current content is ~15% over this target. The Canonical Vocabulary table contributes ~136 tokens but is critical for cross-layer consistency — documented deviation.

When cutting tokens, remove elaboration before removing rules. A concise declarative rule is better than a detailed narrative explanation.

## The Clarification Protocol

The clarification protocol (RESTATE/IDENTIFY/LIST/LIST/SURFACE/FLAG) is the core cognitive mechanism for resolving ambiguity. It lives in `docs/penny/clarification-protocol.md` and is activated via the Ambiguity Gate section of SYSTEM.md. The Ambiguity Gate activation condition stays inline in SYSTEM.md; the full 5-step protocol (identify knowns → surface assumptions → flag unknowns → classify BLOCKER/NAVIGABLE/IRRELEVANT → irreversibility check) is loaded via `read` when the gate activates.

Steps prevent misalignment (wrong goal, wrong category), define the solution space, and surface hidden risks. The protocol ends with a decision rule: ask only when a BLOCKER is present OR the action is irreversible.

## Compliance Checklist

Before modifying SYSTEM.md, verify every item:

- [ ] Who You Are section present (identity + reasoning merged)
- [ ] Canonical Vocabulary table present
- [ ] Instruction Hierarchy defined with explicit priorities
- [ ] Confidence Levels enforcement rule present
- [ ] Ambiguity Gate activation condition + reference to clarification protocol
- [ ] Route to the Right Abstraction present and mandatory
- [ ] Available Tools and Guidelines present and accurate
- [ ] Pi Documentation reference paths present
- [ ] Delivery Checklist present and unconditional
- [ ] Output Contract defined
- [ ] Knowledge Graph Integration directive present
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)

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
