# Skill Invocation Extension

Drives Python-based skill orchestration using the subagent tool for agent invocation.

## Architecture

```
Penny → skill tool → TypeScript loop:
  1. Call Python orchestrate.py → get next action
  2. Invoke subagent tool → agent runs in isolated context
  3. Extract SUMMARY from agent output → feed to Python
  4. Repeat until complete or error
  5. Return final result to Penny
```

**Key principle: Mempalace-first communication.** Agents read/write mempalace directly. The extension only passes structured summaries (findings_count, verdict, step_count) to the orchestrator. Penny's context window stays clean.

## How It Works

1. Penny invokes the `skill` tool with `skill_name` and `goal`
2. The extension calls `python3 orchestrate.py start` to get the first action
3. For each action:
   - `invoke_agent` → calls `ctx.tools.subagent()` with the agent name, task, and optional skillContext
   - `invoke_agents_parallel` → calls `ctx.tools.subagent()` in parallel mode
4. Extracts the SUMMARY block from agent output (not full output)
5. Feeds summary back to `python3 orchestrate.py step`
6. Loops until `complete` or `error`
7. Returns structured result to Penny

## Mempalace-First Design

| What                             | Where                | Why                       |
| -------------------------------- | -------------------- | ------------------------- |
| Full explore findings            | Mempalace            | Downstream agents read it |
| Full plan text                   | Mempalace            | Critique agent reads it   |
| Full critique                    | Mempalace            | Taskifier reads it        |
| Full structured plan             | Mempalace            | Final deliverable         |
| SUMMARY blocks (counts, verdict) | Orchestrator         | Minimal state tracking    |
| Orchestrator state               | Python state machine | Workflow progression      |

Penny never sees full agent output. The skill tool result shows only: session ID, phases completed, step count, and success/failure.

## Parameters

| Parameter      | Type   | Description                                 |
| -------------- | ------ | ------------------------------------------- |
| `skill_name`   | string | Name of the skill to invoke (e.g., "plan")  |
| `goal`         | string | The goal or objective                       |
| `session_id`   | string | Optional unique session ID (auto-generated) |
| `project_root` | string | Optional project root directory             |
| `constraints`  | object | Optional additional constraints             |

## Agent Invocation

The skill extension delegates to the **subagent extension** for all agent invocation:

- Uses `ctx.tools.subagent()` — same proven code path as manual subagent calls
- Passes `skillContext` pointing to the skill's agent prompt file
- Sets `agentScope: "project"` — agents are discovered from `.pi/agents/`

This means:

- Agent invocation gets all subagent features: streaming, TUI rendering, error handling, agent_end grace period
- Subagents run with `--session-dir` so the Penny compaction extension fires on context limits
- No duplicated agent spawning code
- Consistent behavior between manual and skill-driven invocations

## Subagent Tool vs. Previous invokeAgent()

The skill extension previously had its own `invokeAgent()` function that duplicated the subagent extension's logic. This has been replaced with `ctx.tools.subagent()`:

| Aspect             | Old (invokeAgent)                     | New (ctx.tools.subagent)                              |
| ------------------ | ------------------------------------- | ----------------------------------------------------- |
| Code path          | Duplicated spawn logic                | Single proven code path                               |
| Agent discovery    | `loadAgentSystemPrompt()` from file   | `discoverAgents()` from subagent extension            |
| Streaming          | No TUI rendering                      | Full TUI rendering, progress updates                  |
| Skill context      | Separate `--append-system-prompt` arg | `skillContext` parameter (subagent handles injection) |
| Error handling     | Custom ad-hoc                         | Proven (agent_end grace, timeout, abort)              |
| Tool filtering     | Custom BUILTIN_TOOLS set              | Subagent extension's built-in filter                  |
| Maintenance burden | High (duplicate code)                 | Low (single source of truth)                          |

## Session Room Lifecycle

Each skill invocation creates a mempalace room `skills/plan-{session_id}`:

- Agents read from and write to this room
- The room is specified in each agent's `task_summary` by the orchestrator
- On completion, the final deliverable is graduated to `completed-plans`

## Testing

The suite is written for **Vitest** (`vi.mocked`, module mocks). Do **not** run
`bun test` — bun's mock API differs and produces false failures. Use the
package.json scripts (which invoke `bunx vitest run --config ...`):

```bash
cd .pi/extensions/skill
bun install
bun run test              # unit    → tests/vitest.config.ts
bun run test:integration  # integration
bun run test:e2e          # e2e (must run from the project root — uses process.cwd())
```
