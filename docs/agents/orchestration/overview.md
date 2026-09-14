# Orchestration Package — TypeScript execution engine

## What

`apps/orchestration` is Penny’s sole workflow runtime. It provides a registry of
`PlaybookCoreV1` implementations, closed request/directive and `SkillContractV2` contracts,
durable Node SQLite checkpoints, exact artifacts, signed worker receipts, recovery, gates,
owner-resolved research context, and observability.

The skill extension discovers every package once from `.pi/skills` and constructs
`OrchestrationService` in-process for single, parallel, chain, and resume modes. Skill packages
contain manifests, prompts, and resources—never executable delegates. `PLAYBOOK_REGISTRY` is the
sole executable registry. Model-visible packages omit `disable-model-invocation`; only parsed
`disable-model-invocation: true` hides a valid package from model discovery. Redundant `false` is not
permitted. A hidden development package may remain unregistered, and generic execution then fails
safely.

## Components

| Module                        | Role                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`                   | Closed request handling, playbook dispatch, transitions, receipts, gates, recovery                                                            |
| `service.ts`                  | Engine/checkpointer/artifact/worker composition                                                                                               |
| `checkpointer.ts`             | Owner-only Node SQLite state keyed by exact `run_id`; canonical content-review packet/receipt rows                                            |
| `artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                                                                                   |
| `worker.ts`                   | Active-registration checks, bounded Pi SDK execution, capture, fan-out, signed receipts                                                       |
| `model-client.ts`             | Registration guidance, agent SSOT models, YAML maxima, strict-subset validation, and active equality                                          |
| `playbooks/registry.ts`       | Fail-closed playbook construction plus digest-bound active generic-child parent/provider authority projection                                 |
| `child-workflows/`            | Bounded envelopes, active depth-one engine owner, artifact custody, durable call state, exact terminal capture, and atomic parent consumption |
| `playbooks/research.ts`       | Research cognitive graph, host sealing/rendering, latest-core product graph and DoD                                                           |
| `playbooks/knowledge-base.ts` | Knowledge-base machine and host-only gates                                                                                                    |
| `observability.ts`            | Best-effort metadata/digest events                                                                                                            |

## Rules

1. The request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and `cancel`.
2. Every cognitive directive carries exact input refs and output metadata.
3. The owner persists complete worker bytes and signs a receipt before routing.
4. `RunContext` stores refs, never payload bytes.
5. Playbooks classify structurally valid domain gaps and may update domain bookkeeping only.
   `EvaluationResultV2` cannot select a target or claim exhaustion. The engine resolves the unique
   registered state/kind route, charges its budget, guards control fields, transitions, and records
   body-free route digests in the existing checkpoint event transaction.
6. Structural malformed results remain isolated on the P1.2 routing-repair/liveness path.
   Playbook `repair_routing` declarations cannot claim `malformed_result`.
7. The engine alone admits positive terminals through the registration's closed `CompletionGate`
   v2 and host-owned receipt predicates. A rejected positive candidate becomes durable
   `incomplete/met:false` with its best
   artifacts preserved. Negative terminals pass through without gate evaluation.
8. Recovery is exact-run and forward-only. It never scans semantic memory.
9. Compaction reads only caller-supplied run IDs from the catalog-bound unversioned orchestration database.
10. `PENNY_ARTIFACT_DISPATCH_MODE=paused` preserves pending state and blocks new dispatch.
11. Unknown playbooks, predicates, requests, trust profiles, contract fields, routes, and dispatch modes fail closed.
12. The exact active registration reaches engine, service, worker, and catalog/private model paths.
    Missing guidance and state/agent mismatches refuse before session work. Durable non-private catalog
    workers persist a closed companion containing the complete authoritative opening for compaction;
    owner-resolved private-context workers are marked for Pi default compaction. Custom worker
    compaction requires exact verification of every input plus successful context persistence/readback.
    Every created SDK worker session emits and awaits `session_shutdown` before disposal on all exits.
13. A catalog worker's YAML is its maximum ordinary authority. Direct/parallel/chain paths
    and orchestration phases without `allowed_tools` request and activate YAML exactly. An
    eligible catalog phase may use only one explicit non-empty duplicate-free strict YAML subset
    held by the active `PlaybookRegistrationV1`; the canonical runtime-registration digest and
    worker invocation metadata include it. The model client validates strict YAML membership
    before session creation, passes the list exactly to Pi, and checks active equality before the
    model prompt. Task, trust profile, input, runtime condition, model/liveness policy, typed
    product, context metadata, and optional-service state cannot select or alter tools.
