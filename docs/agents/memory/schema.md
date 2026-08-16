# Memory Retention — Active knowledge and legacy skill-room corpus

## Classes

| Class                                 | Examples                                                                         | Policy                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Primary diary / recent working memory | `penny/diary`, selected audit/session material                                   | T2 with explicit room TTL and recall-aware extension.               |
| Curated durable knowledge             | `penny/architecture`, `penny/decisions`, `penny/skills`                          | T3 permanent; written only after a durable-value judgment.          |
| Legacy skill-room corpus              | Historical `penny/skills/<skill>-<session_id>` and retired dedicated skill wings | Historical data classification only; never active workflow handoff. |
| Cold archive                          | Content-hash-bound JSONL archive                                                 | T4 recovery corpus, never automatic prompt input.                   |

New skills do **not** require a memory room or an entry in
`scripts/system/tiered_memory/skill_rooms.json`. Active stage handoff uses owner
artifacts, and run state uses the orchestration checkpointer.

## `skill_rooms.json`

`skill_rooms.json` records historical room shapes so a retention **planner** can
classify legacy corpus. It is not:

- a live skill registry;
- a scaffolding or structure-check requirement;
- proof that a room is transient;
- a deletion list or deletion authority.

Unknown or unreviewed rooms are kept by default. A classification can only
produce candidates in a dry-run plan.

## Retention gates

1. Read online data only through the authenticated supervised 3.7.1 HTTP hub.
2. Write a new immutable retention manifest bound to exact IDs and content hashes.
3. Review the plan, archive destination, counts, and unknown/kept records.
4. Apply only with that exact manifest plus a new operation journal and explicit
   apply authorization.
5. Cold-write each selected record before requesting hub deletion.
6. Stop on ref, hash, revision, archive, or journal mismatch.

Historical labels never bypass these gates.

## Data preservation

Setup never discovers, initializes, migrates, or deletes an existing palace.
Cutover requires backup and rollback evidence before old access paths are
retired. Uninstall removes code/service definitions only and preserves
caller-owned palace, KG, logstream, archive, config, and state roots. Deleting
those roots is a separate explicit operator action.

## Offline repair

Raw-byte tools may operate only on an explicit copied target after all writers
are drained, the supervised hub and peers are stopped, and an owner-approved
receipt binds the copy. Configured live paths are rejected.

## Verification

- [ ] Old skill rooms are described as legacy corpus, not active handoff.
- [ ] Live skills have no room-manifest requirement.
- [ ] `skill_rooms.json` is planning classification only.
- [ ] Unknown data defaults to keep.
- [ ] Apply is exact-manifest, archive-first, journaled, and explicitly authorized.
- [ ] Setup, cutover, offline work, and uninstall preserve data.

## Files

| File                                            | Purpose                            |
| ----------------------------------------------- | ---------------------------------- |
| `scripts/system/tiered_memory/skill_rooms.json` | Legacy corpus classification hints |
| `scripts/system/tiered_memory/archiver.py`      | Hub-routed plan/apply workflow     |
| `scripts/system/memory/offline_access.py`       | Copied-target authorization        |
