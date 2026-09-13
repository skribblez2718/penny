# Skill Orchestration — TypeScript engine and exact artifacts

## Architecture

Every workflow skill is a registered TypeScript playbook. The playbook owns states,
input selection, happy routing, gap classification, domain bookkeeping, gates, fan-out, and
terminal candidates. The active registration owns ingress, typed start admission, liveness/thinking policy, required
guidance/opening, state/agent/result contracts, model policy, repair routes, and completion criteria. The shared engine owns request validation,
route/budget execution, canonical transitions, checkpoints, artifacts, receipts, positive-terminal
admission, recovery, and observability. Skill directories contain no executable runtime.

## Protocol

1. Closed requests: `start`, `step`, `status`, `recover`, `respond`, `cancel`.
2. Persist control state in the Node SQLite checkpointer keyed by exact `run_id`.
3. Every cognitive directive carries exact input IDs/refs and output metadata.
4. Preflight every input by direct manifest lookup and exact-byte verification; cross-run fan-in is valid.
5. Persist and re-read complete finalized worker bytes before routing fields can advance.
6. Keep payload bytes out of `RunContext`; retain exact selected refs.
7. Require active-registration guidance. Refuse unknown playbook/state/agent bindings before
   input reads or session work. Catalog phases request and activate YAML exactly when their
   registration omits `allowed_tools`. When present, accept only one explicit non-empty,
   duplicate-free strict YAML subset bound into the canonical registration digest and worker
   invocation metadata; validate it before session creation, pass it exactly to Pi, and check
   active equality before the model prompt. Task/trust/input/runtime/model/liveness/service state
   cannot select tools. Host-private matrices remain separate.
8. Use branch IDs—not completion order—for fan-in and partial recovery.
9. Workers and skill drivers receive no workflow-memory transport.
10. Route structurally valid domain gaps with `EvaluationResultV2` plus registered state-aware
    routes. The evaluation carries no target/exhaustion fields; event evidence is digest-only.
11. Keep structural malformed-result correction on the bounded P1.2 path.
12. Route every new positive terminal through the one engine-owned admission helper.
13. Evaluate the closed `CompletionGate` v2 from append-only visits, the exact latest
    product, host-registered receipt predicates, and the unresolved policy. Research's predicate
    resolves the latest core/receipt/render/envelope graph and matching compatibility files. Never use
    `previousState`, model-selected predicates, observability, or memory as admission evidence.
14. Persist visit/admission/refusal and body-free repair-route metadata in the existing checkpoint event transaction.
    A refused positive becomes durable `incomplete/met:false` with candidate artifacts retained.

## Directives

| Action                    | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `invoke_agent`            | One worker assignment with exact inputs and output contract  |
| `invoke_agents_parallel`  | Bounded branch assignments with independent output contracts |
| `await_user`              | Persisted human/clarification gate                           |
| `paused`                  | Retriable owner dispatch stop; checkpoint unchanged          |
| `complete` / `incomplete` | Honest terminal truth plus selected product ref              |
| `cancelled` / `error`     | Typed negative terminal                                      |
| `status`                  | Safe persisted-state projection                              |

## Composition

- Every skill-ingress start validates its closed request and exact typed inputs before
  `RunContext.create`; each input must resolve to exactly one source/kind/schema/version port and
  semantic products require a registered exact-byte validator.
- Single and parallel modes create TypeScript runs directly.
- Chain mode verifies and forwards the prior terminal ID directly across runs.
- `{previous}` names that exact ID; it never carries predecessor payload text.
- Chain steps may add explicit multi-source IDs; schema-v3 checkpoints bind each step's canonical
  contract SHA-256, and resume re-resolves it.
- Legacy checkpoints without an immutable contract digest fail closed on resume.
- Generic chain failure stops with exact refs and `resumable:true`; it adds no retry/skip/diagnose
  approval questionnaire. Genuine playbook clarification still uses `await_user`.

## Active generic-child authority and storage boundary

`playbooks/registry.ts` carries the active **runtime authority projection** for exactly the six
operator-authorized ordinary workflows: `assess`, `decide`, `diagnose`, `plan`, `produce`, and
`research`. Every one is both a depth-one parent and provider for the same all-six target set. The
parent declaration fixes one call, one active child, and project concurrency one without predicting
per-call turns, tools, output size, steps, elapsed time, aggregate capacity, or a sealing reserve. The
provider declaration binds its native request validator/port, input and single terminal output ports,
expected child output, and every registered phase's agent, result
schema, tool carrier, and existing browser-network allowlist. A subset-absent carrier records its
exact YAML maximum snapshot and registration validation re-reads the catalog to refuse drift. All of
this participates in the active registration digest. Missing declarations, unknown workflows, and the
dedicated/private `knowledge-base` registration deny.

