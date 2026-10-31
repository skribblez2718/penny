# @penny/orchestration — TypeScript workflow engine

Penny’s sole orchestration runtime. The package owns playbook dispatch, closed
request/directive contracts, durable Node SQLite checkpoints, exact owner artifacts,
signed worker receipts, gates, recovery, and digest-only observability.

`PLAYBOOK_REGISTRY` is the sole executable registry and contains every registered workflow. Every
package lives under `.pi/skills`. A model-invocable orchestration package must have a matching
registration; a model-disabled development package may remain unregistered but generic execution
then refuses safely. Skills carry static manifests, prompts, and resources; they do not ship
executable delegates.

## Runtime

Requires Node.js 24.21.0 or newer and bundled SQLite 3.51.3 or newer. Use the repository `.nvmrc` and restart existing Pi/service processes after switching runtimes:

```bash
bun install
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
```

### One shipping generation

Shipping integrations use compiled `dist` modules and matching `dist/*.d.ts` declarations.
The root and explicit package subpaths resolve to the same modules; `/source` is not exported.
Checkout-relative imports in sibling workspaces must resolve to a declared compiled export,
not an arbitrary package-internal file. `check:shipping` mechanically checks this boundary
(including extension/library imports, dynamic literal imports, mocks and source aliases),
and every build runs it before compilation. There are no wildcard exports.

The explicit `skill-contracts/common` subpath is the shared primitive-schema boundary needed
by existing SCA shipping consumers; it is intentionally opened rather than loading its source
or cloning schemas. It remains absent from the root barrel. Research context and research
contracts remain package-internal: integration tests may read their compiled files, but
shipping consumers may not bypass the closed export map. `src/skill-result.ts` owns the sole
current skill-result schema/parser; skill and compaction import it from the package root.
There is no `.pi/lib` schema copy or facade. SCA service bundles normalize nested workspace
imports to declared compiled exports and keep orchestration external, so bundling cannot
inline a second set of classes or relocate the provenance checker. Build orchestration first,
then `bun run --cwd apps/sca-service build`; use that package's `test:build` for the real-bundler
externalization and failed-build retention regression.

`dist/build-provenance.json` records sorted SHA-256 input/output inventories, the artifact
worker's transitive local input graph, source inventory and Node/Bun/TypeScript build versions.
Inputs include compiler configuration, build scripts, workspace manifest/lockfile and the
external compaction-policy helper. The bundler's actual input metadata must be covered.
The builder compares inputs before compilation and again before publication. All emitted JS
entry paths check the manifest; their guard imports are generation-keyed so Node's module
cache cannot admit a later rebuilt subpath alongside already-loaded classes. The service
rechecks before construction, requests and lazy artifact-helper loading. Missing provenance, changed sources/helpers/declarations/output,
a new source file, or a different generation in an already-loaded process refuses with
`ORCHESTRATION_BUILD_STALE` before new service work. Digests establish checkout/build identity,
not a signed supply-chain attestation or protection from a malicious same-UID writer.

This private package is checkout-bound, not a standalone source-free distribution: required
source/control inputs must remain available for freshness checks. Stop workers before
rebuilding. After a successful build, start a **fresh Pi/service process**; an extension reload
alone is not evidence that Node's cached package modules were replaced. Rebuilding does not
magically hot-reload an active session. Continuous source edits require another successful
build and fresh process before live qualification.

Package, smoke and cross-extension integration tests use the compiled generation, including
shared fixtures, rather than mixing source and compiled classes. Build before running direct
focused tests or declaration-dependent typechecks; `test` and `test:unit` build automatically.
Internal implementation modules still import their sibling source modules normally.

### Failure-safe builds