14. A phase subset does not mutate agent YAML/profiles and creates no OS/process sandbox or
    extension-code isolation. Anonymous host-private matrices remain separate and unchanged.
15. `registry.ts` projects the six ordinary workflows—`assess`, `decide`, `diagnose`, `plan`,
    `produce`, and `research`—as active depth-one generic parents and providers. A normal service
    constructs the child owner; an explicit host-only `enableChildWorkflows: false` setting disables
    it and returns the typed owner-unavailable refusal. The owner revalidates registration/YAML and
    native request bindings, atomically reserves one child, drives the ordinary child engine and
    runner, validates the exact terminal core, persists a child-result artifact, and atomically marks
    the call consumed with the parent continuation. It enforces fixed call/active/project admission
    and a content-free inactivity lease renewed only by host-observed worker activity or workflow
    convergence. The child otherwise uses its registered repair/liveness policy and the service-wide
    step backstop; active calls carry no predicted child-specific turn, tool, output, step, time,
    aggregate, or reserve budget. Runner
    cancellation, a concurrent durable parent cancel, and lease expiry all stop the current child;
    only parent cancellation marks the parent cancelled. `knowledge-base` remains dedicated/private
    and excluded. Child user gates, arbitrary restart reconciliation after terminal capture,
    artifact/receipt/session cohort retention, promotion, and live-provider qualification remain
    separate work; Gate 2 evidence remains unrun.
16. New calls use schema-v3 `invoke_child_workflow` directives and durable
    `ChildWorkflowCallRecordV2`. They contain no resource allocation and bind one exact,
    content-free child-execution lease profile. Each execution uses a fenced
    owner/attempt/session coordinate; stale or empty activity cannot renew it, activity does not
    manufacture convergence, and expiry aborts the child. Legacy schema-v2 directives and V1 records
    remain exact replay inputs under their original timing policy and are never minted for new calls.
17. New research starts canonicalize `ResearchRequestV1` and validate typed imported semantic-core bytes before run mutation or model/session work.
18. Research context persists metadata-only, versioned `ContextSourceRef` artifacts. Resolver-v2 admission uses bounded pre-resolved snapshots, while every selected current or legacy envelope is asynchronously re-resolved immediately before model execution under the current manifest/use-time policy. The worker owns the wall-clock deadline, `AbortController`, and Promise race; synchronous throws, rejections, non-settling Promises, cancellation, stale output, drift, revocation, conflicts, and unavailable sources fail before `runAgent`. V2 handlers are explicitly trusted in-process adapters and receive the use-time `AbortSignal` and deadline. This does not let JavaScript preempt malicious CPU-infinite synchronous adapter code; untrusted resolver logic requires an interruptible worker/process boundary behind the adapter. Invocation is deferred one event-loop turn so cancellation already requested can win before adapter start. Scope and verification-disposition widening is never inferred for an older selection: it requires a newly admitted binding with its exact source, revision/approval, scope, role, media type, disposition, and provider identity verified.
19. P3 research returns/forwards the latest canonical `GroundedSynthesisV1` semantic-core ID. Synthia's closed `ResearchSemanticDraftV1` is deterministically projected and sealed by the host before Vera; every changed core re-enters Vera before optional report Carren. Host rendering persists latest-core receipts/renders/envelope and admits success only through the research DoD from `rendering`.
20. A catalog phase's optional `browser_network_allowlist` is frozen, canonical, registration-digest-bound, and projected only by `WorkerExecutor`. `browser-policy-contract-v1.ts` is the single v1 parser/bounds/carrier contract used by orchestration and Playwright; production accepts only the context-local `orchestration-registration` carrier admitted by `PiAgentClient`. Browser resource closure alone retains a live binding; captured session retirement reclaims it only after owned browser-process exit is confirmed.

## Child-call storage boundary

`ChildWorkflowStateOwner` mints opaque custody from one concrete `ArtifactStore`. The checkpointer
matches that store to the control database's project ID and re-verifies the canonical request and
all input refs/bytes before mutation. For a new logical call, one `BEGIN IMMEDIATE` transaction:

1. records the exact `invoke_child_workflow` directive as the running parent's pending work;
2. inserts an ordinary unstarted child run with the same project root/trust profile and the reserved
   service-configured step backstop;
3. inserts the canonical `child_workflow_calls` row; and
4. appends parent-reservation and child-creation events, then checks exact readback.

The row binds the exact parent visit, deterministic call/child identities, parent and child
registration digests, request/input/output-contract refs and digests, policy binding, active lease binding,
lifecycle, and timestamps. Historical V1 rows additionally retain their original allocation. Exact
duplicate immutable operands adopt the existing row and lifecycle;
changed operands conflict. Missing linked runs, an unpaired deterministic child run, mismatched
registration/project/trust/visit data, corrupt rows, or artifact-only state fail closed rather than
being reconstructed.

