# PRD Skill Reference

Technical reference for the prd skill: state machine, schemas, conventions, domain detection, and output structure.

The prd skill is a `BasePlaybook` subclass (`PrdPlaybook` in `apps/orchestration/src/orchestration/playbooks/prd.py`) running on the shared orchestration engine. Run state is held in a durable SQLite checkpointer keyed by `run_id`; there are no session files, no `--state` argv, and no `orchestrator_state`.

## State Machine (`PrdMachine`)

### States

| State                    | Agent     | Description                                                                 |
| ------------------------ | --------- | -------------------------------------------------------------------------- |
| `intake`                 | —         | Initial state. `initial_transition` detects domain, sets clarify-first mode, seeds the revision budget, then fires `start_generate`. |
| `generating`             | `synthia` | Produce the four PRD artifacts. Three modes: `clarification` (questions first), `synthesis` (full artifacts), `revision` (fix vera's issues). |
| `validating`             | `vera`    | Validate IDEAL_STATE schema + 12 narrative sections + catalog quality + matrix coverage + cross-artifact traceability. |
| `unknown`                | —         | Escalation staging state (entered via `to_unknown` from an escalatable state). |
| `awaiting_clarification` | —         | Paused for user input. Run status is `awaiting_user`; resume by feeding the user response back keyed on `run_id`. |
| `complete`               | —         | Terminal success. `result_payload` returns the session summary + mempalace drawers. |
| `error`                  | —         | Terminal failure (reached via `abort`).                                    |

Domain detection is folded into `intake`; the legacy `classify`/echo state is gone (the legacy `start()` always auto-skipped it).

### Transitions

| Event                | From                                                        | To                       | Guard / trigger                                              |
| -------------------- | ---------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `start_generate`     | intake                                                     | generating               | Fired by `initial_transition`.                              |
| `synthesize`         | generating                                                 | generating (self)        | A clarification pass emitted no questions and 0 requirements → run a full synthesis instead of dispatching vera an empty room. One-shot (mode leaves `clarification` permanently). |
| `generate_done`      | generating                                                 | validating               | Artifacts produced.                                         |
| `validate_pass`      | validating                                                 | complete                 | `valid && ideal_state_valid`.                               |
| `revise`             | validating                                                 | generating               | Issues found and `iteration + 1 < max_iterations`. Records an iteration digest, then re-dispatches synthia in `revision` mode. |
| `validate_exhausted` | validating                                                 | complete                 | Budget spent. Completes HONESTLY with `met=False` and unresolved issues reported (no fabricated `valid=True`). |
| `to_unknown`         | generating, validating                                     | unknown                  | `progress_check` returned a reason: `needs_clarification`, or (validating only) a stalled revision loop. |
| `escalate`           | unknown                                                    | awaiting_clarification   | Auto.                                                       |
| `clarify`            | awaiting_clarification                                     | generating               | User response supplied; sets `ctx.clarification_text`, which promotes a `clarification`-mode dispatch to `synthesis`. |
| `abort`              | intake, generating, validating, unknown, awaiting_clarification | error               | Unrecoverable failure.                                      |

### Escalation gate (`progress_check`)

`ESCALATABLE_STATES = {generating, validating}`. Before routing, the engine calls `progress_check`:

- If the agent SUMMARY has `needs_clarification`, the run escalates (`to_unknown` → `escalate` → `awaiting_clarification`), carrying synthia's `clarifying_questions`.
- In `validating`, if the PRD is not valid (`valid && ideal_state_valid` is false) and `is_stalled` reports the same issues persisting across revisions with no measurable progress, the run escalates rather than fabricating a valid PRD.

### Revision loop budget

`ctx.max_iterations` defaults to 5 (`constraints.max_iterations` overrides). The `validating → generating` revise loop is bounded by it; on exhaustion the run takes `validate_exhausted` to `complete` with `met=False`.

## Three-Layer PRD Output

The prd skill produces four artifacts written to the mempalace room `skills/prd-{session_id}` (wing `penny`):

### Layer 1: Narrative PRD (Markdown)

Prose document following the 12-section PRD template (`resources/prd-template.md`):

1. Overview — one paragraph: what and why
2. Problem Statement — who's affected, quantified pain
3. Success Metrics — 2-5 measurable outcomes
4. User Stories — with acceptance criteria
5. Features — P0/P1/P2 priority table (max 5 per iteration)
6. Out of Scope — what will NOT be built
7. Non-Functional Requirements — performance, security, reliability
8. Dependencies & Constraints — external systems, platform limits
9. Risks & Assumptions — with mitigations
10. Edge Cases — what-if scenarios
11. Build Order — implementation sequence, dependencies first
12. Deliverables — all artifacts

### Layer 2: Atomic Requirement Catalog (JSON)

Each requirement is atomic (single behavior), testable, and prioritized:

```json
[
  {
    "id": "REQ-001",
    "priority": "P0",
    "title": "User authentication endpoint",
    "description": "POST /auth/login accepts email+password, returns JWT",
    "acceptance_criteria": [
      "Valid credentials return 200 with JWT in response body",
      "Invalid credentials return 401 with error message",
      "Missing fields return 400 with validation errors"
    ]
  }
]
```

### Layer 3: Verification / Traceability Matrix (JSON)

Maps every REQ to verification strategies:

```json
{
  "REQ-001": {
    "unit_tests": ["auth_service_test.py::test_valid_login", "auth_service_test.py::test_invalid_login"],
    "integration_tests": ["test_auth_api.py::test_login_endpoint"],
    "e2e_tests": [],
    "manual_tests": []
  }
}
```

### IDEAL_STATE JSON

Canonical schema consumed by the `code` skill:

| Field                     | Required | Description                                            |
| ------------------------- | -------- | ------------------------------------------------------ |
| `goal`                    | Yes      | One sentence: what are we building?                    |
| `source`                  | No       | Default: `"prd_synthesis"`                             |
| `success_criteria`        | Yes      | List of measurable "done" conditions (min 1)           |
| `anti_criteria`           | No       | Things that must NOT happen                            |
| `verification`            | No       | Dict of verification tiers (lint, unit_tests, etc.)    |
| `security_review`         | No       | Security domains to review                             |
| `edge_cases`              | No       | What-if scenarios                                      |
| `language`                | No       | Primary programming language                           |
| `impacted_files_estimate` | No       | Estimated files affected                               |
| `dependencies`            | No       | External systems, APIs, packages                       |
| `deliverables`            | No       | All artifacts this task produces                       |
| `build_order`             | No       | Implementation sequence, dependencies first            |

vera's `ideal_state_valid` verdict is the artifact oracle on the engine path — it overrides synthia's self-reported claim, and the run cannot complete unless it is true.

## Mempalace Room Convention

Room: `skills/prd-{session_id}`, wing `penny`.

Contents written by agents:
- `{session_id} PRD Narrative` — synthia's Layer 1 prose
- `{session_id} Requirement Catalog` — synthia's Layer 2 JSON
- `{session_id} Verification Matrix` — synthia's Layer 3 JSON
- `{session_id} IDEAL_STATE` — synthia's IDEAL_STATE JSON
- `{session_id} Validate` — vera's validation report

Downstream skills (especially `code`) read from this room after the prd skill completes; `code` reads IDEAL_STATE from it as a hard dependency.

## Domain Detection

Keyword scan in goal text against `WEB_APP_KEYWORDS`, run in `initial_transition` and stashed in `ctx.extras["prd"]["domain"]`:

```
react, vue, angular, django, flask, fastapi, next, next.js, nuxt,
streamlit, frontend, backend, api, web, website, spa, ssr, express,
node, node.js, postgres, mysql, supabase, firebase, tailwind,
bootstrap, css, html, javascript, typescript, htmx, graphql,
rest, websocket, svelte
```

Match → `web-app`. No match → `generic`.

## Agent SUMMARY Contracts

Each state validates its agent's SUMMARY against the primitive spec's contract before routing. Only the listed required field is mandatory; the rest are optional.

### Synthia (`generating`) — required `complete: bool`

Optional: `requirement_count`, `narrative_sections`, `verification_matrix_complete`, `ideal_state_valid`, `needs_clarification`, `clarifying_questions`, `resolved_issues`, `confidence`.

Synthesis mode:

```
SUMMARY:{"requirement_count":12,"narrative_sections":12,"verification_matrix_complete":true,"ideal_state_valid":true,"confidence":"PROBABLE","complete":true,"needs_clarification":false,"clarifying_questions":[]}
```

Clarification mode:

```
SUMMARY:{"requirement_count":0,"narrative_sections":0,"verification_matrix_complete":false,"ideal_state_valid":false,"confidence":"PROBABLE","complete":true,"needs_clarification":true,"clarifying_questions":["What framework?"]}
```

### Vera (`validating`) — required `valid: bool`

Optional: `ideal_state_valid`, `issues`, `complete`, `needs_clarification`, `clarifying_questions`, `confidence`.

```
SUMMARY:{"valid":true,"ideal_state_valid":true,"issues":[],"confidence":"CERTAIN","complete":true}
```

## Escalation & Resume

When the run reaches `awaiting_clarification`, the engine returns an `awaiting_user` status carrying the clarifying questions. Resume by feeding the user's response back to the engine keyed on the same `run_id` (no `orchestrator_state`); the engine sets `ctx.clarification_text` and fires `clarify` to re-enter `generating` in synthesis mode.

## Subagents Used

| Agent    | State        | Purpose                                        | Prompt File                 |
| -------- | ------------ | ---------------------------------------------- | --------------------------- |
| `synthia`| `generating` | PRD synthesis (clarification / synthesis / revision) | `assets/prompts/synthia.md` |
| `vera`   | `validating` | Validation (IDEAL_STATE + PRD quality)         | `assets/prompts/vera.md`    |
