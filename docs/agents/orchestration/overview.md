# Orchestration Package — TypeScript execution engine

## What

`apps/orchestration` is Penny’s sole workflow runtime. It provides a registry of
`PlaybookCore` implementations, closed request/directive and `SkillContractV2` contracts,
durable Node SQLite checkpoints, exact artifacts, signed worker receipts, recovery, gates,
owner-resolved research context, and observability.

The skill extension discovers every package once from `.pi/skills` and constructs
`OrchestrationService` in-process for single, parallel, chain, and resume modes. Skill packages
contain manifests, prompts, and resources—never executable delegates. `PLAYBOOK_REGISTRY` is the
sole executable registry. Manifest YAML, visibility, and hidden-development-package behavior follow
[SKILL.md Format](../skills/skill-md-format.md); visibility never grants execution authority.

## Components

| Module                        | Role                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`                   | Closed request handling, playbook dispatch, transitions, receipts, gates, recovery                                                            |
| `service.ts`                  | Engine/checkpointer/artifact/worker composition                                                                                               |
| `checkpointer.ts`             | Owner-only Node SQLite state keyed by exact `run_id`; canonical review, child-call, and host-operation journal rows                           |
| `artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                                                                                   |
| `worker.ts`                   | Active-registration checks, bounded Pi SDK execution, runner-owned child/host delegation, capture, fan-out, and signed receipts               |
| `model-client.ts`             | Registration guidance, agent SSOT models, YAML maxima, strict-subset validation, and active equality                                          |
| `playbooks/registry.ts`       | Fail-closed playbook construction plus digest-bound active generic-child parent/provider authority projection                                 |
| `child-workflows/`            | Bounded envelopes, active depth-one engine owner, artifact custody, durable call state, exact terminal capture, and atomic parent consumption |
| `host-operations/`            | Registered asynchronous adapter owner, project journal, global FIFO/fenced leases, quarantine, and atomic parent consumption                  |
| `playbooks/research.ts`       | Research cognitive graph, host sealing/rendering, latest-core product graph and DoD                                                           |
| `playbooks/knowledge-base.ts` | Knowledge-base machine and host-only gates                                                                                                    |
| `observability.ts`            | Best-effort metadata/digest events                                                                                                            |

## Rules

1. The request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and `cancel`.
2. Every cognitive directive carries exact input refs and output metadata.
3. The owner persists complete worker bytes and signs a receipt before routing.
4. `RunContext` stores refs, never payload bytes.
5. Playbooks classify structurally valid domain gaps and may update domain bookkeeping only.
   `EvaluationResult` cannot select a target or claim exhaustion. The engine resolves the unique
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
    SDK worker teardown awaits registered `session_shutdown` handlers before disposal on all exits.
13. Apply the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule) for
    tool selection, including the guarded zero-tool exception's exact registration-bound
    model/payload/disclosure/final-opening checks. Profiles own static maxima; runtime/tool/trust
    content cannot choose a surface. A subset is not OS/process or extension-code isolation;
    anonymous host-private matrices remain separate.
14. Apply [Invocation](../agents/invocation.md) for transport and exact final-text capture/readback
    before routing. This engine owns checkpoint continuity and admission, not a second handoff policy.
15. `registry.ts` authorizes exactly seven ordinary generic-child peers: `assess`, `decide`,
    `define`, `diagnose`, `plan`, `produce`, and `research`. A normal service constructs the child
    owner; host-only `enableChildWorkflows: false` returns owner-unavailable refusal. WorkerExecutor
    never executes child directives. The owner revalidates registration/YAML and native request
    bindings, drives the child engine/runner, validates the exact terminal core, persists a
    `child-result` artifact and atomically consumes it with the parent continuation once. This
    never grants parent success. Missing owner/bindings/milestones refuse. See the feature status
    and exact custody, gate, recovery, and authority sections below. Gate 2 remains `not_run`.
16. New calls use schema-v3 `invoke_child_workflow` directives and durable
    `ChildWorkflowCallRecordV2`. They contain no resource allocation and bind one exact,
    content-free child-execution lease profile. Each execution uses a fenced
    owner/attempt/session coordinate; stale or empty activity cannot renew it, activity does not
    manufacture convergence, and expiry aborts the child. Legacy schema-v2 directives and V1 records
    remain exact replay inputs under their original timing policy and are never minted for new calls.
