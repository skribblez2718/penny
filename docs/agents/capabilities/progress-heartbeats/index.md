# Direct-Subagent Progress and Session Boundaries

## What

Direct subagent execution currently has **no general progress-heartbeat timeout**.
The runner exports an optional `ProgressEmitter` seam and can translate Pi stdout
records (`agent_start`, assistant `message_end`, and tool results) when a caller
supplies one, but no production caller constructs or passes that emitter. The
runner therefore applies no general worker timeout; cancellation uses its own
bounded graceful/forced termination lifecycle.

Do not confuse this with skill-run progress. New ordinary orchestrated workers bind
an immutable V3 inactivity-lease profile after the host resolves the provider/model.
The lease renews only from content-free projections of non-empty assistant text or
thinking deltas, admitted tool start/completion and changed cumulative tool updates,
provider turn completion, or worker completion. Raw prompt, message, thinking, tool,
and evidence bodies never enter the liveness event. A fixed host-operation deadline
remains an independent upper bound; total elapsed work is not an ordinary V3 liveness
budget. Recovery fences interrupted workers and does not charge process downtime as
worker inactivity. Historical V1/V2 policies replay their fixed-duration semantics.

The orchestration engine also emits typed `phase_started`, `worker_completed`, and
`boundary_reached` events, and the skill extension maps those to user-interface
progress. Those UI events are observational; they do not renew the worker lease,
reset a direct-subagent timer, autonomously schedule work, or carry artifact handoff.

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
2. Renew an orchestrated-worker lease only from the closed trusted activity adapter;
   model-authored progress claims and repeated identical tool updates do not count.
3. Treat user-interface orchestration progress events as observational output only.
4. Keep the host-operation deadline independent from the renewable inactivity lease.
5. Cancellation must wait for the bounded process-termination lifecycle to settle.
6. Resume orchestration by its public run/session identity and hand off exact work
   by artifact ID; do not reconstruct either from conversation history.
7. A fresh chat session changes conversational context, not durable-store custody.

## Verification

- [ ] Repository search finds no production construction or pass-through of
      `ProgressEmitter`.
- [ ] `runSingleAgent` still states that there is no general direct-worker timeout.
- [ ] V3 orchestrated-worker tests cover slow productive renewal, exact inactivity
      expiry, changed-versus-repeated tool updates, and V1/V2 replay.
- [ ] Skill UI progress mapping remains typed and observational.
- [ ] Pi's command reference names `/new`, not `/clear`, for a fresh session.
- [ ] Documentation does not imply that session reset deletes artifacts or
      checkpoints.

## Files

| File                                                    | Purpose                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `.pi/extensions/subagent/agent-runner.ts`               | Direct worker process lifecycle and optional progress seam |
| `.pi/extensions/skill/index.ts`                         | Orchestration progress-to-UI mapping                       |
| `apps/orchestration/src/model-client.ts`                | Content-free Pi activity projection                        |
| `apps/orchestration/src/liveness-profiles.ts`           | Immutable calibrated worker lease profiles                 |
| `apps/orchestration/src/liveness.ts`                    | Durable liveness policy, renewal, and replay               |
| `apps/orchestration/src/worker.ts`                      | Lease timer plus typed observational progress events       |
| `docs/humans/capabilities/progress-heartbeats/index.md` | Human explanation                                          |
