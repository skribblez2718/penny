# PRD Skill — Agent Implementation Notes

## Purpose

Generate production-grade PRDs from free-form goals. Output is layered (narrative + atomic requirement catalog + verification/traceability matrix) plus a structured IDEAL_STATE JSON. Designed to feed into the `code` skill via the chain contract.

## Architecture

Hybrid extension + Python orchestrator (mirrors `plan` skill):

- **Skill extension** (`skill` tool): Routes orchestrator actions, invokes `subagent` for agents
- **Python state machine** (`orchestrate.py`): Drives the workflow through 4+ states

## State Machine

```
[classify] → [generate] → [validate] → [complete]
                ↑            │
                └────────────┘
             (revision loop)

[classify] → [generate] → [unknown] → [awaiting_clarification] → [generate] (resume)
```

States: `classify`, `generate`, `validate`, `complete`, `error`, `unknown`, `awaiting_clarification`

## Agent Definitions

| Agent    | Role                                           | Tools                                                                |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Echo     | Domain classification (web-app vs generic)     | `read,grep,find,ls,bash,web_search,web_fetch,questionnaire,memory_*` |
| Synthia  | Dual-mode: clarifying questions OR synthesis   | `read,grep,find,ls,questionnaire,memory_*`                           |
| Vera     | Validate IDEAL_STATE + PRD quality             | `read,grep,find,ls,questionnaire,memory_*`                           |

## Output Contract — Mempalace Room

The prd skill writes to `skills/prd-{session_id}/`:

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

The code skill refuses to start without PRD+IDEAL_STATE — emits a chain-contract error pointing to this example.

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

1. **Penny is a router in the skill loop** — agents communicate via mempalace, never through Penny
2. **Synthia uses the `needs_clarification` signal pattern** — returns `needs_clarification: true` with `clarifying_questions` array, orchestrator routes through `unknown → awaiting_clarification`, Penny presents questions interactively
3. **Vera validates twice** — IDEAL_STATE matches `validate_ideal_state.py` schema AND PRD layers are internally consistent (narrative ↔ catalog ↔ matrix)
4. **Revision loop bounded** — `max_iterations: 5` prevents infinite loops
5. **Safe defaults never claim completion** — empty agent results get `complete: false`, `valid: false`, `requirement_count: 0`

## Resilience — Pi Update Safety

Mirrors the plan skill's defensive measures:

- `_validate_summary()` per agent — rejects empty/malformed summaries
- `_safe_default_summary()` — defaults do NOT claim completion
- Synthia verification supports both modes (clarification vs synthesis)
- Session file at `/tmp/prd-{session_id}.json` — survives subprocess boundaries
- `--state-data` CLI arg for state passthrough (instead of mempalace search from subprocess)

## Version History

- **1.0.0** — Initial release with web-app domain pack. Hard dependency on code skill via chain contract.
