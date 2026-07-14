# orchestration — Penny's shared FSM execution engine

`orchestration` is the one installable runtime every Penny skill's state machine
delegates to. Skills delegate in ~5 lines; the package owns the FSM protocol, a
durable checkpointer, self-recovery, and best-effort observability. It replaces
the per-skill `orchestrate.py` FSM plumbing and the legacy `--state`/`/tmp`
state model.

## Why

Previously every skill re-implemented state serialization, transition replay,
the `start/step/status` protocol, summary validation, and escalation — ~10k
lines that drifted out of sync. One engine collapses that into a thin
`BasePlaybook` subclass per playbook. State lives in a SQLite checkpointer keyed
by `run_id`, so a fresh `step` subprocess resumes by id — no argv blob, no
replay — and any interrupted run auto-resumes.

## Install (uv workspace)

This package is a member of the repo's uv workspace and is installed **editable**
into `.venv`:

```bash
uv sync --extra dev      # installs orchestration + penny-observability editable
python -c "import orchestration; print(orchestration.__version__)"
```

No `sys.path`/`PYTHONPATH` hacks — the skill driver spawns `.venv/bin/python`
and `import orchestration` just works.

## CLI

```
orchestrate {start|step|status|recover} --playbook <name> --session-id <id> --run-id <id>
            [--goal <text>] [--constraints <json>] [--agent <name>] [--result <json>]
```

- `start` — init a run, checkpoint, emit the first directive.
- `step`  — validate the agent SUMMARY, route the FSM, checkpoint, emit the next directive.
- `status`— report the run's state.
- `recover` — auto-resume a pending run for the session (playbook-scoped).

Exactly one JSON directive is printed to stdout. **There is no `--state` flag** —
state lives in the checkpointer.

## How skills delegate

Each `.pi/skills/<name>/scripts/orchestrate.py` is the entire delegate:

```python
from orchestration.cli import main
if __name__ == "__main__":
    raise SystemExit(main(default_playbook="<name>"))
```

`<name>` is a domain skill's playbook (e.g. `code`, `plan`, …), registered in
`orchestration.playbooks.PLAYBOOKS`. (`reference-cycle` is registered too, but
only as the engine's internal smoke-test fixture — it has no `.pi/skills/` dir
and is never delegated to.)

## Components

| Module | Role |
|---|---|
| `engine.py` (`BasePlaybook`) | FSM engine: start/step/status, summary gatekeeper, escalate, planned gates, parallel fan-out (static or runtime-emitted), resume, checkpoint, emit, budgets + honest-exhaustion backstop, retry, default-on loop guards, model-owned routing helper |
| `loans.py` | LOAN registry + Ablate hooks: every piece of "current model is weak" scaffolding is tagged (rationale, dates) and toggleable via `PENNY_ABLATE_<LOAN_ID>=1` for scaffold-ON/OFF ablation runs |
| `recall.py` | Recall (atom F2): best-effort run-start retrieval of distilled lessons from MemPalace `penny/system_amendments`, seeded into the FIRST agent directive as advisory context |
| `primitives/` (`PrimitiveSpec` / `ParallelSpec`) | Reusable operation descriptors — name, default agent, per-state SUMMARY contract, task hint; a playbook binds them to its own states (and fan-out branches) via `PRIMITIVE_BY_STATE` / `PARALLEL_BY_STATE` |
| `playbooks/` | One `BasePlaybook` subclass per domain skill (e.g. `code.py`) — each defines its own states, `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate` — plus `reference_cycle.py` (`ReferenceCycle`, the engine test fixture) and the registry |
| `checkpointer.py` | Durable SQLite persistence by `run_id` (replaces `--state`/`_force_state`) |
| `recovery.py` | Auto-recovery scan (resume `running`/`awaiting_user` runs, playbook-scoped) |
| `obs_client.py` | Best-effort digest emission to the observability server (never blocks a run) |
| `contracts.py` | Confidence taxonomy, per-state SUMMARY contract validation + weakest-confidence aggregation, directive builders |
| `context.py` | `RunContext` (references not payloads, plus a domain `extras` dict) + `to_dict`/fail-loud `from_dict` |

## Engine seams (what a playbook subclass customizes)

Domain skills subclass `BasePlaybook` directly — there is no shared "standard
cycle" base and no single-primitive playbook. A subclass owns its state names
and wires the seams it needs:

- **Per-state SUMMARY contracts** — each state's `PrimitiveSpec.summary_contract`
  is validated by the engine's gatekeeper; missing/mistyped fields fail loud.
- **Parallel fan-out** — a `PARALLEL_BY_STATE` state dispatches N branch agents in
  one `invoke_agents_parallel` directive and routes once on fan-in, aggregating by
  weakest branch confidence.
- **Planned-gate HITL** — `GATE_STATES` + `gate_questions`/`route_user` pause for a
  user decision with multi-way resume, distinct from the `UNCERTAIN`-confidence
  escalation path.
- **Domain `extras`** — a subclass stashes its own run state in `RunContext.extras`
  (round-trips through the checkpointer without touching the schema).
- **Dynamic fan topology** — the `parallel_spec(state, ctx)` seam reads runtime-emitted
  branches from `ctx.extras["dynamic_branches"][state]` (a model's PLAN output in
  JSON-safe form, see `parallel_spec_from_dict`) before falling back to
  `PARALLEL_BY_STATE`; both are bounded by `constraints["max_fan_width"]` (default 8).
- **Default-on loop guards** — the base `progress_check` escalates a retry whose
  declared `strategy_change` repeats the prior one, or a `gaps` set that hasn't moved
  in two iterations (the engine auto-records iteration digests). Opt-out:
  `LOOP_GUARDS = False`. Backstop: routing past `max_iterations` forces honest
  exhaustion (`complete`, `met=False`, `exhausted` reason) — never a fake pass.
- **Model-owned routing** — `route_after` may delegate an edge choice to the model via
  `fire_model_route(summary)`: the chosen event fires iff it is a declared, currently
  allowed, non-reserved transition; otherwise the code-owned fallback routes.
- **Safe completion default** — the base `done_predicate` returns `False`; success is
  only ever claimed by a playbook's own grounded predicate.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `PENNY_ORCH_DB` | checkpointer SQLite path | `<project>/.penny/orchestration.db` (gitignored) |
| `PI_OBSERVABILITY_URL` | observability base URL | `http://localhost:8765` |
| `PI_OBSERVABILITY_API_KEY` | Bearer token (reused) | empty ⇒ auth off |
| `PENNY_ORCH_MAX_STEP_RETRIES` | transient step-retry budget | 2 |
| `PENNY_RECALL` | `0` disables run-start lesson recall | on |
| `PENNY_ABLATE_<LOAN_ID>` | `1` ablates a tagged loan (see `loans.list_loans()`) | off |

## Tests & CI guards

```bash
.venv/bin/python -m pytest apps/orchestration/tests --timeout=30
python scripts/system/checks/check_orchestration_guards.py   # zero _force_state, zero --state
```

See `docs/agents/orchestration/overview.md` and `docs/agents/skills/orchestration.md`.
