# Progress Heartbeats

## What It Is

A mechanism that prevents Penny from killing agents that are actively making progress on long-running tasks. Instead of a fixed "kill after N minutes" timer, Penny watches the agent's output stream and resets the kill timer whenever the agent produces results.

## When It Matters

- Agents running multi-step research, planning, or coding tasks
- Long-running tools (e.g., `bash` commands that take minutes)
- Any skill where agents chain multiple tool calls before completing

## How It Works

Pi agents emit JSON lines to stdout. Each of these events counts as a heartbeat:

- **Tool result** — agent executed a tool (read a file, ran bash, searched the web)
- **Message end** — agent produced an assistant response
- **Agent start** — agent process began

If progress events keep arriving, the agent stays alive. If the agent goes silent, a three-tier escalation kicks in.

## Three-Tier Escalation

| Phase           | Duration (default) | What Happens                          |
| --------------- | ----------------- | ------------------------------------- |
| Warning         | 30 minutes        | Logged: "Agent slow but hasn't stalled yet" |
| Staleness kill  | 60 minutes        | Agent resolved with timeout result     |
| Hard cap        | 90 minutes        | Agent killed regardless of last progress |

The thresholds are multipliers of the per-skill `agent_timeout_ms`:
- Window = `agent_timeout_ms`
- Staleness = `agent_timeout_ms × 2`
- Hard cap = `agent_timeout_ms × 3`

## Configuration

| Environment Variable                  | Effect                                      | Default |
| ------------------------------------- | ------------------------------------------- | ------- |
| `PENNY_AGENT_TIMEOUT`                 | Base timeout per agent invocation (ms)        | 1,800,000 (30 min) |
| `PENNY_PROGRESS_WINDOW_MULTIPLIER`    | (Reserved) Future multiplier override       | —       |

Per-skill timeouts are set via the `agent_timeout_ms` field in orchestrator actions. The skill extension passes this value to `withAgentTimeout`.

## Troubleshooting

**Agent was killed despite making progress**
- Check if the agent's output format changed — progress detection relies on Pi JSON lines containing `tool_result_end`, `message_end`, or `agent_start`
- Verify `agent_timeout_ms` isn't set too low for the task complexity

**Agent runs too long**
- Increase `agent_timeout_ms` in the orchestrator action
- Check the logs at `WARN` level for "Agent slow but hasn't stalled yet" — this tells you the agent is still alive but approaching the threshold

**False staleness kills**
- Some agents may produce bursts of output then go silent while computing. If this is normal for your workflow, increase the base timeout or adjust the orchestrator to emit periodic heartbeat messages.

## Observability

- **DEBUG**: Progress events are logged each time a heartbeat fires
- **WARN**: Emitted when an agent crosses the progress window threshold
- **ERROR**: Emitted on staleness kill or hard cap kill, including duration metrics

## Learn More

- Agent docs: `docs/agents/capabilities/progress-heartbeats/index.md`
- Implementation: `.pi/extensions/skill/index.ts` (withAgentTimeout), `.pi/extensions/subagent/agent-runner.ts` (ProgressEmitter)
- Tests: `.pi/extensions/skill/tests/unit/heartbeat.test.ts`, `.pi/extensions/skill/tests/integration/heartbeat.test.ts`
