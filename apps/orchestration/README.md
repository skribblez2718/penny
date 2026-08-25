# @penny/orchestration — TypeScript workflow engine

Penny’s sole orchestration runtime. The package owns playbook dispatch, closed
request/directive contracts, durable Node SQLite checkpoints, exact owner artifacts,
signed worker receipts, gates, recovery, and digest-only observability.

The registry currently contains `research` and `knowledge-base`. Skills carry static
manifests, prompts, and resources; they do not ship executable delegates.

## Runtime

Requires Node.js 22.19 or newer:

```bash
bun install
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
```

The skill extension constructs `OrchestrationService` in-process. Single, parallel,
chain, and chain-resume modes all execute TypeScript playbooks. Chain handoff verifies and
forwards the predecessor's exact artifact ID across runs; no target-run grant/copy or
payload substitution is required, and no Python child is spawned.

The closed request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and
`cancel`. The CLI accepts one version-2 request on stdin; `--execute` runs Pi SDK workers
until a terminal, clarification, or dispatch-pause boundary:

```bash
node apps/orchestration/dist/cli.js --project-root="$PROJECT_ROOT" --execute < request.json
```

## Components

| Module                            | Role                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/engine.ts`                   | Request validation, playbook dispatch, receipt gates, recovery, and terminal admission   |
| `src/service.ts`                  | In-process composition of engine, workers, checkpoints, artifacts, and observability     |
| `src/checkpointer.ts`             | Owner-only Node SQLite run state keyed by `run_id`                                       |
| `src/artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                              |
| `src/state/**`                    | Pi-root resolver, opaque project catalog, custody checks, setup, and migration planning  |
| `src/worker.ts`                   | Pi SDK worker execution, owner capture, receipts, and bounded fan-out                    |
| `src/model-client.ts`             | Exact YAML tool surfaces, phase guidance, provider loading, and pre-model equality guard |
| `src/playbooks/registry.ts`       | Fail-closed playbook registry                                                            |
| `src/playbooks/research.ts`       | Research state machine                                                                   |
| `src/playbooks/knowledge-base.ts` | Knowledge-base state machine and host-only gates                                         |
| `src/kb/**`                       | Private KB records, policy, generations, capabilities, retrieval, and workflows          |

## Pi-native state

The default Penny state root is:

```text
${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}
```

Pi's `getAgentDir()` honors `PI_CODING_AGENT_DIR`. `PENNY_STATE_ROOT` is the only
Penny-specific state-root override and must be absolute.

Projects are registered by a commitment to their canonical root and receive an opaque
random project ID. Raw project paths are not stored in `catalog.db`. Current target paths
include:

```text
<Penny state root>/
  catalog.db
  observability/observability.db
  projects/<opaque-project-id>/
    orchestration/orchestration.db
    orchestration/receipt-key
    artifacts/manifest.db
    artifacts/objects/
    skill-chains/
    subagent-sessions/<agent>/
    kb/
```

Initialize a fresh target explicitly:

```bash
penny-state init --project-root="$PROJECT_ROOT"
penny-state status --project-root="$PROJECT_ROOT"
```

Existing-state migration is explicit and source-manifest driven:

```bash
penny-state migrate plan \
  --project-root="$PROJECT_ROOT" \
  --source-manifest=/absolute/private/sources.json \
  --output=/absolute/private/migration-plan.json

penny-state migrate apply \
  --project-root="$PROJECT_ROOT" \
  --source-manifest=/absolute/private/sources.json \
  --plan=/absolute/private/migration-plan.json

penny-state migrate verify \
  --project-root="$PROJECT_ROOT" \
  --plan=/absolute/private/migration-plan.json

penny-state migrate finalize \
  --project-root="$PROJECT_ROOT" \
  --plan=/absolute/private/migration-plan.json
```

Planning records commitments and digests rather than raw paths. Apply uses Node's SQLite
backup API, owner-only no-follow file copying, manifest-bound staging, a durable journal,
and a pending catalog reservation. Legacy skill-chain JSON is normalized into checksum-bound
project/layout-bound checkpoints during apply. Verify checks integrity, foreign keys,
source-table row counts, target schema versions, project binding, exact file/tree content,
historical receipt signatures, artifact objects, and every retained chain artifact ref.
Finalize atomically renames the complete staged project partition before activating its
catalog row. Exact finalized reruns are verified no-ops. A test-only injected-failure seam covers
journal/file fsync and rename boundaries, SQLite backup/reconciliation, file/tree copies,
verification, project publication, and catalog transitions; it is not exposed by the operator CLI
or ordinary runtime.

Multiple orchestration or artifact-manifest sources require an explicit reconciliation unit
in the private source manifest; repeated store IDs remain invalid:

