# Code Skill

## Overview

- **Purpose**: Test-verified coding skill using the Ralph Wiggum Loop. Always invoked for code generation, refactoring, or bug fixes. Uses skribble for implementation with mandatory security and coding standard compliance.
- **PRD (optional)**: Uses a PRD + IDEAL_STATE from the `prd` skill when available; otherwise synthesizes lightweight criteria from the goal. Runs standalone, or as a chain: `skill({ chain: [{ skill_name: "prd", ... }, { skill_name: "code", ... }] })`.
- **Use When**: Multi-step process requiring code orchestration (with or without a preceding PRD)
- **Outcome**: Validated implementation matching the IDEAL STATE from the PRD

## P0 Foundation Contract

A new schema-v2 run persists one canonical registry of schema-versioned, run-bound, digest-verifiable artifacts. Every stage references the same immutable selected quality-floor version; each dependent stage also consumes the exact selected IDEAL STATE, target profile, and—after planning creates it—Piper plan by reference. Fresh-process recovery returns the same content and references; legacy missing fields are reconstructed only with provenance or remain explicitly unverified.

The quality floor has exactly six non-waivable dimensions: **security, scope-appropriate production readiness, target idiom, harmful duplication avoidance, unnecessary complexity avoidance, and regression freedom**. No stage may skip, waive, disable, delete, reinterpret, or mark one not applicable.

Completion is fail-closed. `result.met=true` and public success/complete require final verification plus 100% coverage of every criterion, Annie obligation, and quality dimension. A command-verifiable claim needs a valid same-run execution receipt with successful status, intact redacted output digest/reference, and trusted execution-owner integrity. Judgment-only claims need an independent reviewer disposition. Self-authored evidence, missing config, wrong-run/tampered/failed receipts, or unresolved findings never count.

An Annie finding is remediated with evidence, not applicable with rationale and independent confirmation, unresolved, or a human-accepted residual risk. Only complete human acceptance can select the last state; successful terminal results and outcomes preserve the human-accepted residual risk record.

Both human gates use complete, non-truncated structural questionnaire transport. The actual selected artifact ID/version/digest and full criteria/findings or full Piper plan remain visible across crash recovery; terminal controls are escaped without changing the recovered value. Plain caller text cannot approve. Greenfield, ambiguous polyglot, or insufficient-evidence target profiles route to clarification before planning/implementation. Plan, implementation, and verification use project-native commands from one selected target profile—never a Python/JavaScript universal fallback.

Release uses a selected verification manifest, immutable full-eval baseline, dirty-worktree preservation artifact, public-boundary scope/leak manifest, and named contract/drift matrix. Out-of-scope matches are report-only and pre-existing dirty paths retain path, Git/index/worktree state, mode, digest, and directly compared bytes.

## State Machine

The code skill runs on the shared orchestration engine — one `BasePlaybook`
subclass, `orchestration.playbooks.code:CodePlaybook`, whose `CodeMachine` FSM
has custom-named states:

```
intake → exploring → analyzing → checking_criteria
  → [criteria_gate: P0 trusted accept; legacy accept/skip] → planning
  → [criteria_gate: refine] → refining_criteria (piper)
       → valid changed proposal → checking_criteria (carren judgment)
       → invalid/unchanged proposal → criteria_gate with errors
  → [plan_gate: approve/refine/deny] → implementing → verifying ⇄ learning

learning gap=false → one final verifying → complete
learning gap=true  → implementing (within budget) | P0 public incomplete with result.met=false (budget spent)
plan_gate deny     → error

Terminal: complete, error
Escalation: <working state incl. refining_criteria/learning> → unknown → awaiting_clarification → exploring
```

Entry point is `exploring`. When chained, the `prd` skill handles intake and
specification (IDEAL_STATE), which `start()` resolves; run standalone, `start()`
synthesizes it from the goal. See `resources/flow.html` for the full diagram.

## Subagents Used

| Subagent | State(s)                    | Purpose                                                                                    | Prompt File                |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| echo     | exploring                   | Deep exploration — find impacted files, verify IDEAL_STATE                                 | assets/prompts/echo.md     |
| annie    | analyzing                   | Security analysis — risks, integration surface, dependencies                               | assets/prompts/annie.md    |
| carren   | checking_criteria, learning | Judgment only: criteria quality before planning; output-vs-IDEAL-STATE gap                 | assets/prompts/carren.md   |
| piper    | refining_criteria, planning | Author a changed criteria proposal; implementation planning                                | assets/prompts/piper.md    |
| skribble | implementing, verifying     | Code + tests to satisfy the IDEAL STATE (sequencing is the model's call), and verification | assets/prompts/skribble.md |

## Mempalace Integration

**Context Retrieved (before workflow)**:

- Read `skills/prd-{session_id}/IDEAL_STATE` — IDEAL STATE JSON from prd skill (required)
- Read `skills/prd-{session_id}/PRD Narrative` — PRD document (optional, for context)
- Search `skills/code-<session_id>` for prior session context

**Learnings Stored (after completion)**:

- `penny/skills` — Session summary, decisions, outcomes

## Files

| File                     | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `scripts/orchestrate.py` | Thin delegate routing `start`/`step`/`status`/`recover` to the orchestration engine |
| `assets/prompts/*.md`    | Domain Guidance for subagents                                                       |
| `resources/reference.md` | Technical reference                                                                 |
| `resources/flow.html`    | Self-contained state diagram (dark HTML)                                            |

The FSM itself lives in `apps/orchestration/src/orchestration/playbooks/code.py`
(and `code_detection.py` for server-framework detection).

## Testing

The playbook and detection logic are tested in the orchestration package:

```bash
pytest apps/orchestration/tests/test_code_playbook.py -v
pytest apps/orchestration/tests/test_code_detection.py -v
```

## Version History

- **1.0.0** — Initial scaffold
- **2.0.0** — Removed intake/define_specs; PRD skill is now a hard dependency. Explore is the entry point.
- **3.0.0** — Migrated onto the shared orchestration engine. `scripts/orchestrate.py` is now a thin delegate; the FSM lives in `orchestration.playbooks.code:CodePlaybook`. State persists in the engine's durable checkpointer (no `--state-data`).
- **3.1.0** — PRD/IDEAL_STATE is now **optional**: standalone runs synthesize criteria from the goal (`ideal_state_from_goal`); `code` runs independently or as a `prd → code` chain. Flow diagram migrated to self-contained `resources/flow.html`.
