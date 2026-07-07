# PRD Skill — Generate production-grade PRDs

## What

A structured skill that turns free-form goals into layered PRDs: narrative prose, an atomic requirement catalog (REQ-NNN), a verification/traceability matrix, and a structured IDEAL_STATE JSON. Output is written to mempalace for downstream consumption, especially by the `code` skill.

## Why

Implementation needs a single source of truth for scope, acceptance criteria, and verification. The PRD skill produces four mutually consistent artifacts and feeds them directly into the `code` skill via the chain contract.

## Rules

1. **Use when starting a feature or project that needs clear requirements.** Do not use for quick bug fixes, simple specs, or exploratory research.
2. **Penny is a router.** Agents (`synthia`, `vera`) communicate via mempalace (`skills/prd-<session_id>`); Penny only sees summaries.
3. **Approval is required before implementation.** The skill stops at `complete` and waits for user approval/refinement/discard.
4. **Synthia uses the `needs_clarification` signal pattern.** When requirements are ambiguous, Synthia returns clarifying questions and the run routes through `unknown → awaiting_clarification`, pausing until the user answers.
5. **Vera validates twice.** IDEAL_STATE must pass `scripts/validate_ideal_state.py`, and the PRD layers must be internally consistent (narrative ↔ catalog ↔ matrix). Vera's `ideal_state_valid` verdict is the artifact oracle.
6. **Revision loop is bounded.** `max_iterations` prevents infinite loops; budget exhaustion completes honestly instead of forcing a pass.
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

### How it runs

Every Penny skill runs on one shared orchestration engine. The prd skill is a bespoke playbook (`PrdPlaybook` in `apps/orchestration/src/orchestration/playbooks/prd.py`) — the skill directory holds only a ~5-line delegate, not a state machine. Run state lives in the engine's durable SQLite checkpointer keyed by `run_id`; there are no `/tmp` session files. If a run is interrupted mid-step, the engine automatically resumes it and re-issues that step.

### Workflow phases

```
intake ──▶ generating ──▶ validating ──▶ complete
              ▲              │
              └──────────────┘
             (bounded revision loop)

generating/validating ──▶ unknown ──▶ awaiting_clarification ──▶ generating (resume)
```

States: `intake`, `generating`, `validating`, `unknown`, `awaiting_clarification`, `complete`, `error`.

| State | Agent | Purpose | Output to mempalace |
|-------|-------|---------|----------------------|
| `intake` | — | Validate the goal, detect domain (`web-app`/`generic` keyword scan), set clarify-first mode | — |
| `generating` | `synthia` | Ask clarifying questions, synthesize all four PRD artifacts, or revise them | Narrative, catalog, matrix, IDEAL_STATE |
| `validating` | `vera` | Schema-validate IDEAL_STATE and quality-check PRD consistency | Validation report |
| `complete` | — | Return summary (may report honest exhaustion) | — |
| `unknown` / `awaiting_clarification` | — | Pause and surface clarifying questions | Clarifying questions |
| `error` | — | Terminal failure | Errors |

Domain detection is a deterministic keyword scan inside the playbook — there is no separate classify agent step.

### Synthia's three modes

Inside `generating`, Synthia runs in one of three modes:

- **Clarification questions** — the first pass; identifies gaps and returns clarifying questions.
- **Synthesis** — produces all four artifacts.
- **Revision** — fixes issues Vera reported and re-emits all four.

The first `generating` pass always runs in clarification mode. If it produces neither questions nor artifacts, the playbook dispatches a full synthesis (a one-shot self-loop that cannot spin).

### Revision loop

When Vera finds issues:

1. `validating → generating` in revision mode with the issue list.
2. Synthia rewrites the affected artifacts.
3. Vera re-validates.
4. Loop continues until validation passes or `max_iterations` is reached.

If the budget is spent, the run completes honestly with `met=False` and the unresolved issues reported — it never fabricates a passing PRD. If the same issues persist across revisions with no progress, the run escalates to the user instead of looping.

### Mempalace output contract

After completion, `skills/prd-<session_id>/` (wing `penny`) contains:

| Drawer | Content | Format |
|--------|---------|--------|
| `prd_goal` | Original goal | String |
| `prd_narrative` | 12-section prose PRD | Markdown |
| `prd_requirement_catalog` | Atomic requirements (REQ-001 → REQ-NNN) | JSON |
| `prd_verification_matrix` | REQ → test strategy mapping | JSON |
| `ideal_state` | Structured JSON matching canonical schema | JSON |

> Vera's `ideal_state_valid` verdict is the artifact oracle: the run is marked complete only when `valid` AND `ideal_state_valid` hold. There is no separate database-scan gate.

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
- Synthia operates in three modes inside `generating`: clarification questions (first pass), synthesis, and revision.
- The engine rejects empty or malformed summaries, so a run never advances on a fabricated completion.

## Verification

- [ ] All four core artifacts exist in mempalace.
- [ ] IDEAL_STATE passes `validate_ideal_state.py`.
- [ ] Narrative, catalog, and matrix are internally consistent.
- [ ] No agent returned `confidence: UNCERTAIN` without escalation.
- [ ] User approved the PRD before chaining to `code`.

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/prd.py` | `PrdPlaybook` — states, routing, escalation, SUMMARY contracts |
| `apps/orchestration/tests/test_prd_playbook.py` | Playbook tests |
| `.pi/skills/prd/SKILL.md` | Skill definition and invocation (`metadata.penny.engine: orchestration`) |
| `.pi/skills/prd/scripts/orchestrate.py` | ~5-line delegate to the engine CLI |
| `.pi/skills/prd/scripts/validate_ideal_state.py` | IDEAL_STATE schema validator |
| `.pi/skills/prd/assets/prompts/*.md` | Agent domain guidance |
| `.pi/skills/prd/resources/web-app/*.md` | Domain-specific guidance, question bank, NFR checklist, example |
| `docs/agents/capabilities/prd-skill/prd-skill.md` | Agent implementation notes |
</content>