17. New research starts canonicalize `ResearchRequestV1` and validate typed imported semantic-core bytes before run mutation or model/session work.
18. Research context persists metadata-only, versioned `ContextSourceRef` artifacts. Resolver-v2 admission uses bounded pre-resolved snapshots, while every selected current or legacy envelope is asynchronously re-resolved immediately before model execution under the current manifest/use-time policy. The worker owns a renewable inactivity lease, `AbortController`, and Promise race; synchronous throws, rejections, non-settling Promises without progress, cancellation, stale output, drift, revocation, conflicts, and unavailable sources fail before `runAgent`. V2 handlers are explicitly trusted in-process adapters and receive the use-time `AbortSignal`, inactivity interval, and `reportProgress` callback. Only real provider progress renews the lease; repeated timer heartbeats do not. Productive resolution has no total-duration cutoff. This does not let JavaScript preempt malicious CPU-infinite synchronous adapter code; untrusted resolver logic requires an interruptible worker/process boundary behind the adapter. Invocation is deferred one event-loop turn so cancellation already requested can win before adapter start. Scope and verification-disposition widening is never inferred for an older selection: it requires a newly admitted binding with its exact source, revision/approval, scope, role, media type, disposition, and provider identity verified.
19. P3 research returns/forwards the latest canonical `GroundedSynthesisV1` semantic-core ID. Synthia's closed `ResearchSemanticDraftV1` is deterministically projected and sealed by the host before Vera; every changed core re-enters Vera before optional report Carren. Host rendering persists latest-core receipts/renders/envelope and admits success only through the research DoD from `rendering`.
20. A catalog phase's optional `browser_network_allowlist` is frozen, canonical, registration-digest-bound, and projected only by `WorkerExecutor`. `browser-policy-contract.ts` is the single v1 parser/bounds/carrier contract used by orchestration and Playwright; production accepts only the context-local `orchestration-registration` carrier admitted by `PiAgentClient`. Browser resource closure alone retains a live binding; captured session retirement reclaims it only after owned browser-process exit is confirmed.
21. Registered asynchronous host operations use only the runner-owned generic boundary in `host-operations/`. Registration fixes adapter and artifact contracts, backend/capability binding, lease/inactivity policy, and limits. The project journal retains full remote correlation privately; the state-root-global fenced lease serializes a backend across projects and quarantines ambiguous acceptance without automatic takeover. Workers cannot execute the directive, and parent routing plus `settled → consumed` is one project transaction. See the [accepted host-operation decision](../architecture/host-operations.md).
22. A deterministic registered opening or disclosure-policy refusal before provider dispatch is a typed non-retriable boundary. The runner must commit the playbook's negative terminal before returning; recovery returns that terminal without rebuilding the opening or rerunning a worker. No model-dispatch guard may exist for work refused at this boundary. Payload admission reserves deterministic framing capacity, while the final guard measures the complete serialized opening against a stricter ceiling than catalog continuity storage.
23. Implementation identity values confer runtime authority only when admission compares them with host-derived current bindings. A contract that carries caller-supplied revision or digest values without that comparison must mark them with a closed declaration-only, non-attestation scope and must not use them to authorize execution.
24. Closed result vocabularies also require closed cross-field semantics. Invalid recommendation/evidence/uncertainty combinations fail result validation, and obligation-ledger plus gate construction independently treats every evidence-gap signal as pending so a validator regression cannot create a positive transition.

## Child-workflow feature status

This is the status owner for skill/state-management guidance. Source support and available tests
are not proof those tests ran or that a live provider is qualified.

