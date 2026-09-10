# Direct-Subagent Progress and Fresh Sessions

## Current Behavior

Penny does not currently apply a general heartbeat timeout to direct
`subagent()` runs. The worker runner can recognize Pi start, message, and tool
stdout events through an optional compatibility hook, but the production direct
subagent path does not supply that hook. A direct worker is therefore not kept
alive—or killed—by a documented three-tier heartbeat policy. Explicit
cancellation instead follows a bounded graceful/forced shutdown process.

Skill runs have a different progress surface. The orchestration engine reports
phase starts, completed workers, and user/completion boundaries to the skill user
interface. This is useful status output, but it is observational: it does not
reset a direct-worker timeout, schedule background work, or transfer artifacts.

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

- Do not assume a heartbeat monitor will terminate it.
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
