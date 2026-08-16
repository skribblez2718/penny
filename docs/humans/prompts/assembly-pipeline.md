# Assembly Pipeline

## Direct primary conversation

Pi loads the Cognitive Frame, project indexes, discovered skills, date/cwd, and
the user's task. The unmarked primary runtime may expose durable-memory tools.

## Worker dispatch

1. The runner reads and transforms the Cognitive Frame, removing parent-only protocols.
2. It reads one Role Definition from the current `.pi/agents` catalog snapshot.
3. It injects optional static Domain Guidance before `<agent_boundary>`.
4. Pi appends project indexes and runtime context.
5. The runner marks the process as a worker, strips approval/receipt secrets, and
   applies the role tool allowlist.
6. If trusted owner metadata grants exact artifacts, the runner exposes
   `artifact_read`; otherwise it explicitly excludes that tool.
7. The task supplies the current goal, constraints, and exact input/output
   artifact contracts.

Workers receive no durable-memory tools.

## Output path

The worker reads every granted input with `artifact_read` and follows typed
continuation until complete. It returns complete stage content, then any
Domain-Guidance SUMMARY. The execution owner persists and verifies exact bytes
before parsing the SUMMARY or advancing a skill/chain.

Parallel branches get no sibling grants. A chain grants only the verified prior
step ref; `{previous}` points to that ref rather than carrying payload text.

## Context-safe continuation

The artifact tool has no list/search/self-grant surface. Continuation cursors are
bound to caller, operation, query/ref, revision, and next byte range. Missing or
invalid content fails closed.

Run checkpoints preserve compact state and selected refs. After compaction, a
prose brief plus optional code-owned `[RESUME-REFS v2]` addresses restores the
same continuation. Durable memory is optional and not recovery authority.

## Structural markers and controls

`<skill_context>`, `<agent_boundary>`, and `<system_boundary>` help the model parse
regions. Actual controls are system-role placement, tool allowlists, artifact
grants, signed workflow receipts, and OS/container permissions.

## Fixed channels

Pi still provides one system prompt, one append-system-prompt channel, AGENTS
context, skill discovery, runtime info, and the user/task message. Role Definition
and Domain Guidance share the append channel and remain separated by the static
`<skill_context>` wrapper.
