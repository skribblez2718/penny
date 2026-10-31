# Direct-Subagent Progress and Session Boundaries

## What

Direct subagent execution uses a calibrated renewable inactivity lease. The runner
projects trusted Pi stdout activity directly: non-empty assistant text or thinking,
admitted tool starts/completions, changed cumulative tool updates, and terminal
progress renew the lease. Its optional `ProgressEmitter` remains observational and
is not required for liveness. Cancellation uses its own bounded graceful/forced
termination lifecycle.

Do not confuse this with skill-run progress. New ordinary orchestrated workers bind
an immutable V3 inactivity-lease profile after the host resolves the provider/model.
The lease renews only from content-free projections of non-empty assistant text or
thinking deltas, admitted tool start/completion and changed cumulative tool updates,
provider turn completion, or worker completion. Raw prompt, message, thinking, tool,
and evidence bodies never enter the liveness event. Host operations have their own
renewable inactivity lease; no current worker, child, host operation, or direct
subagent has a total elapsed-work ceiling. Recovery fences interrupted workers and
does not charge process downtime as worker inactivity. Historical V1/V2 records
retain their exact policy fields for compatibility; those are not finite defaults for new runs, but their duration
fields are telemetry rather than live execution-abort gates.

The orchestration engine also emits typed `phase_started`, `worker_completed`, and
`boundary_reached` events, and the skill extension maps those to user-interface
progress. Those UI events are observational; they do not renew a worker or direct-subagent
lease, autonomously schedule work, or carry artifact handoff.

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

1. Renew direct and orchestrated worker leases only from their closed trusted activity
   adapters; model-authored progress claims and repeated identical tool updates do not count.
2. Treat user-interface orchestration progress events as observational output only.
3. Give host operations their own renewable inactivity lease; never impose a total
   elapsed-work deadline on productive execution.
4. Cancellation must wait for the bounded process-termination lifecycle to settle.
5. Resume orchestration by its public run/session identity and hand off exact work
   by artifact ID; do not reconstruct either from conversation history.
6. A fresh chat session changes conversational context, not durable-store custody.

## Verification

- [ ] Direct-worker tests cover elapsed work beyond the former ceiling, trusted
      renewal, repeated-update refusal, inactivity expiry, and cancellation.
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
