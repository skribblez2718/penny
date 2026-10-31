# Registered Asynchronous Host Operations — Accepted Decision

## Status and decision

**Status:** Accepted for the generic platform boundary. Production operation kinds still require an explicit registration and an injected trusted adapter.

Penny uses a dedicated `HostOperationRuntimeOwner` for bounded asynchronous host work. The owner is reached only from `OrchestrationRunner` after the engine has checkpointed a closed `invoke_host_operation` directive. It reuses the shared engine, artifact store, checkpoint transaction patterns, and state-root catalog, but it does not reuse a model worker, child workflow, synchronous host continuation, or domain-specific second engine.

This seam is generic. Registrations and adapters supply every operation kind, request/result contract, backend binding, capability class, queue and operation inactivity profiles, and output/progress limit. The platform contains no image-backend operation kind or production adapter.

## Alternatives considered

| Alternative                                          | Useful existing property                                                                                     | Decision                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend operation event groups                        | Exact idempotency and receipt ordering for short external ingress operations                                 | Rejected as the owner. Event groups are project-local replay records, not an intermediate remote-milestone journal, asynchronous runner, or cross-project backend coordinator. Their transaction and receipt patterns remain useful.                                                                                              |
| Extend the child-workflow owner                      | Durable reserve/adopt/conflict semantics and atomic parent consumption                                       | Rejected as the owner. A child call drives another registered workflow and model workers; privileged host effects have different authority, cancellation, remote-correlation, and quarantine semantics. The host owner reuses its custody and compare-and-set patterns without pretending an external effect is a child workflow. |
| Extend synchronous host continuation                 | Small surface and existing deterministic host-state support                                                  | Rejected for long-running work. A synchronous continuation cannot safely represent queue wait, renewable activity, process restart, remote cancellation, or an ambiguous acceptance window without blocking the engine call. Deterministic short host continuation remains unchanged.                                             |
| Add a domain-specific async engine                   | Could encode one backend directly                                                                            | Rejected. It would duplicate checkpoints, routing, cancellation, and recovery while hardcoding a downstream domain into Penny.                                                                                                                                                                                                    |
| Add one registered asynchronous host-operation owner | Keeps the engine and registrations authoritative while separating privileged effects and global coordination | **Chosen.** It is the smallest reusable seam that satisfies cancellation, exact recovery, cross-project serialization, and quarantine.                                                                                                                                                                                            |

## Authority and execution boundary

A playbook registration may add a closed `host_operations` authority. Each declaration binds:

- one unique operation kind and fixed adapter ID;
- exact request, operation-result, and optional adapter-output artifact contracts;
- one backend-binding ID and a non-empty capability-class set;
- a digest-bound fenced-lease profile, finite queue-inactivity interval, and renewable operation-inactivity interval;
- request, exact-input count/byte, output-artifact, output-byte, progress-event, and pre-acceptance retry ceilings;
- an optional result-selection policy (`selected` by default) that governs whether the owner selects its operation result, platform result, and receipt as the current revision of their `(run, phase, branch, kind)` coordinate, with `unselected` persisting them durably without selecting them so distinct per-item results of one kind can coexist under one state; and
- fixed recovery and cancellation semantics.

The canonical declaration participates in `runtimeRegistrationSha256`. To preserve historical registrations, an absent `host_operations` field contributes no new canonical member. Unknown, duplicate, stale, drifted, task-selected, model-selected, or trust-selected authority fails before adapter execution.

The directive carries only identity, state, attempt, operation identity, registration digest, exact request ref/digest, exact input refs, expected result contract, and the registration-derived policy binding. Before adapter execution, the owner reads and hashes only those bound inputs, enforces their registered count and aggregate-byte limits, and exposes them by exact slot through `readInput()`. There is no adapter artifact discovery surface. Request and result bodies remain immutable artifacts, never `RunContext` payloads.

`WorkerExecutor` has no host-operation execution branch. Direct engine recovery only reissues the pending directive. `OrchestrationRunner` is the sole delegate to `HostOperationRuntimeOwner`; a missing owner returns the stable `HOST_OPERATION_OWNER_UNAVAILABLE` boundary. The owner accepts adapter results only through its bounded execution context and then asks the engine to prepare the ordinary playbook continuation.

