---
name: agent
description: Generate Penny agent definitions using a structured workflow. Use for creating, designing, or scaffolding new agents with validated definitions. Do not use for modifying existing agents (edit directly) or simple file creation (use skribble).
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - vera
      - piper
      - carren
      - skribble
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
| `constraints`  | No       | JSON object of constraints. Special fields: `parent_session_id` (links to calling skill), `create_skill_scaffold` (bool, default false), `agent_name` (override extracted from goal) |

## Post-Completion

After the skill completes, present the result for user approval. Do not execute, modify, or analyze the output further.

### Procedure

1. Fetch the agent design (Piper) and scaffold (skribble) from mempalace:
   ```
   memory_smart_search(query="<session_id> Agent Design", room="skills/agent-<session_id>", limit=5, include_full=true)
   memory_smart_search(query="<session_id> Agent Scaffold", room="skills/agent-<session_id>", limit=5, include_full=true)
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
4. On **refine**: re-invoke with `constraints: { refinement_context: "<user notes>" }`.
5. On **discard**: stop.

### Constraints

- Do not execute the generated agent definition.
- Do not modify the output directly — use "Refine" for changes.
- Do not perform additional analysis or research on the output.

## UNKNOWN_STATE

When the skill returns `success: false` with `escalation` data, the FSM has entered UNKNOWN_STATE — an agent returned `UNCERTAIN` confidence. This is a paused state, not a failure.

### Procedure

1. Check for escalation data: `if (result.escalation) { ... }`
2. Present the questions via `questionnaire` using `result.escalation.questions`.
3. Re-invoke with the user's response:
   ```typescript
   skill({
     skill_name: "agent",
     goal: "<same goal>",
     constraints: {
       user_response: questionnaire_result,
       orchestrator_state: result.escalation.orchestrator_state,
     },
   });
   ```

## Sub-Skill Contract

When invoked by a parent skill, the agent skill accepts:

| Constraint Field        | Type   | Description                                                                                     |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `parent_session_id`     | string | The parent session ID. The agent skill records this linkage in mempalace.                       |
| `create_skill_scaffold` | bool   | Always `false` for the `agent` skill. Other values are rejected at intake.                      |
| `agent_name`            | string | Override for the agent name to generate. If absent, the orchestrator extracts it from the goal. |

When `parent_session_id` is provided, the skill skips the post-completion approval loop and returns the artifact directly. The parent skill handles approval, file writing, AGENTS.md updates, and doc scaffolding.

On completion, the skill returns:

```json
{
  "agent_name": "<name>",
  "agent_definition": "<full .md content>",
  "file_path": ".pi/agents/<name>.md",
  "verification_result": { "yaml_valid": true, "schema_valid": true, "diff_applied": true },
  "confidence": "PROBABLE"
}
```

## Storing Learnings

```python
memory_add_drawer(wing="penny", room="skills", content="## Agent Skill Session\n\n**Session:** {session_id}\n**Goal:** {goal}\n**Agent:** {agent_name}\n**Success:** {is_success}")
memory_kg_add(f"SkillSession:{session_id}", "completed", f"Skill:agent:{goal[:50]}")
```