```json
{
  "id": "orchestration-db",
  "kind": "sqlite",
  "sources": [
    { "source_id": "main", "path": "/private/main.db" },
    { "source_id": "nested", "path": "/private/nested.db" }
  ],
  "reconciliation": {
    "strategy": "strict-union",
    "precedence": ["main", "nested"]
  }
}
```

`strict-union` accepts disjoint rows and exact duplicates but refuses every divergent identity;
precedence never chooses between orchestration conflicts. Orchestration candidates containing
receipts must also declare `receipt_key_path`, and every signed history must verify under the
single separately declared target `orchestration-receipt-key`.

Artifact manifests use `strategy: "artifact-union"` and require
`selection_policy: "require-identical"` or the explicit
`"prefer-precedence"` disposition. Artifact refs and metadata are normalized from retained
schema v1 to schema v2; immutable identity/content conflicts always refuse regardless of
selection policy. The plan contains each source commitment/snapshot, duplicate and precedence
resolution counts, per-table row digests, and a target logical digest. Source IDs should be
opaque non-sensitive evidence labels. Changed candidates or a reproduced target/report mismatch
refuse apply or verify.

Tree stores must enumerate every embedded SQLite member explicitly in the private source
manifest, for example `"sqlite_files":["grants.sqlite"]`. Each member is inventoried and
copied through SQLite backup while its WAL is included logically and SHM is never adopted.
Unlisted database-like files fail during planning. After finalize and target-only smoke, an
operator may create a checksum-bound one-time deletion approval with `migrate authorize-delete`.
`migrate delete` accepts only the same private source/plan/deletion manifests, refuses open handles
or source drift, protects target/Pi/memory roots, records per-entry progress for crash recovery, and
publishes a deletion receipt. It is never reachable from ordinary startup or model-facing tools.

## Persistence and recovery

- The canonical checkpoint filename is `orchestration.db`; its internal SQLite schema is
  independently versioned and project-bound.
- The canonical artifact manifest is `manifest.db`; object reads verify SHA-256 and byte
  length and the manifest is project-bound.
- The receipt key is `orchestration/receipt-key`, not a filename-derived versioned path.
- `RunContext` stores exact selected refs, never artifact payload bytes.
- Successful worker output is persisted and re-read before its final `SUMMARY` line is
  parsed into routing state.
- Recovery reissues the checkpointed directive with the same selected refs or the next
  explicit compatible revision.
- Skill chains persist project-bound checkpoints in the current partition.
- Subagent Pi JSONL is retained under the current partition rather than deleted with a
  temporary session directory.
- `PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new dispatch without converting the run
  to success or error. Unknown values fail closed.
- Compaction reads exact run IDs through the catalog-bound database and verifies project
  metadata; it never scans for active runs or consults semantic memory.
- Ordinary constructors perform no legacy path scan, fallback, or artifact-manifest
  import.

The retired Python orchestration database is never a runtime fallback. Any historical
conversion or archive is an explicit operator migration disposition.

## Environment

| Variable                                   | Purpose                                   | Default             |
| ------------------------------------------ | ----------------------------------------- | ------------------- |
| `PENNY_STATE_ROOT`                         | Optional absolute Penny state root        | Pi agent dir/penny  |
| `PENNY_ORCHESTRATION_MAX_STEPS`            | Hard step ceiling                         | `96`                |
| `PENNY_ORCHESTRATION_WORKER_TIMEOUT_MS`    | Worker timeout                            | `900000`            |
| `PENNY_ORCHESTRATION_PARALLEL_CONCURRENCY` | Worker fan concurrency                    | `4`                 |
| `PENNY_ORCHESTRATION_MAX_RETAINED_RUNS`    | Bounded terminal-run retention            | `500`               |
| `PENNY_ARTIFACT_DISPATCH_MODE`             | `active` or `paused`                      | `active`            |
| `PI_OBSERVABILITY_REST_URL`                | Observability REST endpoint               | localhost           |
| `PI_OBSERVABILITY_API_KEY`                 | Observability bearer token                | empty               |
| `PENNY_RESEARCH_DEFAULT_MODEL`             | Optional per-invocation research override | agent SSOT defaults |

`PENNY_ORCH_DB`, `PENNY_ORCH_V2_DB`, `PENNY_ARTIFACT_ROOT`, and the versioned
orchestration limit variables are retired and rejected rather than aliased.

Production models remain in `.pi/agents/*.md` frontmatter. Test callers may pass a
bounded model override without mutating that SSOT.

## Verification

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd apps/orchestration test:parity
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/compaction test:unit
```

See `docs/agents/orchestration/overview.md` and
`docs/agents/skills/orchestration.md` for the canonical protocol.
