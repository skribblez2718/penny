# Retrieval and Lint

## Reading one generation

Retrieval starts from one validated `.kb/current.json`, reads only that generation's immutable
catalog and index, and never combines a directory scan with a different generation. Candidates are
ranked by descending deterministic score, ties broken by UTF-8 bytewise `(page_id, revision_id)`,
with one candidate per revision. Determinism is the point: the same corpus and query produce the
same ranking, so a retrieval regression is measurable rather than anecdotal.

Search is closed over the validated request. The child's search tool takes **no query field** — it
uses the admitted query, filters, and candidate bound already validated by the host, and returns at
most that bound. A child cannot widen its own retrieval scope.

v1 retrieval is deterministic lexical/FTS plus bounded reranking. Semantic retrieval is a measured
future decision, not a v1 promise: a later generation-selected index provider can be added without
changing page, source, capability, or action contracts, but no vector service is introduced
speculatively.

## Query results

A complete query produces exactly one `query_answer` artifact handle. This section owns query delivery for both operators and host implementations.

`answer_delivery` is a closed field with exactly one bounded parent-facing outcome per outcome class:

- **`artifact_ref`** (default) — the result carries the answer artifact handle only. The tool
  result itself never carries derived content.
- **`parent_tool_result`** — the result may carry one bounded derived answer, and only when the
  policy permits it and exactly one host-minted grant matches.

The grant rule is closed and fails closed. A parent-delivery grant is owner-only and binds one
exact Pi session, host tool invocation ID, action, profile, closed-request digest, current policy digest,
and runtime-reported parent provider/model, with a single-use byte cap and expiry. The host grant
authority enforces one issuance per session/invocation transactionally; a byte-identical retry of
the same grant ID is idempotent, while a competing issuance loses before delivery can become
ambiguous. The delivered run consumes the grant atomically; an exact run retry observes the same
consumption but never redelivers, and another run loses. A grant refused for any other reason
(policy/model drift, byte cap, malformed answer, mismatch) is retained in its original state.

The grant is not the only condition. Delivery re-hashes the current policy and requires both the
grant's exact provider/model binding and an **exact parent allowlist match**: the provider and model
the runtime reports for the active parent context must appear in `allowed_parent_models`, and under
`local_only` the matched rule must itself declare `locality: "local"`. The host never guesses
locality. An empty allowlist, policy drift, or an identity the host cannot establish denies.

Delivery also requires the answer to be what the request asked for. `verify_grounding` defaults
true: deterministic retrieval binds one selected generation and candidate set, Synthia synthesizes
through the no-argument private-request and selected-generation readers, and Vera independently
checks every answer citation through the same closed page/source posture. The host requires exact
citation/finding equality, all findings supported, a passing report, and a durably created save
claim before the run can be `complete`/`met:true` or parent-deliverable. A request flag or boolean
report by itself has no authority.

An explicit `verify_grounding: false` request retains the deterministic answer path, records
`grounding_not_verified`, creates no save claim, and is not parent-deliverable. `page_ids` and
`source_ids` are honored as retrieval filters (page set, and pages whose claim evidence cites an
allowed source).

The delivered answer is closed: advisory-only, non-empty text, one or more opaque
page/claim/source citations (never locators), a contradictions array, an unknowns array, and
`canonical_verification_required: true`. It may never present itself as canonical current state,
and no raw source, page, claim, report, or patch body may ever appear in the tool result.

On any miss the parent sees its safe handle result plus exactly one bounded warning code,
`refused_parent_delivery` — never the answer, the diagnostic reason, or grant internals. The host
logs a bounded reason for the operator (missing/mismatched/expired/consumed/ambiguous grant,
policy denial, byte-cap miss, malformed answer) and never returns one to the model.

The decision core and its fail-closed behavior live in the KB modules of the orchestration app
(`kb/parent-delivery`; the adapter only builds the closed request and surfaces the decision), and
the shape, sealed-answer extraction, and every refusal reason are pinned by the
`test:kb-answer-quality` suite alongside the parent-delivery suite.

An answer with no supported citation completes as `met: false` with the evidence gap stated in `unknowns`. It is not parent-deliverable as a met answer. An honest "the sources do not support an answer" is a correct outcome, not a failure to conceal.

## Lint

Lint is **deterministic-first**. The deterministic floor runs before any semantic work, and
malformed structure blocks semantic work entirely — there is no point asking a model to reason
about a corpus whose hashes do not verify.

The deterministic floor catches malformed schemas, hashes, IDs and references; missing page/claims
pairs; structurally unresolved claim references; orphaned objects, records, and pages; stale
selector, catalog, or index; publication-transaction debris; invalid current policy schema or KB
identity; policy-digest drift on a nonterminal run (while correctly treating catalog policy hashes
as historical); and tracked leaks.

Semantic lint is advisory review: unsupported-claim judgments and candidate conflicts, cited. It
proposes; it never repairs, publishes, or promotes.

### Candidate conflicts are not conflict records

A standalone lint reports **candidate** conflicts inside its report artifact. These are not
`ConflictRecordV1` values and they never carry forward into publication on their own.

A candidate becomes a published conflict record only inside an `ingest` or `save` content-review
packet, where the host deterministically converts **all and only** the lint candidates — sorted by
candidate ID — into preallocated conflict records, binding each candidate ID to its final ID and
digest. Approve publishes all of them; refine creates a fresh packet and allocation set; deny
publishes none. This is what stops advisory observations from quietly becoming stored facts.

## The no-write rule, by plane

For `query` and `lint`, "no-write" means **no publication and no KB content publication**. It does
not mean a byte-frozen filesystem. Conflating the two produces tests that either fail spuriously or
pass vacuously, so the planes are separated explicitly:

| Plane             | Paths                                                                                                         | `query` / `lint`    |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Publication**   | `sources/objects`, `sources/records`, `pages`, `conflicts`, `.kb/generations`, `.kb/current.json`, `index.md` | **Must not change** |
| **Control**       | Orchestration control DB: run, state, safe handles, bounded failure metadata                                  | Allowed             |
| **Same-run work** | That run's bounded artifacts under `work/<run_id>/`                                                           | Allowed             |
| **Receipt**       | Append-only content-free receipts under the trusted ignored receipt root                                      | Allowed             |

The oracle enforcing this snapshots path existence, type, and bytes recursively across exactly the
publication plane, before and after **successful, refused, failed, and resumed** runs. Every
snapshot must be identical. A separate assertion permits deltas only in the control DB, that run's
private input directory, `work/<run_id>/`, and that run's append-only receipt directory — an
unexpected root fails the test.

Testing the whole filesystem for byte-equality would fail on a legitimate control write; testing
nothing would miss a real leak. Asserting per-plane is what makes the guarantee both true and
checkable.
