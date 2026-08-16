# Agent Invocation

A worker invocation assembles the Cognitive Frame, one local Role Definition,
optional static Domain Guidance, project navigation, and the current task. The
worker starts in a fresh context with only its allowlisted tools.

## Exact current-run inputs

When prior stage output is needed, the execution owner grants immutable artifact
refs instead of pasting payload text or pointing to a memory room. The worker
uses `artifact_read` and follows the returned continuation cursor until the
content is complete. It cannot enumerate or grant itself other artifacts.

The worker returns the complete task result. In a workflow, the owner captures
and verifies those exact bytes before parsing an optional trailing SUMMARY. The
SUMMARY routes the state machine; it is not the artifact.

## Invocation patterns

- **Single:** one worker returns complete work to the caller.
- **Parallel:** branches receive independent tasks and no sibling artifact grants.
- **Chain:** each step is persisted; the next worker receives only the preceding
  canonical ref. `{previous}` points to that grant rather than containing the
  previous payload.

## Recovery

Run checkpoints retain selected refs, so retry, clarification, restart, and
partial parallel recovery do not depend on semantic search. After conversation
compaction, code-owned exact run/artifact refs can restore the same continuation.
Large inputs remain context-safe through typed byte-exact continuation.

Workers have no durable-memory tools. The primary runtime's optional durable
recall is a separate cross-session capability.

## Learn more

- [Agents](overview.md)
- [Definition Format](definition-format.md)
- [System Prompt Security](system-prompt-security.md)
- Agent reference: [Invocation](../../agents/agents/invocation.md)
