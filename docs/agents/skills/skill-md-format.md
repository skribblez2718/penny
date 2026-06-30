# SKILL.md Format — Manifest specification for skill discovery

## What

Every skill's SKILL.md is a YAML frontmatter + Markdown body that Pi discovers and Penny reads to decide when to invoke the skill.

## Why

Pi auto-discovers skills by scanning `.pi/skills/*/SKILL.md`. The frontmatter provides structured metadata; the body provides human/agent-readable usage guidance.

## Rules

1. **YAML frontmatter required.** `name`, `description`, `metadata.penny` fields.
2. **Canonical description pattern.** `description` must follow: `[One sentence defining the skill]. Use for [specific use cases]. Do not use for [anti-use-cases].` This pattern enables Pi's skill discovery to route tasks correctly.
3. **`metadata.penny.state_machine`** — `true` if the skill uses an orchestrator.
4. **`metadata.penny.mempalace`** — `true` if agents communicate via mempalace.
5. **`metadata.penny.subagents`** — list of agent names this skill uses.
6. **Body sections required:** `## When to Use`, `## When NOT to Use`, `## Invocation`.

## Template

```yaml
---
name: skill-name
description: "[One sentence]. Use for [cases]. Do not use for [anti-cases]."
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - piper
---

# Skill Name

## When to Use
- Condition 1
- Condition 2

## When NOT to Use
- Anti-condition 1

## Invocation
skill({ skill_name: "name", goal: "..." })
```

## What Belongs in SKILL.md vs. Elsewhere

| Belongs in SKILL.md | Belongs in `assets/prompts/` | Belongs in `README.md` |
|---------------------|------------------------------|------------------------|
| When to invoke | Domain checklists (CREST) | Detailed flow diagrams |
| Parameters | Session-specific instructions | Failure modes |
| Output location | Output format (SUMMARY) | Diagnostics |
| Chain integration | Mempalace protocols | Version history |
| Post-completion rules | | |

## Constraints

- **SKILL.md is Project Index, not Domain Guidance.** It tells Penny when to invoke. Domain patterns go in `assets/prompts/`.
- **No deprecation notices in SKILL.md.** Remove deprecated skills; don't leave warnings.

## Canonical Vocabulary

Skill-specific terms. The system-wide vocabulary (constraints, variables, assumptions, unknowns, tradeoffs, verification) is defined in `.pi/SYSTEM.md`.

### SKILL.md Section Headers

| Term | Definition | Do NOT substitute |
|------|-----------|-------------------|
| **Invocation** | How to invoke the skill | Usage, How to Use, MANDATORY |
| **Post-Completion** | What happens after the skill succeeds | Approve/Refine, After Completion |
| **UNKNOWN_STATE** | FSM state when an agent returns UNCERTAIN | escalation, error, paused |
| **Verification** | FSM state for high-stakes confirmation | approval gate, verify required |

### Prompt↔Code Bridge Terms

These terms appear in both skill prompts and orchestrator code. They must match exactly.

| Term | Definition | Code Binding | Do NOT substitute |
|------|-----------|-------------|-------------------|
| **SUMMARY** | Minimal structured output returned to orchestrator | Agent output parsed by `_validate_summary()` | result, output, response |
| **verdict** | Carren's approval decision | `critique_verdict` (orchestrator), `"verdict"` (SUMMARY JSON) | ruling, decision, result |
| **needs_clarification** | Agent signals it needs user input | `needs_clarification: bool` (SUMMARY), `_check_confidence_and_handle()` (orchestrator) | ask_user, escalate, blocked |
| **clarifying_questions** | Questions for the user | `clarifying_questions: []` (SUMMARY), `result.escalation.questions` (orchestrator) | questions, prompts, queries |
| **confidence** | CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN | `confidence` field (SUMMARY), `last_confidence` (orchestrator) | certainty, sureness |
| **explore_complete** | Echo agent finished exploration | `explore_complete: bool` (SUMMARY), `explore_done` transition guard | done, finished, complete |
| **plan_complete** | Piper agent finished planning | `plan_complete: bool` (SUMMARY), `plan_done` transition guard | done, finished, complete |

## Verification

- [ ] YAML frontmatter parses without errors
- [ ] All `subagents` listed have corresponding prompt files
- [ ] When to Use / When NOT to Use sections present
- [ ] Invocation syntax documented

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/skill-md-template.md` | Copy-paste template |
