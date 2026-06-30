---
name: prd
description: "Use for generating world-class PRDs from free-form product/project briefs. Produces layered output: narrative prose (12 sections), atomic requirement catalog (REQ-NNN with priority + acceptance criteria), verification/traceability matrix, and structured IDEAL_STATE JSON. Output is written to mempalace room `skills/prd-{session_id}/` for downstream consumption. Chains naturally with the code skill (code requires prd output as hard dependency). Do not use for code generation (use code skill), bug fixes (use code skill), or simple specifications that don't need layered output."
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - synthia
      - vera
    invocation_modes:
      - single
      - chain
---

## When to Use

- User requests a PRD, product spec, or requirements document
- Starting a new feature or project that needs clear requirements before coding
- User says "spec this out," "write a PRD," "define requirements," or "what should we build?"
- Downstream skill (code) needs structured IDEAL_STATE input — chain `prd` → `code`
- The task is ambiguous and needs structured requirements before implementation
- You need a verification matrix to trace requirements to tests

## When Not to Use

- Simple, single-step tasks (execute directly)
- Quick bug fixes with obvious scope (fix immediately)
- User explicitly says "just do it" (execute directly)
- Task is already well-defined with a complete PRD (proceed directly to code skill)
- Purely exploratory or research tasks with no implementation intent (use plan or research skills)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

```
skill({
  skill_name: "prd",
  goal: "Your goal here",
  project_root: "/path/to/project"
})
```

### Parameters

| Parameter      | Required | Description                                                             |
| -------------- | -------- | ----------------------------------------------------------------------- |
| `skill_name`   | Yes      | Must be `"prd"`                                                         |
| `goal`         | Yes      | The goal to generate a PRD for                                          |
| `session_id`   | No       | Unique session ID (auto-generated if omitted)                           |
| `project_root` | No       | Project root directory (defaults to cwd)                                |
| `constraints`  | No       | JSON object of constraints, e.g., `{"domain": "web-app"}`               |

## Post-Completion

After the skill completes, present the result for user approval. Do not execute, modify, or analyze the output further.

### Procedure

1. Fetch all four PRD artifacts from mempalace:
   ```
   memory_smart_search(query="<session_id> PRD Narrative", room="skills/prd-<session_id>", limit=5, include_full=true)
   memory_smart_search(query="<session_id> Requirement Catalog", room="skills/prd-<session_id>", limit=5, include_full=true)
   memory_smart_search(query="<session_id> Verification Matrix", room="skills/prd-<session_id>", limit=5, include_full=true)
   memory_smart_search(query="<session_id> IDEAL_STATE", room="skills/prd-<session_id>", limit=5, include_full=true)
   ```

2. Present key sections via questionnaire:
   ```typescript
   questionnaire({
     questions: [{
       id: "prd_approval",
       label: "PRD Review",
       prompt: "## PRD Summary\n\n**Overview:** <overview>\n**Success Metrics:** <metrics>\n**Features:** <table>\n**Requirements:** <count>\n**IDEAL_STATE:** <valid/invalid>\n\nFull PRD in mempalace room `skills/prd-<session_id>/`.\n\nApprove, refine, or discard?",
       options: [
         { value: "approve", label: "Approve", description: "Accept — ready for code skill or manual implementation" },
         { value: "refine", label: "Refine", description: "Re-run with modifications or more clarifying questions" },
         { value: "discard", label: "Discard", description: "Discard this PRD" },
       ],
       allowOther: true,
     }],
   });
   ```

3. On **approve**: PRD is ready. Chain to code skill if implementing.
4. On **refine**: re-invoke with `constraints: { refinement_context: "<user notes>" }`.
5. On **discard**: stop.

### Constraints

- Do not perform additional analysis or research on the PRD's topic.
- Do not execute implementation steps before approval.
- Do not modify the PRD — use "Refine" for changes.
- Do not verify or cross-check the PRD's findings — the agents already did this.

## UNKNOWN_STATE

When the skill returns `success: false` with `escalation` data, the FSM has entered UNKNOWN_STATE — Synthia needs clarifying questions answered, or an agent returned `UNCERTAIN` confidence.

### Procedure

1. Check for escalation data: `if (result.escalation) { ... }`
2. Present the questions via `questionnaire` using `result.escalation.questions`.
3. Collect user responses as a key-value object.
4. Re-invoke with the user's responses:
   ```typescript
   skill({
     skill_name: "prd",
     goal: "<same goal>",
     constraints: {
       user_responses: { "What frontend framework?": "React", ... },
       orchestrator_state: result.escalation.orchestrator_state,
     },
   });
   ```

## Mempalace Output Contract

After completion, `skills/prd-{session_id}/` contains:

| Drawer | Content | Format |
|--------|---------|--------|
| `{sid} Classify` | Domain classification and project context | Markdown |
| `{sid} PRD Narrative` | 12-section prose PRD | Markdown |
| `{sid} Requirement Catalog` | Atomic requirements (REQ-001 through REQ-NNN) | JSON |
| `{sid} Verification Matrix` | REQ → test strategy mapping | JSON |
| `{sid} IDEAL_STATE` | Structured IDEAL_STATE matching canonical schema | JSON |
| `{sid} Validate` | Vera's validation report | Markdown |

Downstream skills read from this room. The `code` skill reads `IDEAL_STATE` and `PRD Narrative` during `define_specs`, and `Verification Matrix` during `verify`.

## Chain Contract

```
skill({
  chain: [
    { skill_name: "prd", goal: "Build a user authentication dashboard" },
    { skill_name: "code", goal: "Implement the PRD from the previous step" }
  ]
})
```

When chaining, the code skill reads IDEAL_STATE and verification matrix from `skills/prd-{session_id}/` automatically.

## Storing Learnings

```python
memory_add_drawer(wing="penny", room="skills", content="## PRD Skill Session\n\n**Session:** {session_id}\n**Goal:** {goal}\n**Domain:** {domain}\n**Requirements:** {count}\n**IDEAL_STATE Valid:** {valid}\n**Success:** {is_success}")
memory_kg_add(f"SkillSession:{session_id}", "completed", f"Skill:prd:{goal[:50]}")
```

## Resilience

The orchestrator validates every agent SUMMARY before advancing the state machine, rejecting empty or malformed summaries. If agents fail silently, the skill returns error — it does not advance on fabricated defaults. See `README.md` for detailed failure modes and diagnostics.
