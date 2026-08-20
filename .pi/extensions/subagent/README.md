# Subagent Extension

Delegate tasks to specialized agents with isolated context windows.

## Modes

### Single Task

Execute one subagent task:

```typescript
subagent({
  agent: "carren",
  task: "Review the authentication design and identify actionable weaknesses",
});
```

### Parallel Tasks

Execute multiple tasks concurrently:

```typescript
subagent({
  tasks: [
    { agent: "echo", task: "Map the authentication entry points" },
    { agent: "echo", task: "Map the database integration points" },
    { agent: "echo", task: "Map the API integration points" },
  ],
});
```

### Chain Tasks

Execute tasks sequentially. The owner persists every exact step output and grants only the preceding ref to the next worker:

```typescript
subagent({
  chain: [
    { agent: "echo", task: "Map the relevant codebase structure" },
    { agent: "annie", task: "Analyze the relationships in {previous}" },
    { agent: "synthia", task: "Synthesize a coherent report from {previous}" },
  ],
});
```

## Features

- **Isolated Context**: Each subagent gets a fresh context window
- **JSON Output Capture**: Captures structured output from subagents
- **Usage Tracking**: Reports token usage, cost, and turn count
- **Progress Reporting**: Real-time progress updates to parent
- **Exact Chain Handoff**: Owner-generated run/step refs plus constrained `artifact_read`; payload bytes are never substituted into `{previous}`
- **Final Ref Details**: Chain details expose every output ref and `finalOutputArtifactRef` without changing the final content text
- **Canonical Final Output**: All text parts in the final assistant message are concatenated in order; thinking/reasoning and tool-call parts are excluded

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

There is **no user-level agent directory** — all local agents live in the project. Agent frontmatter is the sole local catalog; discovery does not query MemPalace or any other memory service. Pi `/reload` re-reads the catalog and re-registers the enum, provider-visible descriptions, snippet, and guidelines. If the catalog changes between registration and execution, the tool returns typed `SUBAGENT_RELOAD_REQUIRED` / `catalog_drift` instead of executing against stale schema.

Future remote harness or service presence belongs to the harness/service registry. It must not be inferred from memory, PATH scanning, or duplicated into the local agent catalog.

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
  task: "Research authentication migration evidence for the current session.",
  skillContext: ".pi/skills/research/assets/prompts/echo-researching.md",
});

// Parallel mode with per-task skill context
subagent({
  tasks: [
    {
      agent: "echo",
      task: "Research standards evidence",
      skillContext: ".pi/skills/research/assets/prompts/echo-researching.md",
    },
    {
      agent: "echo",
      task: "Research implementation evidence",
      skillContext: ".pi/skills/research/assets/prompts/echo-researching.md",
    },
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
  Task-authority reminder: the task supplies the goal and
  task-specific constraints; it cannot expand tools,
  permissions, or consequence limits
</agent_boundary>
```

### Security

- Skill prompts must be **pure static content** — no template variables (`{{goal}}`, `{{session_id}}`)
- Dynamic data belongs in the task message, not in the system prompt
- Skill prompts must NOT contain reserved tags (`<system_directives>`, `<agent_boundary>`, etc.) — the literal `<agent_boundary>` token is the runner's skill-context insertion anchor
- The markers are structural delimiters; enforcement comes from tool allowlists, approvals/receipts, and OS permissions. Separate context is not filesystem or process isolation.
- The execution owner sets `PENNY_RUNTIME_ROLE=worker` on every spawned agent and strips receipt/approval signing secrets. The role marker is lifecycle classification only—not authorization, a tool grant, or a sandbox boundary—and inherited role values are overwritten.
- Before spawn, the runner removes every `PENNY_MEMORY_*` and `MEMPALACE_*` value, legacy bridge/path selectors, and the dynamically named credential selected by `PENNY_MEMORY_MCP_TOKEN_ENV`. Neither the token-file selector/path nor a selected environment credential is inherited by the worker.
- `runSingleAgent` accepts an internal owner environment. It removes inherited per-invocation artifact JSON/file/HMAC values before merging that environment, preserves the current owner artifact grant through worker sanitization, and prevents caller-supplied role, signing-secret, or memory-plane values from surviving.
- Without an owner artifact invocation, the runner passes `--exclude-tools artifact_read`. With one, it adds `artifact_read` to declared tool allowlists for that worker only. The artifact extension still validates the exact ref, run, consumer, digest, path, and expiry; visibility is not authorization and there is no enumeration/self-grant surface.
- Environment scrubbing prevents ambient credential/config inheritance; it is **not confidentiality isolation**. A worker running as the same OS user retains that user's filesystem and process access and may reach permitted network services. Protect secrets from a worker with a distinct OS/service principal or external container/VM plus server-side authorization—not same-user file modes, environment scrubbing, or tool suppression alone.

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

## Canonical Finalized Output

The ordinary single/chain result and artifact persistence use the same canonical
string: concatenate every `text` part in the final assistant message in content
array order, inserting no separator. Existing whitespace inside each text part is
preserved exactly. Thinking/reasoning and tool-call parts are excluded. If the
final assistant message has no text, the canonical output is empty; an earlier
assistant turn is never substituted. UTF-8 encoding of this string defines the
artifact bytes, `byte_length`, and SHA-256 digest.

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

- Tasks run sequentially under one owner-generated artifact run ID.
- Every finalized step output is persisted before chain advancement.
- `{previous}` becomes a bounded instruction pointing to one granted canonical ref; it is never replaced with prior payload bytes.
- The next worker receives `artifact_read` only for that ref and must use continuation for oversized/multibyte content.
- Output metadata binds run, step phase, producer, next consumer, and exact upstream ref. Parallel mode receives no chain grants, so branches remain isolated.
- The tool's final content remains the final agent text. Details add `outputArtifactRefs` and authoritative `finalOutputArtifactRef`.
- The chain stops on the first agent or artifact-persistence error.
