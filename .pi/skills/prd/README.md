# PRD Skill

Generates world-class PRDs with layered output: narrative prose, atomic requirement catalog, verification/traceability matrix, and structured IDEAL_STATE JSON. Outputs to mempalace for downstream skill consumption.

## Overview

- **Purpose**: Generate production-grade PRDs from goals and user responses
- **Domains**: Web-app (primary), generic (fallback) — extensible via resource packs
- **Outcome**: Four artifacts in mempalace: narrative PRD, requirement catalog, verification matrix, IDEAL_STATE
- **Downstream**: Chains naturally with the `code` skill which reads IDEAL_STATE from mempalace

## Architecture

```
┌──────────────────────────────────────────────┐
│  Penny invokes skill tool                    │
│  skill({ skill_name: "prd", goal: "..." })   │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Skill Extension (TypeScript)                │
│  ┌─────────────────────────────────────┐     │
│  │ Loop:                                │     │
│  │  1. Python orchestrate.py → Action   │     │
│  │  2. Subagent tool → Agent result     │     │
│  │  3. Extract SUMMARY → Feed to Python │     │
│  │  4. Repeat until complete/error      │     │
│  └─────────────────────────────────────┘     │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Python State Machine (orchestrate.py)       │
│  classify → generate → validate → complete   │
│              ↑           │                   │
│              └───────────┘                   │
│          (revision loop)                     │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Subagents (fresh context each)              │
│  echo (classify) → synthia (generate)        │
│  → vera (validate)                           │
│  All read/write via mempalace                │
│  Only SUMMARY goes back to orchestrator      │
└──────────────────────────────────────────────┘
```

**Key principle: Penny's context stays clean.** Agents communicate via mempalace — Penny never sees full agent output. The orchestrator only receives structured summaries (requirement_count, valid, issues, etc.).

## State Machine

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ classify │ ──▶ │ generate │ ──▶ │ validate │ ──▶ │ complete │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                      │                │
                      │                │ (issues found)
                      │                └──────────────┐
                      │                               │
                      │ (needs clarification)          │
                      ▼                               ▼
               ┌──────────┐                   ┌──────────┐
               │  unknown │                   │ generate │
               └──────────┘                   │(revision)│
                      │                       └──────────┘
                      ▼
          ┌──────────────────────┐
          │ awaiting_clarification│
          └──────────────────────┘
                      │
                      │ (user responds)
                      ▼
               ┌──────────┐
               │ generate │ (synthesis mode)
               └──────────┘
```

### States

| State                    | Agent   | Description                                         |
| ------------------------ | ------- | --------------------------------------------------- |
| `classify`               | `echo`  | Domain detection + project scan                     |
| `generate`               | `synthia`| Synthesis, question generation, or revision        |
| `validate`               | `vera`  | IDEAL_STATE schema + PRD quality check              |
| `complete`               | —       | Return structured completion summary                |
| `unknown`                | —       | Escalation triggered by UNCERTAIN or needs_clarification |
| `awaiting_clarification` | —       | Waiting for user response                           |
| `error`                  | —       | Terminal failure                                    |

### Transitions

| Transition           | From                    | To                      | Trigger                                   |
| -------------------- | ----------------------- | ----------------------- | ----------------------------------------- |
| `classify_done`      | classify                | generate                | Domain detected                           |
| `prd_generated`      | generate                | validate                | Requirements synthesized                  |
| `validation_pass`    | validate                | complete                | All validations pass                      |
| `revise`             | validate                | generate                | Issues found, revision loop               |
| `generate_unknown`   | generate                | unknown                 | Synthia signals needs_clarification       |
| `escalate`           | unknown                 | awaiting_clarification  | Auto-escalate                             |
| `resume_generate`    | awaiting_clarification  | generate                | User provides responses                   |

## Workflow Phases

| Phase      | Agent    | Purpose                                              | Output to Mempalace       |
| ---------- | -------- | ---------------------------------------------------- | ------------------------- |
| Classify   | `echo`   | Detect domain, scan project, confirm technology stack | `{session_id} Classify`   |
| Generate   | `synthia`| Synthesize all 4 PRD artifacts (or generate questions) | 4 separate drawers        |
| Validate   | `vera`   | Schema validate IDEAL_STATE + quality check          | `{session_id} Validate`   |

The revision loop (validate → generate) can repeat up to 5 iterations.

## Mempalace Integration

**Room**: `skills/prd-{session_id}`

**After completion, the room contains:**

| Drawer                        | Content                                    |
| ----------------------------- | ------------------------------------------ |
| `{session_id} Classify`       | Domain classification + project context    |
| `{session_id} PRD Narrative`  | 12-section prose PRD document              |
| `{session_id} Requirement Catalog` | Atomic requirements (REQ-001 → REQ-NNN) |
| `{session_id} Verification Matrix` | REQ → test strategy mapping            |
| `{session_id} IDEAL_STATE`    | Structured JSON matching canonical schema  |
| `{session_id} Validate`       | Vera's validation report with issues       |

**Mempalace artifact verification (defense against hallucinated completions):**

The orchestrator queries the chroma backend directly after Vera's
validation. If any of the four core artifacts (`prd_narrative`,
`prd_requirement_catalog`, `prd_verification_matrix`, `ideal_state`)
are missing from the room, the orchestrator refuses to mark the PRD
complete. Instead, it routes back to the `generate` state with a
`revision_issues` list naming the missing artifacts, forcing Synthia
to actually write them on the next pass.

**Downstream consumption**: The `code` skill reads from this room during its `define_specs` phase — no manual data transfer needed when chaining.

## Usage

### Via Skill Tool (Recommended)

```
skill({
  skill_name: "prd",
  goal: "Build a user authentication dashboard with React and FastAPI",
  project_root: "/path/to/project"
})
```

### Direct CLI Invocation

```bash
cd .pi/skills/prd
python3 scripts/orchestrate.py start \
  --session-id my-prd-001 \
  --goal "Build a user authentication dashboard with React and FastAPI" \
  --project-root /path/to/project