`build` compiles into the fresh ignored `build/` sibling directory, bundles the artifact
worker, copies the voice peer, checks declared entry points and imports the compiled
package before replacing `dist`. Compiler, bundler, asset, validation or cancellation
failures before publication leave the existing package untouched. A build lock rejects
overlapping builds; it does not serialize source edits or commands that bypass this builder.
Use `typecheck` when validation must not publish runtime files. A successful build replaces the installed files; it does not replace already-loaded modules.
Use an isolated checkout when live sessions must not observe filesystem changes.

Publication retains the real-directory `dist` layout and uses two synchronous renames
with rollback, not an atomic directory exchange or a zero-downtime deployment. If
publication and rollback both fail, the error names the retained previous output.
An uncatchable termination or host failure can leave `.build-lock`, `build/` staging or
`out/previous-*/dist` rollback output. A pre-existing `build/` is refused, never reused or
deleted. Before clearing an interrupted lock or staging directory, inspect `owner.json`,
confirm that the build is no longer running, and preserve/restore any retained previous
output if `dist` is absent. No stale lock or backup is automatically discarded.
Use `bun run --cwd apps/orchestration test:build` for the isolated real-tool regressions.

The skill extension constructs `OrchestrationService` in-process. Single, parallel,
chain, and chain-resume modes all execute TypeScript playbooks. Chain handoff verifies and
forwards the predecessor's exact artifact ID across runs; no target-run copy or payload
substitution is required. Runtime playbooks are TypeScript only.

The closed request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and
`cancel`. The CLI accepts one version-2 request on stdin; `--execute` runs Pi SDK workers
until a terminal, clarification, or dispatch-pause boundary. The active ordinary skill set is
`assess`, `decide`, `define`, `diagnose`, `plan`, `produce`, and `research` (seven). This
registry inventory is runtime authority, not proof of live provider reliability:

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
| `src/playbooks/seal-attempt.ts`   | Draft-addressed, exact-adoption product/diagnostic sealing for ordinary skills                      |
| `src/playbooks/define.ts`         | Define source/clarification/support/trace workflow                                                  |
| `src/composition-assurance.ts`    | Consumer-bound specification assurance and strict owner admission                                   |
| `src/playbooks/knowledge-base.ts` | Knowledge-base state machine and host-only gates                                                    |
| `src/kb/**`                       | Private KB records, policy, generations, capabilities, retrieval, and workflows                     |

## Worker extension source composition

Trusted hosts can supply `workerExtensionReplacements` to `OrchestrationService` or
`PiAgentClient`: each carrier pairs one absolute extension entry-file `source` with an
inline `extension`. Before any factory executes, the ordinary worker loader resolves Pi's
complete enabled native inventory, including project/global settings, package manifests
and filters. It freezes that inventory, removes only canonical matches for the declared
source files (including symlink aliases), and loads the remainder explicitly with
`noExtensions` plus the scoped factories. Other inline providers remain unchanged.
Duplicate canonical replacement declarations and all unrelated loader conflicts/errors
still refuse before model/session creation. The inventory resolver requests errors rather
than installation for missing package sources. An explicitly no-ambient host runtime remains no-ambient;
its scoped factories still register.

The skill host uses this carrier to replace its exact installed memory extension with
`memory-worker-read`. Unconfigured memory still registers the ten read tools as typed
unavailable providers, without primary memory writes or lifecycle hooks. This composes
provider sources, not tool lists: YAML activation, registered `allowed_tools`, active
set equality and shipping-build freshness checks remain unchanged.

## Pi-native state

The default Penny state root is:

```text
${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}
```

Pi's `getAgentDir()` honors `PI_CODING_AGENT_DIR`. `PENNY_STATE_ROOT` is the only
Penny-specific state-root override and must be absolute.

