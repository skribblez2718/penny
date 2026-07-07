# Plan Skill

## What It Is

A structured planning workflow that breaks complex goals into actionable steps using four specialized agents. It runs on Penny's shared orchestration engine, which owns the workflow's state in a durable checkpointer.

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

1. **Explore** (Echo agent): Gathers evidence in parallel across three focuses — entry points, tests, and configuration
2. **Plan** (Piper agent): Synthesizes findings into an execution-grade plan
3. **Critique** (Carren agent): Reviews the plan for gaps, risks, and feasibility (CREST)
4. **Taskify** (Tabitha agent): Converts the approved plan into structured, trackable tasks

Each agent writes its full output to mempalace (`skills/plan-<session_id>`). Penny only sees structured summaries.

## Safety Features

- **Escalation on uncertainty**: If any agent asks for clarification, the run pauses and asks you for direction. Your answer resumes the same run.
- **Honest exhaustion**: If the critique loop runs out of revisions without approval, the plan completes marked *not met* with the unresolved issues listed — it never fakes an approval.
- **Verification gate**: High-stakes plans pause for your explicit confirmation before proceeding to critique.
- **Approve/Refine cycle**: After the skill completes, Penny presents the plan and asks for approval — it never executes plan steps without explicit consent.
- **Crash-safe**: Workflow state is checkpointed durably. If a run is interrupted mid-step, it automatically resumes and re-issues that step.

## Constraints

| Constraint            | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| **verification_mode** | `"default"`, `"strict"`, `"relaxed"` (default), `"off"` — controls whether high-stakes plans hit the verification gate |

Under `relaxed` (the default) and `off`, no gate. Under `default` the gate triggers on high-stakes plans; under `strict` it triggers on high- or medium-stakes plans.

## Learn More

- Agent docs: `docs/agents/capabilities/plan-skill/plan-skill.md`
- Workflow (source of truth): `apps/orchestration/src/orchestration/playbooks/plan.py` (`PlanPlaybook`)
- Tests: `apps/orchestration/tests/test_plan_playbook.py`
- Skill wiring: `.pi/skills/plan/SKILL.md`
