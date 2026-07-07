# Subagent Extension

Delegate tasks to specialized agents with isolated context windows.

## Modes

### Single Task

Execute one subagent task:

```typescript
subagent({
  agent: "reviewer",
  task: "Review the authentication module for security issues",
});
```

### Parallel Tasks

Execute multiple tasks concurrently:

```typescript
subagent({
  tasks: [
    { agent: "reviewer", task: "Review auth module" },
    { agent: "reviewer", task: "Review database module" },
    { agent: "reviewer", task: "Review API module" },
  ],
});
```

### Chain Tasks

Execute tasks sequentially, passing output to next:

```typescript
subagent({
  chain: [
    { agent: "analyzer", task: "Analyze the codebase structure" },
    { agent: "reviewer", task: "Review the main files identified by {previous}" },
    { agent: "summarizer", task: "Summarize the findings from {previous}" },
  ],
});
```

## Features

- **Isolated Context**: Each subagent gets a fresh context window
- **JSON Output Capture**: Captures structured output from subagents
- **Usage Tracking**: Reports token usage, cost, and turn count
- **Progress Reporting**: Real-time progress updates to parent

## Parameters

| Parameter              | Type    | Description                                                           |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `agent`                | string  | Agent name (single mode)                                              |
| `task`                 | string  | Task description                                                      |
| `tasks`                | array   | Parallel tasks array                                                  |
| `chain`                | array   | Sequential chain array                                                |
| `cwd`                  | string  | Working directory (optional)                                          |
| `agentScope`           | string  | "project" (default), "user", or "both" — all resolve to `.pi/agents/` |
| `confirmProjectAgents` | boolean | Skip project agent prompt (default: false = no prompt)                |
| `skillContext`         | string  | Path to skill prompt file or inline content (optional)                |

## Agent Discovery

Agents are discovered from the project's `.pi/agents/` directory:

- `.pi/agents/<agent-name>.md` — Agent definition with YAML frontmatter

There is **no user-level agent directory** — all agents live in the project.

Each agent `.md` file should contain:

- YAML frontmatter with `name`, `description`, `tools`, `model`
- Agent system prompt as the body

## Events

| Event                  | Purpose                  |
| ---------------------- | ------------------------ |
| `tool_execution_start` | Before spawning subagent |
| `tool_result`          | After subagent completes |

## Testing

```bash
cd .pi/extensions/subagent
bun install
bun test
```

## Skill Context Injection

The `skillContext` parameter injects skill-specific prompt content into the subagent's system prompt. This enables generic agents to be reused across different skills — each skill provides domain-specific guidance.

### How It Works

1. Pass `skillContext` as a file path (relative to cwd or absolute) or inline content
2. The extension resolves the path (reads file if it exists, otherwise uses as inline)
3. Content is wrapped in `<skill_context>` tags and inserted BEFORE `<agent_boundary>`
4. The combined prompt (agent body + skill context + boundary) goes to `--append-system-prompt`

### Example

```typescript
// Single mode with skill context
subagent({
  agent: "echo",
  task: "Explore for session plan-001. Goal: Refactor auth.",
  skillContext: ".pi/skills/plan/assets/prompts/echo.md",
});

// Parallel mode with per-task skill context
subagent({
  tasks: [
    { agent: "echo", task: "...", skillContext: ".pi/skills/plan/assets/prompts/echo.md" },
    { agent: "echo", task: "...", skillContext: ".pi/skills/plan/assets/prompts/echo.md" },
  ],
});
```

### Resulting System Prompt Structure

```
Agent body (generic role, tools, rules)
<skill_context>
  Skill-specific domain guidance
  Output format requirements
  Non-negotiable rules for this skill
</skill_context>
<agent_boundary>
  SECURITY REINFORCEMENT
</agent_boundary>
```

### Security

- Skill prompts must be **pure static content** — no template variables (`{{goal}}`, `{{session_id}}`)
- Dynamic data belongs in the task message (user role), not in the system prompt
- Skill prompts must NOT contain reserved security tags (`<system_directives>`, `<agent_boundary>`, etc.)

## Architecture

```
┌────────────────────────────────────────┐
│           Parent Agent                  │
│  ┌─────────────────────────────────┐   │
│  │ subagent tool call              │   │
│  │ { agent: "reviewer", task: ... }│   │
│  └─────────────────┬───────────────┘   │
└────────────────────┼──────────────────┘
                     │
                     ▼
┌────────────────────────────────────────┐
│          spawn(pi subprocess)          │
│  ┌─────────────────────────────────┐   │
│  │ Session directory (--session-dir)│  │
│  │ Penny compaction extension (-e) │   │
│  │ Agent prompt + task             │   │
│  │ JSON mode for structured output │   │
│  └─────────────────────────────────┘   │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│          Subagent Execution            │
│  - Executes task                      │
│  - Uses tools                         │
│  - Compaction fires on context limit  │
│  - Returns structured result          │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│          Result Processing             │
│  - Parse JSON output                  │
│  - Extract usage stats                │
│  - Format for parent display          │
│  - Clean up session directory         │
└────────────────────────────────────────┘
```

## Output Format

Subagents return:

```typescript
{
  content: string,        // Main result text
  details: {
    usage: {
      input: number,
      output: number,
      cost: number,
      turns: number,
      contextTokens: number
    },
    model: string,
    output: object      // Parsed JSON if available
  }
}
```

## Parallel Execution

- Max concurrent tasks: 4 (configurable)
- Max total tasks: 8
- Results collected in order

## Chain Execution

- Tasks run sequentially
- `{previous}` placeholder replaced with prior output
- Stops on first error (optional: continue)
