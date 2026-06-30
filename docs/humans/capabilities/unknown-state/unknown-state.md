# UNKNOWN_STATE Escalation Protocol

## What It Is

When Penny's planning skill encounters **UNCERTAIN confidence** from any agent — or a situation no FSM guard can handle — it enters `UNKNOWN_STATE` instead of silently proceeding with unsupported assumptions. The user is asked for direction via a structured questionnaire, and the FSM resumes to the appropriate working state based on their response.

## Why It Exists

Without an escape hatch, the system would fall through to raw LLM behavior in novel situations — the exact scenario where AI is most dangerous. UNKNOWN_STATE ensures Penny **halts and escalates** rather than improvising.

## When It Triggers

| Condition                                 | Example                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| Agent returns `confidence: UNCERTAIN`     | Echo can't find relevant files for the goal               |
| Parser fails to extract structured output | Piper produces steps without the required `SUMMARY` block |
| Guard condition evaluates unexpectedly    | State machine can't determine next transition             |

## User Experience

When UNKNOWN_STATE triggers, Penny presents:

1. **What was being attempted** — the current task and agent
2. **Why it failed** — the `unknown_reason` from the agent (e.g., "No relevant files found")
3. **A structured questionnaire** with three options:
   - **Retry** — Resume the interrupted working state with fresh context
   - **Skip** — Proceed with best available data (clears the blocker)
   - **Restart** — Abandon the session and return error

## Resume Behavior

| User Choice | Resumes To                                                      | When to Use                        |
| ----------- | --------------------------------------------------------------- | ---------------------------------- |
| **Retry**   | The interrupted working state (exploring, planning, critiquing) | More context might help            |
| **Skip**    | The interrupted working state, with errors cleared              | Blocker is minor / acceptable risk |
| **Restart** | Error state                                                     | The plan is fundamentally flawed   |

## Relationship to VERIFYING

| State           | Meaning                           | Trigger                              |
| --------------- | --------------------------------- | ------------------------------------ |
| `UNKNOWN_STATE` | "I don't know what to do"         | `confidence: UNCERTAIN`              |
| `VERIFYING`     | "I can act but want confirmation" | `confidence: POSSIBLE` + high stakes |

`UNCERTAIN` always halts for escalation. `POSSIBLE` with low stakes proceeds directly.

## Configuration

No explicit configuration needed. The UNKNOWN_STATE protocol is automatic and deterministic.

## Learn More

- Agent docs: `docs/agents/unknown-state.md`
- Design doc: `plans/ai-gaps-resolution/02-designs/03-unknown-state.md`
- Implementation: `.pi/skills/plan/scripts/orchestrate.py` — `PlanWorkflow` states, `process_user_clarification()`
