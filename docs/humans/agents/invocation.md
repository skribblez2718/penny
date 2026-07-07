# Agent Invocation

## What It Is

Invocation is the moment an agent goes from being a definition file on disk to being a running subprocess doing work. Penny (or a skill orchestrator) calls the `subagent` tool with the agent name and a task description. The subagent extension then assembles a prompt, spawns a Pi process, and returns the agent's structured SUMMARY after the agent finishes.

## Why It Matters

Understanding invocation matters because it explains what an agent can and cannot see. An agent has no conversation history. It does not remember what Penny said three turns ago. It receives only the assembled system prompt and the task message it is given. This isolation is a feature, but it means the caller must provide the right pointers in the task message and store the right context in mempalace.

## How an Agent Is Invoked

The pipeline has four stages:

1. **Request.** Penny or a skill calls `subagent({ agent, task })`, optionally including a `skillContext` path.
2. **Assembly.** The subagent extension reads the agent definition file. If a skill context is provided, it injects the skill's Domain Guidance as a `<skill_context>` block.
3. **Execution.** Pi spawns the agent subprocess with the assembled system prompt plus the task message.
4. **Completion.** The agent writes its full output to mempalace and returns a compact SUMMARY to the caller.

The SUMMARY is typically only a few dozen tokens. The full reasoning, drafts, code, or analysis live in mempalace and are reachable via the pointers in the SUMMARY.

## The Three Invocation Patterns

| Pattern | Use Case | What Happens |
| ------- | -------- | ------------ |
| **Single** | One focused task needs one agent's perspective. | Penny invokes one agent and waits for its SUMMARY. |
| **Parallel** | Several independent perspectives are needed at once. | Penny invokes multiple agents concurrently and later synthesizes their SUMMARYs. |
| **Chain** | The output of one agent is the input to the next. | Agent A produces a draft, Agent B reviews it, Agent C revises it. Each step is explicit. |

Skills often use all three patterns inside one workflow, dispatching agents as the state machine advances.

## What Skill Context Injection Is

When a skill invokes an agent, it provides a path to a Domain Guidance prompt. The subagent extension inserts that prompt as a `<skill_context>` block inside the agent's system prompt, after the agent's role definition but before the `<agent_boundary>`.

This is how the same agent adapts to wildly different domains. Carren reviewing a security skill receives security-specific checklists. Carren reviewing a planning skill receives planning-specific criteria. The agent identity stays constant; the domain lens is swapped in at invocation time.

## What a Good Task Message Contains

Because agents have no memory, the task message must carry everything the agent needs to know right now. A typical task message includes:

- **Goal:** the one-sentence objective.
- **Session:** the session identifier so the agent can read and write to the right mempalace room.
- **Room:** the mempalace room where context and results belong.
- **Constraints:** any hard limits the agent must respect.
- **Context:** pointers to prior mempalace drawers or relevant files.

The task message is deliberately lean. Full context belongs in mempalace, not in the message itself.

## Learn More

- [Agents Overview](overview.md): How agents fit into Penny's reasoning.
- [Agent Definition Format](definition-format.md): What the assembled prompt is built from.
- [Discovery and Tools](discovery-and-tools.md): How Pi decides which tools the agent receives.
- [System Prompt Security](system-prompt-security.md): Where the task message sits relative to security boundaries.
- Agent-facing reference: [Agent Invocation](../../agents/agents/invocation.md)
