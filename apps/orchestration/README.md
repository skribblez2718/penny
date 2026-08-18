# orchestration — Penny's research workflow engine

`orchestration` contains Penny's stable Python runtime and its opt-in TypeScript
successor for the retained research skill. The package owns the FSM protocol,
durable checkpointing, recovery, exact artifacts, signed receipts, and
best-effort observability.

Python remains the default engine. TypeScript is selected only by an explicit
`engine: "typescript"` on a single `research` skill invocation until the M7
approval gate authorizes any default change.

The registry contains exactly:

- `research` — the user-facing research workflow.
- `reference-cycle` — an internal engine/CLI/recovery fixture with no skill directory.

## Install

The package is a member of the repository's uv workspace and is installed
editable into `.venv`:

```bash
uv sync --extra dev
.venv/bin/python -c "import orchestration; print(orchestration.__version__)"
```

No `sys.path` or `PYTHONPATH` hacks are required.

The TypeScript package uses Node.js 22.19 or newer:

```bash
bun install
bun run build:orchestration
bun run test:orchestration
bun run test:orchestration:parity
```

Its checkpoint database defaults to
`$PROJECT_ROOT/.penny/orchestration-v2.db`; it never opens or mutates the Python
checkpoint database. The skill host supports the pilot only in single research
mode:

```text
skill({ skill_name: "research", goal: "...", engine: "typescript" })
```

Omitting `engine` follows the unchanged Python path.

## CLI

```text
orchestrate {start|step|status|recover} --playbook <name> --session-id <id> --run-id <id>
            [--goal <text>] [--constraints <json>] [--agent <name>] [--result <json>]
```

- `start` initializes and checkpoints a run, then emits the first directive.
- `step` validates a SUMMARY, routes the FSM, checkpoints, and emits the next directive.
- `status` reports durable run state.
- `recover` reissues a pending step or re-presents pending user input.

Track A uses forward-only recovery. `PENNY_ARTIFACT_DISPATCH_MODE=paused`
returns a typed, retriable `paused` directive before any new agent, deterministic
tool, or fan-out dispatch. It does not complete/error the run or rewrite the
pending checkpoint. A fresh `recover` after the mode returns to `active`
reconstructs the same selected input refs and output metadata (or the next
explicit compatible revision). There is no semantic-memory fallback.

Exactly one JSON directive is printed to stdout. There is no `--state` flag;
state lives in the checkpointer.

The TypeScript CLI accepts one closed version-2 JSON request on stdin and emits
one JSON directive. `--execute` runs SDK-backed workers until a terminal,
clarification, or dispatch-pause boundary:

```bash
node apps/orchestration/dist/cli.js --project-root="$PROJECT_ROOT" --execute < request.json
```

Its request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and
`cancel`. TypeScript artifacts use a separate owner-only immutable manifest and
content-addressed object plane while retaining canonical schema-v1 refs.

### Two manifests, one object store

Both engines write under `PENNY_ARTIFACT_ROOT`, but each owns its own manifest:

| Engine             | Manifest           | Writer                       |
| ------------------ | ------------------ | ---------------------------- |
| Python (default)   | `manifest.sqlite3` | `orchestration/artifacts.py` |
| TypeScript (pilot) | `manifest-v2.db`   | `src/artifact-store.ts`      |

The schemas differ: the Python manifest stores a full `envelope_json` plus a
materialization table; the TypeScript manifest stores `metadata_json`/`ref_json`.

The `objects/sha256/<2>/<62>` content-addressed object tree is **shared**. Since
objects are content-addressed, identical bytes written by either engine converge
on one object, and neither engine can corrupt the other's content.

Manifest records, however, are **not** cross-visible: an artifact registered by
one engine cannot be resolved through the other engine's manifest. Exact refs
remain valid across both because a ref carries its own `store_ref` and digest,
and `artifact_read` resolves bytes from the object path rather than by manifest
lookup. Treat the two manifests as independent registries over shared storage;
do not assume a run started on one engine can be recovered by the other.

Retention must be applied per manifest. Pruning objects by consulting only one
manifest would delete bytes the other still references.

## Research delegate

`.pi/skills/research/scripts/orchestrate.py` delegates directly to the package:

```python
from orchestration.cli import main

if __name__ == "__main__":
    raise SystemExit(main(default_playbook="research"))
```

## Components

