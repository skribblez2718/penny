# PRD Skill — Agent Implementation Notes

## Purpose

Generate production-grade PRDs from free-form goals. Output is layered (narrative + atomic requirement catalog + verification/traceability matrix) plus a structured IDEAL_STATE JSON. Designed to feed into the `code` skill via the chain contract.

## Architecture

The prd skill runs on the shared orchestration engine (`apps/orchestration/`, an installed package). It is a bespoke `BasePlaybook` subclass — `PrdPlaybook` in `apps/orchestration/src/orchestration/playbooks/prd.py` — with custom-named states, per-state SUMMARY contracts, `route_after` routing, a `done_predicate`, `progress_check` escalation, and `ESCALATABLE_STATES`.

- `.pi/skills/prd/scripts/orchestrate.py` is a ~5-line delegate: `from orchestration.cli import main; raise SystemExit(main(default_playbook="prd"))`. There is no FSM and no state serialization in the skill directory.
- `SKILL.md` frontmatter sets `metadata.penny.engine: orchestration`.
- Run state lives in the engine's durable SQLite checkpointer keyed by `run_id`. There is no `--state`/`--state-data` argv and no `/tmp/prd-<session_id>.json` session file. Crash-resume is automatic (engine `recover` / `recover_pending`): a run interrupted mid-step re-issues that step.
- Summary validation is the engine's job (`contracts.py` `validate_summary_contract`). Empty or malformed summaries are rejected by the engine — the run does not advance on fabricated defaults.

## State Machine (`PrdMachine`)

```
intake ──start_generate──▶ generating ──generate_done──▶ validating ──validate_pass──▶ complete
                              ▲    │ synthesize (self-loop)     │
                              │    └── clarification pass with  │
                              │        no output → full synth   │
                     revise   │                                 │
                              └─────────────────────────────────┤
                                                                │ validate_exhausted
                                                                ▼ (budget spent; met=False)
                                                             complete

generating | validating ──to_unknown──▶ unknown ──escalate──▶ awaiting_clarification ──clarify──▶ generating
any non-final state ──abort──▶ error
```

States: `intake` (initial), `generating`, `validating`, `unknown`, `awaiting_clarification`, `complete` (final), `error` (final).

The legacy `classify` state is gone. Domain selection is **model-owned** (the keyword `detect_domain` table was deleted per the Bitter-Lesson gate): `initial_transition` enumerates the guidance packs under the skill's `resources/` (via `available_domains`), synthia declares the best-fit `domain` in its SUMMARY, and `route_after` stores it (`constraints["domain"]` wins; an unknown declaration falls back to `generic`). Stashed in `ctx.extras["prd"]["domain"]`.

`validating` is **evidence-gated** (Rec 4): `PRD_VALIDATE` declares an `evidence` field the engine's contract requires non-empty, so vera cannot PASS a PRD on a bare assertion — the captured check output flows to `ctx.verify_evidence` and the outcome ledger.

### Transitions

| Transition | Edge | When |
| ---------- | ---- | ---- |
| `intake → generating` | `start_generate` | Fresh run; mode set to `clarification` (clarify-first HITL) |
| `generating → generating` | `synthesize` | Clarification pass yielded neither questions nor artifacts → dispatch full synthesis. One-shot (mode leaves `clarification` permanently), so it cannot spin |
| `generating → validating` | `generate_done` | Artifacts produced |
| `validating → complete` | `validate_pass` | `valid` AND `ideal_state_valid` |
| `validating → generating` | `revise` | Issues found and within `max_iterations` budget; mode = `revision` |
| `validating → complete` | `validate_exhausted` | Budget spent; completes HONESTLY with `met=False` and the unresolved issues (no fabricated `valid=True`) |
| `generating\|validating → unknown` | `to_unknown` | Escalation triggered |
| `unknown → awaiting_clarification` | `escalate` | Pause the run and surface questions |
| `awaiting_clarification → generating` | `clarify` | User answer resumes the same run; a clarify resume promotes clarify-first mode to full synthesis |
| any → `error` | `abort` | Terminal failure |

## Synthia's Three Modes

`generating` dispatches synthia in one of three modes (signaled in the task text; the effective mode is derived in `_effective_mode` from `ctx.extras["prd"]["mode"]` plus `ctx.clarification_text`):

- **CLARIFICATION QUESTIONS** — the first `generating` pass. Analyze goal + domain, identify gaps, return `needs_clarification: true` with a `clarifying_questions` array.
- **SYNTHESIS** — produce all 4 artifacts (narrative, requirement catalog, verification matrix, IDEAL_STATE) and write each to mempalace.
- **REVISION** — read existing artifacts, fix the reported issues, re-emit all 4.

## Escalation & Resilience

- `ESCALATABLE_STATES = {generating, validating}`.
- `progress_check` drives `generating`/`validating → unknown → awaiting_clarification` and pauses the run when: the agent emits `needs_clarification` (questions are stashed in `ctx.extras["prd"]["clarifying_questions"]`), OR — in `validating` — the same PRD issues persist across revisions with no measurable progress (`is_stalled`), escalating rather than fabricating a valid PRD. An agent emitting `confidence=UNCERTAIN` escalates the same way.
- The user answer resumes the SAME run via a `user` step keyed by `run_id`; `previous_state` lives in `ctx` and is checkpointed (no state blob on the wire).
- The revision loop is bounded by `ctx.max_iterations` (default 5). Budget exhaustion reports honestly (`met=False`, `exhausted=True`, `unresolved_issues`), never a forced completion. The legacy `_write_placeholder_artifacts` (which hardcoded an unrelated past project into chroma) is deleted.
- There is no direct `chroma.sqlite3` artifact-verification gate. Vera's `ideal_state_valid` verdict is the artifact oracle on the engine path; her verdict overrides synthia's claim. `done_predicate` returns `valid AND ideal_state_valid`.

