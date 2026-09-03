# Skill Orchestration — TypeScript engine and exact artifacts

## Architecture

Every workflow skill is a registered TypeScript playbook. The playbook owns states,
input selection, happy routing, gap classification, domain bookkeeping, gates, fan-out, and
terminal candidates. The active registration owns ingress, typed start admission, liveness/thinking policy, required
guidance/opening, state/agent/result contracts, model policy, repair routes, release status, and
completion criteria. The shared engine owns request validation,
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
- Chain steps may add explicit multi-source IDs; schema-v2 checkpoints bind each step's
  `release_status` and canonical contract SHA-256, and resume re-resolves both.
- Schema-v1 checkpoints remain readable for production registrations only.
- Generic chain failure stops with exact refs and `resumable:true`; it adds no retry/skip/diagnose
  approval questionnaire. Genuine playbook clarification still uses `await_user`.

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
- [ ] Direct paths and subset-absent phases—including every ordinary candidate phase—prove exact
      YAML equality. Registration-bound synthetic/evaluation strict subsets, exact Pi handoff,
      invalid pre-session refusal, and separate host-private tools remain covered.
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
