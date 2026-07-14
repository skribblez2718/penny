# Prompt Layer Architecture

How Penny's system prompts are structured, assembled, and the rules governing each layer.

**Definitive reference:** [Layer Reference](layer-reference.md) defines every named layer, its responsibilities, when it's active, and cross-layer rules. This document covers the assembly mechanism and compliance.

## Named Layers

Penny's prompt architecture uses **named layers**, not numbered layers. Numbers conflate scope and injection order while obscuring function. Names describe what each layer does.

| Layer                  | Function                | Active When       | Source                             |
| ---------------------- | ----------------------- | ----------------- | ---------------------------------- |
| **Cognitive Frame**    | How to think            | Always            | `.pi/SYSTEM.md`                    |
| **Role Definition**    | Who I am                | Skill invocations | `.pi/agents/*.md`                  |
| **Domain Guidance**    | How to think about this | Skill invocations | `.pi/skills/*/assets/prompts/*.md` |
| **Project Index**      | Where things are        | Always            | `AGENTS.md` files (Pi)             |
| **Invocation Context** | What to do now          | Always            | Task message + Pi runtime          |

Full definitions, responsibilities, and interaction circumstances: [Layer Reference](layer-reference.md).

## Assembly Pipeline

### Direct Conversation (Most Common)

```
Pi framework:
  1. Loads SYSTEM.md (customPrompt)           ← Cognitive Frame
  2. Appends AGENTS.md files from cwd up       ← Project Index
  3. Appends Skills section                    ← Project Index
  4. Appends date/cwd                          ← Invocation Context

Environment extension:
  5. Appends <system_boundary>                  ← Security boundary

User:
  6. Types message                             ← Invocation Context (the goal)
```

**Layers present:** Cognitive Frame + Project Index + Invocation Context.
**Layers absent:** Role Definition, Domain Guidance (no agent or skill active).

### Skill Invocation (Subagent)

```
Pi framework:
  1. Loads SYSTEM.md (customPrompt)             ← Cognitive Frame

Subagent extension:
  2. Reads agent file (.pi/agents/<name>.md)    ← Role Definition
  3. Reads skill prompt (if skillContext given)  ← Domain Guidance
  4. Combines: agent body + <skill_context> + <agent_boundary>
  5. Writes to temp file → --append-system-prompt

Pi framework:
  6. Appends AGENTS.md files from cwd up         ← Project Index
  7. Appends Skills section                      ← Project Index
  8. Appends date/cwd                            ← Invocation Context

Environment extension:
  9. Appends <system_boundary>                   ← Security boundary

Orchestrator (orchestrate.py):
  10. Constructs task message                    ← Invocation Context (the goal)
```

**Layers present:** All five.

### Combined Prompt Structure (Skill Invocation)

```
SYSTEM.md (customPrompt) — Authored content, used verbatim by Pi
├── <system_directives>              ← Immutable security rules (authored)
├── <system_context>                 ← Cognitive Frame (authored)
├── Tools, Guidelines, Pi docs       ← Operational reference (authored)
│
│   ┌─ --append-system-prompt ────┐
│   ├── Agent body                │  ← Role Definition
│   ├── <skill_context>           │  ← Domain Guidance
│   │   (domain checklists,      │
│   │    session instructions,   │
│   │    output formats)          │
│   ├── </skill_context>          │
│   ├── <agent_boundary>          │  ← Security marker
│   │   SECURITY REINFORCEMENT   │
│   └─────────────────────────────┘
│
│   ┌─ Pi auto-appends ──────────┐
│   ├── AGENTS.md context        │  ← Project Index
│   ├── Skills section           │  ← Project Index
│   ├── Date / cwd               │  ← Invocation Context
│   └─────────────────────────────┘
│
├── <system_boundary>               ← Security boundary (environment extension)
│
│   User message: "Task: ..."       ← Invocation Context (the goal)
```

## Prompt Assembly Code Path

The subagent extension assembles prompts as follows:

