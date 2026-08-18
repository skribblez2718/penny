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

| Status | `met` | `next` |
|---|---|---|
| `running` | false | `resume` |
| `awaiting_user` | false | `review` |
| `refused`, `error`, `exhausted` | false | `none` |
| `complete` | true for a satisfied action, false for a completed deny or unsupported answer | `none` |

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
replay projection, with no second side effect. The same pair with a *different* digest is a
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
- **`lint`** — deterministic first; malformed structure blocks semantic work. Reports findings and
  **candidate** conflicts only. Publishes nothing.
- **`promote`** — prepare and verify only. See [Privacy and Promotion](privacy-and-promotion.md).

`status` and `resume` are profile-safe control operations that expose no root and no body.

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
itself, records a durable `prepared` row *before* writing bytes, writes a mode-`0600` no-follow
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

Each run carries an **immutable** engine owner. Python and TypeScript engines use separate database
files and schemas and never convert rows. A pending run is finished by the engine that started it,
or explicitly abandoned and recorded — a flag change affects only new runs.
