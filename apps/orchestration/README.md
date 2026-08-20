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
chain, and chain-resume modes all execute TypeScript playbooks. Chain handoff copies
exact predecessor bytes into an immutable target-run `chain_input` artifact before the
next playbook starts; no payload text is substituted and no Python child is spawned.

The closed request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and
`cancel`. The CLI accepts one version-2 request on stdin; `--execute` runs Pi SDK workers
until a terminal, clarification, or dispatch-pause boundary:

```bash
node apps/orchestration/dist/cli.js --project-root="$PROJECT_ROOT" --execute < request.json
```

## Components

| Module                            | Role                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `src/engine.ts`                   | Request validation, playbook dispatch, receipt gates, recovery, and terminal admission |
| `src/service.ts`                  | In-process composition of engine, workers, checkpoints, artifacts, and observability   |
| `src/checkpointer.ts`             | Owner-only Node SQLite run state keyed by `run_id`                                     |
| `src/artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                            |
| `src/worker.ts`                   | Pi SDK worker execution, owner capture, receipts, and bounded fan-out                  |
| `src/model-client.ts`             | Agent SSOT posture, phase guidance, worker-safe extension loading                      |
| `src/playbooks/registry.ts`       | Fail-closed playbook registry                                                          |
| `src/playbooks/research.ts`       | Research state machine                                                                 |
| `src/playbooks/knowledge-base.ts` | Knowledge-base state machine and host-only gates                                       |
| `src/kb/**`                       | Private KB records, policy, generations, capabilities, retrieval, and workflows        |

## Persistence and recovery

- Checkpoints default to `$PROJECT_ROOT/.penny/orchestration-v2.db`.
- Artifacts default to `$XDG_STATE_HOME/penny/artifacts` or the platform home state directory.
- `RunContext` stores exact selected refs, never artifact payload bytes.
- Recovery reissues the checkpointed directive with the same selected refs or the next
  explicit compatible revision.
- `PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new dispatch without converting the run
  to success or error. Unknown values fail closed.
- Compaction reads exact run IDs from the TypeScript v2 database; it does not scan for
  runs or consult semantic memory.

The retired Python database is never converted. Operator archival lives outside the
tracked repository and is not a runtime fallback.

## Environment

| Variable                             | Purpose                                   | Default                                    |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------ |
| `PENNY_ORCH_V2_DB`                   | TypeScript checkpoint database            | `$PROJECT_ROOT/.penny/orchestration-v2.db` |
| `PENNY_ORCH_V2_MAX_STEPS`            | Hard step ceiling                         | `96`                                       |
| `PENNY_ORCH_V2_WORKER_TIMEOUT_MS`    | Worker timeout                            | `900000`                                   |
| `PENNY_ORCH_V2_PARALLEL_CONCURRENCY` | Worker fan concurrency                    | `4`                                        |
| `PENNY_ARTIFACT_ROOT`                | Artifact manifest/object root             | XDG/platform state                         |
| `PENNY_ARTIFACT_DISPATCH_MODE`       | `active` or `paused`                      | `active`                                   |
| `PI_OBSERVABILITY_REST_URL`          | Observability REST endpoint               | `http://localhost:8765`                    |
| `PI_OBSERVABILITY_API_KEY`           | Observability bearer token                | empty                                      |
| `PENNY_RESEARCH_DEFAULT_MODEL`       | Optional per-invocation research override | agent SSOT defaults                        |

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