## SUMMARY Contracts

| State | Agent | Required | Optional |
| ----- | ----- | -------- | -------- |
| `generating` (`PRD_GENERATE`) | synthia | `complete: bool` | `requirement_count`, `narrative_sections`, `verification_matrix_complete`, `ideal_state_valid`, `needs_clarification`, `clarifying_questions`, `resolved_issues`, `confidence` |
| `validating` (`PRD_VALIDATE`) | vera | `valid: bool` | `ideal_state_valid`, `issues`, `complete`, `needs_clarification`, `clarifying_questions`, `confidence` |

## Agent Definitions

| Agent    | Role                                           | Tools                                                                |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Synthia  | Three modes: clarifying questions / synthesis / revision | `read,grep,find,ls,questionnaire,memory_*`                 |
| Vera     | Validate IDEAL_STATE + PRD quality             | `read,grep,find,ls,questionnaire,memory_*`                           |

Domain selection is model-owned, not an agent step on the engine path (see the states description above): synthia declares the best-fit `domain` in its SUMMARY, `route_after` stores it, and `constraints["domain"]` overrides (unknown → `generic`). There is no keyword scan — the legacy `detect_domain` table was deleted per the Bitter-Lesson gate. (Echo does not run on the engine path.)

## Output Contract — Mempalace Room

The prd skill writes to `skills/prd-{session_id}/` (wing `penny`). The room name and the `wing=penny` mempalace instructions are preserved verbatim because the `code` skill reads IDEAL_STATE from this room as a hard dependency.

| Drawer                    | Type    | Content                                                          |
| ------------------------- | ------- | ---------------------------------------------------------------- |
| `prd_goal`                | string  | Original goal                                                   |
| `prd_narrative`           | string  | Full PRD prose (12 sections per prd-template.md)                 |
| `prd_requirement_catalog` | list    | `[{id, priority, description, acceptance_criteria}, ...]`        |
| `prd_verification_matrix` | dict    | `{REQ-001: {unit_test, integration_test, e2e_test}, ...}`        |
| `ideal_state`             | dict    | IDEAL_STATE JSON matching `scripts/validate_ideal_state.py`      |

The `code` skill reads `ideal_state` and `prd_goal` from this room on startup.

## Chain Contract (Hard Dependency with code)

```typescript
skill({ chain: [
  { skill_name: "prd", goal: "<goal>", constraints: { ... } },
  { skill_name: "code", goal: "<goal>", constraints: { ... } }
]})
```

The code skill refuses to start without PRD+IDEAL_STATE — emits a chain-contract error pointing to this example. The prd result payload exposes `session_room` and `mempalace_drawers: {wing: penny, room: skills/prd-<session_id>}` so the chain handler injects the room into the next step's constraints.

## Domain Packs

`resources/<domain>/` directory contains domain-specific guidance loaded on demand:

- `web-app/` — question-bank, guidance, nfr-checklist, example (v1 pack)
- Future: `mobile-app/`, `cli/`, `data-pipeline/`, `internal-tool/`

## Web-App Domain Pack (v1)

- **question-bank.md**: 40+ clarifying questions across 6 areas (architecture, frontend, backend, infrastructure, testing, compliance)
- **guidance.md**: Per-section synthesis guidance for the 12 PRD sections
- **nfr-checklist.md**: Concrete NFR thresholds (Core Web Vitals, WCAG 2.1 AA, OWASP ASVS)
- **example.md**: Full worked example — "User Authentication Dashboard" with all 4 artifacts

## Key Rules

1. **Penny is a router in the skill loop** — agents communicate via mempalace, never through Penny.
2. **Synthia uses the `needs_clarification` signal pattern** — returns `needs_clarification: true` with `clarifying_questions`; `progress_check` routes `generating → unknown → awaiting_clarification` and Penny presents questions interactively.
3. **Vera validates twice** — IDEAL_STATE matches `validate_ideal_state.py` schema AND PRD layers are internally consistent (narrative ↔ catalog ↔ matrix). Her `ideal_state_valid` verdict is the artifact oracle.
4. **Revision loop bounded** — `ctx.max_iterations` (default 5); exhaustion completes honestly with `met=False`.
5. **The engine rejects empty/malformed summaries** — a run never advances on fabricated defaults.

## Files

| File | Purpose |
| ---- | ------- |
| `apps/orchestration/src/orchestration/playbooks/prd.py` | `PrdPlaybook` — states, SUMMARY contracts, routing, escalation |
| `apps/orchestration/tests/test_prd_playbook.py` | Playbook tests |
| `.pi/skills/prd/scripts/orchestrate.py` | ~5-line delegate to `orchestration.cli.main` |
| `.pi/skills/prd/scripts/validate_ideal_state.py` | IDEAL_STATE schema validator |
| `.pi/skills/prd/assets/prompts/*.md` | Agent domain guidance |
| `.pi/skills/prd/resources/web-app/*.md` | Domain-specific guidance, question bank, NFR checklist, example |

## Version History

- **1.0.0** — Initial release with web-app domain pack. Hard dependency on code skill via chain contract.
</content>
</invoke>
