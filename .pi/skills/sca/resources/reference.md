# sca — Reference

Technical reference for the **secure code analysis** skill. `sca` is an
engine-backed `BasePlaybook` subclass (`ScaPlaybook` /
`orchestration.playbooks.sca`) that analyzes **cloned source repositories** on
disk. State lives in the durable SQLite checkpointer keyed by `run_id`; the
skill-dir `scripts/orchestrate.py` is a thin delegate to the shared engine
(`orchestration.cli:main`, `default_playbook="sca"`). There is no per-skill
FSM, no `/tmp` state file, no `--state` argv, and no `extract_state` /
`restore_state`.

The FSM is a strictly-sequential 13-phase pipeline with six human gates, two
deterministic tool phases, and one bounded augmentation loop. See `flow.mmd`
for the mermaid diagram (edge-for-edge with the playbook).

## States (custom names → legacy phase → agent)

Each work state maps to a `STATE_TO_PHASE` label (used for mempalace room
naming + phase-result capture). `TOOL` states run in-process with no agent.

| State | Phase | Kind | Agent | Prompt | Description |
|-------|-------|------|-------|--------|-------------|
| `charter` | P0_CHARTER | agent | echo | `echo-charter` | Establish charter, scope, rules of engagement; confirm deterministic charter draft |
| `census` | P1_CENSUS | agent | echo | `echo-census` | Inventory repo: languages, entry points, dependencies |
| `baseline_scan` | P2_BASELINE_SCAN | **tool** | — | — | Deterministic baseline scan (semgrep/osv/gitleaks); auto-advances |
| `context` | P3_CONTEXT | agent | synthia | `synthia-context` | Business/domain context: actors, data classes, PII, integrations |
| `architecture` | P4_ARCHITECTURE | agent | synthia | `synthia-architecture` | Architecture + trust boundaries from context |
| `requirements` | P5_REQUIREMENTS | agent | synthia | `synthia-requirements` | Derive SR-### security requirements |
| `threat_model` | P6_THREAT_MODEL | agent | tabitha | `tabitha-threat-model` | STRIDE/LINDDUN threat model against requirements |
| `targeted_scan` | P7_TARGETED_SCAN | **tool** | — | — | Deterministic targeted scan (+ augment rules); merges/dedupes vs P2; auto-advances |
| `triage` | P8_TRIAGE | agent | annie | `annie-triage` | Triage merged findings: dedup, prioritize, filter false positives |
| `deep_dive` | P9_DEEP_DIVE | agent | annie | `annie-deep-dive` | Deep-dive suspicious findings; optionally request augment scan |
| `verification` | P10_VERIFICATION | agent | vera | `vera-verification` | Single-shot non-destructive PoC batch in the Docker sandbox |
| `fix_verification` | P11_FIX_VERIFICATION | agent | vera | `vera-fix-verification` | Note whether prior findings appear remediated (enrichment, no re-scan) |
| `report` | P12_REPORT | agent | skribble | `skribble-report` | Human-readable report narrative (`report_md`) over deterministic artifacts |

Non-work states: `intake` (initial), the six `*_gate` states, `unknown` +
`awaiting_clarification` (escalation), `complete` (final), `error` (final).

`ESCALATABLE_STATES` = every agent phase above. `TOOL_STATES` =
`{baseline_scan, targeted_scan}`. `GATE_STATES` = `{charter_gate,
context_gate, threat_gate, triage_gate, verification_gate, report_gate}`.

## Transitions

Linear + gate + loop (exact event names from `SCAMachine`):

| Event | From → To | Guard / note |
|-------|-----------|--------------|
| `start_charter` | intake → charter | `initial_transition` |
| `charter_gate_ev` | charter → charter_gate | gate not yet cleared |
| `charter_skip` | charter → census | gate already cleared (defensive) |
| `charter_ok` | charter_gate → census | user approve |
| `charter_revise` | charter_gate → charter | user revise |
| `census_done` | census → baseline_scan | |
| `baseline_done` | baseline_scan → context | after tool run |
| `context_gate_ev` | context → context_gate | gate not yet cleared |
| `context_skip` | context → architecture | gate already cleared |
| `context_ok` | context_gate → architecture | user approve |
| `context_revise` | context_gate → context | user revise |
| `architecture_done` | architecture → requirements | |
| `requirements_done` | requirements → threat_model | |
| `threat_gate_ev` | threat_model → threat_gate | gate not yet cleared |
| `threat_skip` | threat_model → targeted_scan | gate already cleared |
| `threat_ok` | threat_gate → targeted_scan | user approve |
| `threat_revise` | threat_gate → threat_model | user revise |
| `targeted_done` | targeted_scan → triage | after tool run |
| `triage_gate_ev` | triage → triage_gate | gate not yet cleared |
| `triage_skip` | triage → deep_dive | gate cleared (augment re-entry) |
| `triage_ok` | triage_gate → deep_dive | user approve |
| `triage_revise` | triage_gate → triage | user revise |
| `dd_augment` | deep_dive → targeted_scan | `augment=true` AND iterations < cap |
| `dd_verify` | deep_dive → verification_gate | no augment, or cap reached |
| `vgate_ok` | verification_gate → verification | user approve |
| `verification_done` | verification → fix_verification | after single-shot PoC batch |
| `fix_done` | fix_verification → report_gate | |
| `rgate_ok` | report_gate → report | user approve |
| `report_done` | report → complete | after skribble returns |

