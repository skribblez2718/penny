# Knowledge Base Reference

## Runtime

`KnowledgeBasePlaybook` is registered in the sole TypeScript orchestration engine. The
`knowledge_base` Pi tool is a thin host adapter over closed workflows and private content
planes. No executable skill delegate exists.

## Records and generations

- Immutable source objects and page revisions are content-addressed/private.
- A generation selects exact page/source/conflict records.
- The selector is the authority; generated indexes are conveniences.
- Publication is additive and compares the expected base generation under lock.
- Crash recovery decides from durable transaction state, selector, and hashes—not timestamps.

## Capabilities and policy

Capabilities are opaque host-minted IDs with bounded operations, targets, expiry, and
single-use semantics. Complete envelopes and leases remain in the owner-only host SQLite store,
never in the KB tree. Source admission allocates independent opaque source IDs and immutable
same-run snapshots before child work; every child/refinement/review source read uses those snapshots.
Children receive private readers scoped to admitted source or prior phase IDs; they never receive
filesystem paths, capability stores, policy files, selectors, or apply credentials. Source
objects/records publish only after content approval. Model identity is admitted before a child
session starts.

## Workflows

### Ingest

`ingest → compose → lint → verify → awaiting_review → publishing → complete`

The review gate can approve, refine, or deny. Refine returns to the producer under a bounded
repair budget. Only host publication can replace the selected generation.

### Save

Save claims one exact query answer, enters at `compose`, and uses the same lint/verify/gate
publication path. Claims prevent duplicate concurrent saves and are returned on denial.

### Query

Query never mutates the publication plane. `verify_grounding` defaults true: deterministic ranking
binds one selected generation and candidate set, Synthia produces a cited `query_answer`, and Vera
produces a closed finding for every citation. The host admits `complete/met:true` claim/delivery
authority only when citations belong to that bound set, every finding is supported, the report
passes, and the save claim is durably created. Explicit `verify_grounding:false` remains
deterministic, carries `grounding_not_verified`, and creates no save or parent-delivery authority.

### Promote preparation and host-only apply

`plan → patch → awaiting_review` (public prepare machine)

The host independently re-resolves targets, checks capability operation/kind, captures current
preimage digests, and verifies named page revisions against the selected generation. Failure is
a bounded `verified:false` finding. The public path has no publishing edge and cannot apply.

Before `awaiting_review`, the exact target-presentation packet is durable in the approval DB.
Authenticated host decisions create one exact approve/refine/deny intent. Approve signs a strict
JCS receipt with HMAC-SHA-256 and an active raw 32-byte key; the private apply resume captures and
fsyncs all preimages, atomically reserves receipt + complete target set under the host mutex,
performs same-directory fsync/rename writes, verifies all postimages, and finalizes approval DB →
capability store → control DB. Owned failure restores in reverse order; a third-party byte state is
never overwritten and ends `blocked_external_drift`. Apply never commits or pushes.

## Prompt and flow contracts

Cognitive prompts are exactly:

- `echo-ingest.md`
- `synthia-compose.md`
- `synthia-query.md`
- `carren-lint.md`
- `vera-verify.md`
- `piper-plan.md`
- `skribble-patch.md`

`prompt-guidance-contract.test.ts` compares this complete surface with `KB_FLOW`.
`flow-diagrams.test.ts` compares `KB_FLOW` with `resources/flow.html` in both directions.

## Terminal truth

Positive publication terminals require host receipts and completion-gate admission. Denial,
invalid capability, drift, exhausted repair, or failed verification remain explicit negative or
unresolved outcomes; no child verdict becomes authority.