| Module                         | Role                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `engine.py`                    | Shared start/step/status protocol, owner artifact validation/selection, SUMMARY validation, fan-out, gates, budgets, and recovery |
| `playbooks/research.py`        | Research state machine, routing, contracts, prompts, and terminal result                                                          |
| `playbooks/reference_cycle.py` | Internal full-cycle fixture                                                                                                       |
| `checkpointer.py`              | Durable SQLite FSM/run persistence keyed by `run_id`; stores selected refs, never artifact payloads                               |
| `artifacts.py`                 | Generic immutable artifact schemas, content-addressed objects, manifest validation, and CAS selection                             |
| `artifact_cli.py`              | Owner-side exact-stdin artifact persistence used before SUMMARY parsing                                                           |
| `execution_receipts.py`        | Generic execution-owner receipt signing, redaction, and binding to a real artifact ref                                            |
| `loans.py`                     | Exact live engine LOAN ledger and ablation switches                                                                               |
| `independence.py`              | Research producer/verifier independence ledger                                                                                    |
| `recovery.py`                  | Pending-run recovery through the registry                                                                                         |
| `obs_client.py`                | Best-effort digest-only observability                                                                                             |
| `contracts.py`                 | Confidence, SUMMARY, and directive contracts                                                                                      |
| `context.py`                   | Serializable `RunContext` and research `extras` storage                                                                           |
| `src/*.ts`                     | TypeScript v2 contracts, context, checkpointer, SDK workers, service/CLI, receipts, artifacts, observability, and loans           |
| `src/playbooks/research.ts`    | TypeScript research state machine and phase-result tool schemas                                                                   |

## Environment

| Variable                             | Purpose                                     | Default                                    |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------ |
| `PENNY_ORCH_DB`                      | Python checkpointer SQLite path             | `$PROJECT_ROOT/.penny/orchestration.db`    |
| `PENNY_ORCH_V2_DB`                   | TypeScript checkpointer SQLite path         | `$PROJECT_ROOT/.penny/orchestration-v2.db` |
| `PENNY_ORCH_V2_MAX_STEPS`            | TypeScript hard step ceiling                | `96`                                       |
| `PENNY_ORCH_V2_WORKER_TIMEOUT_MS`    | TypeScript worker timeout                   | `900000`                                   |
| `PENNY_ORCH_V2_PARALLEL_CONCURRENCY` | TypeScript fan concurrency                  | `4`                                        |
| `PENNY_ARTIFACT_ROOT`                | Separate owner-only manifest/object root    | XDG state directory                        |
| `PENNY_ARTIFACT_DISPATCH_MODE`       | Owner dispatch control: `active`/`paused`   | `active`                                   |
| `PENNY_TOOL_RESULT_MAX_BYTES`        | Optional lower model-result byte cap        | `32768`                                    |
| `PENNY_TOOL_RESULT_MAX_TOKENS`       | Optional lower conservative token cap       | `8192`                                     |
| `PI_OBSERVABILITY_REST_URL`          | Observability REST base URL                 | `http://localhost:8765`                    |
| `PI_OBSERVABILITY_API_KEY`           | Observability bearer token                  | empty                                      |
| `PENNY_ORCH_MAX_STEP_RETRIES`        | Transient step retry budget                 | `2`                                        |
| `PENNY_ABLATE_<LOAN_ID>`             | Disable one registered loan for an ablation | unset                                      |
| `PI_STALL_MODEL`                     | Optional semantic stall judge               | unset                                      |
| `PI_STRATEGY_MODEL`                  | Optional semantic retry-strategy judge      | unset                                      |
| `PI_MODEL_TIER`                      | `strong` / `cheap` capability-tier scaling  | unset                                      |
| `RESEARCH_VERA` / `RESEARCH_DEFAULT` | Optional research validation/model routing  | unset                                      |

The engine never injects retrieved durable memory into directives. It emits exact
`input_artifacts` and owner-only `output_artifact` contracts. Output
`consumer_scope` is derived from the actual non-control FSM successors, the
same-state retry/parallel fan-in consumer, and a fail-closed playbook seam for
explicit retained historical inputs. It never defaults to the playbook registry;
a ref granted to one legitimate phase is rejected by every other unlisted phase.
Only a direct or explicitly declared terminal consumer receives `state:complete`.

Unknown dispatch-mode values fail closed as a retriable pause. `status` and
exact artifact reads remain available while paused; the mode controls dispatch,
not read access or memory-service authority.

The skill driver persists canonical finalized output before parsing SUMMARY:
every text part in the final assistant message, concatenated in order with no
inserted separator; thinking/reasoning and tool calls are excluded. The engine
verifies exact bytes, length/digest, receipt, run/state/branch/producer/consumer
binding, and stale-safe selection before routing. Memory may be absent.

## Verification

From the repository root:

```bash
.venv/bin/python -m pytest apps/orchestration/tests/test_cli.py \
  apps/orchestration/tests/test_research_playbook.py \
  apps/orchestration/tests/test_execution_receipts.py -v
.venv/bin/python -m pytest apps/orchestration/tests -v
bun run typecheck:orchestration
bun run test:orchestration
bun run test:orchestration:parity
(cd .pi/extensions/skill && bun run test:unit)
```

See `docs/agents/orchestration/overview.md` and
`docs/agents/skills/orchestration.md` for the shared protocol.
