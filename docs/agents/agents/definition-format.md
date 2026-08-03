# Agent Definition Format — Structure and compliance for agent files

## What

Every agent definition (`.pi/agents/<name>.md`) follows a canonical structure: YAML frontmatter, Purpose, Working Discipline, Non-Negotiables, Output, and `<agent_boundary>`.

## Why

Consistent agent structure enables the subagent extension to parse frontmatter for tool declarations and inject the body as Role Definition. Deviation breaks tool access and prompt assembly.

## Rules

1. **YAML frontmatter with `tools:` field.** Single source of truth for tool access. Pi parses this and passes to `--tools`.
2. **Canonical description pattern.** `description` must follow: `[One sentence defining the agent]. Use when [trigger conditions + 5–8 signal phrases the user actually says]. Do not use when [other agents' domains — name who to use instead].` The signal phrases (e.g., "analyze", "look into", "poke holes") are load-bearing: they are what the orchestrator matches against for proactive routing. Prefer situation/trigger framing over abstract capability nouns.
3. **Purpose section.** The agent's cognitive domain: what it IS and DOES, what it does NOT do, plus the domain-agnostic clause (criteria come from Domain Guidance — never embedded).
4. **Working Discipline.** Compact wire-format block: mempalace-first, one role honesty rule, the confidence vocabulary, `needs_clarification` escalation. Nothing else — frame disciplines are not restated per agent.
5. **Non-Negotiables.** Only durable rules Cognitive Frame doesn't cover, phrased as outcomes and constraints (consequence boundaries, evidence contracts, honesty contracts) — never how-to-work procedure.
6. **Output.** Generic shape only; exact schema comes from Domain Guidance.
7. **`<agent_boundary>` at end.** Security marker required, byte-preserved across edits.

## Required Sections

```markdown
---
name: agent-name
description: "[One sentence]. Use when [trigger conditions + signal phrases]. Do not use when [other agents' domains — use X instead]."
tools: tool1, tool2, memory_smart_search, memory_add_drawer, memory_check_duplicate, memory_kg_add
model: model-name
---

## Purpose
Cognitive domain + what this agent does NOT do. Criteria, rubrics, and schemas come from Domain Guidance — never embedded here.

## Working Discipline
- **Mempalace-first**: read from mempalace; write full output to mempalace; return only the minimal SUMMARY.
- **[Role honesty rule]**: the one evidence/honesty contract this role lives by.
- **Confidence is a wire format**: CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN; CERTAIN requires direct evidence.
- **Escalate, don't guess**: signal `needs_clarification` in the SUMMARY when inputs are missing.

## Non-Negotiables
1. **RULE-NAME** — outcome or constraint only this agent needs.

## Output
Generic shape; exact schema per Domain Guidance.

<agent_boundary>
```

## Frontmatter Field Constraints

The four frontmatter fields have hard limits and selection guidance. Violations break
prompt assembly or tool access silently.

| Field | Constraint | Guidance |
|-------|-----------|----------|
| `name` | Lowercase, alphanumeric + hyphens, 1–64 chars. Must match the filename (`.pi/agents/<name>.md`) and the containing directory if one exists. | Single word preferred; the name is what callers pass to `subagent({ agent })`. |
| `description` | 1–1024 chars. Must follow the canonical description pattern in Rule 2. | Describes what the agent IS and DOES, plus trigger/signal phrases — this is the string the orchestrator routes on. |
| `tools` | **Comma-delimited** list drawn from the available tool set. All four memory tools are mandatory. | Match tools to the role — grant no more than the role needs. A read-only reviewer must not carry `write`/`edit`; unnecessary `bash` widens the blast radius. |
| `model` | A model name the runtime resolves. | Weigh cost against generative load: cheaper/faster models suit narrow, mechanical, or read-only roles; stronger models suit open-ended generative and judgment-heavy roles. This is guidance, not a rule — a read-only role doing hard reasoning still warrants a strong model. |

## Constraints

- **No Cognitive Frame repeats.** Reference, don't restate. The retired "Alignment with System Rules" restatement pattern must not be reintroduced.
- **Outcomes and constraints, never procedure.** A rule states what must hold ("every write leaves a complete, valid file"), not how to work ("use edit for X, write for Y"). How-to-work text is a loan against the next model release.
- **No domain-specific content.** Checklists and CREST tables belong in Domain Guidance.
- **No contradictions with Cognitive Frame.** "Do NOT ask" conflicts with Priority 2 (Clarity).
- **Concrete verbs, not nominalized actions.** Write "Identify gaps," not "responsible for the identification of gaps." See [Design Principles §10](../../humans/prompts/design-principles.md).
- **All four memory tools required** — canonical list + rationale in [memory/integration.md](../memory/integration.md#base-tool-set) (the frontmatter example above shows the names).
- **Never write output to the project tree.** Agents with `write`/`edit`/`bash` tools must write output files to `/tmp/` or mempalace, never to the project directory, unless the task explicitly specifies a project path.

## Canonical Vocabulary

Agent-specific terms. Rows marked in the SUMMARY JSON are **engine-parsed wire formats** — treat them as an API; never rename them in a prompt edit. (The frame no longer carries a system-wide vocabulary table; term consistency is review-enforced — see [Cognitive Frame Standards Rule 3](../prompts/cognitive-frame-standards.md).)

| Term | Definition | Code Binding | Do NOT substitute |
|------|-----------|-------------|-------------------|
| **READ-ONLY** | Agent cannot modify files | Used in Non-Negotiable Rules | view-only, no-write |
| **EVIDENCE-BASED** | Every claim must cite a source | Used in Non-Negotiable Rules | well-researched, thorough |
| **DOMAIN-AGNOSTIC** | Works across domains; specifics from Domain Guidance | Used in Non-Negotiable Rules | general-purpose, universal |
| **NO REWRITING** | Critique only; do not produce revised versions | Used in Non-Negotiable Rules | review-only |
| **ATOMIC** | Each task independently completable | Used in Non-Negotiable Rules | self-contained, isolated |
| **needs_clarification** | Agent signals it needs user input | `needs_clarification: bool` in SUMMARY JSON | ask_user, escalate, blocked |
| **clarifying_questions** | Questions for the user to resolve unknowns | `clarifying_questions: []` in SUMMARY JSON | questions, prompts, queries |
| **confidence** | CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN | `confidence` field in SUMMARY JSON | certainty, sureness |

## Verification

- [ ] YAML frontmatter with `tools:` field
- [ ] `name` is lowercase/alphanumeric+hyphens, 1–64 chars, and matches the filename
- [ ] `description` is 1–1024 chars and follows the canonical description pattern
- [ ] `tools` is comma-delimited and scoped to the role — no surplus write/exec capability
- [ ] All four memory tools in tools list
- [ ] Working Discipline present with exact wire formats (confidence vocab, `needs_clarification`, SUMMARY)
- [ ] Non-Negotiables are outcomes/constraints only — no how-to-work procedure
- [ ] `<agent_boundary>` present at end, byte-identical across edits
- [ ] No domain-specific content
- [ ] No Cognitive Frame contradictions or restatements
- [ ] Consequence boundaries (READ-ONLY, NO-EXECUTION, scope rules) preserved or strengthened — never trimmed

## Files

| File | Purpose |
|------|---------|
| `docs/agents/agents/overview.md` | Agent architecture overview |
| `docs/agents/prompts/role-and-domain-standards.md` | Role Definition standards |
