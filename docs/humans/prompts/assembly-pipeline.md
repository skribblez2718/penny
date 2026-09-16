# Assembly Pipeline

## Direct primary conversation

Pi loads the Cognitive Frame, project indexes, discovered skills, date/cwd, and the user's
task. The primary runtime may expose durable-memory tools.

## Catalog-worker dispatch

1. Transform the Cognitive Frame and remove parent-only protocols.
2. Read one Role Definition from the current `.pi/agents` snapshot, or select the anonymous private-worker posture.
3. Resolve contract-declared canonical documents to exact paths and content digests.
4. Inject bound documents and registered static Domain Guidance before `<agent_boundary>` for catalog workers; private workers receive bound documents followed by private phase guidance without a catalog role.
5. Append the canonical project index, place one system boundary last, and keep task plus caller-selected context below it.
6. Load all tool providers and validate every YAML name. Direct/parallel/chain invocation
   and orchestration phases without `allowed_tools` activate YAML exactly. An eligible
   TypeScript orchestration phase instead activates only its fixed non-empty duplicate-free
   strict YAML subset from the active canonical registration. Trust profiles, task/input,
   runtime conditions, model/liveness policy, and optional-service state cannot select tools.
7. Validate any phase subset against YAML before session creation, pass the selected list
   exactly to Pi, and verify active equality before the model prompt.
8. Verify every supplied artifact ID before model use.

The CLI runner, SDK skill workers, and anonymous private KB workers share one prompt
composer. The transformed frame, role body (without YAML), digest-bound canonical docs,
registered domain guidance, and canonical Penny root `AGENTS.md` are system-role content.
Missing, empty, malformed, symlink-escaping, or digest-drifted sources fail before model
execution; no path falls back to Pi's default prompt. Ambient ancestor/global context and
append-system files are excluded. A different task cwd may contribute its `AGENTS.md` only
as subordinate task material. Direct `skillContext`, task text, exact IDs, and dynamic
invocation data stay in the task message. Private KB sessions use the same baseline composer
without claiming a catalog role and retain their separate closed tool policy.

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
are system-role placement, equality to the selected exact-YAML or registration-bound strict
subset surface, workflow gates/receipts, artifact byte integrity, and OS/container
permissions. A subset is not OS/process sandboxing and does not isolate extension code.
