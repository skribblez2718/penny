# Orchestration Package — The shared execution engine

## What

`orchestration` is an installable Python package (`apps/orchestration/`) that provides the shared runtime for engine-backed skills. Each skill is a `BasePlaybook` subclass with domain-named states and per-state SUMMARY contracts; its `orchestrate.py` is a thin delegate. The package owns the FSM protocol, durable checkpointer, self-recovery, and best-effort observability emission. The current user-facing playbook is `research`; `reference-cycle` is an internal engine fixture, not a user-facing skill.

## Why

Previously every skill re-implemented state serialization, transition replay (`_force_state`), the `start/step/status` protocol, summary validation, and escalation — ~10k lines that drifted out of sync. One engine collapses that into a thin `BasePlaybook` subclass per playbook. State lives in a SQLite checkpointer keyed by `run_id`, so a fresh `step` subprocess resumes by id — no argv blob, no replay — and any interrupted run auto-resumes.

## Components

| Module                                           | Role                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.py` (`BasePlaybook`)                     | The FSM engine: `start/step/status`, summary gatekeeper, escalate, planned gates, parallel fan-out, resume, checkpoint, emit, budgets, retry                                                      |
| `primitives/` (`PrimitiveSpec` / `ParallelSpec`) | Reusable operation descriptors — name, default agent, per-state SUMMARY contract, task hint; a playbook binds them to its own states via `PRIMITIVE_BY_STATE` / `PARALLEL_BY_STATE`               |
| `playbooks/` (`BasePlaybook` subclasses)         | Domain playbooks such as `research.py`, each with its own state names, `PRIMITIVE_BY_STATE`, `route_after`, and `done_predicate`, plus the internal `reference_cycle.py` fixture and the registry |
| `checkpointer.py`                                | Durable SQLite persistence keyed by `run_id` (session-indexed); kills `--state`/`_force_state`                                                                                                    |
| `artifacts.py` / `artifact_cli.py`               | Separate immutable exact-byte artifact plane and generic stdin owner CLI; not FSM authority                                                                                                       |
| `recovery.py`                                    | Forward-only recovery: owner dispatch pause and exact pending-state/ref reissue for `running`/`awaiting_user` runs                                                                                |
| `obs_client.py`                                  | Best-effort digest emission to the observability server (never blocks a run)                                                                                                                      |
| `cli.py`                                         | `orchestrate <start-or-step-or-status-or-recover> --playbook --session-id --run-id`                                                                                                               |

## Engine seams (what a playbook subclass customizes)

A domain skill subclasses `BasePlaybook` directly (no shared "standard cycle" base, no single-primitive playbook) and wires only the seams it needs:

- **Per-state SUMMARY contracts** — each state's `PrimitiveSpec.summary_contract` is validated by the gatekeeper; missing/mistyped fields fail loud.
- **Parallel fan-out** — a `PARALLEL_BY_STATE` state dispatches N branch agents in one `invoke_agents_parallel` directive and routes once on fan-in, aggregating by weakest branch confidence.
- **Planned-gate HITL** — `GATE_STATES` + `gate_questions`/`route_user` pause for a user decision with multi-way resume, distinct from the `UNCERTAIN`-confidence escalation path.
- **Artifact input retention** — direct non-control FSM successors and same-state retry/fan-in consumers are derived from the machine. `artifact_input_phases` explicitly declares older selected phases a later state must still inspect; every pair is validated for known states and graph reachability before a scope is minted.
- **Domain `extras`** — a subclass stashes its own run state in `RunContext.extras`, which round-trips through the checkpointer without a schema change; `from_dict` rejects unknown top-level keys.

## Rules

1. **The action vocabulary is stable** (`invoke_agent`, `invoke_agents_parallel`, `paused`, `escalate_to_user`, `complete`, `error`, `status`); agent actions also carry strict owner `output_artifact` metadata, every directive carries `run_id`, and no `orchestrator_state` blob returns. `paused` is typed, non-terminal, and retriable.
2. **Consumer scopes are least-authority.** They contain only the producing state for retry/fan-in, legal non-control FSM successors, and validated retained-input consumers. They never default to every registered playbook state, and only a legal terminal edge/declaration grants `state:complete`.
3. **The engine imports no worker-side capability.** Workers receive owner-selected exact artifact grants and no durable-memory tools; the engine only sequences and persists compact refs/state.
4. **Rehydrate FSM position with `sm.current_state_value = <id>`** — never `_force_state`, never `start_value` for restore.
5. **Observability is best-effort** — a down server never blocks or breaks a run.
6. **Installed into `.venv`** via the uv workspace, so spawned skills `import orchestration` with no path hacks.
7. **Track A is forward-only.** `PENNY_ARTIFACT_DISPATCH_MODE` accepts exactly `active|paused` (default `active`; unknown fails closed). Paused mode blocks every new agent, deterministic-tool, and fan-out dispatch before artifact selection/checkpoint mutation. Status and exact artifact reads stay available. Fresh-process recovery after reactivation reconstructs the identical pending refs/metadata or the next explicit compatible revision; semantic rooms and memory payloads are never recovery inputs.

## Constraints

- **Primitives must be safe to re-run**; **ACT** must be idempotent (crash-resume re-issues the pending step).
- A dispatch pause preserves the current running checkpoint and selected refs; it never marks the run complete/error or changes palace/service authority.
- **Digests only** to observability — never full worker output (exact bytes live in the owner-only artifact store).
- **Context-safe reads** — granted artifact payloads use typed continuation; `RunContext` stores refs, never payload bytes.
- Checkpointer DB (`PENNY_ORCH_DB`) is gitignored.

## Verification

- [ ] `import orchestration` works from `.venv/bin/python` with no `sys.path` hacks
- [ ] Kill-and-resume by `run_id` works; CI grep finds zero `_force_state` / `--state`
- [ ] A run emits correlated `orchestration_events` (by `session_id`); server-down run still completes
- [ ] Auto-recovery resumes a `running` run with no manual `run_id`

## Files

| File                                                                    | Purpose                                  |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| `apps/orchestration/`                                                   | The package                              |
| `docs/agents/skills/orchestration.md`                                   | The orchestrator protocol (skill-facing) |
| `docs/agents/capabilities/observability-server/observability-server.md` | Correlated timeline schema               |