```typescript
// From subagent/index.ts:
let combinedPrompt = agent.systemPrompt; // Agent body from .pi/agents/*.md

// Inject skill context BEFORE <agent_boundary>
if (skillContextContent) {
  const boundaryIdx = combinedPrompt.indexOf("<agent_boundary>");
  if (boundaryIdx !== -1) {
    combinedPrompt =
      combinedPrompt.substring(0, boundaryIdx) +
      `\n<skill_context>\n${skillContextContent}\n</skill_context>\n\n` +
      combinedPrompt.substring(boundaryIdx);
  }
}

// Pass via --append-system-prompt (appended to SYSTEM.md)
args.push("--append-system-prompt", tmpPromptPath);
```

## Token Budgets

All layer token counts are measured with **tiktoken** (`cl100k_base`) — the one
canonical token counter (see `scripts/system/checks/check_token_budget.py`).
Because Penny runs a variety of models whose tokenizers differ, these counts are a
consistent approximation, not exact per-model figures. Never use a word-count
heuristic — markdown tables tokenize very differently from prose.

The Cognitive Frame is the **always-on** layer — injected into every Penny turn and
every subagent invocation — so it is the most-multiplied text in the system and is
kept the leanest. It is the only layer with a CI-enforced gate.

| Layer                                      | Budget        | Rationale                                                     |
| ------------------------------------------ | ------------- | ------------------------------------------------------------- |
| Cognitive Frame (SYSTEM.md system_context) | ≤1,500 tokens | Always-on + multiplied across every subagent — CI-enforced   |
| Role Definition (agent def)                | ≤1,200 tokens | Role-specific rules must be lean                              |
| Domain Guidance (skill prompt)             | ≤1,000 tokens | Domain guidance, not repetition                              |
| Total system prompt                        | ≤3,000 tokens | ~1.5% of a 200K window for instructions                      |

**There is no hard token cliff at any small number.** Modern long-context models
tolerate multi-thousand-token system prompts; published degradation findings are
positional and much larger-scale — the U-shaped "lost in the middle" effect (Liu
et al., TACL 2024, arXiv:2307.03172) and long-context rot at tens-of-thousands of
tokens — and what actually governs adherence is structure and position
(front-load critical rules, avoid contradiction), not raw token count. See the
[Evidence Base](../../humans/prompts/evidence.md). The 1,500-token cap is
therefore an engineering **forcing-function**, not a model limit: it keeps the
always-on layer lean and pushes non-universal content out, rather than a claim
about where a model breaks. Whether each section of the frame *earns* its share
of the budget is measured by section ablation
(`run_prompt_efficacy.py --ablate`), not asserted.

**Staying under budget:** keep only universal, always-needed cognitive content in
`<system_context>`. Move conditionally-needed or Penny-operational content into
`docs/penny/` and reference it for on-demand `read` — the **extraction pattern**
(see `docs/penny/AGENTS.md`). Remove elaboration before removing rules.

## Conflict Resolution

When layers conflict, the Instruction Hierarchy in Cognitive Frame resolves:

| Priority         | Rule                              | Example Conflict                                                      |
| ---------------- | --------------------------------- | --------------------------------------------------------------------- |
| 1 — Truth        | Never fabricate                   | "Just give me an answer" → still verify                               |
| 2 — Clarity      | Resolve ambiguity first           | Domain Guidance says "don't ask" but there's critical ambiguity → ask |
| 3 — User intent  | "Just do it" → execute directly   | User says "skip questions" → skip clarification                       |
| 4 — Thoroughness | Verify before delivering          | —                                                                     |

## Compliance Checklists

### Cognitive Frame (SYSTEM.md)