The projection authorizes active depth-one child dispatch. `OrchestrationService` constructs the
child owner by default; a host can explicitly disable it with `enableChildWorkflows: false`, which
returns the typed owner-unavailable refusal. The owner revalidates registration and canonical
request authority, reserves an exact child run, drives the registered child engine/runner, validates
its terminal core, persists a `child-result` artifact, and atomically records the parent continuation
with `consumed`. `WorkerExecutor` still rejects child directives itself; `OrchestrationRunner`
delegates them only to the state owner. The path enforces fixed call/active/project admission,
uses the child playbook's existing repair/liveness policy plus the service-wide step backstop, and
forwards cancellation from the runner signal or a concurrent durable parent-cancel request. It does
not impose a guessed child-specific turn, tool, output-byte, step, time, aggregate, or reserve budget.

New calls use schema-v3 directives and durable V2 call records. Their child-execution lease is
content-free and host-selected from the digest-bound liveness registry. Fenced, monotonic
host-observed worker activity and workflow convergence renew one inactivity interval; empty/stale
signals refuse, activity does not manufacture convergence, and expiry aborts the child. Legacy V1
records remain replayable but are not minted. Provider qualification remains separate: Gate 2 is
`not_run` with no evidence, so execution alone neither promotes nor externally discovers a provider.

Active schema-v3 directives and V2 call records intentionally contain no guessed resource
allocation. Their digest-bound, content-free inactivity lease detects silence from host-observed
activity; it is a liveness control, not a prediction of how much useful work a child should need.
Historical schema-v2 directives and V1 rows retain their exact fixed allocations solely for replay.

`ChildWorkflowStateOwner` remains the storage/custody boundary. It accepts one concrete,
project-bound `ArtifactStore`; the checkpointer rechecks that store against its project binding and
verifies the canonical child request plus every bound input by exact manifest ref, length, digest,
and object bytes before mutation. Exact retry adopts; changed operands or missing/mismatched linkage
fail closed. The current active path does **not** project child user gates, reconcile arbitrary
post-crash child terminals, retain whole artifact/receipt/session
cohorts, promote providers, or establish live qualification.

## Deterministic host continuation

Host-only states begin only after accepted worker bytes and execution receipts are durable. They use
existing selected artifact refs plus append-only checkpoint events, never payload fields or a new
state table. Research `sealing_core` creates immutable core revisions; `rendering` persists stable
intent/time, render artifacts, latest-core receipts/envelope, and atomic/fsync compatibility files.
A crash leaves either an adoptable immutable artifact, matching final file, or the prior checkpoint;
explicit recovery converges before terminal admission.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new dispatch before selected refs or
pending state can change. `active` recovery reissues the exact pending directive or next
compatible revision. Post-v2 positive terminals replay only after their exact envelope,
terminal digest, visit refs, product, and evidence refs verify. Pre-v2 positives without an
envelope remain exact legacy replays and are never backfilled. Compaction reads caller-supplied
run IDs from the TypeScript v2 database; it never scans sessions or semantic memory.

## Safety

- Reissued states must be idempotent or split prepare/apply.
- Repair routes and exhaustion successors are registered, bounded, and engine-executed; playbooks cannot select them.
- Verifiers require captured evidence where the contract declares it.
- Model diversity is supplementary review, not independent proof.
- Worker context/tool boundaries, including an `artifact_read`-only phase subset, are not
  OS/process sandboxing and do not isolate extension code.

## Verification

- [ ] Playbook is registered and its contract validates.
- [ ] Wrong-run, wrong-state, stale, and malformed refs fail closed.
- [ ] Owner capture and receipt verification precede routing.
- [ ] Single, parallel, chain, resume, clarification, and crash recovery are covered.
- [ ] Compaction reconstructs TypeScript run/artifact refs by exact ID.
- [ ] Payload bytes and durable memory never enter checkpoint control state.
- [ ] Direct paths and subset-absent ordinary phases prove exact YAML equality.
      Registration-bound synthetic strict subsets, exact Pi handoff, invalid pre-session refusal,
      and separate host-private tools remain covered.
- [ ] Flow descriptor and `resources/flow.html` agree exactly.

## Files

| File                                       | Purpose                          |
| ------------------------------------------ | -------------------------------- |
| `apps/orchestration/src/engine.ts`         | Shared protocol and admission    |
| `apps/orchestration/src/service.ts`        | In-process host                  |
| `apps/orchestration/src/checkpointer.ts`   | Durable state                    |
| `apps/orchestration/src/artifact-store.ts` | Immutable artifact owner         |
| `apps/orchestration/src/playbooks/*.ts`    | Registered playbooks             |
| `.pi/extensions/skill/README.md`           | Skill composition and invocation |
