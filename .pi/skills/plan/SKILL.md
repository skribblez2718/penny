---
name: plan
description: Structured planning workflow that breaks complex goals into actionable steps. Use when planning, sequencing steps, creating a roadmap, mapping dependencies, or decomposing a goal into a reviewable plan deliverable. Do not use when the task is a simple single-step task or quick fix, when the user says "just do it," when lightweight sequencing without a deliverable suffices (piper), or when breaking an existing plan into executable tasks (tabitha).
license: MIT
metadata:
  version: "2.0.0"
  penny:
    engine: orchestration
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
| `constraints`  | No       | JSON object of constraints (see below)        |

### Constraints

| Key                 | Effect                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `explore_branches`  | `{branch_id: focus}` — supply the exploration topology directly and skip `scoping`. Otherwise piper's `scoping` step emits it at runtime (arrangement 4). |
| `max_fan_width`     | Cap on exploration branches (default 8). Over-width scoping output errors.                                      |
| `verification_mode` | `off` / `relaxed` (default) / `default` / `strict` — when the high-stakes verify gate fires.                    |
| `max_iterations`    | Critique revision budget (default 3).                                                                          |

**Exploration topology is model-owned:** piper's `scoping` step decomposes the goal into read-only `echo` foci and emits `explore_branches`; the engine fans out one branch per focus. The legacy fixed 3-branch split survives only as a tagged LOAN fallback (`plan_default_explore_topology`) for when scoping emits nothing. **Critique is evidence-gated** (Rec 4): carren's verdict must carry captured evidence or the engine rejects it.

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

## Human-in-the-Loop Pauses

The skill pauses in two cases: the **verify gate** (`verify_gate` — a high-stakes plan awaiting confirmation) and **clarification escalation** (`awaiting_clarification` — an agent needs more information, or the critique loop stalled). Both surface `escalation` data with `questions`.

### Procedure

1. Check for escalation data: `if (result.escalation) { ... }`.
2. Present the questions via `questionnaire` using `result.escalation.questions`.
3. Resume the paused run by re-issuing the step as the `user` agent with the response. The engine rehydrates by `run_id` from the durable checkpointer — do **not** pass any orchestrator state back:
   ```typescript
   skill({
     skill_name: "plan",
     run_id: result.run_id,
     user_response: questionnaire_result,
   });
   ```

### Verify-gate response values

| Value                             | Effect                                        |
| --------------------------------- | --------------------------------------------- |
| `confirm` / `approve` / `proceed` / `yes` | Proceed to critique (`verify_confirm`)  |
| Any other value                   | Return to planning with the note (`verify_revise`) |

For clarification escalation, the user's reply resumes at `scoping` (`clarify → scoping`) — re-scoping after an answer is cheaper and safer than resuming downstream with a stale topology.

## Post-Completion Storage

The engine records the run outcome automatically on completion — do **not** write session drawers or knowledge-graph edges by hand. The plan and task breakdown live in the mempalace room `skills/plan-{session_id}` (see Post-Completion above for the retrieval queries).

## Resilience

The engine validates every agent SUMMARY against the state's contract before advancing the FSM, rejecting empty or malformed summaries. If an agent fails silently, the run does not advance on fabricated defaults; a stalled critique loop escalates rather than force-approving, and true budget exhaustion completes with `met: false` and the unresolved issues reported. Run state is durable in the `run_id`-keyed checkpointer, so a killed run is resumable via `recover`.
