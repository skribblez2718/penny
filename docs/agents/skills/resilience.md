# Skill Resilience — Error handling and recovery for skill orchestrators

## What

Skill orchestrators must handle agent failures, malformed SUMMARYs, state corruption, and timeouts gracefully. Never crash; always return an `error` action with diagnostics.

## Why

Skills run in subprocesses with no interactive user. A crash leaves Penny waiting indefinitely. Graceful degradation with clear diagnostics enables recovery.

## Rules

1. **Catch all exceptions at the top level.** Every `start`, `step`, and `status` handler must have a try/except that returns `{"action": "error", "error": "..."}`.
2. **Validate agent SUMMARY before processing.** Reject empty, malformed, or missing SUMMARY fields.
3. **Use safe defaults that never claim completion.** `complete: false`, `valid: false`, `count: 0`.
4. **Retry once on transient failures.** Agent timeout, parse error → retry once before escalating.
5. **State survives subprocess boundaries.** Write to `/tmp/<skill>-<session_id>.json` after every state change.

## Error Handling Matrix

| Error | Behavior |
|-------|----------|
| Agent SUMMARY malformed | Log error, retry once, then error state |
| Agent SUMMARY empty | Log error, error state |
| Parallel task failure | Continue if ≥1 succeeded; all fail → error |
| State restore failure | Redirect to planning with error context |
| Mempalace write failure | Log error, error state |
| Max iterations exceeded | Error state |
| Skill timeout | Error state |

## Constraints

- **Never crash.** Every code path must return a valid JSON action.
- **Never claim completion on error.** `complete: false` in all error paths.
- **Session file is the recovery mechanism.** Write after every state change.

## Verification

- [ ] All exception paths return `{"action": "error", ...}`
- [ ] Malformed SUMMARY rejected with clear error
- [ ] State survives round-trip through file
- [ ] Retry logic works for transient failures

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/orchestration.md` | Orchestrator protocol |
| `docs/agents/skills/testing.md` | Test requirements |
