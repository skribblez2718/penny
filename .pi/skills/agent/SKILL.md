---
name: agent
description: Generate Penny agent definitions using a structured workflow. Use when the task requires creating, designing, or scaffolding a new agent with a validated definition — signals like "create an agent", "new agent", "design an agent", "scaffold an agent", "agent definition". Do not use when modifying an existing agent (edit it directly) or generating non-agent files (skribble).
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
      - skribble
      - vera
---

## When to Use

- Creating a new Penny agent definition from scratch
- Generating a generic agent scoped to a specific domain or task
- Producing a validated agent definition that passes the Penny agent standard
- Invoked as a sub-skill by the `create` skill (future) to scaffold agent definitions

## When Not to Use

- Modifying an existing agent (edit directly)
- Generating a full skill scaffold (use the `create` skill when available)
- Simple one-line file edits (execute directly)
- When the user explicitly says "just create it" (use the `skribble` agent directly)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

```typescript
skill({
  skill_name: "agent",
  goal: "Generate a research agent for climate data analysis",
  project_root: "/path/to/project",
});
```

### Parameters

| Parameter      | Required | Description                                                                                                                                                                          |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skill_name`   | Yes      | Must be `"agent"`                                                                                                                                                                    |
| `goal`         | Yes      | The agent definition goal. Should include the target agent name and domain purpose.                                                                                                  |
| `session_id`   | No       | Unique session ID (auto-generated if omitted)                                                                                                                                        |
| `project_root` | No       | Project root directory (defaults to cwd)                                                                                                                                             |
| `constraints`  | No       | JSON object of constraints. Recognized field: `agent_name` (optional hint; the authoritative name is read from skribble's scaffold SUMMARY).                                        |

## Post-Completion

After the skill completes, present the result for user approval. Do not execute, modify, or analyze the output further.

### Procedure

1. Fetch the agent design (piper) and verification report (vera) from mempalace
   (the engine has already recorded the run outcome; this is just to present the
   full artifacts to the user):
   ```
   memory_smart_search(query="<session_id> Design", room="skills/agent-<session_id>", limit=5, include_full=true)
   memory_smart_search(query="<session_id> Verify", room="skills/agent-<session_id>", limit=5, include_full=true)
   ```

2. Present the definition and verification result via questionnaire:
   ```typescript
   questionnaire({
     questions: [{
       id: "agent_approval",
       label: "Agent Definition Review",
       prompt: "## Generated Agent Definition\n<full content>\n\n## Verification Result\n<summary>\n\nApprove, refine, or discard?",
       options: [
         { value: "approve", label: "Approve", description: "Accept and install the generated agent definition" },
         { value: "refine", label: "Refine", description: "Re-run the agent skill with modifications" },
         { value: "discard", label: "Discard", description: "Discard this agent definition" },
       ],
       allowOther: true,
     }],
   });
   ```

3. On **approve**: verify `.pi/agents/<name>.md` exists, update AGENTS.md index, scaffold docs, validate links, record outcome.
4. On **refine**: start a new run with the goal updated to fold in the user's notes.
5. On **discard**: stop.

### Constraints

- Do not execute the generated agent definition.
- Do not modify the output directly — use "Refine" for changes.
- Do not analyze or research the output further.

## Escalation (paused run)

When an agent reports `UNCERTAIN` confidence or sets `needs_clarification`, or a
loop stalls, the run pauses at `awaiting_clarification` — a paused state, not a
failure. The engine surfaces the clarifying questions and keeps the run's state
in the durable checkpointer keyed by `run_id`.

### Procedure

1. Present the returned clarifying questions to the user via `questionnaire`.
2. Resume the same run with the user's answer — pass the run's `run_id` and the
   answer as `user_response`. There is no `orchestrator_state` to thread; the
   engine rehydrates the paused run from the checkpointer by `run_id`.
3. On resume the run re-enters `exploring` with the clarification in context.

## Result

On completion the engine returns the `result_payload`: `met`, `iterations`,
`verify_iterations`, `goal`, `agent_name`, `agent_file_path`,
`verification_result` (`yaml_valid` / `schema_valid` / `diff_applied`),
`critique_verdict`, `session_id`, `session_room`, `exhausted`, and
`unresolved_issues`. `met` is true only when all three verification checks pass;
on honest exhaustion `met=False`, `exhausted=true`, and the unresolved
issues/checks are listed. The engine records the run outcome automatically — no
manual mempalace writes are required.
