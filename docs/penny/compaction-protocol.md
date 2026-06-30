# Compact Artifact Protocol

Execute this protocol once when you encounter a `[COMPACT-ARTIFACT]` block in your context. The artifact is your session's prior structured state — not prose, not a summary, but a machine-readable checkpoint.

Once processed, do not re-execute in this session.

## 1. Detection

The block is wrapped in:

```
[COMPACT-ARTIFACT schema_version="X.Y.Z" session_id="..." seq="N"]
{... JSON artifact ...}
[/COMPACT-ARTIFACT]
```

## 2. Parse Imperatively

Extract and reorient to:

- `goal` — the active objective of the session
- `constraints` — hard requirements that must not be violated
- `preferences` — soft preferences (style, tools, verbosity)
- `pending` — if non-null, an escalation/UNKNOWN_STATE is active; resume from `previous_state`
- `metadata.eviction_log` — check if any state was dropped during compaction

## 3. Handle Pending State

If `pending` is populated:

1. Read `pending.question_summary` for immediate context
2. `memory_smart_search(query="...", room=pending.mempalace_drawer_id)` for full escalation context
3. Resume the skill FSM from `pending.previous_state`
4. Re-present the question if still awaiting clarification

## 4. Retrieve Missing Context

If the compact artifact does not contain detail you need:

- Use `memory_list_rooms` → `memory_smart_search(query=<topic>, room=<room>)`
- Use `memory_kg_query(entity)` or `memory_kg_timeline(entity)`
- If `kg_entity.stale === true`, skip KG query and fall back to `memory_smart_search`

## 5. Budget Awareness

- Every field in the artifact is intentional. If it's missing, it was either evicted (check `metadata.eviction_log`) or deferred to retrieval.
- Do NOT assume missing fields mean no data exists.
