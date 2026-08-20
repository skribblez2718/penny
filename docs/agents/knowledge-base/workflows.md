# Workflows

Every public call is a **request**, never an authority grant. The host validates a closed schema,
resolves authority itself, and returns a bounded safe result.

## Request and result shape

No request carries a root, path, locator, canonical target, approval decision, receipt body, start
`run_id`, or idempotency key. Requests name an opaque `kb_profile_id` and, where applicable, opaque
capability IDs the host already minted.

A result carries the action, host-generated `run_id`, optional `kb_id`, status, `met`, opaque IDs
and counts, path-free artifact handles, safe evidence references, bounded warnings and unresolved
items, and a `next` step. Cross-fields are closed:

| Status                          | `met`                                                                         | `next`   |
| ------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `running`                       | false                                                                         | `resume` |
| `awaiting_user`                 | false                                                                         | `review` |
| `refused`, `error`, `exhausted` | false                                                                         | `none`   |
| `complete`                      | true for a satisfied action, false for a completed deny or unsupported answer | `none`   |

An **artifact handle is path-free**: an ID, kind, digest, media type, and byte length. It has no
path, relative path, logical filename, root, or locator. `answer_delivery: "artifact_ref"` means the
result carries that handle — it is not a second reference schema.

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

## The six flows

- **`init`** — validate profile and create authority → admit an existing empty or exact-scaffold
  root → stage manifest, default-deny policy, layout, first empty catalog and index → commit the
  selector → receipt. This is the only base-none transaction.
- **`ingest`** — profile, policy, and source capabilities → immutable objects and records → Echo
  extracts claims → Synthia composes a page revision pair → deterministic lint → Carren semantic
  report → Vera grounding check → **human content-review gate** → publish a generation.
- **`query`** — read one selected generation → deterministic bounded retrieval → optional synthesis
  and grounding → a same-run answer artifact handle. No publication-plane change.
- **`save`** — an explicit prior query run → Synthia composes → deterministic, semantic, and
  grounding checks → **human content-review gate** → publish a generation. A useful query does not
  authorize a save; the save must claim that exact query run.

### The save claim

What authorizes a save is not the request but a **single-use claim** over one query run's sealed
answer. A completed query with a sealed answer creates exactly one claim, and the claim ratchets
one way:

```text
  available ──claim──> claimed ──reserve──> commit_reserved ──selector──> consumed
      ^                   │                        │
      └──deny/abort───────┘                        └──pre-selector abort──> invalidated
       (only while the sealed answer is still valid)
```

- Claiming is the **first** side effect of a save, before any compose, read, or write, so a
  drifted, consumed, cross-profile, or concurrently-claimed answer stops the run at the door.
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

`answer_delivery` is a closed field with exactly one bounded parent-facing outcome per outcome class:

- **`artifact_ref`** (default) — the result carries the answer artifact handle only. The tool
  result itself never carries derived content.
- **`parent_tool_result`** — the result may carry one bounded derived answer, and only when the
  policy permits it and exactly one host-minted grant matches.

The grant rule is closed and fails closed. A grant is owner-only, minted for one Pi session — its
session and invocation fields both carry the operator's session id — with a single-use byte cap
and an expiry. Admission requires **exactly one** matching unconsumed grant whose profile, exact
request digest (SHA-256 over the closed request), and byte cap all match and which is unexpired;
two matching candidates are an ambiguity refusal, never a coin flip. The delivered run consumes
the grant atomically; a retry is refused rather than redelivered; and a grant refused for any
other reason (policy denial, byte cap, malformed answer, mismatch) is _retained_ for a future
eligible run.

The grant is not the only condition. Delivery additionally requires an **exact parent allowlist
match**: the provider and model the runtime reports for the active parent context must appear in
the policy's `allowed_parent_models`, and under `local_only` the matched rule must itself declare
`locality: "local"`. The host never guesses locality — it reads the operator's own declaration for
that exact provider/model. An empty allowlist denies, and a parent identity the host cannot
establish denies. The grant says the operator approved this _request_; the allowlist says the
operator approved this _parent_ to receive derived private content.

