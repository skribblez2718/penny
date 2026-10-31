# Direct-Subagent Progress and Fresh Sessions

## Current Behavior

Direct `subagent()` runs use a renewable inactivity lease. The worker runner
recognizes trusted Pi start, non-empty assistant/reasoning, admitted tool lifecycle,
changed tool-update, and completion activity directly from Pi stdout. Real activity
renews the lease; repeated identical updates do not. Explicit cancellation follows
a bounded graceful/forced shutdown process.

Skill runs have a different progress surface. New ordinary orchestrated workers
use calibrated renewable inactivity leases. The host renews a worker only when it
observes real non-empty assistant or reasoning output, admitted tool lifecycle or
changed tool-update progress, or completion progress. The liveness record keeps
only event classes and counters—not prompt, reasoning, message, tool-result, or
evidence bodies. Slow work may exceed the old fixed worker duration while it keeps
making progress; stalled work stops when its inactivity lease expires. Host
operations use their own renewable inactivity leases, so current execution has no
total elapsed-work ceiling. Interrupted-process downtime does not consume a new
worker lease. Older V1/V2 runs keep their exact recorded policy fields, not finite defaults for new runs, but historical duration fields no longer stop live work.

The orchestration engine also reports phase starts, completed workers, and
user/completion boundaries to the skill user interface. This is useful status
output, but it is observational: UI updates do not renew a worker lease, schedule
background work, or transfer artifacts.

## Starting a Fresh Session

In the pinned Pi runtime, the command is `/new`; `/clear` is the retired name.
Starting a fresh session resets the conversation/session context. It does not
purge Penny's independently persisted artifacts, orchestration checkpoints, or
retained worker-session records.

That distinction matters:

- The new conversation does not automatically remember or receive the old chat.
- An immutable artifact remains readable when its exact artifact ID is supplied.
- A checkpointed workflow remains resumable through its normal run/session
  identity and public resume operation.
- Durable-store deletion and retention follow store policy, not the chat-reset
  command.

So “start fresh” means fresh conversational context, not deletion of prior work.
Do not rely on chat history as workflow state, and do not describe `/new` (or the
historical `/clear` name) as clearing durable artifacts or checkpoints.

## Troubleshooting

**A direct subagent seems stuck**

- Its inactivity lease ends a silent worker; trusted Pi activity renews it.
- Cancel explicitly when appropriate; the runner waits for bounded process exit
  and stream closure.
- Preserve any exact completed output artifact IDs before starting replacement
  work.

**A skill stopped at a boundary**

- Use the emitted run/session identity and the skill's public respond/resume
  operation. UI progress text is not the checkpoint itself.

**A new chat cannot see earlier work**

- Supply the exact artifact ID or workflow identity needed now. A fresh session
  intentionally does not inherit the old conversation, even though separate
  durable stores remain intact.

## Learn More

- Agent reference: `docs/agents/capabilities/progress-heartbeats/index.md`
- Direct worker lifecycle: `.pi/extensions/subagent/agent-runner.ts`
- Skill progress mapping: `.pi/extensions/skill/index.ts`
- Orchestration progress events: `apps/orchestration/src/worker.ts`