The canonical section-by-section checklist lives in [Cognitive Frame Standards](cognitive-frame-standards.md#compliance-checklist) — that is the single source of truth. The structural invariants:

- [ ] ≤1,500 tokens for `system_context` (tiktoken `cl100k_base`, via `check_token_budget.py`)
- [ ] All rules are declarative (imperative verbs), not narrative
- [ ] All sections state goals, constraints, capabilities, or wire formats — no procedure scripts (Rule 7, the Bitter-Lesson rule)
- [ ] What Done Requires present: evidence-backed completion, honest exhaustion, strategy change on retry
- [ ] The Operating Bet present: ratchet on capabilities, add-side gate, knobs over procedure
- [ ] Ask vs. Act present: clarification condition + mid-work escalation, protocol named by trigger
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)
- [ ] No file paths in `<system_context>`; security directives block untouched
- [ ] Change shipped through the prompt-efficacy gate (`frame_on_pass_rate` no-regress, `frame_regressed_families` empty)

### Role Definition (Agent Definitions)

- [ ] YAML frontmatter `tools:` field declares all tools (single source of truth — Pi parses and passes to `--tools`)
- [ ] No repeated Cognitive Frame rules (the old "Alignment with System Rules" restatement pattern is retired — do not reintroduce it)
- [ ] No contradictions with Cognitive Frame
- [ ] Purpose defines the cognitive domain, what the agent does NOT do, and the domain-agnostic clause (criteria come from Domain Guidance)
- [ ] Working Discipline present: mempalace-first + role honesty rule + confidence wire format + `needs_clarification` escalation (see [Role & Domain Standards](role-and-domain-standards.md#working-discipline-pattern))
- [ ] Non-Negotiables are outcomes/constraints only — consequence boundaries, evidence contracts, honesty contracts; no how-to-work procedure
- [ ] Wire formats (confidence vocab, `needs_clarification`, SUMMARY shape) exactly match the engine contract — never renamed in a prompt edit
- [ ] Output section states the generic shape only; exact schema from Domain Guidance
- [ ] `<agent_boundary>` security marker present and byte-preserved
- [ ] All rules are declarative (imperative verbs), not narrative
- [ ] Process-shaped cognitive instructions — no output-shaped phrasing (output format specification is output-shaped by design; see note under Domain Guidance)
- [ ] No abstract nominalizations — concrete verbs in all instructions

### Domain Guidance (Skill Prompts)

- [ ] No repeated Cognitive Frame or Role Definition rules
- [ ] No "Do NOT ask for more information" (use hierarchy-compliant language)
- [ ] Domain checklists present (CREST-derived or equivalent)
- [ ] Session context instructions present (session IDs, mempalace rooms)
- [ ] Mempalace instructions present
- [ ] Output format specifies what goes to mempalace vs. what goes to summary
- [ ] All cognitive instructions are declarative (imperative verbs), not narrative
- [ ] Process-shaped cognitive instructions — no output-shaped phrasing (see note below)
- [ ] No abstract nominalizations — concrete verbs in all instructions

### Process-Shaped vs Output-Shaped: Scope Clarification

The compliance checklist item "Process-shaped throughout — no output-shaped phrasing" applies to **cognitive instructions** — the CREST tables, checklists, review dimensions, analysis workflows, and domain-specific rules that tell the model *how to think* about the domain. These must be process-shaped: executable steps, not quality aspirations.

The **Output Format specification** (field names, SUMMARY JSON schema, output structure) is inherently output-shaped by design. It defines *what to produce* (a structural contract), not *what quality to aim for* (an aspiration). This is the same conditional pattern as the Invocation Context being output-shaped by design. The distinction:

| Type | Shape | Example | Correct? |
|------|-------|---------|----------|
| Cognitive instruction | Process-shaped | "Trace backward to see if input comes from an attacker-controllable source" | ✅ |
| Output format specification | Output-shaped (by design) | "Output Format: Goal Restatement, High-Signal Findings, Key Information" | ✅ |
| Quality aspiration | Output-shaped (WRONG) | "Be thorough in your analysis" | ❌ |

The checklist bans the third row (quality aspirations). The second row (format specifications) is correct and expected. See [Design Principles §1: Scope](../../humans/prompts/design-principles.md#scope-which-layers-this-principle-applies-to) for the full layer-by-layer breakdown.

### Project Index (AGENTS.md Files)

- [ ] Index only — no rules, no standards, no content, no cross-cutting references
- [ ] Every referenced file actually exists at the listed path
- [ ] Every file in the directory appears in the index (no orphans)
- [ ] Descriptions are one line only
- [ ] Updated immediately on any documentation change

### Invocation Context (Task Messages)

- [ ] Goal clearly stated
- [ ] Session ID and mempalace room included
- [ ] No Cognitive Frame or Role Definition rules restated
- [ ] No template variables (`{{...}}`)
- [ ] Under 100 tokens for `task_summary`

## Enforcement: Carren Critique + Vera Verification

Compliance checklists are enforced by **review, not by a linter** — a suffix-based automated check produces too many false positives on legitimate domain nouns (e.g., "the analysis skill", "the specification") to be useful. Instead, prompt changes go through a two-agent enforcement pipeline:

### Pipeline

```
Prompt authored/modified (any layer)
    → Carren critiques against compliance checklists
        (model MUST differ from the one that authored the prompt)
    → Corrections applied based on Carren's findings
    → Vera verifies each correction resolves the cited violation
        without introducing new violations
    → PASS → merge; FAIL → repeat from corrections
```

### Roles

| Step | Agent | Model | Responsibility |
|------|-------|-------|----------------|
| **Critique** | Carren | `deepseek-v4-pro:cloud` | Review the changed prompt against every applicable compliance checklist item. Flag violations of declarative rules, process-shaped phrasing, and abstract nominalizations with specific line references and suggested fixes. |
| **Verify** | Vera | `glm-5.2:cloud` | Judge each corrected item as PASS or FAIL against the compliance checklist. A correction PASSES only if it resolves the cited violation without introducing a new one. FAIL → return to corrections. |

### Why Not a Linter

A nominalization check based on suffixes (`-tion`, `-ment`, `-ance`) flags too many legitimate domain nouns ("the analysis skill", "the verification agent", "a requirement") to produce actionable signal. The Carren+Vera pipeline uses model judgment to distinguish "perform verification of the result" (a hidden action — flag) from "the verification agent" (a label — don't flag). This is the same judgment the compliance checklists require for declarative and process-shaped rules, which also resist automated detection.

### When to Apply

Apply the pipeline to any change that adds, modifies, or reorders rules in:

- **Cognitive Frame** (`.pi/SYSTEM.md`) — all compliance checklist items
- **Role Definition** (`.pi/agents/*.md`) — all compliance checklist items
- **Domain Guidance** (`.pi/skills/*/assets/prompts/*.md`) — all compliance checklist items

Typos, canonical vocabulary additions, and clarifications that don't change semantics do not require the full pipeline (per the [Change Protocol in cognitive-frame-standards.md](cognitive-frame-standards.md#change-protocol)).

### What Carren Checks

For each compliance checklist, Carren evaluates:

1. **Declarative**: Is every rule an imperative verb instruction, not aspirational narrative? (❌ "The agent should try to understand constraints" → ✅ "LIST the constraints")
2. **Process-shaped**: Does every cognitive instruction define a thinking step, not a desired output quality? (❌ "Be thorough" → ✅ "Verify before delivering"). Note: Output Format specifications (field names, SUMMARY schemas) are output-shaped by design — they are structural contracts, not cognitive instructions, and are not violations.
3. **No nominalizations**: Does every instruction name its action with a concrete verb, not hide it inside an abstract noun? (❌ "Perform verification of the result" → ✅ "Verify the result")

### What Vera Verifies

For each correction Carren flagged:

1. Does the corrected text resolve the specific violation type (declarative / process-shaped / nominalization)?
2. Does the corrected text introduce any new violation of the same type or a different type?
3. Does the corrected text preserve the original semantic intent?

All three must be PASS for the correction to be accepted. Any FAIL → return to corrections with Vera's specific objections.