Projects are registered by a commitment to their canonical root and receive an opaque
random project ID. Raw project paths are not stored in `catalog.db`. Both orchestration
CLIs resolve `--project-root` through that catalog at process entry and use only the
canonical root thereafter, so a symlink alias cannot create a second project identity or
leak into persisted/project-relative paths. Current target paths include:

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
  duplicate-free strict YAML subset owned by the active `PlaybookRegistration`; the canonical
  runtime-registration digest and worker invocation metadata include it. Before session creation,
  the model client rejects empty, duplicate, non-YAML/unavailable, additive, replacement, or
  equality-sized lists, then passes the accepted list exactly to Pi and checks active equality
  before the prompt. Task, trust profile, input, runtime condition, model/liveness policy,
  context, typed product, and optional-service state cannot select tools. Ordinary Assess, Decide,
  Diagnose, Plan, and Produce phases omit `allowed_tools`, use exact agent YAML, and have no
  ordinary elapsed-time, model-turn, tool-call, or external-call quota; routing-only repair remains
  separately bounded. Synthetic registration-bound tests retain strict subsets solely to prove enforcement. A subset
  changes no agent metadata/profile and supplies no OS/process sandbox or extension-code isolation.
  KB workers remain anonymous host-private sessions with their existing phase-specific matrices.
- `SkillContractV2` carries objective, typed request/input/active-output ports, closed
  side-effect/approval/stop/escalation consequences, required guidance, named budget
  policy/resolver/admission/snapshot bindings, state-aware repair routes, and the completion gate.
  The recursive contract oracle has no declaration-only debt.
- Assess, Decide, Define, Diagnose, Plan, and Produce allow one deterministic seal correction per
  same-run product epoch. A first rejection has a persisted diagnostic with ordinal 1, used 0/limit 1,
  `correction_offered`; a rejected corrective draft gets its own final diagnostic with ordinal 2,
  used 1/limit 1, `exhausted`. Research retains its separately registered finite allowance
  (`max_iterations - 1`, two corrections by default). Semantic reviewer repair and malformed
  routing repair are separate budgets. `seal_product` and `seal_diagnostic` each use an exact
  draft-addressed version-1 operation, not a run-global artifact version counter. Interrupted
  writes adopt only exact bytes. A negative terminal reports `seal_diagnostics` separately from
  `repair_diagnostics` and labels a rejected draft as such even if a legacy output ref points to it;
  an earlier accepted best partial is not a current reviewed completion.
- Define creates a deterministic `DefinitionSourceManifestV1` from the admitted request before
  framing. New starts use FrameV2 stable question identities, per-question clarification response,
  EvidenceAdmissionV2 allowed-use support slots and a SpecificationDraftV2 footer. Protected caller
  constraints, non-goals, exclusions and binding decision effects cannot be silently excluded;
  unrepresentable content refuses before run/model creation. Host `DefinitionTraceV1` projection
  binds exact product, draft, source, question and support refs before Vera/Carren review. Material
  unanswered or unsupported questions cannot yield ready, but a useful blocked specification can
  complete. Structural support-slot presence alone does not prove the claim's meaning.
- Define-revise and Plan accept V2 `specification_assurance` modes `semantic_only` and
  `reviewed_definition`; V1 maps to semantic-only, absent specification to `not_applicable`.
  Semantic-only checks canonical bytes without attesting producer completion. Strict mode verifies
  the committed, trace-capable Define producer's exact current owner/review/completion graph and
  immediate-parent closure before consumer creation; failure refuses without fallback. The
  consumer-bound assurance ref joins reviews and completion. `{previous}` remains one exact core ID.
  Neither mode guarantees full reviewed ancestry or availability of original external sources.
  Provider-free checks do not demonstrate live-model completion reliability for this change; the
  repeated seven-skill live qualification cohort has not been run.
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
  Every durable catalog session also appends a closed worker-continuity V1 custom entry before the
  opening prompt. It leaves the existing correlation V1 entry unchanged while preserving exact
  assignment identity, task, registered guidance, input refs, and—for non-private workers—the complete
  authoritative opening for compaction. Owner-resolved private-context workers are marked for Pi's
  default compaction so private bodies do not enter a generic context artifact. Custom worker
  compaction proceeds only after every input ref verifies and its context artifact persists and
  re-reads successfully.
  Structurally valid repair evaluations use `EvaluationResult`, which contains findings and a
  strategy delta but no target or exhaustion claim. The engine selects the registered route,
  charges the iteration budget, transitions, and stores only detail/strategy digests in the same
  checkpoint event transaction. Structural malformed-result repair remains the P1.2 path. In a
  parallel fan, valid siblings are accepted immediately while every malformed sibling is replaced
  in place by its own branch-bound routing repair; each accepted repair is checkpointed, recoverable,
  and cannot consume another branch's source binding.
