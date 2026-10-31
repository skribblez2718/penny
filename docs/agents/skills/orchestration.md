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
4. Apply [Invocation](../agents/invocation.md) for input preflight and complete reads.
5. Apply its exact final-text capture, readback-before-SUMMARY, fan-in, and failure semantics.
6. Keep payload bytes out of `RunContext`; retain exact selected refs.
7. Require active-registration guidance; reject unknown playbook/state/agent bindings before input
   reads or session work. Apply the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule),
   including the guarded zero-tool exception's registered exact model, admitted payload/disclosure,
   and final-opening authorization. Profiles own static maxima; host-private matrices remain separate.
8. Use branch IDs—not completion order—for fan-in and partial recovery.
9. Workers and skill drivers receive no workflow-memory transport.
10. Route structurally valid domain gaps with `EvaluationResult` plus registered state-aware
    routes. The evaluation carries no target/exhaustion fields; event evidence is digest-only.
11. Keep structural malformed-result correction on the separate P1.2 path.
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
- For Define-revise and Plan, V2 invocations explicitly select `reviewed_definition` or `semantic_only` for a supplied `SpecificationV1`; V1 maps to semantic-only. Without a specification, the result is `not_applicable`. Strict admission checks the completed, trace-capable Define producer and exact owner graph **before** consumer creation; missing or unsupported proof refuses, never downgrades. Semantic-only checks canonical bytes, not producer completion or reviewed ancestry. The assurance artifact binds the consumer policy and current review/completion graph; `{previous}` stays the exact semantic core ID. The check covers immediate revision closure, not full ancestry or the ongoing availability of original external sources.
- Generic chain failure stops with exact refs and `resumable:true`; it adds no retry/skip/diagnose
  approval questionnaire. Genuine playbook clarification still uses `await_user`.

## Active generic-child authority and storage boundary

`playbooks/registry.ts` carries the active **runtime authority projection** for exactly the seven
operator-authorized ordinary workflows: `assess`, `decide`, `define`, `diagnose`, `plan`, `produce`,
and `research`. Every one is both a depth-one parent and provider for the same all-seven target set. The
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
uses the child playbook's existing repair/liveness policy plus any operator-supplied service-wide step limit, and
forwards cancellation from the runner signal or a concurrent durable parent-cancel request. It does
not impose a guessed child-specific turn, tool, output-byte, step, time, aggregate, or reserve budget.

New calls use schema-v3 directives and durable V2 call records. Their child-execution lease is
content-free and host-selected from the digest-bound liveness registry. Fenced, monotonic
host-observed worker activity and workflow convergence renew one inactivity interval; empty/stale
signals refuse, activity does not manufacture convergence, and expiry aborts the child. Legacy V1
records remain replayable but are not minted. Provider qualification remains separate: Gate 2 is
`not_run` with no evidence, so execution alone neither promotes nor externally discovers a provider.

`ChildWorkflowStateOwner` remains the storage/custody boundary. It accepts one concrete,
project-bound `ArtifactStore`; the checkpointer rechecks that store against its project binding and
verifies the canonical child request plus every bound input by exact manifest ref, length, digest,
and object bytes before mutation. Exact retry adopts; changed operands or missing/mismatched linkage
fail closed. Child user gates now use a versioned parent-owned projection and exact mediated reply;
waiting and captured-terminal recovery preserve frozen registration/operand bindings. Parent
cancellation fences consumption even between preparation and commit. Linked control/receipt/session
cohorts stay together through retention, including consumed-but-quarantined host effects; immutable
artifact bytes are preserved rather than garbage-collected.

Imagegen reuse is a separate opt-in `imagegen_child` registration policy plus concrete host asset
and runtime owners, not an eighth ordinary peer or a larger ordinary call allowance. It permits
only explicitly scoped serial asset calls and rechecks current G1/rights and native dual-review
lineage at import. See the [engine protocol](../orchestration/overview.md) for exact projected-response,
activation and recovery boundaries. Neither this support nor provider-free tests promote a provider,
activate videogen, qualify a deployment, or finish the proposed host request/intent/wrapper protocol.

## Deterministic host continuation

Host-only states begin only after accepted worker bytes and execution receipts are durable. They use
existing selected artifact refs plus append-only checkpoint events, never payload fields or a new
state table. Each new seal product or diagnostic is addressed by its exact draft, epoch and policy in a separate version-1 operation; artifact version is not a run-global attempt counter. Persist/read/adopt at that address before checkpointing, and fail closed on conflict. A successful seal opens the next same-run product epoch; seal-correction allowances derive from actual operator policy, not skill-wide finite defaults. Seal correction, engine semantic review repair, and routing-only malformed-result repair are independent. Research `sealing_core` creates immutable core products; `rendering` persists stable
intent/time, render artifacts, latest-core receipts/envelope, and atomic/fsync compatibility files.
A crash leaves either an adoptable immutable artifact, matching final file, or the prior checkpoint;
explicit recovery converges before terminal admission.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new dispatch before selected refs or
pending state can change. `active` recovery reissues the exact pending directive or next
compatible revision. Post-v2 positive terminals replay only after their exact envelope,
terminal digest, visit refs, product, and evidence refs verify. Pre-v2 positives without an
envelope remain exact legacy replays and are never backfilled. Compaction reads caller-supplied
run IDs from the catalog-bound unversioned orchestration database (schema-v2 `RunContext` rows);
it never scans sessions or semantic memory.

## Safety

- Reissued states must be idempotent or split prepare/apply.
- Repair routes and exhaustion successors are registered and engine-executed under actual operator policy; playbooks cannot select them.
- Verifiers require captured evidence where the contract declares it.
- Model diversity is supplementary review, not independent proof.
- Worker context/tool boundaries, including an `artifact_read`-only phase subset, are not
  OS/process sandboxing and do not isolate extension code.

## Verification

Apply [Testing](testing.md#required-coverage) for shared-runtime and skill-specific evidence.
The [engine feature-status table](../orchestration/overview.md#child-workflow-feature-status)
separates implemented custody, gates/recovery/retention and active dispatch from qualification.
Keep exact refs through composition, compaction, and recovery; flow drift, wrong-identity refusal,
and worker tool boundaries need their own applicable evidence.

## Files

| File                                       | Purpose                          |
| ------------------------------------------ | -------------------------------- |
| `apps/orchestration/src/engine.ts`         | Shared protocol and admission    |
| `apps/orchestration/src/service.ts`        | In-process host                  |
| `apps/orchestration/src/checkpointer.ts`   | Durable state                    |
| `apps/orchestration/src/artifact-store.ts` | Immutable artifact owner         |
| `apps/orchestration/src/playbooks/*.ts`    | Registered playbooks             |
| `.pi/extensions/skill/README.md`           | Skill composition and invocation |