| Feature                                                                         | Implemented boundary / evidence scope                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact custody, atomic reservation, adopt-or-conflict and lifecycle CAS          | Storage-only boundary in `child-workflows/storage.ts`, `child-workflows/owner.ts` and `checkpointer.ts`; storage tests do not establish dispatch.                                                                                                 |
| Depth-one engine/runner dispatch, exact terminal capture and atomic consumption | Active runtime owner in `child-workflows/owner.ts`; fixed call/active/project admission, registered repair/liveness, any operator-supplied service step limit, and a fenced inactivity lease.                                                     |
| Child user gates and mediated replies                                           | Active version-2 parent projection plus closed `penny.projected-child-response.v1`; exact committed reply binding and crash-window recovery, not direct child replies.                                                                            |
| Waiting/captured-terminal restart                                               | Active recovery adopts frozen registration/operand bindings and durable replies/terminals; it does not reconstruct arbitrary missing linkage or rebind old calls to new registrations.                                                            |
| Cancellation and selection fences                                               | Runner signal/durable parent cancellation stop children; consumption rechecks the durable parent snapshot and current authority. Lease expiry is not parent cancellation.                                                                         |
| Linked retention                                                                | Control/gate/receipt cohorts and correlated catalog sessions remain together under custody/unconsumed/quarantine holds; eligible control eviction is atomic, then safe session cleanup. Immutable artifacts are preserved, not garbage-collected. |
| Imagegen reuse                                                                  | Separate opt-in `imagegen_child` policy and concrete enabled runtime/asset owners; not an eighth ordinary peer, videogen activation, or qualification.                                                                                            |
| Provider promotion/external discovery/live qualification                        | Not established by internal execution or provider-free evidence. `gate_2_live_provider` stays `status: not_run`, `evidence: null`.                                                                                                                |

## Child-call storage boundary

`ChildWorkflowStateOwner` mints opaque custody from one concrete `ArtifactStore`. The checkpointer
matches that store to the control database's project ID and re-verifies the canonical request and
all input refs/bytes before mutation. For a new logical call, one `BEGIN IMMEDIATE` transaction:

1. records the exact `invoke_child_workflow` directive as the running parent's pending work;
2. inserts an ordinary unstarted child run with the same project root/trust profile and any
   operator-supplied service step limit;
3. inserts the canonical `child_workflow_calls` row; and
4. appends parent-reservation and child-creation events, then checks exact readback.

The row binds the exact parent visit, deterministic call/child identities, parent and child
registration digests, request/input/output-contract refs and digests, policy binding, active lease binding,
lifecycle, and timestamps. Historical V1 rows additionally retain their original allocation. Exact
duplicate immutable operands adopt the existing row and lifecycle;
changed operands conflict. Missing linked runs, an unpaired deterministic child run, mismatched
registration/project/trust/visit data, corrupt rows, or artifact-only state fail closed rather than
being reconstructed.

Schema v13 accepts both exact legacy V1 and active V2 child-call records. The explicit v11→v12 migration
rebuilds only the row-version check and preserves every canonical V1 record byte; v12→v13 adds the
host-operation journal without inventing child or host-operation rows. Exact older fingerprints
upgrade without synthetic records. Unversioned, unsupported, newer, or malformed
retained state refuses before use. The separate state-migration verifier requires the artifact
manifest and objects whenever retained call rows exist and rechecks their exact refs.

Lifecycle updates are compare-and-set operations. A captured terminal can be consumed only through
one owner transaction that verifies the original pending directive, preserves the terminal operands,
writes the parent continuation, and changes the record to `consumed`; a repeated delivery cannot
advance the parent twice. Consumption rechecks the durable parent inside that transaction, including the source snapshot
selected by the owner. Cancellation, rights revocation or a changed selection between preparation
and commit cannot be overwritten by the older prepared context.

Terminal retention treats linked parent/child runs as one cohort. A live member, retained member,
unconsumed call, other custody hold, or unconsumed/quarantined host journal pins the whole cohort.
A cancelled parent's captured or cancelled child is eligible only with an exact durable terminal
and no unsettled host work. Eligible old cohorts are deleted parent-first in one transaction;
the existing session custodian then removes only safely reconciled owner-only JSONL. Immutable
artifact objects are preserved: this is not a new artifact garbage collector or quarantine reset.

Retention below or at the terminal-run cap performs no writer reservation or dependency traversal.
Above the cap, cohort and transitive producer planning uses a read snapshot and validates compact
checkpoints without restoring runtime contexts. The deletion transaction acquires `BEGIN IMMEDIATE`
and compares the same connection's `PRAGMA data_version` with its pre-snapshot value. An intervening
commit defers eviction to the next pass rather than deleting from stale selections, holds or keep
order. The writer reservation covers the version check and atomic deletion, not history replay;
busy timeouts and corruption errors are not suppressed. Visit reads filter irrelevant events in SQL
but retain canonical validation of malformed rows, including nested numeric overflow.