## Exact transaction and compare-and-set identity

The deterministic operation record ID commits to:

```text
project ID + run ID + state ID + attempt + operation ID
+ registration digest + request digest
```

Reservation additionally compares the complete immutable directive and artifact operands. Every project-journal transition compares the expected lifecycle and canonical record SHA-256. A changed request or any changed immutable operand conflicts rather than adopting prior work.

The global lease owner compares the backend key plus project/run/state/attempt/operation/registration/request identity and the current lease ID, epoch, and fencing-token digest. A stale fence cannot submit, renew, reconcile acceptance, release, or quarantine.

## Durable ownership scopes

### Project operation journal

The project orchestration database owns one canonical record:

```text
prepared → lease_acquired → submitting → submitted → fetched
         → persisting → persisted → verified → terminal → settled → consumed
```

It retains the full remote recovery correlation ID. That value is owner-private and bounded. Events, progress, standard results, receipts, and global catalog rows receive only its SHA-256.

### State-root-global backend authority

The state-root catalog owns:

- a backend-keyed FIFO queue shared by projects and service processes;
- one active lease with epoch and fencing-token digest;
- the phase `pre_submission | submission_guarded | remote_accepted`;
- disposition receipts; and
- append-only inspected quarantine-reset receipts.

Queue wait does not hold a SQLite transaction. A stale `pre_submission` lease may be replaced because remote non-acceptance is proven. A stale guarded or accepted lease is quarantined. Quarantine has no automatic expiry, takeover, or release.

## Write ordering and crash meaning

The owner uses this order:

1. The engine checkpoints the pending directive before runner execution.
2. The project owner verifies exact artifact custody and reserves `prepared`.
3. The global owner enqueues/acquires a fenced lease; the project journal records `lease_acquired`.
4. Immediately before external submission, the global owner moves the lease to `submission_guarded`; the project journal records `submitting`.
5. On known acceptance, the project journal first stores `submitted` with the full correlation ID, then the global owner reconciles `remote_accepted` using only its digest. A crash before the project write remains ambiguous and quarantines; a crash after it can reconcile from exact durable proof.
6. Fetched metadata is journaled before output persistence.
7. The owner journals deterministic artifact coordinates and digests as `persisting`, writes or exactly adopts those coordinates, records `persisted`, then re-reads and hashes every byte before `verified`.
8. The project record becomes `terminal` with a closed disposition.
9. The global owner records and applies release or quarantine before project settlement.
10. The owner persists a platform result and body-free receipt, then records `settled`.
11. The engine verifies the settled artifacts and prepares normal playbook dispatch. One project transaction checkpoints that parent continuation and changes `settled → consumed`.

No broad artifact, history, log, memory, or remote queue scan may synthesize a missing journal milestone. A pre-journaled deterministic artifact coordinate may be adopted only when its exact ref and bytes match.

## Opt-in request/intent and receipt-citing result protocol

A declaration may explicitly select `effect_protocol: request_intent_v1` and the fixed
`receipt_citing_result` contract. Both fields participate in the existing registration and
policy digests. Omission preserves legacy declaration bytes and replay; it does not migrate
or reinterpret a retained call. No table, key, signer, runtime registration or activation is added.

`prepareHostEffectArtifacts` derives the logical operation ID from existing project/run,
state visit/attempt, kind, scope ref, predecessor ref and slot. It validates and persists the
request with that ID first, then the exact `penny.videogen-effect-intent.v1` referencing it.
The directive and journal retain both refs and the logical identity. Mismatched IDs, request
refs, operands or project/state/visit bindings refuse before execution. An interrupted orphan
request/intent pair refuses; recovery never fills its missing link by scanning artifacts.
This is custody, not current gate, rights, capacity or deployment qualification: the registered
use-time checks remain mandatory for those decisions.