- Every SDK-created worker session runs the `session_shutdown` extension lifecycle and awaits it
  before disposal on success, failure, cancellation, and pre-prompt refusal.
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
| `PENNY_ORCHESTRATION_MAX_STEPS`            | Finite workflow step allocation           | `96`                |
| `PENNY_ORCHESTRATION_PARALLEL_CONCURRENCY` | Worker fan concurrency                    | `4`                 |
| `PENNY_ORCHESTRATION_MAX_RETAINED_RUNS`    | Bounded terminal-run retention            | `500`               |
| `PENNY_ARTIFACT_DISPATCH_MODE`             | `active` or `paused`                      | `active`            |
| `PI_OBSERVABILITY_REST_URL`                | Observability REST endpoint               | localhost           |
| `PI_OBSERVABILITY_API_KEY`                 | Observability bearer token                | empty               |
| `PENNY_RESEARCH_DEFAULT_MODEL`             | Optional per-invocation research override | agent SSOT defaults |

`PENNY_ORCH_DB`, `PENNY_ORCH_V2_DB`, `PENNY_ARTIFACT_ROOT`, the former worker/host
elapsed-time selectors, and the versioned orchestration limit variables are retired and rejected
rather than aliased. Current workers and host operations use renewable inactivity leases.
The current worker API is `LivenessPolicy` / `WorkerPromptBudget` (wire schema 3), with no
versioned API aliases. V1/V2 policy events refuse execution and recovery before mutation; retained
checkpoints, event history, and artifact bytes are not rewritten or deleted. Historical record
verification schemas are not execution authority. Trusted progress renews inactivity, not a total
work deadline; explicit operator limits, cancellation, and routing-only malformed-result repair
remain independent controls.

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

### Actual CPU media qualification (opt-in)

Default/root deterministic tests exclude `tests/videogen-media-cpu.test.ts`, even
when private bindings are present in the environment. The provider-free
`tests/videogen-media-cpu-routing.test.ts` checks this routing; it does not qualify a decoder.
Package `test:all` and the root TypeScript runner use `test:videogen-media-cpu:aggregate`,
which explicitly reports **external CPU qualification NOT RUN** unless
`PENNY_VIDEOGEN_MEDIA_CPU=1`. An opted-in aggregate propagates failures rather than skipping them.

Run the actual CPU cohort from this package directory with
`bun run test:videogen-media-cpu`. This direct command requires both
`PENNY_VIDEOGEN_MEDIA_CPU=1` and
`VIDEOGEN_MEDIA_TEST_BINDINGS`, containing caller-supplied JSON (not a filename).
Missing or malformed bindings fail closed. Keep the binding file outside the checkout;
load it privately as JSON without printing its contents or committing paths or pins.
No executable discovery, installation, ambient binding fallback, live provider, GPU or editor
is part of this route.