## Projected gates and controlled imagegen children

A child `await_user` becomes a parent-owned gate and `waiting_user` call in one transaction.
The version-2 `child_workflow` projection binds call/child identity, exact child gate/challenge and
payload digest, both registration digests, invocation digest and the entire child-gate digest.
The parent gate/challenge and payload digest derive from that projection. `recover` returns the
same durable gate without playbook rebind or a render inactivity timer.

A parent reply is a closed `penny.projected-child-response.v1` document with `schema_version:1`,
`projection`, `payload_digest` and JSON `reply`. The engine persists an exact `child-gate-response`
artifact, then atomically commits its selected ref, the answered parent gate and restored original
child directive. The child engine accepts delivery only through that committed parent binding;
direct child replies and duplicate/stale/mismatched parent replies refuse. Recovery covers both
parent-reply and child-reply commit windows without applying the reply twice. Cancellation also
reaches a waiting child; late results cannot continue a cancelled parent. Version-1 projection
shapes remain parseable but are not silently granted the version-2 execution protocol.

`PlaybookRegistration.imagegen_child` is a separate, optional, digest-bound
`ImagegenChildPolicyV1`. It fixes finite serial call/project limits, asset IDs, parent states, the
exact provider registration digest and progress lease. It does not add imagegen to the ordinary
seven-peer projection. The service also needs concrete same-project `ImagegenChildRuntimeAuthority`,
`ImageAssetAuthority` and injected, already-enabled imagegen registries; standalone canary activation
is not supported on this child path. No construction enables a deployment or issues qualification.

The adapter admits only one-image/no-export native asset requests under current G1, rights,
consent, profile and per-call allowance. Source/mask call operands map to the native typed `asset`
request, not invented generic semantic-input ports. Results use the native
`penny.image-asset-result.v1` port. Capture and restart consumption recheck current authority and
imagegen's reviewed-product predicate, then atomically import the PNG and exact review/operation
lineage. Serial results coexist at separate immutable operation coordinates rather than competing
for a first-revision store selection. Provider-free tests cover fresh/revision calls, unauthorized
nth calls, reply/capture crashes, cancellation fences and eventual control/session eviction.
They do not qualify a live provider. The separate opt-in request/intent and post-receipt result
wrapper milestones are documented in [Host Operations](../architecture/host-operations.md);
those custody checks do not replace domain evidence or qualification.

## Active generic-child authority projection

Every active ordinary registration carries the same explicit all-seven parent allowlist and its own
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

The seven ordinary registrations opt into `accepted_terminal_products_v1` contextual inputs.
At skill ingress, `context_artifacts` carries exact IDs separately from native `input_artifacts`;
a chain step uses `previous_artifact_designation: "context"` to label the automatic predecessor.
Omission retains native binding behavior. Engine bindings persist the explicit designation with
the full exact ref and slot. Shared admission verifies a current accepted terminal product and
its producer/review graph, excludes context from native admission/source indexes/assurance,
and attaches it to cognitive directives without changing native product semantics. Context
never grants evidence status, tools, approval or effect permission. Recovery rejects changed
refs/designations and reuses the owner's original slots. Schema validity and exact delivery
are not proof a model used the content faithfully; content-sensitive and live evidence remain
separate obligations.

## Pre-review mechanical evidence

Before Vera runs, Assess, Decide, Define, Diagnose, Plan and Research execute their native
validators and append one `HOST_MECHANICAL_CHECKS:` statement to the task. The execution
receipt's task hash binds that exact statement. Produce instead keeps its existing
`penny.produce-mechanical-checks.v1` artifact; it does not use the inline carrier.

These are actual checks over the current product and selected sources, not a checklist for
the reviewer to claim it ran. Their scope differs: Assess checks draft/product lineage and
effect-graph shape; Diagnose checks diagnosis lineage and authored no-action literals;
Decide checks parsed-draft lineage and evidence-admission execution; Plan additionally
checks specification source coverage/index and assurance; trace-capable Define replays its
trace/support projection and evidence admission; Research reprojects the core and checks
captured excerpts, relations and considered evidence history. Produce checks its native
request/draft/product lineage and effect-graph shape.