After exact raw-result/output persistence, terminal proof and the existing owner receipt,
the settled journal records a deterministic wrapper plan, persists/readbacks the wrapper, and
commits its exact ref. The fixed `penny.host-operation-receipted-result.v1` fields are
`schema_id`, `schema_version`, `operation_record_id`, `operation_id`, `request_ref`,
`effect_intent_ref` (nullable), `raw_result_ref`, `output_refs` and `receipt_ref`.
The earlier platform result and receipt bind raw artifacts only, never the later wrapper
that cites them. The wrapper counts against registered output count/bytes; its plan/ref and
settled raw/receipt evidence cannot be replaced. Consumed replay re-verifies its exact bytes.
A pre-wrapper crash finishes only that exact local wrapper, without adapter re-entry or a new
remote submission. Existing host receipts retain their v1 journal-custody format; this change
does not add or claim a cryptographic signature field.

Host and child owners also pass a source-checkpoint digest into their atomic consume
transactions. A parent selection, rights or cancellation change after continuation preparation
conflicts instead of being overwritten. Terminal retention follows retained exact cross-run
selected refs to preserve producer control/gate/receipt/session cohorts; settled unreferenced
cohorts can still be evicted. Immutable artifact objects are not garbage-collected here.

`host-effect-protocol.test.ts` exercises reopened real stores and every new wrapper milestone,
an actual raw-decode adapter with a deterministic subprocess boundary, parent-selection fencing,
service composition and dependency retention. The Comfy video suite drives actual upload/render
adapters through the real owner with local HTTP fixtures. These are protocol tests, not live
decoder, backend, media-playback or production qualification. Domain evidence such as
`VideoEvidenceV1` remains independently validated by its fixed custody module; this generic
result wrapper is not a replacement for that evidence.

## Cancellation, inactivity, and recovery

Cancellation and inactivity expiry describe evidence, not wishes:

- queued or `prepared`: dequeue and terminate with no remote effect;
- `lease_acquired`: release only as proven not accepted;
- `submitting`: acceptance is ambiguous, so quarantine;
- `submitted`: invoke the one registered remote-cancellation observer when available; release only on terminal proof, otherwise quarantine as remote-may-continue;
- `fetched` or later: preserve evidence and settle without claiming that cancellation reversed the remote effect.

Four clocks have separate ownership and meaning:

- queue ownership wait ends at its finite queue-inactivity expiry and does not consume active-operation time;
- after fenced acquisition or adoption, the operation-inactivity lease renews only through accepted adapter activity/progress callbacks and durable work/output milestones;
- backend lease heartbeats preserve fencing but do not by themselves renew operation activity, while adapter transports apply their own connect/read inactivity bounds; and
- cancellation and remote-observation cleanup use bounded grace periods after cancellation begins, not an execution-duration ceiling.

Progress count and scalar metadata remain bounded by registration. A restart begins a fresh active-operation inactivity interval only after exact operation, registration, artifacts, fence, and correlation proof are adopted. Persisted output is accepted only after exact readback, and an ambiguous submission is never automatically retried.

An operator may clear quarantine only by comparing the exact quarantine ID and recording one disposition: inspected empty queue, explicitly drained exact queue snapshot, or specific remote terminal proof. The receipt stores evidence and queue-snapshot digests, not response bodies or full correlation IDs.

## Opt-in capacity accounting

The generic capacity core extends the same state-root catalog at schema **4** with an
immutable host policy, bounded reservation records and cumulative measurement history.
It does not replace the backend lease authority or operation journal, create another
workflow runtime, or grant dispatch. The generic host owner and service now accept an
explicit host-only capacity binding. With no opt-in, existing adapters and backend keys
retain their current behavior; this code does not activate a production deployment.

A concrete project authority verifies the exact operation journal and artifact custody.
The core requires the existing current backend fence, enforces finite global/project
admission, queue and active limits, atomically holds all requested physical-resource
and meter allowances, and preserves protected finishing capacity.
A unique journal-bound kind/adapter/backend-binding/worker tuple determines purpose;
request aliases cannot promote ordinary work to finish authority. Cumulative measurements are idempotent; complete bounded
measurement history must remain canonical, monotonic and exactly selected on read, with a
reserved final-proof slot. Unused allowances settle only against the exact fenced
catalog disposition and final trusted measurements. Quarantined holds never expire
or release merely because the backend quarantine was reset. Capacity records retain
`effect_permission: none`: a hold never replaces registered effect, rights, approval
or qualification authority.