Escalation + abort:

| Event | From → To | Note |
|-------|-----------|------|
| `to_unknown` | any agent phase → unknown | `progress_check` flags `needs_clarification` / UNCERTAIN |
| `escalate` | unknown → awaiting_clarification | engine HITL pause |
| `clarify` | awaiting_clarification → escalating phase | routed by `resume_target` (`_resume` sets it from `previous_state`; `context` fallback) |
| `abort` | any non-final state → error | terminal |

## Gates

Gates are engine planned-gate seams; each pauses exactly once. A gate cleared
once STAYS cleared (recorded in `meta["cleared_gates"]`), so the augment loop
re-entering `triage` does NOT re-gate — it takes `triage_skip`.

| Gate | Kind | Behavior |
|------|------|----------|
| `charter_gate` | AFTER | Structured charter questionnaire (`charter_questions`). Approve merges the answer, computes the deterministic census, fires `charter_ok`. Revise re-runs charter. |
| `context_gate` | AFTER | Approve the reconstructed business/domain context → `context_ok`. Revise → `context_revise`. |
| `threat_gate` | AFTER | Approve the threat model → `threat_ok`. Revise → `threat_revise`. |
| `triage_gate` | AFTER | Approve the triage results → `triage_ok`. Revise → `triage_revise`. |
| `verification_gate` | BEFORE | Pauses BEFORE dispatching vera. Approve → `vgate_ok` dispatches vera exactly once. Rejection re-asks (engine re-enters the gate). This is the sole checkpoint before any sandboxed code execution. |
| `report_gate` | AT | Pauses on entering the report phase. Approve builds the deterministic report artifacts, then `rgate_ok` dispatches skribble exactly once; completion happens on skribble's return. |

Approval words: `approve`, `approved`, `confirm`, `proceed`, `yes`, `accept`
(`_user_approved`). Anything else at an AFTER gate is recorded as a revision
note (`clarification_text`) and re-runs the phase.

## Augmentation loop (deep_dive → targeted_scan)

The only non-linear work transition. In `_route_deep_dive`: if the annie
result has `augment: true`, the playbook compares `meta["augment_iterations"]`
against the cap (`DEFAULT_AUGMENT_CAP = 3`, overridable via
`constraints["augment_cap"]`; negative values normalize back to the default).
While under cap it writes the P9-authored `new_rules` via
`write_augment_rules`, increments the counter, records the iteration, and
fires `dd_augment` (re-run targeted_scan). Once the cap is reached it sets
`meta["augment_capped"] = True` (surfaced in the report's residual-risk
disclosure) and falls through via `dd_verify`. The cap is enforced in code,
never a prose promise.

## Deterministic tool phases

`baseline_scan` and `targeted_scan` run via `run_tool_state` (no agent, no
dispatch). Execution seams `_run_baseline` / `_run_targeted` import the
skill-dir `baseline_scan.py` / `targeted_scan.py` lazily (tests override them
so real scanners never run). `baseline_scan` is idempotent on resume and HARD
BLOCKS to `error` only when ALL required tools are missing (never degrades to a
fake-clean empty findings set). `targeted_scan` never blocks (best-effort
semgrep). Each emits a mempalace drawer STUB recorded in `meta["mempalace_stubs"]`.

## The Docker verification sandbox (verification / P10)

On `vgate_ok`, vera returns a `run_pocs` batch of NON-DESTRUCTIVE PoCs (may be
empty with a coverage note if nothing is exploitable — the contract requires
the list but does NOT force it non-empty, avoiding fabrication pressure). The
playbook runs the batch once via `_run_pocs` (`process_verification_pocs`),
then fires `verification_done`. There is NO loop and NO re-dispatch. Every
executed PoC is recorded `poc_executed_pending_review`; the engine never
auto-decides a pass/fail verdict.

## Escalation / resume

Any agent phase whose summary carries `needs_clarification: true` (or requests
clarifying questions) is caught by `progress_check`, routed
`to_unknown → escalate → awaiting_clarification`, and pauses on the engine's
HITL path. Resume is by `run_id` + `user_response` (the engine's standard
resume) — there is NO `orchestrator_state` / `constraints.orchestrator_state`.
On resume `_resume` sets `resume_target` from `ctx.previous_state`, and
`clarify` routes back to the exact escalating phase (conservative `context`
fallback).

## Result payload

`result_payload` returns: `met`, `output_dir`, `report_dir`,
`findings_summary` (`findings_source`, `total_findings`, `severity_counts`),
`augment_capped`, `augment_iterations`, `requires_approval` (always true),
`report_md_present`, `cleared_gates`, `mempalace_stubs`, `errors`. Because the
subprocess cannot call MCP tools, each scan emits a mempalace drawer stub for
Penny to replay after completion.

## MemPalace

All inter-agent data exchange goes through MemPalace under wing `wing_sca`
(`MEMPALACE_WING`), with a per-phase room named
`<session_id>-<phase_name_lowercased>` (e.g. `<session_id>-p8_triage`). Penny
receives only structured summaries.
