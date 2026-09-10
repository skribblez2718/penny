# Direct-Subagent Progress and Session Boundaries

## What

Direct subagent execution currently has **no general progress-heartbeat timeout**.
The runner exports an optional `ProgressEmitter` seam and can translate Pi stdout
records (`agent_start`, assistant `message_end`, and tool results) when a caller
supplies one, but no production caller constructs or passes that emitter. The
runner therefore applies no general worker timeout; cancellation uses its own
bounded graceful/forced termination lifecycle.

Do not confuse this with skill-run progress. The orchestration engine emits typed
`phase_started`, `worker_completed`, and `boundary_reached` events, and the skill
extension maps those to user-interface progress. Those events are observational;
they do not reset a direct-subagent timer, autonomously schedule work, or carry
artifact handoff.

## Session reset semantics

The pinned Pi command is `/new` (the historical `/clear` name is retired). It
starts a fresh conversation/session. Starting a fresh session does **not** delete
Penny's separately persisted immutable artifacts, orchestration checkpoints, or
retained worker-session records. Those stores remain available through their
normal exact IDs and resume operations; their contents are not automatically
injected into the new conversation.

Never document `/new` or the retired `/clear` name as a purge of durable artifacts
or workflow state. Deletion/retention follows each store's own policy.

## Rules

1. Do not claim heartbeat-based staleness protection for direct `subagent()` runs.
2. Treat orchestration progress events as UI/observability output only.
3. Cancellation must wait for the bounded process-termination lifecycle to settle.
4. Resume orchestration by its public run/session identity and hand off exact work
   by artifact ID; do not reconstruct either from conversation history.
5. A fresh chat session changes conversational context, not durable-store custody.

## Verification

- [ ] Repository search finds no production construction or pass-through of
      `ProgressEmitter`.
- [ ] `runSingleAgent` still states that there is no general worker timeout.
- [ ] Skill progress mapping remains typed and observational.
- [ ] Pi's command reference names `/new`, not `/clear`, for a fresh session.
- [ ] Documentation does not imply that session reset deletes artifacts or
      checkpoints.

## Files

| File                                                    | Purpose                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `.pi/extensions/subagent/agent-runner.ts`               | Direct worker process lifecycle and optional progress seam |
| `.pi/extensions/skill/index.ts`                         | Orchestration progress-to-UI mapping                       |
| `apps/orchestration/src/worker.ts`                      | Typed orchestration progress events                        |
| `docs/humans/capabilities/progress-heartbeats/index.md` | Human explanation                                          |
