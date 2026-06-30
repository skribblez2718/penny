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

Research (iBuidl 2026) shows instruction adherence degrades above 800 tokens. Our budgets:

| Layer                                      | Target        | Rationale                           |
| ------------------------------------------ | ------------- | ----------------------------------- |
| Cognitive Frame (SYSTEM.md system_context) | ≤800 tokens   | Peak adherence per research         |
| Role Definition (agent def)                | ≤1,200 tokens | Role-specific rules must be lean    |
| Domain Guidance (skill prompt)             | ≤1,000 tokens | Domain guidance, not repetition     |
| Total system prompt                        | ≤3,000 tokens | ~5% of 200K window for instructions |

Current SYSTEM.md system_context: ~911 tokens ⚠️ (over 800 budget — Canonical Vocabulary adds ~100 tokens critical for cross-layer consistency)

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

- [ ] ≤800 tokens for `system_context` section (or justified exception)
- [ ] All rules are declarative (imperative verbs), not narrative
- [ ] Who You Are section present (identity + reasoning merged)
- [ ] Canonical Vocabulary present
- [ ] Instruction Hierarchy defined with explicit priorities
- [ ] Confidence Levels enforcement rule present
- [ ] Ambiguity Gate activation condition + protocol reference present
- [ ] Route to the Right Abstraction present and mandatory
- [ ] Delivery Checklist present and unconditional
- [ ] Output Contract defined
- [ ] No domain-specific content (no CREST tables, no agent roles, no checklists)
- [ ] Process-shaped throughout — no output-shaped phrasing

### Role Definition (Agent Definitions)

- [ ] YAML frontmatter `tools:` field declares all tools (single source of truth — Pi parses and passes to `--tools`)
- [ ] No repeated Cognitive Frame rules (reference, don't restate)
- [ ] No contradictions with Cognitive Frame
- [ ] Purpose section defines role (what this agent IS and DOES)
- [ ] Mempalace-First Protocol present (or equivalent read/write cycle)
- [ ] Alignment with System Rules section present
- [ ] Role-specific Non-Negotiable Rules (only rules Cognitive Frame doesn't cover)
- [ ] Output Format section present
- [ ] `<agent_boundary>` security marker present

### Domain Guidance (Skill Prompts)

- [ ] No repeated Cognitive Frame or Role Definition rules
- [ ] No "Do NOT ask for more information" (use hierarchy-compliant language)
- [ ] Domain checklists present (CREST-derived or equivalent)
- [ ] Session context instructions present (session IDs, mempalace rooms)
- [ ] Mempalace instructions present
- [ ] Output format specifies what goes to mempalace vs. what goes to summary

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
