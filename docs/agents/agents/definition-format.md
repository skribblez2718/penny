# Agent Definition Format — Structure and compliance for agent files

## What

Every agent definition (`.pi/agents/<name>.md`) follows a canonical structure: YAML frontmatter, Purpose, Mempalace Protocol, Alignment, Role-Specific Rules, Output Format, and `<agent_boundary>`.

## Why

Consistent agent structure enables the subagent extension to parse frontmatter for tool declarations and inject the body as Role Definition. Deviation breaks tool access and prompt assembly.

## Rules

1. **YAML frontmatter with `tools:` field.** Single source of truth for tool access. Pi parses this and passes to `--tools`.
2. **Canonical description pattern.** `description` must follow: `[One sentence defining the agent]. Use for [specific use cases]. Do not use for [other agents' domains].` This pattern enables Pi's agent discovery to route tasks correctly.
3. **Purpose section.** One sentence defining what this agent IS and DOES.
3. **Mempalace-First Protocol.** Read before acting, write after completing.
4. **Alignment with System Rules.** Bridges Cognitive Frame to this agent's role.
5. **Role-Specific Rules.** Only rules Cognitive Frame doesn't cover.
6. **Output Format.** What this agent produces and how.
7. **`<agent_boundary>` at end.** Security marker required.

## Required Sections

```markdown
---
name: agent-name
description: "[One sentence]. Use for [cases]. Do not use for [other agents]."
tools: tool1, tool2, memory_smart_search, memory_add_drawer, memory_check_duplicate, memory_kg_add
model: model-name
---

## Purpose
One-sentence role definition.

## Mempalace-First Protocol
1. Read: search for prior context
2. Work: perform task
3. Write: store results
4. Link: add KG facts

## Alignment with System Rules
- **Surfacing**: How this agent surfaces context
- **Assumptions**: How this agent handles assumptions
- **Confidence**: When this agent declares confidence
- **Verification**: What this agent verifies before delivering

## Role-Specific Rules
- Rule only this agent needs

## Output Format
Structure of this agent's output.

<agent_boundary>
```

## Constraints

- **No Cognitive Frame repeats.** Reference, don't restate.
- **No domain-specific content.** Checklists and CREST tables belong in Domain Guidance.
- **No contradictions with Cognitive Frame.** "Do NOT ask" conflicts with Priority 2 (Clarity).
- **All four memory tools required.** `memory_smart_search`, `memory_add_drawer`, `memory_check_duplicate`, `memory_kg_add`.
- **Never write output to the project tree.** Agents with `write`/`edit`/`bash` tools must write output files to `/tmp/` or mempalace, never to the project directory, unless the task explicitly specifies a project path.

## Canonical Vocabulary

Agent-specific terms. The system-wide vocabulary (constraints, variables, assumptions, unknowns, tradeoffs, verification) is defined in `.pi/SYSTEM.md`.

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
- [ ] All four memory tools in tools list
- [ ] Alignment section bridges Cognitive Frame to role
- [ ] `<agent_boundary>` present at end
- [ ] No domain-specific content
- [ ] No Cognitive Frame contradictions
- [ ] Output-to-project-tree rule present in Role-Specific Rules

## Files

| File | Purpose |
|------|---------|
| `docs/agents/agents/overview.md` | Agent architecture overview |
| `docs/agents/prompts/role-and-domain-standards.md` | Role Definition standards |
