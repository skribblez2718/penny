# SKILL.md Format — Manifest specification for skill discovery

## What

Every skill's SKILL.md is a YAML frontmatter + Markdown body that Pi discovers and Penny reads to decide when to invoke the skill.

## Why

Pi auto-discovers skills by scanning `.pi/skills/*/SKILL.md`. The frontmatter provides structured metadata; the body provides human/agent-readable usage guidance.

## Rules

1. **YAML frontmatter required.** `name`, `description`, `metadata.penny` fields.
2. **Canonical description pattern.** `description` must follow: `[One sentence defining the skill]. Use when [trigger conditions + 5–8 signal phrases the user actually says]. Do not use when [anti-use-cases — name the skill/agent to use instead].` The signal phrases are load-bearing: the orchestrator matches them for proactive routing (see SYSTEM.md → Route to the Right Abstraction). `check_skill_structure.py` enforces the presence of `Use when` and `Do not use when`.
3. **`metadata.penny.engine: orchestration`** — the routing key that marks the skill as running on the shared orchestration engine. This is the current marker. (The legacy `metadata.penny.state_machine: true` boolean is REMOVED — do not add it.)
4. **`metadata.penny.mempalace`** — `true` if agents communicate via mempalace.
5. **`metadata.penny.subagents`** — list of agent names this skill uses.
6. **Body sections required:** `## When to Use`, `## When NOT to Use`, `## Invocation`.

## Template

```yaml
---
name: skill-name
description: "[One sentence]. Use when [trigger conditions + signal phrases]. Do not use when [anti-cases — use X instead]."
# Prefer concrete verbs over abstract nominalizations throughout SKILL.md (see Design Principles §10):
# "Analyze the source", not "perform analysis of the source".
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: true
    subagents: [echo, piper]
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
- **The playbook is not in SKILL.md.** The state machine is a `BasePlaybook` subclass in the `orchestration` package. SKILL.md only names the engine and the agents.

## Canonical Vocabulary

Skill-specific terms. The system-wide vocabulary (constraints, variables, assumptions, unknowns, tradeoffs, verification) is defined in `.pi/SYSTEM.md`.

### SKILL.md Section Headers

| Term | Definition | Do NOT substitute |
|------|-----------|-------------------|
| **Invocation** | How to invoke the skill | Usage, How to Use, MANDATORY |
| **Post-Completion** | What happens after the skill succeeds | Approve/Refine, After Completion |
| **awaiting_clarification** | Engine pause state when an agent returns UNCERTAIN | escalation, error, paused |
| **Verification** | Playbook state / final oracle for high-stakes confirmation | approval gate, verify required |

### Prompt↔Playbook Bridge Terms

These terms appear both in skill prompts and in the playbook's SUMMARY contracts and `route_after` routing. They must match exactly across the two.

| Term | Definition | Where it binds | Do NOT substitute |
|------|-----------|----------------|-------------------|
| **SUMMARY** | Minimal structured output an agent returns to the engine | The `result` dict the playbook validates and routes on | result, output, response |
| **verdict** | Carren's approval decision | `verdict` field in the SUMMARY, read by `route_after` | ruling, decision, result |
| **needs_clarification** | Agent signals it needs user input | SUMMARY field; pauses the run at `awaiting_clarification` | ask_user, escalate, blocked |
| **clarifying_questions** | Questions for the user | SUMMARY field surfaced in the escalation directive | questions, prompts, queries |
| **confidence** | CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN | SUMMARY field; UNCERTAIN in an `ESCALATABLE_STATES` state escalates | certainty, sureness |
| **explore_complete** | Echo agent finished exploration | SUMMARY field read by the playbook's `route_after` | done, finished, complete |
| **plan_complete** | Piper agent finished planning | SUMMARY field read by the playbook's `route_after` | done, finished, complete |

## Verification

- [ ] YAML frontmatter parses without errors
- [ ] `metadata.penny.engine: orchestration` present (no `state_machine` key)
- [ ] All `subagents` listed have corresponding prompt files
- [ ] When to Use / When NOT to Use sections present
- [ ] Invocation syntax documented

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/skill-md-template.md` | Copy-paste template |