```

### With Constraints

```bash
python3 scripts/orchestrate.py start \
  --session-id my-prd-001 \
  --goal "Build a dashboard" \
  --constraints '{"domain": "web-app", "max_iterations": 3}'
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

| Constraint            | Default   | Description                                      |
| --------------------- | --------- | ------------------------------------------------ |
| `max_iterations`      | 5         | Maximum revision cycles (validate → generate)    |
| `domain`              | auto-detect | Override domain classification                 |

## Testing

```bash
cd .pi/skills/prd

# Unit tests
PYTHONPATH=/home/skribblez/projects/penny python3 -m pytest tests/test_unit.py -v

# Integration tests
PYTHONPATH=/home/skribblez/projects/penny python3 -m pytest tests/test_integration.py -v

# E2E tests (requires model)
PYTHONPATH=/home/skribblez/projects/penny python3 -m pytest tests/test_e2e.py -v -m e2e
```

## Files

| File                         | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `SKILL.md`                   | Skill definition and invocation            |
| `README.md`                  | This documentation                         |
| `scripts/orchestrate.py`     | Python state machine + CLI                 |
| `scripts/__init__.py`        | Package init                               |
| `tests/test_unit.py`         | Unit tests for state machine               |
| `tests/test_integration.py`  | Integration tests for multi-step flows     |
| `tests/test_e2e.py`          | E2E tests for full CLI lifecycle           |
| `assets/prompts/echo.md`     | Domain classification agent prompt         |
| `assets/prompts/synthia.md`  | PRD synthesis agent prompt (dual-mode)     |
| `assets/prompts/vera.md`     | Validation agent prompt                    |
| `resources/prd-template.md`  | 12-section PRD template (canonical)        |
| `resources/flow.mmd`         | Mermaid state diagram                      |
| `resources/reference.md`     | Technical reference: schemas, contracts    |
| `resources/web-app/question-bank.md` | Domain-specific clarifying questions |
| `resources/web-app/guidance.md`     | Per-section synthesis guidance       |
| `resources/web-app/nfr-checklist.md`| Concrete NFR thresholds              |
| `resources/web-app/example.md`     | Full worked example                  |
| `requirements.txt`           | Python dependencies                        |

## Resilience — Pi Update Safety

The PRD skill is designed to survive Pi updates that change:

- Event type strings (`agent_end`, `message_end`)
- Message structure (field names, nesting)
- CLI entry point
- SSE timeout behavior
- Subprocess exit semantics

### Defensive Measures

| Layer            | Defense                              | What It Catches                                                                       |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| **Orchestrator** | `_validate_summary()` per agent      | Missing required SUMMARY fields from empty/crashed agents                             |
| **Orchestrator** | `_safe_default_summary()`            | Defaults that do NOT claim completion — prevents advancing on fabricated data         |
| **Orchestrator** | `_extract_and_validate_summary()`    | Single gatekeeper: every agent result validated before state transition               |
| **Orchestrator** | `_check_statemachine_version()`      | Logs python-statemachine version at startup for diagnostics                           |
| **Orchestrator** | Session persistence to `/tmp/prd-*.json` | Recovers state across process restarts                                           |

### Known Failure Modes

| Mode                    | Symptom                                                    | Root Cause                               | Fix                                                             |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| **SSE Timeout**         | Agent exits 0, no SUMMARY, skill advances with empty data  | undici bodyTimeout killed SSE            | Skill validates all summaries; rejects empty dicts              |
| **Missing SUMMARY**     | `parseSummaryFromOutput` returns `{}`; orchestrator errors | Agent crashed or didn't emit SUMMARY     | `_validate_summary()` rejects; returns error action             |
| **Bad Default Fallback**| `_safe_default_summary` claimed completion                 | Old defaults lied about completion       | All defaults set `*_complete: false`, fields zeroed             |
| **State Machine Desync**| Guard fails unexpectedly                                   | python-statemachine behavior change      | `_check_statemachine_version()` logs version; fallback loop     |

### If the Skill Fails After a Pi Update

1. Check `scripts/orchestrate.py` logs for `_check_statemachine_version()` output
2. Run tests: `PYTHONPATH=<project_root> python3 -m pytest tests/ -v`
3. Check agent-runner stderr for `"completed without message_end"`
4. Verify `parseSummaryFromOutput` can still find SUMMARY blocks
5. Check Pi changelog for event type or message structure changes

## Version History

- **1.0.0** — Initial release: classify → generate → validate → complete with revision loop, UNKNOWN_STATE protocol, 3-layer PRD output, IDEAL_STATE generation, web-app domain pack
