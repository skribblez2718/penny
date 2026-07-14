---
name: prd
description: Produce a formal product or project specification from a free-form brief — narrative sections, an atomic requirement catalog with acceptance criteria, a traceability matrix, and a structured IDEAL_STATE the code skill consumes. Use when a change needs a spec before building. Do not use when generating or fixing code (the code skill) or writing a simple spec that needs no formal catalog.
license: MIT
metadata:
  version: "2.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
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
| `constraints`  | No       | JSON object of constraints (see below)                                  |

### Constraints

| Key              | Effect                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `domain`         | Fixes the guidance pack (e.g. `"web-app"`). Omit to let synthia declare the best-fit pack from those available under `resources/` — domain selection is model-owned, not keyword-detected. |
| `max_iterations` | Revision budget (default 5).                                                                       |
| `skill_dir`      | Optional absolute skill path; lets the engine enumerate available domain packs from `<skill_dir>/resources/`. |

**Validation is evidence-gated:** vera's PASS must carry captured evidence (the IDEAL_STATE schema-check output, section/coverage counts) — the engine rejects an empty-evidence verdict, so a PRD is never marked valid on a bare assertion.

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

- Do not analyze or research the PRD's topic further.
- Do not execute implementation steps before approval.
- Do not modify the PRD — use "Refine" for changes.
- Do not verify or cross-check the PRD's findings — the agents already did this.

## Escalation (awaiting_clarification)

When the run pauses with an `awaiting_user` status and escalation data, the FSM is in `awaiting_clarification` — Synthia asked clarifying questions, or a validating stall was surfaced. Run state is held in the durable checkpointer keyed by `run_id`; there is no `orchestrator_state` to carry.

### Procedure

1. Detect the pause: the directive carries the clarifying questions and the run's `run_id`.
2. Present the questions to the user via `questionnaire`.
3. Collect the user's answer.
4. Resume the SAME run by feeding the answer back keyed on its `run_id` (do not start a fresh run). The engine sets `ctx.clarification_text`, fires `clarify`, and re-enters `generating` in synthesis mode.

## Mempalace Output Contract

After completion, `skills/prd-{session_id}/` contains:

| Drawer | Content | Format |
|--------|---------|--------|
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

## Outcome Capture

Do not write session-learning drawers manually. The orchestration engine records every terminal run's outcome into `penny/outcomes` automatically when the run reaches `complete` or `error`. The prd PRD artifacts themselves live in the session room `skills/prd-{session_id}` (see the Mempalace Output Contract above).

## Resilience

The engine validates every agent SUMMARY against the state's contract before advancing the FSM, rejecting empty or malformed summaries — it does not advance on fabricated defaults. Run state is checkpointed after every committed transition (keyed by `run_id`), so a killed run resumes via `recover`. On budget exhaustion the run completes honestly with `met=False` and the unresolved issues reported, never a fabricated pass.
