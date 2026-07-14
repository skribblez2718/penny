# PRD Skill

Generates layered PRDs: narrative prose (12 sections), an atomic requirement catalog (REQ-NNN with priority + acceptance criteria), a verification/traceability matrix, and structured IDEAL_STATE JSON. All artifacts are written to mempalace for downstream skill consumption.

## Overview

- **Purpose**: Generate production-grade PRDs from goals and user responses
- **Domains**: Web-app (primary), generic (fallback) — extensible via resource packs
- **Outcome**: Four artifacts in the mempalace room `skills/prd-{session_id}`: narrative PRD, requirement catalog, verification matrix, IDEAL_STATE
- **Downstream**: Chains with the `code` skill, which reads IDEAL_STATE from that room as a hard dependency

## Architecture

The prd skill is an engine-backed playbook: `PrdPlaybook`, a `BasePlaybook` subclass in `apps/orchestration/src/orchestration/playbooks/prd.py`. The shared orchestration engine owns the protocol — the SUMMARY gatekeeper, escalation/HITL, checkpointing, budgets, and outcome capture. `scripts/orchestrate.py` is a thin delegate that routes `start`/`step`/`status`/`recover` into the engine (`orchestration.cli.main`).

Run state lives in a durable SQLite checkpointer keyed by `run_id` — there are no `/tmp` session files, no `--state` argv, and no `extract_state`/`restore_state`. Agents (synthia, vera) run in fresh context and communicate only via mempalace; Penny receives only the structured SUMMARY per step (`requirement_count`, `valid`, `issues`, etc.), never the full agent output.

## State Machine

The FSM (`PrdMachine`) is the source of truth; see `resources/flow.mmd` for the exact diagram and `resources/reference.md` for the full transition table.

```
intake ──start_generate──▶ generating ──generate_done──▶ validating ──validate_pass──▶ complete
                              │  ▲                            │  │
                        synthesize│                     revise │  │ validate_exhausted
                          (self)  └────────────────────────────┘  └────────────────▶ complete (met=False)
```

### States

| State                    | Agent     | Description                                                              |
| ------------------------ | --------- | ----------------------------------------------------------------------- |
| `intake`                 | —         | Initial. Lists available domain packs, sets clarify-first mode, seeds revision budget |
| `generating`             | `synthia` | Produces the four artifacts (modes: clarification / synthesis / revision) |
| `validating`             | `vera`    | IDEAL_STATE schema + PRD quality + traceability check                   |
| `unknown`                | —         | Escalation staging (entered via `to_unknown`)                           |
| `awaiting_clarification` | —         | Paused for user input; resume by run_id                                 |
| `complete`               | —         | Terminal success                                                        |
| `error`                  | —         | Terminal failure (via `abort`)                                          |

Domain selection is **model-owned**: `intake` lists the guidance packs under `resources/`, and synthia declares the best-fit `domain` in its SUMMARY (a caller `constraints.domain` short-circuits the choice). The legacy keyword `detect_domain` table is deleted; the `classify`/echo state was already gone.

- **Evidence-gated validation** (Rec 4): vera's `PRD_VALIDATE` contract requires a non-empty `evidence` field — captured check output (IDEAL_STATE schema result, section/coverage counts). The engine rejects an empty-evidence PASS, so a PRD is never marked valid on a bare assertion; the evidence rides to the outcome ledger.

### Key flows

- **Clarify-first HITL**: the first `generating` dispatch runs in CLARIFICATION mode. If synthia asks questions (`needs_clarification`), the run escalates through `unknown` → `awaiting_clarification`; the user's response resumes into synthesis.
- **Evaluator-optimizer loop**: `validating → generating` (`revise`) fixes vera's issues, bounded by `max_iterations` (default 5). On budget exhaustion the run completes honestly with `met=False` and the unresolved issues reported — never a fabricated `valid=True`.
- **Stall escalation**: if the same validation issues persist across revisions with no progress, the run escalates to the user rather than looping or fabricating a pass.
- **Artifact oracle**: vera's `ideal_state_valid` verdict overrides synthia's self-report; the run cannot complete unless it is true.

## Mempalace Integration

**Room**: `skills/prd-{session_id}` (wing `penny`)

After completion the room contains:

| Drawer                             | Content                                    |
| ---------------------------------- | ------------------------------------------ |
| `{session_id} PRD Narrative`       | 12-section prose PRD document              |
| `{session_id} Requirement Catalog` | Atomic requirements (REQ-001 → REQ-NNN)    |
| `{session_id} Verification Matrix` | REQ → test strategy mapping                |
| `{session_id} IDEAL_STATE`         | Structured JSON matching the canonical schema |
| `{session_id} Validate`            | Vera's validation report with issues       |

**Downstream consumption**: the `code` skill reads from this room during its `define_specs` phase — no manual data transfer needed when chaining.

## Usage

### Via Skill Tool (Recommended)

```
skill({
  skill_name: "prd",
  goal: "Build a user authentication dashboard with React and FastAPI",
  project_root: "/path/to/project"
})
```

### With Constraints

```
skill({
  skill_name: "prd",
  goal: "Build a dashboard",
  constraints: { "domain": "web-app", "max_iterations": 3 }
})
```

### Chain with Code Skill

```
skill({
  chain: [
    { skill_name: "prd", goal: "Build a user authentication dashboard" },
    { skill_name: "code", goal: "Implement the PRD from the previous step" }
  ]
})
```

## Configuration

| Constraint       | Default     | Description                                   |
| ---------------- | ----------- | --------------------------------------------- |
| `max_iterations` | 5           | Revision budget (validating → generating)     |
| `domain`         | auto-detect | Override domain classification                |

## Files

| File                         | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `SKILL.md`                   | Skill definition and invocation                    |
| `README.md`                  | This documentation                                 |
| `scripts/orchestrate.py`     | Thin delegate to the shared orchestration engine   |
| `assets/prompts/synthia.md`  | PRD synthesis agent prompt (three modes)           |
| `assets/prompts/vera.md`     | Validation agent prompt                            |
| `resources/prd-template.md`  | 12-section PRD template (canonical)                |
| `resources/flow.mmd`         | Mermaid state diagram (matches `PrdMachine`)       |
| `resources/reference.md`     | Technical reference: states, schemas, contracts    |
| `resources/frontier-evaluation.md` | Design rationale vs. frontier agent patterns |
| `resources/web-app/`         | Domain pack (question bank, guidance, NFR checklist, example) |

The playbook itself (`PrdPlaybook`) lives in the installed `orchestration` package, not in this skill directory.
