---
name: plan
description: Structured planning workflow that breaks complex goals into actionable steps. Use for planning, step sequencing, roadmap creation, dependency mapping, or goal decomposition. Do not use for simple single-step tasks, quick fixes, or when the user explicitly says "just do it."
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - piper
      - carren
      - tabitha
---

## When to Use

- User requests planning for any goal (code, life, research, communication, etc.)
- Complex task needs to be broken into steps
- Before making significant decisions or changes
- User explicitly asks to "plan this" or "create a plan"
- Multi-step processes with dependencies
- Goals requiring research, coordination, or resources

## When Not to Use

- Simple, single-step tasks (execute directly)
- User just wants to explore or discuss (use explore agent directly)
- Quick fixes or typos (fix immediately)
- User explicitly says "just do it" (execute directly)
- Task is already well-defined with clear steps (proceed directly)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

```
skill({
  skill_name: "plan",
  goal: "Your goal here",
  project_root: "/path/to/project"
})
```

### Parameters

| Parameter      | Required | Description                                   |
| -------------- | -------- | --------------------------------------------- |
| `skill_name`   | Yes      | Must be `"plan"`                              |
| `goal`         | Yes      | The goal to plan for                          |
| `session_id`   | No       | Unique session ID (auto-generated if omitted) |
| `project_root` | No       | Project root directory (defaults to cwd)      |
| `constraints`  | No       | JSON object of constraints                    |

## Post-Completion

After the skill completes, present the result for user approval. Do not execute, modify, or analyze the output further.

### Procedure

1. Fetch the strategic plan (Piper) and task breakdown (Tabitha) from mempalace:
   ```
   memory_smart_search(query="<session_id> Planner", room="skills/plan-<session_id>", limit=5, include_full=true)
   memory_smart_search(query="<session_id> Taskifier", room="skills/plan-<session_id>", limit=5, include_full=true)
   ```

2. Present both via questionnaire:
   ```typescript
   questionnaire({
     questions: [{
       id: "plan_approval",
       label: "Plan Review",
       prompt: "## Strategic Plan\n<Piper content>\n\n## Task Breakdown\n<Tabitha content>\n\nApprove, refine, or deny?",
       options: [
         { value: "approve", label: "Approve", description: "Begin executing the plan steps" },
         { value: "refine", label: "Refine", description: "Re-run the plan skill with modifications" },
         { value: "deny", label: "Deny", description: "Discard this plan" },
       ],
       allowOther: true,
     }],
   });
   ```

3. On **approve**: begin executing plan steps.
4. On **refine**: re-invoke with `constraints: { refinement_context: "<user notes>" }`.
5. On **deny**: stop.

### Constraints

- Do not execute plan steps before approval.
- Do not verify or cross-check the plan's findings — the agents already did this.
- Do not modify the plan — use "Refine" for changes.

## Verification

When the skill returns `success: false` with `escalation` data, the FSM has entered the `verifying` state — the plan involves high-stakes or irreversible actions requiring user confirmation.

### Procedure

1. Check for escalation data: `if (result.escalation) { ... }`
2. Present the questions via `questionnaire` using `result.escalation.questions`.
3. Re-invoke with the user's response:
   ```typescript
   skill({
     skill_name: "plan",
     goal: "<same goal>",
     constraints: {
       user_response: questionnaire_result,
       orchestrator_state: result.escalation.orchestrator_state,
     },
   });
   ```

### Response Values

| Value      | Effect                                                     |
| ---------- | ---------------------------------------------------------- |
| `confirm`  | Proceed with the planned action                            |
| `reject`   | Return to revising                                         |
| `escalate` | Move to UNKNOWN_STATE for clarification                    |
| Custom     | Treat as clarification text (UNKNOWN_STATE)                |

## Storing Learnings

```python
memory_add_drawer(wing="penny", room="skills", content="## Plan Skill Session\n\n**Session:** {session_id}\n**Goal:** {goal}\n**Success:** {is_success}\n**Steps:** {step_count}")
memory_kg_add(f"SkillSession:{session_id}", "completed", f"Skill:plan:{goal[:50]}")
```

## Resilience

The orchestrator validates every agent SUMMARY before advancing the state machine, rejecting empty or malformed summaries. If agents fail silently, the skill returns error — it does not advance on fabricated defaults. See `README.md` for detailed failure modes and diagnostics.
