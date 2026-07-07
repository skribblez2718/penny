# Progress Heartbeats — Staleness-based agent timeout

## What

Agent processes are monitored via stdout progress events instead of a single hard timeout. The timer resets on each `tool_result`, `message_end`, or `agent_start` event. Only true stalls trigger termination.

## Why

A single hard timeout kills agents that are making progress but running slowly. Staleness-based monitoring distinguishes "slow but working" from "stalled."

## Rules

1. **Progress resets the timer.** Any stdout event from the agent process counts as progress.
2. **Three-tier thresholds.** Warn at timeout, kill at 2× timeout, hard cap at 3× timeout.
3. **Transparent to agents.** No agent code changes required — events come from Pi's existing stdout.

## Thresholds

| Tier | Condition | Action |
|------|-----------|--------|
| Progress window | No progress for `timeoutMs` | Log WARN |
| Staleness kill | No progress for `timeoutMs × 2` | Resolve with fallback |
| Hard cap | Total elapsed > `timeoutMs × 3` | Resolve regardless of progress |

## Constraints

- **Fallback result must be safe.** The orchestrator must be able to continue from a timeout result.
- **Backward compatible.** If `progressEmitter` is undefined, falls back to single-`setTimeout`.

## Verification

- [ ] Progress events reset the staleness timer
- [ ] Stalled agents resolve with fallback, not indefinite hang
- [ ] Backward-compatible path works without emitter

## Files

| File | Purpose |
|------|---------|
| `.pi/extensions/subagent/agent-runner.ts` | `ProgressEmitter` + progress emission |
| `.pi/extensions/skill/index.ts` | `withAgentTimeout` staleness logic |
| `.pi/extensions/skill/tests/unit/heartbeat.test.ts` | Unit tests (15) |