Delivery also requires the answer to be what the request asked for. `verify_grounding` defaults
true, and the query flow is deterministic retrieval with no grounding phase, so a request that
asks for verification is refused for parent delivery and its artifact result carries a
`grounding_not_verified` warning. An operator who wants delivery today must mint over a request
that explicitly records `verify_grounding: false` — so the digest itself carries the fact that an
unverified answer was accepted. `page_ids` and `source_ids` are honored as retrieval filters
(page set, and pages whose claim evidence cites an allowed source).

The delivered answer is closed: advisory-only, non-empty text, one or more opaque
page/claim/source citations (never locators), a contradictions array, an unknowns array, and
`canonical_verification_required: true`. It may never present itself as canonical current state,
and no raw private body may ever appear in the tool result.

On any miss the parent sees its safe handle result plus exactly one bounded warning code,
`refused_parent_delivery` — never the answer, the diagnostic reason, or grant internals. The host
logs a bounded reason for the operator (missing/mismatched/expired/consumed/ambiguous grant,
policy denial, byte-cap miss, malformed answer) and never returns one to the model.

The decision core and its fail-closed behavior live in the KB modules of the orchestration app
(`kb/parent-delivery`; the adapter only builds the closed request and surfaces the decision), and
the shape, sealed-answer extraction, and every refusal reason are pinned by the
`test:kb-answer-quality` suite alongside the parent-delivery suite.

## Execution architecture (TypeScript path)

The agent-driven flows run on the orchestration engine, not on standalone workflow calls: the
`knowledge_base` tool starts an engine run named `knowledge-base`, and the KB playbook drives the
state machine — `initialize` claims the source capabilities and admits the source objects (host
I/O, all-or-none, before any agent read), then the four agent phases (echo → synthia → carren →
vera) each producing a typed artifact on the run's content plane, then the run stops at the human
content-review gate (`await_user`).

The gate decision is a **host-authenticated response on the run**: `penny-kb-gate approve|deny|refine`
reads the run's pending gate (challenge and all) and submits it through the engine's respond
protocol. The run's own state machine performs the publication (or the honest denial, or the
bounded refinement re-entry into compose) behind the decision, so the terminal or re-gated state
can never disagree with what happened on disk. `refine` re-enters compose, re-lints and re-verifies, and
re-offers the gate; it is a host decision exactly like approve and deny. The model-facing
tool never carries an approval decision — it only starts runs, re-presents the pending gate, and
returns safe projections (counts and opaque IDs, never bodies, paths, challenges, or digests).

The deterministic host I/O the playbook performs between phases (claim, admit, seal, persist the
gate, approve, deny) is behind one interface — the KB ingest plane — so the state machine stays
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

**Output** leaves a child only through `stage_run_artifact`, which is closed over the current run,
state, allowed kinds, profile, and resolved root. The model submits a closed JSON payload — never a
path, run, state, or profile field. The host strict-parses it, rejects duplicate and unknown keys,
validates it, canonicalizes to JCS, applies policy byte and count limits, allocates the ID and keys
itself, records a durable `prepared` row _before_ writing bytes, writes a mode-`0600` no-follow
temporary file, fsyncs, atomically renames, then marks the row `staged` and returns a path-free
handle.

The phase then makes **exactly one** `submit_phase_result` call with a typed, state-specific result
referencing only handles issued to that run and state. It stores content-free details, terminates,
and closes the session. There is **no prose `SUMMARY` parser** — assistant text is never a result.

Artifact lifecycle is `prepared → staged → sealed → consumed`, with `discarding → discarded` for
cleanup. Recovery uses only the exact index row and keys: a `prepared` row with no file is
discarded and the phase retried; matching bytes resume the rename; a type, link, hash, or length
mismatch blocks. No directory scan and no adoption of a found file is ever permitted.

Sessions are purpose-built: an in-memory session and settings manager, explicit model selection, all
builtin tools off, and exactly the custom tools for that phase — listed by name, because SDK
filtering would otherwise remove custom tools. No project or global extension, skill, prompt,
setting, or `AGENTS.md` content discovered around the working directory reaches a child.

## Publication and recovery

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