The closed binding object contains pinned `bubblewrap`, `prlimit`, `security_probe`
and `fixture_ffmpeg` objects (`path`, `sha256`); `ffmpeg`, `ffprobe` and `runtime_files`
entries (`source`, `target`, `sha256`); and `max_runtime_bytes`.
`fixture_ffmpeg` is an explicitly separate trusted tool for synthetic source generation,
invoked with an empty environment; it is never a decoder binding or sandbox capability.
Its direct ELF library closure must work without inherited loader variables. Decoder tools
instead use their explicit pinned namespace closure. Compile the existing
`tests/helpers/videogen-media-sandbox-probe.c` with an already available compiler and pin
that actual ELF as `security_probe`, never `ffprobe`. Execute this untrusted helper only
through the sandbox. Qualification checks task, network, namespace/module, file/process
counter isolation and independent resource limits. Pins establish identity, not patch status;
review current publisher security notices separately before activation.
The collection guard validates that schema and the supplied file pins without printing paths.
The CPU tests check baseline H.264/PCM decoding and additive muxed H.264/AAC
raw decoding, confinement, limits and existing-owner recovery. The additive
`src/videogen/av-media-*.ts` slice uses a closed, host-supplied profile with exact
dimensions, rational frame rate and codec constraints; it has no default profile
or fixture-size routing. It requires complete frame/sample/PTS evidence and
produces canonical PNGs and PCM spans from the same exact muxed source.

The audiovisual subset is constrained-baseline H.264/yuv420p plus AAC-LC at
48 kHz mono. Composition/edit timing, B frames, AAC priming/skip compensation,
unknown metadata and unsupported streams refuse. Test fixtures are generated
pictures and tones, not speech; their explicitly test-only metadata derivation
is not a production normalizer. AAC ancillary-payload clearance remains
unassessed, and coded sample timing does not establish speech alignment.
Raw results and custody therefore keep production admission blocked.

Passing this cohort establishes only the supplied bounded CPU slice—not
production admission, media quality, audible playback, native-editor
interoperability or whole-videogen completion.

### Actual native/CPU qualification (separate opt-in)

Default/root tests exclude `tests/videogen-native-production.test.ts`,
`tests/videogen-native-production-owner.test.ts` and `tests/videogen-default-native-flow.test.ts`
at both roots. Package `test:all` and root discovery route
`vitest.videogen-native-cpu.config.ts` through `test:videogen-native-cpu:aggregate`, never its
unauthorized direct runner. Without `PENNY_VIDEOGEN_NATIVE_CPU=1`, the aggregate reports
**Native/CPU qualification NOT RUN** even if bindings are ambient. With that exact opt-in,
missing bindings and test failures propagate rather than becoming skips.

The direct `bun run test:videogen-native-cpu` requires that opt-in and both
`VIDEOGEN_NATIVE_TEST_BINDINGS` (a private native-binding filename) and
`VIDEOGEN_MEDIA_TEST_BINDINGS` (private media-binding JSON). The native cohort also needs its
explicit synthetic asset/output paths (`VIDEOGEN_NATIVE_TEST_ASSET`,
`VIDEOGEN_NATIVE_TEST_OUTPUT`). Keep all binding paths and pins private; this route does not
discover or install an editor or decoder. Media-only opt-in does not authorize native work.
`tests/videogen-native-cpu-routing.test.ts` verifies routing with a stub, not native execution.
The full composition and its production-qualification limitations remain separate.

See `docs/agents/orchestration/overview.md` and
`docs/agents/skills/orchestration.md` for the canonical protocol.

## Ordinary contextual artifact inputs

The seven ordinary registrations opt into exact NONBINDING terminal-product context without
changing their native typed ports. On engine starts, use
`input_artifacts.artifacts[].designation: "context"`; omission or `"binding"` keeps the existing
native path. The skill tool exposes this as `context_artifacts` and a chain step's explicit
`previous_artifact_designation`. See the [interface and custody contract](../../.pi/extensions/skill/README.md#nonbinding-exact-context)
for recovery, refusal, assurance and qualification limits.

Context admission requires an exact current accepted producer terminal and revalidates current
owner completion evidence, not merely a canonical payload. The checkpoint retains original input
bindings separately from native selected refs. Context cannot become a required native input,
source index, revision subject, evidence or action authorization. Native output/review provenance
is unchanged; designated input custody is independently signed. This capability changes ordinary
runtime-registration digests and does not authorize retained-state migration.
