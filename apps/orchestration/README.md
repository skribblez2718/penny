# @penny/orchestration — TypeScript workflow engine

Penny’s sole orchestration runtime. The package owns playbook dispatch, closed
request/directive contracts, durable Node SQLite checkpoints, exact owner artifacts,
signed worker receipts, gates, recovery, and digest-only observability.

The production registry contains `research` and `knowledge-base`; the separate candidate registry
contains disabled `decide` and `plan` registrations. Every package lives under `.pi/skills` and is
classified by its parsed release status, not its directory. Package and registry namespaces must
agree exactly. Skills carry static manifests, prompts, and resources; they do not ship executable
delegates.

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
forwards the predecessor's exact artifact ID across runs; no target-run copy or payload
substitution is required. Runtime playbooks are TypeScript only.

The closed request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and
`cancel`. The CLI accepts one version-2 request on stdin; `--execute` runs Pi SDK workers
until a terminal, clarification, or dispatch-pause boundary:

```bash
node apps/orchestration/dist/cli.js --project-root="$PROJECT_ROOT" --execute < request.json
```

## Components

| Module                            | Role                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/engine.ts`                   | Request validation, playbook dispatch, receipt gates, recovery, and terminal admission              |
| `src/service.ts`                  | In-process composition of engine, workers, checkpoints, artifacts, and observability                |
| `src/checkpointer.ts`             | Owner-only Node SQLite run state keyed by `run_id`                                                  |
| `src/artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                                         |
| `src/state/**`                    | Pi-root resolver, opaque project catalog, custody checks, setup, and migration planning             |
| `src/worker.ts`                   | Active-registration checks, Pi SDK execution, capture, receipts, and bounded fan-out                |
| `src/model-client.ts`             | Registration guidance, YAML maxima, strict-subset validation, provider loading, and active equality |
| `src/skill-contracts/**`          | Closed research request/product/port/budget schemas and cross-field validators                      |
| `src/research-context.ts`         | Owner-resolved safe context envelopes and pre-model content verification                            |
| `src/playbooks/registry.ts`       | Fail-closed playbook, worker-phase, repair-route, and completion registration                       |
| `src/playbooks/research.ts`       | Research cognitive graph, host core sealing/rendering, product graph, and research DoD              |
| `src/playbooks/knowledge-base.ts` | Knowledge-base state machine and host-only gates                                                    |
| `src/kb/**`                       | Private KB records, policy, generations, capabilities, retrieval, and workflows                     |

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

`init` provisions the global observability database plus the project-bound
orchestration database, receipt key, artifact manifest/object root, and their
current bindings. It is idempotent for a complete target. `status` opens each
component create-never and fails for a missing, stale, corrupt, or misbound
store; it does not repair runtime state.

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
- Positive terminals are admitted only by the engine against the registration's closed
  `CompletionGate` v2: append-only visited-state evidence, an exact latest-product binding,
  and host-owned receipt predicates must all pass. Refusal is durably `incomplete/met:false`
  and preserves candidate artifacts; honest negative terminals are not gated.
- State visits and completion admission/refusal are body-free metadata in the existing
  append-only `events` rows. No state path, SQLite table, schema version, or observability
  authority is involved. Historical positive terminals without a v2 envelope
  remain exact legacy replays; new positives cannot be written without an envelope.
- The engine exposes one validated active registration and the service binds that exact
  object into the worker. A worker refuses an unknown playbook or state/agent mismatch before
  input reads or session work. Required guidance has no fallback.