New physical-worker keys are explicitly opt-in and host-selected; they do not silently
change a retained profile or endpoint key. Shared GPU/resource topology and external-job
exclusion are deployment obligations, not proven by a configuration digest. Current
core activity renews only on new durable output milestones (`fetched`, `persisted`, `verified`)
or verified productive pre-fetch evidence, not transport activity or budget readings. The opt-in runtime supports durable
nonterminal queue parking and fresh fenced reacquisition as described below.

`HostOperationCapacityRuntimeBinding` re-derives the exact current demand from the
journal and request bytes on execution, recovery, settlement and consumed replay.
Reservation requires the current pre-submission fence; `requireHeld` is checked at
adapter entry and immediately before the submission guard. Acceptance/recovery fence
adoption preserves allocation and capacity clocks. A missing reservation after submission
refuses rather than reconstructing a hold. The existing use validator still runs first.

### Nonterminal parking and fresh reacquisition

New runtime reservations use the closed `HostCapacityRuntimeRecordV2` wrapper around the
unchanged V1 core. For unavailable capacity, the catalog transaction checks an exact
never-submitted `lease_acquired` journal, live pre-submission fence, queued/unadmitted
capacity record and absence of any terminal disposition. It atomically stores a versioned
parking proof and matching lease event, frees the backend, and removes its backend FIFO row.
Parking is **not release or terminal settlement**. The project journal remains nonterminal;
its old lease identifies proof, not live authority. Original demand, creation/order and both
queue deadlines survive. Admission/queue-limit refusals still settle as no-effect failures.

A parked waiter joins backend FIFO only when a read-only capacity hint permits it; an
unready waiter removes its FIFO entry rather than blocking unrelated work. Fit is rechecked
atomically after fresh acquisition. Current exact demand and the existing use-time validator
are rechecked after the wait and at adapter entry; asynchronous validation remains bounded
by the original queue deadline. The atomic hold requires the current exact pre-submission
fence, and submission still checks the hold immediately before its guard. A lost fit parks
the fresh fence again without starting active capacity clocks. Fresh identity/token, not
global epoch ordering, proves reacquisition: backend epochs may restart after free. Once
admitted, same-owner fence adoption preserves allocation, measured spend and active clocks.

Parked cancellation/timeout uses exact non-submission proof, never acquires after the
boundary, and cannot free another owner. A crash after fresh global acquisition but before
project/capacity adoption resolves only that already-owned pre-submission fence. Missing
proof, drift, guarded/accepted state or stale fences refuse instead of reconstructing a
milestone. Catalog writes are atomic; cross-database crash windows converge from exact
journal/catalog evidence or refuse safely. If demand or another validation fails after fresh
acquisition, compensation checks concrete current journal/artifact custody, the original
canonical never-admitted queued request and durable parking proof, and the exact live
same-operation pre-submission fence. It atomically frees that fresh fence and re-parks against
the original proof, without selecting changed demand, writing a terminal release, refunding
capacity, or renewing order/deadlines. Guarded, submitted, stale and foreign fences, and any
admitted hold, are ineligible. A durable compensation event permits only proof-fence journal
repair after a catalog-commit/project-CAS crash; it cannot free a subsequent owner. Changed-demand
replay can then settle the original no-effect fence without stranding the fresh acquisition.
Legacy V1 queued records retain their prior refusal path; a terminal release is never
reinterpreted as parking.

### Trusted productive pre-fetch evidence

An optional construction-time host source selects one exact immutable artifact from the
concrete project-bound store. The optional adapter callback carries **no progress payload**.
The owner checks canonical bytes, schema, host producer/source binding, project/run,
operation/directive/request/demand, exact fence and remote-target digest. Strictly increasing
source revision and actual completed work, fixed bounded total work and a new observation
time are required. Accepted evidence and trusted cumulative metering commit together, with
a reserved final-measurement slot. Count, units, bytes and representation remain bounded.

