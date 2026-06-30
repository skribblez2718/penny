# Agent Invocation — How agents are dispatched and executed

## What

Agents are invoked via the `subagent` tool. The subagent extension assembles the system prompt from agent definition + skill context, spawns a Pi subprocess, and returns the agent's SUMMARY.

## Why

Understanding the invocation pipeline is essential for debugging agent behavior, timeout issues, and context injection problems.

## Rules

1. **`subagent({ agent, task })` for direct invocation.** Penny calls this directly for ad-hoc delegation.
2. **`subagent({ agent, task, skillContext })` for skill invocation.** The skill orchestrator provides the skill context path.
3. **Task message includes goal, session ID, mempalace room.** Format: `Goal: <goal> | Session: <id> | Room: <room>`
4. **Agents have no conversation history.** Pass all needed context in the task message or via mempalace pointers.

## Assembly Pipeline

```
1. Subagent extension reads agent file (.pi/agents/<name>.md)
2. If skillContext provided, reads skill prompt and injects as <skill_context>
3. Combines: agent body + <skill_context> + <agent_boundary>
4. Writes to temp file → passes via --append-system-prompt
5. Pi assembles: SYSTEM.md + temp file + AGENTS.md + date/cwd + <system_boundary>
6. Task message becomes user message after <system_boundary>
```

## Task Message Template

```
Goal: <one-sentence goal>
Session: <session_id>
Room: <mempalace_room>
Constraints: <hard limits, if any>
Context: <mempalace pointers, if any>
```

## Constraints

- **Task message ≤100 tokens for `task_summary`.** Full context in mempalace.
- **No Cognitive Frame or Role Definition repeats in task message.**
- **No template variables in task message.** Dynamic values only.

## Verification

- [ ] Task message includes goal, session ID, mempalace room
- [ ] Agent SUMMARY returned to caller, full output in mempalace
- [ ] No conversation history leaked to agent

## Files

| File | Purpose |
|------|---------|
| `.pi/extensions/subagent/index.ts` | Subagent extension implementation |
| `.pi/extensions/subagent/agent-runner.ts` | Agent process management |
| `docs/agents/agents/overview.md` | Agent architecture overview |
