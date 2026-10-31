# KB Host Workflows

Every public call is a **request**, never an authority grant. The host validates a closed schema,
resolves authority itself, and returns a bounded safe result.

## Public contract boundary

[Operator Entry](overview.md#requests-results-and-retries) owns public request/result semantics and safe retry behavior. This guide owns host implementation ordering; it does not add public actions or approval authority.

## Idempotency and durable identity

A start action digests its validated request and, in **one control-DB transaction** before any
capability claim, private read, child session, filesystem write, or receipt append, inserts the run
record, the idempotency record, a reserved operation event group, and a private-input record. The
request bytes — query, title, filters — are then written to an ignored, owner-only, mode-`0600`
control-plane file so they survive restart. They are never returned or logged, and they never live
in the KB root or the control database.

The same session and invocation with the same digest returns the original run and its exact stored
replay projection, with no second side effect. The same pair with a _different_ digest is a
mismatch and is refused. A previously delivered derived answer is never persisted and never
redelivered; a new derived delivery needs a new invocation and a new grant.

Private-input materialization, recovery, reads, rename, unlink, and parent-directory fsync are
anchored to pinned owner-only `O_NOFOLLOW` directory descriptors. Immediately before every
mutating filesystem step, the host rechecks that the indexed pathname still names the pinned
`dev`/`ino`; a run-directory rename or symlink substitution therefore refuses without writing or
deleting through the replacement. The implementation never treats an earlier pathname check as
authority for a later pathname operation. Settlement removes and fsyncs the exact indexed files
but retains the empty owner-only run directory as a custody tombstone, because Node exposes no
inode-conditioned directory-removal primitive that could safely remove its name after closing the
pinned descriptor.

## The six flows

- **`init`** — validate profile and create authority → admit an existing empty or exact-scaffold
  root → stage manifest, default-deny policy, layout, first empty catalog and index → commit the
  selector → receipt. This is the only base-none transaction.
- **`ingest`** — profile, policy, and source capabilities → immutable same-run source snapshots →
  Echo extracts claims → Synthia composes a page revision pair → deterministic lint → Carren
  semantic report → Vera grounding check → **human content-review gate** → publish source
  objects/records and a generation.
- **`query`** — read one selected generation → deterministic bounded retrieval → optional synthesis
  and grounding → a same-run answer artifact handle. No publication-plane change.
- **`save`** — an explicit prior query run → Synthia composes → deterministic, semantic, and
  grounding checks → **human content-review gate** → publish a generation. A useful query does not
  authorize a save; the save must claim that exact query run.

### The save claim

What authorizes a save is not the request but a **single-use claim** over one query run's sealed
answer. Only a `complete`/`met:true` grounded query whose citations are supported by a passing
same-run Vera report creates exactly one claim, and the claim ratchets one way:

```text
  available ──claim──> claimed ──reserve──> commit_reserved ──selector──> consumed
      ^                   │                        │
      └──deny/abort───────┘                        └──pre-selector abort──> invalidated
       (only while the sealed answer is still valid)
```

- After generic start admission and private-request materialization above, the host loads the existing claim and re-reads the sealed answer to validate its current digest, then attempts the single-use claim. Only a successful claim permits composition, consumer use of the answer, or content writes. A drifted, consumed, cross-profile, or concurrently claimed answer stops before those operations, not before the digest-validation read. This does not move claiming ahead of the control-DB admission transaction.
- The claim binds the answer's digest. If the sealed answer is not the one the claim was minted
  over, the claim is invalidated rather than published.
- `commit_reserved` is the point of no return: it can never return to `available` and never
  transfers to another save run. A publish that fails after reservation invalidates, because the
  host cannot prove from outside whether the selector moved — and re-saving a possibly published
  answer is worse than refusing a legitimate retry.
- **Refine retains** the claim; **deny releases** it back to `available` while the sealed answer is
  still valid, so the operator may compose a different page from the same query.

A save composes from that claimed answer instead of extracting from sources: it enters the machine
at `compose`, reads the sealed answer as its one allowed prior-run artifact, and admits no new
sources. Publication carries the KB's existing pages and sources forward, so a save adds a page
rather than replacing the knowledge base.

- **`lint`** — deterministic first; malformed structure blocks semantic work. Reports findings and
  **candidate** conflicts only. Publishes nothing.
- **`promote`** — prepare and verify only. See [Privacy and Promotion](privacy-and-promotion.md).

`status` and `resume` are profile-safe control operations that expose no root and no body.

## Query delivery

[Retrieval and Lint](retrieval-and-lint.md#query-results) owns the complete delivery contract: artifact-default results, exact single-use host grants, current-policy and runtime-identity checks, same-run grounding/save-claim admission, and safe refusal projection. Host implementations must apply that contract; request flags and child reports never grant delivery authority.

## Execution architecture (TypeScript path)

The agent-driven flows run on the orchestration engine, not on standalone workflow calls: the
`knowledge_base` tool starts an engine run named `knowledge-base`, and the KB playbook drives the
state machine — `initialize` preindexes independent opaque source IDs and exact temp/final keys,
claims the source capabilities all-or-none, and streams each external file once into an immutable
same-run snapshot before any agent read. The ingest phases (echo → synthia → carren → vera) then
produce typed artifacts on the run's content plane, and the run stops at the human
content-review gate (`await_user`).

The gate decision enters through the **authenticated host content-review service**.
`penny-kb-gate approve|deny|refine` is one local-OS-authenticated caller of that facade; it is not
the decision store. Before `await_user` becomes durable, the checkpointer stores the complete
canonical packet and atomically binds it to the run's generic gate in the orchestration control DB.
The callback constructs a complete receipt by copying the exact run, session, challenge, profile,
KB, action, base selector/generation, policy, query claim (for save), artifact/source maps, and
conflict allocations from those stored bytes. One control-DB transaction stores the exact receipt
JCS/digest and changes the run/gate binding. Only a byte-identical receipt digest is an idempotent
duplicate; another receipt is a conflict.

The service then invokes the private internal content-review resume. Approve publishes, deny
publishes nothing, and refine re-enters compose and requires a fresh packet/challenge after
re-linting and re-verification. A crash after the decision transaction but before internal resume is
reconciled from the stored receipt; generic engine `respond` is refused for ingest/save, and the
model-facing tool remains decision-free. It only starts runs, re-presents the pending gate, and
returns safe projections (counts and opaque IDs, never bodies, paths, challenges, or digests).

A default-true query uses the same engine and worker seams for Synthia → Vera, but terminates
without a publication gate. Its private request, selected pages, and sources are available only
through host-closed readers; the control state carries only counts, opaque IDs, handles, and the
selected-generation binding. Explicitly unverified queries remain deterministic and spawn no
child session.

The deterministic host I/O the playbook performs between phases (preindex/claim/snapshot,
verify admission, seal, query finalization, persist the gate, approve, deny) is behind one
interface — the KB ingest plane — so the state machine stays
testable without a filesystem and the KB's privacy rules stay in the KB modules. The agent runner
is injectable behind the worker client, which is what lets the full pipeline be tested with
deterministic bodies and no model.

The pure workflow functions (`initKb`, `ingestKb`, `queryKb`, …) remain the shared canonical
machines: the plane's approval path publishes through them, and deterministic surfaces (`init`,
`status`, the gate CLI's listings) call them directly without an engine run.

## The content plane and child tools

Private bodies stay in the host-owned content plane. A child role never receives a filesystem path
and never has a generic write tool.

**Input** reaches a child only through host-closed readers, each bound to the run, state, session,
profile, policy, selected generation, and an exact host-issued allowlist: read the phase brief, read
an admitted source snapshot, read an allowed prior run artifact, search the selected generation,
read an allowed selected page, and read a claimed canonical target. No reader accepts a path, root,
locator, arbitrary query, or provider field. No private body is embedded in a system prompt or
opening message.

Before `compose`, the host freezes a body-free identity allocation in the control DB. It binds the
run, phase, session, profile, KB, exact base generation/catalog, private-input digest, admitted
policy, prior handles, source bounds, and all-and-only page/revision/claim IDs. A null supersede
bound means the allocated page ID is new; a non-null bound names the exact selected page revision
that may be replaced. Save has exactly one page allocation. The pool is exposed only by the
no-argument private phase brief. Draft staging and publication conversion both reject invented,
duplicate, omitted, or out-of-bound identities and supersede attempts.

**Output** leaves a child only through `stage_run_artifact`, which is closed over the current run,
state, allowed kinds, profile, and resolved root. The model submits a closed JSON payload — never a
path, run, state, or profile field. The host strict-parses it, rejects duplicate and unknown keys,
validates it, canonicalizes to JCS, applies policy byte and count limits, allocates the ID and keys
itself, records a durable `prepared` row _before_ writing bytes, writes a mode-`0600` no-follow
temporary file, fsyncs, atomically renames, then marks the row `staged` and returns a path-free
handle.

The phase then makes **exactly one** `submit_phase_result` call with a typed, state-specific result
referencing only handles issued to that run and state. The same control-DB transaction stores the
content-free result, seals its artifact, and closes the frozen operands; restart can replay the
result but no session can reuse the allocation pool. It then terminates and closes the session.
There is **no prose `SUMMARY` parser** — assistant text is never a result.

Artifact lifecycle is `prepared → staged → sealed → consumed`, with `discarding → discarded` for
cleanup. Recovery uses only the exact index row and keys: a `prepared` row with no file is
discarded and the phase retried; matching bytes resume the rename; a type, link, hash, or length
mismatch blocks. No directory scan and no adoption of a found file is ever permitted.

Sessions are purpose-built: an in-memory session and settings manager, explicit model selection, all
builtin tools off, and exactly the custom tools for that phase — listed by name, because SDK
filtering would otherwise remove custom tools. No project or global extension, skill, prompt,
setting, or `AGENTS.md` content discovered around the working directory reaches a child.

## Current callback/recovery boundary

The content-review **control-DB** boundary is implemented: packet + waiting-run insertion,
complete decision receipt custody, duplicate-digest enforcement, decision/run/gate transition,
expiry/base/policy/artifact/source/query revalidation, and restart after a committed callback all
use the owner-only FULL-synchronous orchestration database. Ingest and save use this path; the old
KB-root JSON gate is not content-review authority.

Promotion uses the separate approval-DB-first G9 boundary. The complete target-presentation packet
is stored in the approval DB before the control run can become `awaiting_user`. The host records an
exact approve/refine/deny intent; approve creates a signed single-use receipt and private internal
resume applies through the journal, while refine returns to plan/patch with the same claims and deny
invalidates them. Public `respond` and ordinary `resume` remain decision-free. Restart classifies
targets by preimage/postimage hashes and performs only same-transaction resume, restore, safe block,
or cross-store finalization.

The §5.10 publication transaction is implemented for `init`, approved ingest, and approved save.
The control DB preindexes the exact all-and-only file manifest and selector JCS before publication
I/O, binds it to the reviewed base plus profile/root/KB identity, and records the authority
reservations and selector evidence under one transaction ID. Publication reopens and hashes every
catalog-mapped file through owner/no-follow/single-link custody immediately before the commit.
Therefore a process death after selector replacement is classified as same-transaction success and
is finalize-only; a foreign selector is drift and is never adopted or overwritten.

## Publication and recovery contract

Candidate preparation and human review happen **without** the writer lock, so a long review does not
hold the KB. Before any publication byte is written, the control DB preallocates the candidate
generation ID, every file ID, and every exact staging and final key, and records the complete
planned file set. Only then does the transaction:

1. Re-resolve profile and policy, acquire the writer lock, and revalidate admitted sources or the
   claimed query answer.
2. Read the selector and require it to equal the exact base recorded in the review packet. Drift
   invalidates the candidate — it never silently rebases.
3. Stage source objects, source records, page revision pairs, and all-and-only the approved
   conflict records at their preindexed keys.
4. Build and stage the next catalog, the index, and the selector bytes.
5. Publish the immutable root-level files, then atomically rename the generation directory into
   place. The selector is still staged.
6. **Commit point.** Under the lock, reserve the required authorities, recheck that the selector
   still equals the exact base, and atomically rename the selector into place.
7. Finalize only: consume reservations, mark sources published, write the `published` receipt, and
   bind it to the terminal result.
8. Rebuild `index.md` as convenience. Failure here never rolls back the selector.

**The recovery rule is a decision procedure, not a guess.** Recovery decides from the selector,
durable transaction and index rows, and hashes — never from timestamps or the mere presence of a
file. A crash before step 6 leaves the old generation authoritative and only the same transaction
may resume. A crash after step 6 leaves the new generation authoritative and permits only
finalization; nothing is republished and no child is re-run. A base-none `init` exposes either an
uninitialized root or one complete first generation. A competing writer during review changes the
base, which deterministically invalidates the candidate after lock acquisition without reopening or
leaking source bytes.

## Engine ownership

Each run carries immutable `engine_owner: "typescript"` identity and schema version 2. The active
runtime never converts or resumes retired checkpoint rows; historical bytes remain private archive
evidence only.
