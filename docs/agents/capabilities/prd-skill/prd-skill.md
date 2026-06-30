# PRD Skill — Generate production-grade PRDs

## What

A structured skill that turns free-form goals into layered PRDs: narrative prose, an atomic requirement catalog (REQ-NNN), a verification/traceability matrix, and a structured IDEAL_STATE JSON. Output is written to mempalace for downstream consumption, especially by the `code` skill.

## Why

Implementation needs a single source of truth for scope, acceptance criteria, and verification. The PRD skill produces four mutually consistent artifacts and feeds them directly into the `code` skill via the chain contract.

## Rules

1. **Use when starting a feature or project that needs clear requirements.** Do not use for quick bug fixes, simple specs, or exploratory research.
2. **Penny is a router.** Agents (`echo`, `synthia`, `vera`) communicate via mempalace (`skills/prd-<session_id>`); Penny only sees summaries.
3. **Approval is required before implementation.** The skill stops at `complete` and waits for user approval/refinement/discard.
4. **Synthia uses the `needs_clarification` signal pattern.** When requirements are ambiguous, Synthia returns clarifying questions and the FSM routes through `unknown → awaiting_clarification`.
5. **Vera validates twice.** IDEAL_STATE must pass `scripts/validate_ideal_state.py`, and the PRD layers must be internally consistent (narrative ↔ catalog ↔ matrix).
6. **Revision loop is bounded.** Max iterations prevent infinite loops.
7. **Chain with `code` skill.** Use `skill({ chain: [ { skill_name: "prd" }, { skill_name: "code" } ] })` to hand off PRD output automatically.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "prd",
  goal: "Build a user authentication dashboard with React and FastAPI",
  project_root: "/path/to/project",
})
```

Optional constraints:

| Constraint | Description |
|------------|-------------|
| `domain` | Override auto-detection: `"web-app"`, `"generic"` |
| `max_iterations` | Override default revision bound |
| `refinement_context` | User notes when re-invoking after refine |

### State machine phases

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ classify │────▶│ generate │────▶│ validate │────▶│ complete │
└──────────┘     └────┬─────┘     └────┬─────┘     └──────────┘
                      │                │
                      │ (needs         │ (issues found)
                      │  clarification)│
                      ▼                │
               ┌──────────┐           │
               │  unknown │           │
               └────┬─────┘           │
                    │                 │
                    ▼                 ▼
         ┌─────────────────────┐  ┌──────────┐
         │ awaiting_clarification│  │ generate │ (revision)
         └─────────────────────┘  └──────────┘
                    │
                    │ (user responds)
                    ▼
               ┌──────────┐
               │ generate │ (synthesis mode)
               └──────────┘
```

| State | Agent | Purpose | Output to mempalace |
|-------|-------|---------|----------------------|
| `classify` | `echo` | Detect domain, scan project, confirm tech stack | `{session_id} Classify` |
| `generate` | `synthia` | Synthesize all four PRD artifacts (or generate questions) | Narrative, catalog, matrix, IDEAL_STATE |
| `validate` | `vera` | Schema-validate IDEAL_STATE and quality-check PRD consistency | `{session_id} Validate` |
| `complete` | — | Return summary | — |
| `unknown` / `awaiting_clarification` | — | UNKNOWN_STATE protocol | Clarifying questions |
| `error` | — | Terminal failure | Errors |

### Revision loop

When Vera finds issues:

1. `validate → generate` with `revision_issues` list.
2. Synthia rewrites the affected artifacts.
3. Vera re-validates.
4. Loop continues until validation passes or `max_iterations` is reached.

### Mempalace output contract

After completion, `skills/prd-<session_id>/` contains:

| Drawer | Content | Format |
|--------|---------|--------|
| `{sid} Classify` | Domain classification + project context | Markdown |
| `{sid} PRD Narrative` | 12-section prose PRD | Markdown |
| `{sid} Requirement Catalog` | Atomic requirements (REQ-001 → REQ-NNN) | JSON |
| `{sid} Verification Matrix` | REQ → test strategy mapping | JSON |
| `{sid} IDEAL_STATE` | Structured JSON matching canonical schema | JSON |
| `{sid} Validate` | Vera's validation report | Markdown |

> The orchestrator queries the chroma backend after validation. If any of the four core artifacts are missing, it refuses to mark the PRD complete and routes back to `generate`.

### PRD narrative sections

The narrative follows the canonical 12-section template:

1. Overview / Elevator Pitch
2. Goals & Success Metrics
3. Target Audience / Personas
4. Functional Requirements
5. Non-Functional Requirements
6. User Experience & Flows
7. API / Data Model
8. Security & Privacy
9. Compliance
10. Operational Considerations
11. Open Questions / Risks
12. Out of Scope

### Atomic requirements

Each requirement in the catalog:

```json
{
  "id": "REQ-001",
  "priority": "P0 | P1 | P2",
  "description": "...",
  "acceptance_criteria": ["..."]
}
```

### IDEAL_STATE output

The `ideal_state` drawer is a structured JSON document consumed by the `code` skill during its `define_specs` and `verify` phases. It must pass `scripts/validate_ideal_state.py`.

### Chain contract with code skill

```typescript
skill({
  chain: [
    { skill_name: "prd", goal: "Build a user authentication dashboard" },
    { skill_name: "code", goal: "Implement the PRD from the previous step" }
  ]
})
```

The `code` skill reads IDEAL_STATE and the verification matrix from `skills/prd-<session_id>/` automatically.

## Constraints

- Default `max_iterations = 5`.
- Web-app domain pack is available at `resources/web-app/`; generic is the fallback.
- Synthia operates in two modes inside `generate`: question generation (first pass, no user responses) and synthesis (after responses or during revision).
- Safe default summaries never claim completion.

## Verification

- [ ] All four core artifacts exist in mempalace.
- [ ] IDEAL_STATE passes `validate_ideal_state.py`.
- [ ] Narrative, catalog, and matrix are internally consistent.
- [ ] No agent returned `confidence: UNCERTAIN` without escalation.
- [ ] User approved the PRD before chaining to `code`.

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/prd/SKILL.md` | Skill definition and invocation |
| `.pi/skills/prd/README.md` | Architecture and output contract |
| `.pi/skills/prd/scripts/orchestrate.py` | Python FSM and CLI |
| `.pi/skills/prd/scripts/validate_ideal_state.py` | IDEAL_STATE schema validator |
| `.pi/skills/prd/assets/prompts/*.md` | Agent prompts |
| `.pi/skills/prd/resources/prd-template.md` | 12-section PRD template |
| `.pi/skills/prd/resources/web-app/*.md` | Domain-specific guidance, question bank, NFR checklist, example |
| `.pi/skills/prd/tests/test_*.py` | Unit, integration, and E2E tests |
| `docs/humans/capabilities/prd-skill/prd-skill.md` | Human-facing overview |
