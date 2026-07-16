# Orchestration Package — The shared execution engine


## What

`orchestration` is an installable Python package (`apps/orchestration/`) that provides the shared runtime an engine-backed skill's state machine rides on. Each such skill is a `BasePlaybook` subclass with its own domain-named states and per-state SUMMARY contracts; its `orchestrate.py` is a ~5-line delegate. The package owns the FSM protocol, a durable checkpointer, self-recovery, and best-effort observability emission — replacing the per-skill `orchestrate.py` FSM plumbing and the `--state`/`/tmp` state model. Every workflow skill runs on the engine — each a `BasePlaybook` subclass with a ~5-line delegate `orchestrate.py`, with no exceptions; the registered set is the single source of truth in `playbooks/__init__.py` (this doc does not enumerate it). There are no standalone operation-primitive skills and no user-facing reference-cycle skill.

## Why

Previously every skill re-implemented state serialization, transition replay (`_force_state`), the `start/step/status` protocol, summary validation, and escalation — ~10k lines that drifted out of sync. One engine collapses that into a thin `BasePlaybook` subclass per playbook. State lives in a SQLite checkpointer keyed by `run_id`, so a fresh `step` subprocess resumes by id — no argv blob, no replay — and any interrupted run auto-resumes.

## Components

| Module | Role |
|---|---|
| `engine.py` (`BasePlaybook`) | The FSM engine: `start/step/status`, summary gatekeeper, escalate, planned gates, parallel fan-out, resume, checkpoint, emit, budgets, retry |
| `primitives/` (`PrimitiveSpec` / `ParallelSpec`) | Reusable operation descriptors — name, default agent, per-state SUMMARY contract, task hint; a playbook binds them to its own states via `PRIMITIVE_BY_STATE` / `PARALLEL_BY_STATE` |
| `playbooks/` (`BasePlaybook` subclasses) | One subclass per domain skill (e.g. `code`) — each with its own state names, `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate` — plus `reference_cycle.py` (`ReferenceCycle`, the engine's smoke-test fixture) and the registry |
| `checkpointer.py` | Durable SQLite persistence keyed by `run_id` (session-indexed); kills `--state`/`_force_state` |
| `recovery.py` | Auto-recovery scan: resume `running`/`awaiting_user` runs on start |
| `obs_client.py` | Best-effort digest emission to the observability server (never blocks a run) |
| `cli.py` | `orchestrate {start|step|status|recover} --playbook --session-id --run-id` |

## Engine seams (what a playbook subclass customizes)

A domain skill subclasses `BasePlaybook` directly (no shared "standard cycle" base, no single-primitive playbook) and wires only the seams it needs:

- **Per-state SUMMARY contracts** — each state's `PrimitiveSpec.summary_contract` is validated by the gatekeeper; missing/mistyped fields fail loud.
- **Parallel fan-out** — a `PARALLEL_BY_STATE` state dispatches N branch agents in one `invoke_agents_parallel` directive and routes once on fan-in, aggregating by weakest branch confidence.
- **Planned-gate HITL** — `GATE_STATES` + `gate_questions`/`route_user` pause for a user decision with multi-way resume, distinct from the `UNCERTAIN`-confidence escalation path.
- **Domain `extras`** — a subclass stashes its own run state in `RunContext.extras`, which round-trips through the checkpointer without a schema change; `from_dict` rejects unknown top-level keys.

## Rules

1. **The directive contract is unchanged** (`invoke_agent`, `invoke_agents_parallel`, `escalate_to_user`, `complete`, `error`, `status`); every directive carries `run_id`; no `orchestrator_state` blob.
2. **The engine imports no agent-side capability** (e.g. not `outcome_ledger`). The agent subprocess does the real work; the engine only sequences.
3. **Rehydrate FSM position with `sm.current_state_value = <id>`** — never `_force_state`, never `start_value` for restore.
4. **Observability is best-effort** — a down server never blocks or breaks a run.
5. **Installed into `.venv`** via the uv workspace, so spawned skills `import orchestration` with no path hacks.

## Constraints

- **Primitives must be safe to re-run**; **ACT** must be idempotent (crash-resume re-issues the pending step).
- **Digests only** to observability — never full agent output (that lives in MemPalace).
- Checkpointer DB (`PENNY_ORCH_DB`) is gitignored.

## Verification

- [ ] `import orchestration` works from `.venv/bin/python` with no `sys.path` hacks
- [ ] Kill-and-resume by `run_id` works; CI grep finds zero `_force_state` / `--state`
- [ ] A run emits correlated `orchestration_events` (by `session_id`); server-down run still completes
- [ ] Auto-recovery resumes a `running` run with no manual `run_id`

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/` | The package |
| `docs/agents/skills/orchestration.md` | The orchestrator protocol (skill-facing) |
| `docs/agents/capabilities/observability-server/observability-server.md` | Correlated timeline schema |