- Agent YAML `tools:` is the maximum ordinary catalog authority. Direct/parallel/chain paths
  and TypeScript orchestration phases without `allowed_tools` keep requested SDK tools, active
  SDK tools, and YAML exactly equal. An eligible phase may instead use one explicit non-empty,
  duplicate-free strict YAML subset owned by the active `PlaybookRegistrationV1`; the canonical
  runtime-registration digest and worker invocation metadata include it. Before session creation,
  the model client rejects empty, duplicate, non-YAML/unavailable, additive, replacement, or
  equality-sized lists, then passes the accepted list exactly to Pi and checks active equality
  before the prompt. Task, trust profile, input, runtime condition, model/liveness policy,
  context, typed product, and optional-service state cannot select tools. Ordinary Assess, Decide,
  Diagnose, Plan, and Produce candidate phases omit `allowed_tools`, use exact agent YAML, and have
  normal external-call ceilings of 8 per worker and 64 per run; routing-only repair stays at 0.
  Evaluation-only baselines or ablations may retain strict subsets. A subset changes no agent
  metadata/profile and supplies no OS/process sandbox or extension-code isolation. KB workers remain
  anonymous host-private sessions with their existing phase-specific matrices.
- `SkillContractV2` carries objective, typed request/input/active-output ports, closed
  side-effect/approval/stop/escalation consequences, required guidance, named budget
  policy/resolver/admission/snapshot bindings, state-aware repair routes, and the completion gate.
  The recursive contract oracle has no declaration-only debt.
- A new research start canonicalizes `ResearchRequestV1` and validates imported
  `GroundedSynthesisV1` canonical bytes before run mutation or model/session work. Generic artifact
  refs may carry optional closed `content_schema`; old refs without it remain valid.
- Research context bindings are identifier-only. The artifact plane stores metadata-only
  `ContextSourceRefV1` envelopes; worker owner code re-resolves selected document, caller, or exact
  pre-resolved approved-KB content and verifies digest, length, freshness, approval, conflict, and
  consumer state before the model. Context never changes the registration-selected tool surface or
  KB grants/approvals.
- Production research activates the frozen P3 graph. The sole output port and chain handoff are the
  latest exact canonical `GroundedSynthesisV1` `semantic-core`; the legacy report artifact remains a
  recognized compatibility schema only. Vera and optional report Carren receipts, three deterministic
  renders, and the research product envelope bind that exact core outside it.
- Synthia emits a closed `ResearchSemanticDraftV1`; deterministic host projection resolves local
  indexes, verifies exact excerpt containment/hashes and request/context/Echo/Synthia lineage, then
  seals canonical `GroundedSynthesisV1` bytes before Vera. Every changed core re-enters Vera before
  optional report Carren, deterministic rendering, or completion. Host `sealing_core` and `rendering`
  consume no model turns/tools and use existing selected refs plus append-only checkpoint events.
- Renderer `penny.research.compat-markdown.v1` persists stable intent/time, immutable render artifacts,
  and uses no-follow checks, exact temporary names, file/directory fsync, atomic rename, matching-file
  adoption, and final full-set verification. Recovery converges without a state migration.
- Research success additionally requires the latest-core DoD/product-graph predicate and central
  completion admission from `rendering`; terminal `output_artifact_ref` is the semantic core. Blocking,
  stale, exhausted, unsafe, drifted, cancelled, and error outcomes remain non-positive with best exact
  partial refs and no complete product envelope.
- Successful worker output is persisted and re-read before its final `SUMMARY` line is parsed.
  Structurally valid repair evaluations use `EvaluationResultV2`, which contains findings and a
  strategy delta but no target or exhaustion claim. The engine selects the registered route,
  charges the iteration budget, transitions, and stores only detail/strategy digests in the same
  checkpoint event transaction. Structural malformed-result repair remains the P1.2 path.
- Recovery reissues the checkpointed directive with the same selected refs or the next
  explicit compatible revision.
- Skill chains persist project-bound checkpoints in the current partition.
- Subagent Pi JSONL is retained under the current partition rather than deleted with a
  temporary session directory.
- `PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new dispatch without converting the run
  to success or error. Unknown values fail closed.
- Compaction reads exact run IDs through the catalog-bound database and verifies project
  metadata; it never scans for active runs or consults semantic memory.
- Ordinary runtime opens only complete, pre-provisioned stores. It does not create,
  migrate, repair, relink, import, or fall back to another state location.

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
