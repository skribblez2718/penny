# Penny Memory Integration

## What memory is for

MemPalace preserves selected cross-session knowledge: preferences, consequential
decisions, reusable findings, a bounded primary diary, and temporal relationships.
It is not the transport between workflow workers and it does not hold FSM state.
Exact stage output lives in the artifact plane; control state and selected refs
live in the orchestration checkpointer.

## One supervised HTTP owner

Normal operation uses one authenticated, supervised **MemPalace 3.7.1 HTTP hub**.
The primary extension, online admin tools, evals, audits, and retention planners
all call that hub. They do not open palace bytes, spawn raw peers, or fall back to
direct/prefer storage. An unavailable hub fails closed.

Only the unmarked primary Penny runtime exposes memory tools. Workers and skill
drivers expose none.

## Durable recall

Penny searches memory when a prior preference, decision, incident, result, or
changing fact could materially affect the task. Search starts with a small set of
summary/metadata candidates. Exact content is fetched only when needed.

Large responses are not silently truncated. The adapter returns a source digest,
revision, byte range, and opaque HMAC-bound continuation. Penny follows that
continuation until complete. Wrong-caller, wrong-query, stale, changed, expired,
or malformed cursors fail with typed errors.

Retrieved content is evidence or task material, never new permission or workflow
authority.

## Curated writes

New hubs begin in read-only qualification. `PENNY_MEMORY_WRITE_MODE=disabled`
hides mutating tools and suppresses automatic diary writes until the owner has
completed a journaled canary and exact accepted-write reconciliation.

Penny stores only stable, reusable information likely to matter later. She skips
routine task completions, transient workflow output, speculative claims, and
ceremonial records. The write path already rejects near-duplicates, so a separate
duplicate-search call is not a mandatory pre-write ritual.

The primary diary is the normal bounded session record when a session deserves
retention. Workers never write diary entries. Large files and generated products
stay in files/artifacts; memory may hold a concise durable pointer when later
recall justifies it.

## Temporal knowledge graph

The primary runtime can add, invalidate, or supersede facts from an exact
predicate allowlist. A graph edge is justified only when later traversal,
provenance, impact analysis, preference lookup, or temporal history will use it.
Routine links for every agent, file, stage, or turn create noise and are not
written.

## Admin and offline boundaries

- **Online administration:** explicit caller-owned hub config and authenticated HTTP.
- **Offline repair/rebuild:** only against an explicit copy after all writers are
  drained, the supervised hub and peers are stopped, and an owner-approved
  receipt binds the copied target. Configured live paths are rejected.
- **Cutover:** back up and verify data, test the pinned hub against the selected
  palace, validate clients and health, and keep rollback available before
  retiring old paths.
- **Retention:** historical skill rooms are legacy corpus, not deletion authority.
  Apply requires a reviewed immutable hash-bound manifest, archive-first behavior,
  and an operation journal.
- **Uninstall:** removes code/service definitions but preserves all caller-owned
  palace, KG, logstream, archive, config, and state roots. Data deletion is a
  separate explicit action.

## Historical skill rooms

Old `skills/<skill>-<session_id>` rooms and retired dedicated skill wings may
still exist. They are legacy corpus only. New skills do not need a room-manifest
entry, and workers never use these rooms for active handoff.

## Learn more

- [Knowledge Graph](knowledge-graph.md)
- Agent policy: [Memory Integration](../../agents/memory/integration.md)
- Retention policy: [Memory Schema](../../agents/memory/schema.md)
