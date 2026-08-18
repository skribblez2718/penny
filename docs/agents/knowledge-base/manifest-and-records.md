# Manifest and Records

The private KB is an **immutable, advisory generation store**. Nothing published is ever
overwritten; change happens by adding a new immutable revision and atomically moving one
pointer.

## Static configuration

Two files are static host-owned configuration. A content transaction never rewrites either.

- **`manifest.json`** — schema version, opaque `kb_id`, title, `authority: "advisory"`, the
  fixed path map, and creation time. The path map is fixed vocabulary, not operator choice.
- **`.kb/policy.json`** — the processing policy: local-only or provider-permitted, allowed parent
  and child models, parent-result limits, artifact limits, and reader limits. It is ignored,
  owner-only, default-deny on creation, and edited only by an authenticated out-of-band host
  operation — never by a KB action. See [Privacy and Promotion](privacy-and-promotion.md).

## Live layout

```text
<kb-root>/
├── manifest.json                                  # static, ignored
├── index.md                                       # rebuildable convenience only
├── sources/
│   ├── objects/<sha256>                           # immutable raw bytes
│   └── records/<source_id>.json                   # immutable provenance record
├── pages/<page_id>/revisions/<revision_id>/
│   ├── page.md                                    # immutable advisory Markdown revision
│   └── claims.json                                # immutable claim sidecar for that revision
├── conflicts/<conflict_record_id>.json            # immutable conflict event/record
├── work/<run_id>/                                 # same-root private staging/content plane
│   ├── artifacts/<state_id>/<artifact_id>
│   ├── transaction/
│   └── promotion/
└── .kb/
    ├── policy.json                                # static exact processing policy
    ├── current.json                               # sole atomically replaced selector
    ├── lock
    └── generations/<generation_id>/               # immutable after publication
        ├── catalog.json                           # selected source/page/conflict records
        └── index.sqlite                           # deterministic index for this catalog
```

This tree is **singular**. There is no `.kb/conflicts`, `.kb/receipts`, `.kb/runs`, `.kb/locks`,
digest-subdirectory alias, or `index.json` alias. An implementation that invents a second layout
for the same data is wrong even if it round-trips.

`index.md` is human convenience. It may lag or be missing after a crash and is rebuilt from the
selected catalog. It is **never** authority, checkpoint state, or an `AGENTS.md` node — a reader
that answers from `index.md` instead of the selected catalog has read the wrong file.

## Records

All records are immutable once published. All non-raw JSON is stored as RFC 8785 (JCS) canonical
UTF-8 bytes, so a digest over the bytes is a digest over the meaning. Raw source objects alone
preserve their admitted bytes exactly.

**Source record.** Opaque host-minted `source_id` (ULID or UUID), type, capture and publication
time, title, authors, media type, the raw-byte `sha256`, an `object_ref` derived *exactly* from
that hash, and provenance including the capability digest and originating run.

Three values do distinct jobs and are never conflated:

| Value | Role |
|---|---|
| `source_id` | Stable opaque reference identity. Never a digest, never caller-supplied |
| `sha256` / `object_ref` | Content address of the raw bytes; deduplicates and integrity-checks |
| Catalog record hash | JCS digest of the complete record; detects record change and exact duplicates |

Every canonical metadata field copies byte-exactly from the host-reviewed capability envelope. No
child, model, or filename parser supplies source metadata.

**Page revision.** A frontmatter block plus Markdown with exactly four level-two sections, once
each and in order: `Synthesis`, `Evidence`, `Tensions and unknowns`, `Related`. Published bytes are
exactly `---\n` + JCS(frontmatter) + `\n---\n\n` + markdown.

**Claims sidecar.** Stable claim IDs for one page revision, each with kind, state, confidence,
evidence, contradicted claim IDs, and canonical-verification references. Because IDs are stable and
revision-scoped, an unsupported-claim finding or a conflict link resolves to exactly one revision.

**Conflict record.** Claim references, state, summary, projected evidence references, optional
supersession, and creation time. Conflicts are advisory events; they record that sources disagree.

**Operation receipt.** Content-free audit of one operation: run, session, transaction, event group
and sequence, profile, action, event, input digests, safe output references, generation IDs, policy
digest, and safe metrics. Receipts live in a **separate host-owned audit plane** and are never
generation-selected — audit history is not KB content.

A changed page or claim creates a **new revision directory**. No `page.md`, `claims.json`, source
object or record, conflict record, receipt, catalog, or index is ever overwritten in place.

## Generations and the selector

A **generation** is a complete, immutable snapshot: `catalog.json` names every selected source
record, source object, page revision pair, and conflict record with its digest, plus the digest of
the deterministic `index.sqlite` built for that catalog.

`.kb/current.json` is the **sole selector** — one small pointer naming the generation, its catalog
digest, and its index digest.

Readers start from one validated selector and use only that generation. They never combine a
directory scan with a different generation, and they never mix a new page with an old catalog. That
single rule is what makes a crash produce either the complete old view or the complete new view and
nothing in between.

Publication therefore has exactly **one commit point**: the atomic replacement of `current.json`.
Everything before it is staging that can be discarded; everything after it is finalization that can
only be completed, never re-run. See [Workflows](workflows.md) for the ordered protocol and the
recovery matrix.

A catalog's policy digest is **historical publication audit metadata**. It records which policy was
in force when that generation was published; it does not need to equal today's policy, and a policy
edit never invalidates an already-selected generation.