Inline-evidence recovery recomputes the checks and requires the exact frozen statement,
without rewriting the signed task. Missing, duplicate or changed evidence fails closed.
Mechanical validation failure stops incomplete rather than requesting author repair.
Neither carrier proves semantic validity or absence of effects. Post-review validity
receipts, integrity artifacts and product envelopes are not pre-review prerequisites.
See [Resilience](../skills/resilience.md#preserve-review-judgment) for verification inability
and [Loops](../skills/loops.md#exact-repair-recurrence) for conservative repair measurement.

## Produce review assignment binding

Produce's Carren/Vera review wire V2 contains only semantic judgment and confidence, not model-copied
artifact references. After contextual-input enrichment and before dispatch checkpointing, the host
persists an immutable `penny.produce-review-assignment.v1` companion with the original task hash,
input bindings, output metadata and invocation coordinates. RunContext retains its exact ref; it
is not a new model operand or a payload embedded in checkpoint state. Historical checks use those
frozen fields, not today's task, schema-description or slot generator. Explicit output-revision
rebinds get their own companion only after the saved assignment matches its previous one.

Minting and admission recheck source bytes, current native/context roles, accepted execution events,
the frozen invocation digest and the original receipt signature, including a routed repair's
receipt when present. Missing companions or verifiers fail closed. V1 review bytes retain strict
reference validation; this is not an in-place upgrade of old interrupted registrations. Committed
historical terminals retain their existing replay semantics.

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

## Database health

Readiness/startup and administrative status use SQLite-managed read transactions, not
raw database/WAL copies. They never initialize or repair application data, although
SQLite may manage WAL/SHM sidecars and access timestamps. Closing a raw file descriptor
for an active SQLite file can drop process-owned POSIX locks; do not use raw file reads
for health snapshots. Use SQLite's backup API when a separate consistent image is needed.

Exact artifact operations perform project/schema checks and selected metadata/digest/length
verification, not redundant whole-store scans. Full integrity and foreign-key scans run
at readiness/startup and explicit status. `STATE_DATABASE_CORRUPT` and
`ARTIFACT_STORE_CORRUPT` preserve health diagnostics and remain distinct from missing
configuration and incompatible schemas. Preserve damaged state; offline recovery into a
separate validated database requires an explicit operator disposition.

Use Node from `.nvmrc` (24.21.0) or newer with bundled SQLite >=3.51.3. Restart Pi and
services after switching runtimes; setup checks the actual bundled SQLite version.

## Shipping generation

Shipping extension/library and sibling-workspace imports resolve only to declared compiled
orchestration exports with matching `dist` declarations. `/source` is not exported; private
research modules remain closed. The explicit `skill-contracts/common` subpath supplies the
existing SCA primitive-schema consumers without a source bypass or schema copy. The sole
current skill-result contract lives in orchestration's `src/skill-result.ts` and is exported
from the root. Package and integration tests, including shared fixtures, use compiled modules.

Build before declaration-dependent checks or direct focused tests. `check:shipping` checks
imports and exports mechanically; the builder runs it and records source/helper/output SHA-256
provenance. Shipping entrypoints and service boundaries refuse missing/stale/mixed output.
The package requires its checkout inputs for freshness verification. Stop workers before
rebuilding, then start a fresh Pi/service process; do not treat a build or extension reload as
proof that cached package modules were replaced. Routing-preservation and repair-progress
policy declarations participate in the runtime-registration digest. A changed registration
refuses active/interrupted checkpoints with `REGISTRATION_CONTRACT_MISMATCH`; it does not
silently upgrade them. A cancelled run remains stopped under its stored terminal, not a
candidate for recovery into the new policy. See the package README's
[shipping and build contract](../../../apps/orchestration/README.md#one-shipping-generation).

## Verification

Use the [testing evidence matrix](../skills/testing.md#required-coverage). In particular, prove
active-registration binding and pre-session tool refusal under the
[binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule), exact input/output
custody, completion admission, and each changed recovery/cancellation path. Storage-only,
active-runtime, provider-free, and live-qualification evidence are not interchangeable.
Source inspection and source-mapped fixtures establish only source behavior; compiled-package
checks require the matching shipping generation. Neither establishes live loop qualification.

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/compaction test:unit
```