Schema v12 accepts both exact legacy V1 and active V2 call records. The explicit v11→v12 migration
rebuilds only the row-version check and preserves every canonical V1 record byte; exact older
fingerprints upgrade without inventing call rows. Unversioned, unsupported, newer, or malformed
retained state refuses before use. The separate state-migration verifier requires the artifact
manifest and objects whenever retained call rows exist and rechecks their exact refs.

Lifecycle updates are compare-and-set operations. A captured terminal can be consumed only through
one owner transaction that verifies the original pending directive, preserves the terminal operands,
writes the parent continuation, and changes the record to `consumed`; a repeated delivery cannot
advance the parent twice. Terminal pruning keeps every child run named by a call row and keeps a
parent while a linked call is not consumed. This does not claim artifact-cohort, receipt, or
catalog-session retention, eventual cohort eviction, child-gate projection, or general
restart/cancellation reconciliation.

## Active generic-child authority projection

Every active ordinary registration carries the same explicit all-six parent allowlist and its own
native provider declaration. The policy permits one depth-one call, one active child, and project
concurrency one. It deliberately carries no child-specific resource allocation, aggregate budget,
or parent-sealing reserve. Agent YAML remains the maximum tool authority unless an existing phase registration
already fixes a strict subset; that registered subset is projected unchanged. A subset-absent
provider carrier records the exact YAML maximum snapshot, and registration validation re-reads the
catalog to refuse YAML drift. The existing `browser_network_allowlist`, or null when absent, is the
only destination carrier. Request/task, runtime, trust, liveness, provider response, and
optional-service data cannot select either carrier.

This projection authorizes active depth-one dispatch through the service-owned child runtime;
`WorkerExecutor` still never executes child directives directly. Provider qualification and external
discovery/promotion remain independent: Gate 2 is `not_run` with no evidence, and runtime execution
does not fabricate qualification evidence.

## Composition

Parallel skill invocations create independent TypeScript runs. Chain composition verifies
and forwards the prior terminal artifact ID directly across runs. For research positives this is the
semantic-core ID, never the research product envelope, a render, receipt, or Synthia semantic-draft artifact. The next entry state may
also receive additional explicit fan-in IDs; `{previous}` is never payload transport.
Durable chain checkpoints retain exact terminal/handoff refs across restart.

## Persistence

- State root: `${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}`; Pi relocation follows `PI_CODING_AGENT_DIR`.
- Database: `projects/<opaque-project-id>/orchestration/orchestration.db`. It uses WAL, `synchronous=FULL`, bounded busy timeout, project metadata, and co-locates ingest/save content-review packets and receipts with their runs/gates.
- Receipt key: the same partition's `orchestration/receipt-key`; exact key bytes must survive migration.
- Artifacts: the same partition's `artifacts/manifest.db` plus content-addressed objects.
- Chains and subagent sessions: the same project partition, with project-bound checkpoints and durable Pi JSONL. The existing terminal-run cap retains newest run cohorts (500 by default) with all correlated current-format worker sessions; after committed run eviction, ordinary runtime removes only owner-only, no-follow-validated JSONL whose exact metadata reconciles to an absent run. Custody-blocked and nonterminal runs keep their sessions.
- Retired selectors and roots are rejected; ordinary runtime performs no scan, import, or fallback outside that caller-supplied session partition.
- The existing append-only `events` payload carries body-free state-visit and
  admission/refusal metadata. Research host progress also uses selected immutable refs and bounded
  body-free events; no host-progress field/table is added. Admission binds the terminal digest, gate digest, latest
  product, exact visit refs, and indexed evidence refs in the same checkpoint transaction.
  This adds no table, migration, selector, state path, or observability dependency.
- Exact pre-v2 positive terminals remain replayable as legacy truth. A post-v2 envelope is
  verified on `status`/`recover`; corrupt evidence fails closed and is never regenerated.

## Verification

- [ ] Direct/parallel/chain source guards and real-session tests prove exact YAML equality.
- [ ] Orchestration proves subset-absent YAML equality plus canonical registration-digest and
      invocation-metadata binding, exact Pi handoff, synthetic registration-bound strict subsets,
      and invalid-subset refusal before session creation.
- [ ] Native and Penny model listings plus `.pi/skills/.ignore` follow only explicit
      `disable-model-invocation: true`; visible manifests omit the flag.
- [ ] Strict-subset docs avoid OS/process sandbox and extension-code-isolation claims; host-private
      isolated tools remain separate.

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/compaction test:unit
```
