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
single-use semantics. Children receive private readers scoped to admitted source or prior
phase IDs; they never receive filesystem paths, capability stores, policy files, selectors,
or apply credentials. Model identity is admitted before a child session starts.

## Workflows

### Ingest

`ingest → compose → lint → verify → awaiting_review → publishing → complete`

The review gate can approve, refine, or deny. Refine returns to the producer under a bounded
repair budget. Only host publication can replace the selected generation.

### Save

Save claims one exact query answer, enters at `compose`, and uses the same lint/verify/gate
publication path. Claims prevent duplicate concurrent saves and are returned on denial.

### Query

Query is a read-only selected-generation operation. Deterministic ranking and safe projections
return evidence without mutating KB state.

### Promote preparation

`plan → patch → awaiting_review`

The host independently re-resolves targets, checks capability operation/kind, captures current
preimage digests, and verifies named page revisions against the selected generation. Failure is
a bounded `verified:false` finding. The public path has no publishing edge and cannot apply.

## Prompt and flow contracts

Cognitive prompts are exactly:

- `echo-ingest.md`
- `synthia-compose.md`
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
