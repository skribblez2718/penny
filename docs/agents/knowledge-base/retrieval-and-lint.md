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

A complete query produces exactly one `query_answer` artifact handle. By default the parent receives
that path-free handle and nothing else.

A derived answer reaches the parent tool result **only** when all of the following hold: the host
supplied an exact, unexpired, single-use delivery grant matching the session, invocation, action,
profile, request digest, and byte bound; the parent model matches the policy allowlist; and policy
explicitly permits a derived answer. Missing any condition returns a refusal — it never silently
downgrades or returns partial content.

Even an approved derived answer contains only the derived text, citations by opaque ID,
authority and uncertainty, and a canonical-verification reminder. Raw source, page, claim, report,
and patch bodies never return.

An answer with no supported citation completes as `met: false` with the evidence gap stated in
`unknowns`. It is not parent-deliverable as a met answer. **An honest "the sources do not support
an answer" is a correct outcome, not a failure to be papered over.**

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

| Plane | Paths | `query` / `lint` |
|---|---|---|
| **Publication** | `sources/objects`, `sources/records`, `pages`, `conflicts`, `.kb/generations`, `.kb/current.json`, `index.md` | **Must not change** |
| **Control** | Orchestration control DB: run, state, safe handles, bounded failure metadata | Allowed |
| **Same-run work** | That run's bounded artifacts under `work/<run_id>/` | Allowed |
| **Receipt** | Append-only content-free receipts under the trusted ignored receipt root | Allowed |

The oracle enforcing this snapshots path existence, type, and bytes recursively across exactly the
publication plane, before and after **successful, refused, failed, and resumed** runs. Every
snapshot must be identical. A separate assertion permits deltas only in the control DB, that run's
private input directory, `work/<run_id>/`, and that run's append-only receipt directory — an
unexpected root fails the test.

Testing the whole filesystem for byte-equality would fail on a legitimate control write; testing
nothing would miss a real leak. Asserting per-plane is what makes the guarantee both true and
checkable.
