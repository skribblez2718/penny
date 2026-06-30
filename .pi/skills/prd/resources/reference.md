# PRD Skill Reference

Technical reference for the prd skill: schemas, conventions, domain detection, and output structure.

## State Machine

### States

| State                    | Description                                     | Entry Action                                       |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------- |
| `classify`               | Detect domain from goal + project scan          | Run Echo agent                                     |
| `generate`               | Synthesize PRD artifacts + IDEAL_STATE          | Run Synthia agent in appropriate mode              |
| `validate`               | Run IDEAL_STATE schema check + PRD quality      | Run validate_ideal_state.py + Vera agent           |
| `complete`               | Success — write to mempalace                    | Return structured completion summary               |
| `error`                  | Terminal failure                                | Log errors                                         |
| `unknown`                | Escalation — needs user input                   | Route to awaiting_clarification                    |
| `awaiting_clarification` | Waiting for user response                       | Present clarifying questions to user               |

### Transitions

| Transition           | From                    | To                      | Guard                    |
| -------------------- | ----------------------- | ----------------------- | ------------------------ |
| `classify_done`      | classify                | generate                | `has_domain`             |
| `prd_generated`      | generate                | validate                | `_prd_exists`            |
| `validation_pass`    | validate                | complete                | `is_valid`               |
| `revise`             | validate                | generate                | `has_revision_issues`    |
| `generate_unknown`   | generate                | unknown                 | `needs_clarification_guard` |
| `escalate`           | unknown                 | awaiting_clarification  | (always)                 |
| `resume_generate`    | awaiting_clarification  | generate                | `has_clarification`      |

## Three-Layer PRD Output

The PRD skill produces four artifacts written to the mempalace room `skills/prd-{session_id}/`:

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

Matches canonical schema from `scripts/validate_ideal_state.py`:

| Field                | Required | Description                                            |
| -------------------- | -------- | ------------------------------------------------------ |
| `goal`               | Yes      | One sentence: what are we building?                    |
| `source`             | No       | Default: `"prd_synthesis"`                             |
| `success_criteria`   | Yes      | List of measurable "done" conditions (min 1)           |
| `anti_criteria`      | No       | Things that must NOT happen                            |
| `verification`       | No       | Dict of verification tiers (lint, unit_tests, etc.)    |
| `security_review`    | No       | Security domains to review                             |
| `edge_cases`         | No       | What-if scenarios                                      |
| `language`           | No       | Primary programming language                           |
| `impacted_files_estimate` | No  | Estimated files affected                               |
| `dependencies`       | No       | External systems, APIs, packages                       |
| `deliverables`       | No       | All artifacts this task produces                       |
| `build_order`        | No       | Implementation sequence, dependencies first            |

## Mempalace Room Convention

Room: `skills/prd-{session_id}`

Contents written by agents:
- `{session_id} Classify` — Echo's domain classification findings
- `{session_id} PRD Narrative` — Synthia's Layer 1 prose
- `{session_id} Requirement Catalog` — Synthia's Layer 2 JSON
- `{session_id} Verification Matrix` — Synthia's Layer 3 JSON
- `{session_id} IDEAL_STATE` — Synthia's IDEAL_STATE JSON
- `{session_id} Validate` — Vera's validation report

Downstream skills (especially `code`) read from this room after the PRD skill completes.

## Domain Detection

Keyword scan in goal text against `WEB_APP_KEYWORDS`:

```
react, vue, angular, django, flask, fastapi, next, next.js, nuxt,
streamlit, frontend, backend, api, web, website, spa, ssr, express,
node, node.js, postgres, mysql, supabase, firebase, tailwind,
bootstrap, css, html, javascript, typescript, htmx, graphql,
rest, websocket, svelte
```

Match → `web-app`. No match → `generic`.

## Agent SUMMARY Contracts

### Echo (Classify)

```
SUMMARY:{"domain":"web-app","domain_evidence":"fastapi + react keywords","project_context":{"framework":"fastapi"},"confidence":"PROBABLE","complete":true}
```

### Synthia (Generate — Synthesis Mode)

```
SUMMARY:{"requirement_count":12,"narrative_sections":12,"verification_matrix_complete":true,"ideal_state_valid":true,"confidence":"PROBABLE","complete":true,"needs_clarification":false,"clarifying_questions":[]}
```

### Synthia (Generate — Question Mode)

```
SUMMARY:{"requirement_count":0,"narrative_sections":0,"verification_matrix_complete":false,"ideal_state_valid":false,"confidence":"PROBABLE","complete":true,"needs_clarification":true,"clarifying_questions":["What framework?"]}
```

### Vera (Validate)

```
SUMMARY:{"valid":true,"ideal_state_valid":true,"issues":[],"confidence":"CERTAIN","complete":true}
```

## Error Handling

| Error                         | Behavior                                        |
| ----------------------------- | ----------------------------------------------- |
| Empty SUMMARY                 | `_validate_summary` rejects, returns error action |
| Missing required fields       | `_validate_summary` returns descriptive error   |
| UNCERTAIN confidence          | Route to UNKNOWN_STATE, escalate to user        |
| Max iterations exceeded       | Force-complete with error note                  |
| Invalid state JSON in CLI     | Return error action                             |
| Agent exit code != 0          | Return error action                             |

## Subagents Used

| Agent    | Purpose                                        | Prompt File                 |
| -------- | ---------------------------------------------- | --------------------------- |
| `echo`   | Domain classification + project context scan   | `assets/prompts/echo.md`    |
| `synthia`| PRD synthesis (dual-mode)                      | `assets/prompts/synthia.md` |
| `vera`   | Validation (IDEAL_STATE + PRD quality)         | `assets/prompts/vera.md`    |
