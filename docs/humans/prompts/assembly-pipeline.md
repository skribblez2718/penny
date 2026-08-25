# Assembly Pipeline

## Direct primary conversation

Pi loads the Cognitive Frame, project indexes, discovered skills, date/cwd, and the user's
task. The primary runtime may expose durable-memory tools.

## Catalog-worker dispatch

1. Transform the Cognitive Frame and remove parent-only protocols.
2. Read one Role Definition from the current `.pi/agents` snapshot.
3. Inject optional static Domain Guidance before `<agent_boundary>`.
4. Append project indexes and current task context.
5. Load all tool providers, validate every YAML name, and activate exactly the YAML
   `tools:` list—no trust/profile/input-dependent changes.
6. Verify every supplied artifact ID before model use.

Workers may have YAML-declared read-only memory tools, but those are advisory recall rather
than workflow transport.

## Output path

The worker reads needed IDs with `artifact_read` and repeats with `next_range` until
complete. It returns complete content and a final routing-only SUMMARY. Owner code persists
and re-reads exact bytes before parsing SUMMARY or returning success.

Parallel branches can receive independent exact IDs. Chain mode inserts the prior ID
automatically and permits additional fan-in IDs; `{previous}` never carries payload.

## Recovery

`artifact_read` has no list/search/guess surface. IDs/ranges do not expire. Checkpoints
preserve compact refs. Compaction emits prose plus exact code-proven current-session refs,
or one immutable handoff-index ID when the set is large. Memory is optional and never
recovery authority.

## Markers and controls

`<skill_context>`, `<agent_boundary>`, and `<system_boundary>` aid parsing. Actual controls
are system-role placement, the exact YAML surface, workflow gates/receipts, artifact byte
integrity, and OS/container permissions.
