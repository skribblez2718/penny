# Plan Skill

## What It Is

A structured planning workflow that breaks complex goals into actionable steps using four specialized agents and a Python state machine orchestrator.

## When to Use

- You need a plan for something complex (code, life, research, anything)
- Before making a significant decision or change
- A task has multiple steps with dependencies
- You want structured output, not ad-hoc advice

## When Not to Use

- Simple, single-step tasks (just execute directly)
- Quick fixes or typos (fix immediately)
- You explicitly say "just do it" (execute directly)

## How It Works

1. **Explore** (Echo agent): Gathers evidence from files, web, and mempalace
2. **Plan** (Piper agent): Synthesizes findings into an execution-grade plan
3. **Critique** (Carren agent): Reviews the plan for gaps, risks, and feasibility
4. **Taskify** (Tabitha agent): Converts the approved plan into structured, trackable tasks

Each agent writes its full output to mempalace (`skills/plan-<session_id>`). Penny only sees structured summaries.

## Safety Features

- **UNKNOWN_STATE**: If any agent reports `UNCERTAIN` confidence, the FSM halts and asks you for direction
- **Verification State**: High-stakes plans with `POSSIBLE` confidence pause for your confirmation before proceeding
- **Approve/Refine Cycle**: After the skill completes, Penny presents the plan and asks for approval — it never executes plan steps without explicit consent

## Constraints

| Constraint            | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| **stakes**            | `"high"`, `"medium"`, `"low"` — drives verification threshold                  |
| **verification_mode** | `"default"`, `"strict"`, `"relaxed"`, `"off"` — controls verification behavior |

## Learn More

- Agent docs: `docs/agents/plan-skill.md`
- Design: Architecture embedded in `plans/ai-gaps-resolution/02-designs/` (Steps 3, 4, 6, 7, 8, 9)
- Implementation: `.pi/skills/plan/` — `SKILL.md`, `README.md`, `scripts/orchestrate.py`
- Tests: `.pi/skills/plan/tests/test_*.py` (145 tests)