Duplicate, empty, polling, heartbeat, spend-only, stale-fence and late observations cannot
renew either capacity or ordinary activity through this callback. Ordinary adapter activity
remains a separate legacy mechanism. Recovery retains the selected proof and clocks; new
work after fence adoption needs new exact-fence evidence, not replayed progress. These are
trusted host-source contracts and provider-free protocol tests, not physical work attestation
or production meter qualification. Trusted in-process sources must be bounded and cooperative;
this seam does not isolate malicious synchronous host code.

Capacity inactivity, optional elapsed/cost caps and cleanup grace remain independent.
Cleanup starts before cancellation observation and uses the shorter applicable grace.
Before parent consumption or replay, admitted release requires exact lease disposition
and final trusted measurements; absent or invalid measurements retain the hold and block
consumption. Ambiguous remote work quarantines capacity without fabricated zero usage.

Service composition reads an already installed immutable policy and creates concrete
project-journal custody; it never installs policy or DDL. Configured capacity applies to
all host operations driven by that owner, with no missing-mapping legacy fallback.
Trusted demand/meter ports are construction-time host dependencies, not model tools or
qualification evidence. Production metering, physical/external-job qualification and
whole capacity acceptance remain incomplete.

Fresh explicit setup creates empty capacity tables, not a policy. Retained catalog v2/v3
upgrades use explicit `upgradePennyCatalog` or the project-upgrade entrypoint and require
an external SQLite backup, validated before DDL under the global write lock. Ordinary runtime/setup refuses incompatible retained schemas.
The project upgrade entrypoint performs this backup-first catalog step before any
project database upgrade; neither step is an automatic runtime migration.

## Separate SCA operator bootstrap

No SCA-specific operator bootstrap is required by this generic boundary. The retired standalone bootstrap is not a setup, authority or qualification path for ordinary SCA.

## Compatibility and schema policy

The directive union is additive. Existing agent, parallel, child, gate, status, cancellation, and deterministic host-continuation paths keep their prior behavior. Existing registration digests remain unchanged when host authority is absent.

Capacity V1 record JSON remains closed and is read/replayed without implicit conversion.
V2 adds parking and productive-proof selection only for newly created runtime reservations;
existing V1 reservations cannot opt into either semantic by replay. Catalog schema stays 4:
its bounded JSON/event columns already admit these versioned payloads, so no new table,
runtime DDL, policy installation or retained upgrade is needed. An older binary that only
understands capacity V1 must refuse V2 records; downgrade is not transparent compatibility.

The project database adds the operation journal through the explicit schema upgrade path. The state-root catalog adds global queue/lease/disposition/reset tables through explicit state setup or upgrade. Ordinary runtime does not infer operation records or mutate incompatible retained state.

## Security and verification map

| Affected invariant         | Control and evidence                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority                  | Registration digest, declaration digest, exact input/output contracts, adapter/request projection checks, runner-only dispatch, and worker refusal tests    |
| Interpreter separation     | Adapters receive typed values and bounded callbacks; no generic command, URL, path, artifact discovery, or model-tool surface is added                      |
| Input/resource boundedness | Closed schemas plus request/input/output/progress, queue/operation inactivity, transport, cleanup, and lease limits; expiry, overflow, and contention tests |
| Identity/state integrity   | Deterministic record identity, canonical-record CAS, lease epochs, fencing tokens, exact artifact custody, and atomic consumption tests                     |
| Fail-closed recovery       | Exact adoption only; changed operands conflict; ambiguous acceptance quarantines; stale fences and uninspected resets refuse                                |
| Evidence-backed completion | Exact operation result, platform result, body-free receipt, lease-disposition receipt, and parent checkpoint transaction                                    |

Relevant checks include the synthetic owner suite, real temporary-store cross-project and independent-process capacity contention, restart/stale-fence/corruption/proof-only settlement and migration-rollback cases, and real engine/owner/service fixtures for use-time refusal, independent clocks, cleanup, exact recovery and settled/consumed replay. Run affected suites before claiming their results; source presence is not a pass. Full orchestration regressions are required for changes affecting existing worker, child, resume or cancellation behavior. Provider-free protocol evidence does not qualify physical deployment, external-job exclusion or production collectors/meters.
