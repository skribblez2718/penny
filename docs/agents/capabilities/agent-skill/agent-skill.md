# Agent Skill — Generate validated Penny agent definitions

## What

A structured skill that produces a Penny agent definition file (`.pi/agents/<name>.md`) from a goal description. It explores existing patterns, designs the agent, critiques it, scaffolds the file, and verifies it against the Penny agent standard.

## Why

Agent definitions encode constraints, tool usage, and output contracts. Generating them through a validated workflow keeps new agents consistent with the rest of the system.

## Rules

1. **Use for new agents only.** Do not use the agent skill to modify an existing agent — edit the file directly.
2. **Do not use for one-line edits.** Trivial changes should be executed directly.
3. **Penny is a router.** Agents communicate via mempalace (`skills/agent-<session_id>`); Penny only sees structured summaries.
4. **Approval is required before installation.** The skill returns the generated definition and verification result; Penny must ask for user approval before writing `.pi/agents/<name>.md` and updating indexes.
5. **`create_skill_scaffold` is always rejected.** The agent skill creates agents, not skills.
6. **UNCERTAIN confidence halts the FSM.** Any agent returning `confidence: UNCERTAIN` triggers UNKNOWN_STATE and a user questionnaire.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "agent",
  goal: "Generate a research agent for climate data analysis",
  project_root: "/path/to/project",
})
```

Optional constraints:

| Constraint | Meaning |
|------------|---------|
| `agent_name` | Override the name extracted from the goal |
| `parent_session_id` | Link to a calling skill when invoked as a sub-skill |
| `create_skill_scaffold` | Always rejected |

### State machine phases

```
intake → exploring → designing → critiquing → scaffolding → verifying → complete
         ↑______________|        ↓
         (critique fail          (verify fail
          → revise)               → re-scaffold)
```

| State | Agent | Purpose | Output to mempalace |
|-------|-------|---------|----------------------|
| `intake` | — | Validate goal and start | — |
| `exploring` | `echo` | Gather patterns from existing agents and conventions | Findings, requirements, unknowns |
| `designing` | `piper` | Synthesize findings into structured agent spec | Agent design |
| `critiquing` | `carren` | Review design for schema compliance, security, completeness | Verdict, issues |
| `revising` | — | Decide whether to re-explore or re-design | — |
| `scaffolding` | `skribble` | Generate the actual `.pi/agents/<name>.md` content | Agent scaffold |
| `verifying` | `vera` | Validate the generated file against the Penny agent standard | Verification result |
| `complete` | — | Return final summary | — |
| `unknown` / `awaiting_clarification` | — | UNKNOWN_STATE protocol | Escalation questions |
| `error` | — | Terminal failure | Errors |

### Revision loops

- `critiquing → revising → exploring` when more context is needed.
- `critiquing → revising → designing` when the design can be fixed directly.
- `verifying → scaffolding` when verification fails and the file must be regenerated.

### Sub-skill contract

When invoked by a parent skill with `parent_session_id`:

- The skill skips the post-completion approval loop.
- It returns a structured result containing `agent_name`, `agent_definition`, `file_path`, and `verification_result`.
- The parent skill is responsible for writing the file and updating indexes.

## Constraints

- Max revision iterations are bounded by the orchestrator (default prevents infinite loops).
- Safe default summaries never claim completion; empty agent results stop the FSM.
- Session state is persisted to `/tmp/agent-{session_id}.json` for resilience across subprocess boundaries.

## Verification

- [ ] Generated file passes schema validation (`yaml_valid`, `schema_valid`, `diff_applied`).
- [ ] No agent returned `confidence: UNCERTAIN`.
- [ ] Final output is presented for approval before `.pi/agents/<name>.md` is written.
- [ ] `AGENTS.md` index and human/agent docs are scaffolded after approval.

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/agent/SKILL.md` | Skill definition, invocation, and post-completion procedure |
| `.pi/skills/agent/README.md` | Architecture and state machine overview |
| `.pi/skills/agent/scripts/orchestrate.py` | Python FSM and CLI entry point |
| `.pi/skills/agent/assets/prompts/*.md` | Agent prompts (`echo.md`, `piper.md`, `carren.md`, `skribble.md`, `vera.md`) |
| `.pi/skills/agent/tests/test_*.py` | Unit, integration, and E2E tests |
| `docs/humans/capabilities/agent-skill/agent-skill.md` | Human-facing overview |
