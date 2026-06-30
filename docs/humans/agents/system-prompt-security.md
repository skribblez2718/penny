# System Prompt Security

## What It Is

System prompt security is the set of boundaries that prevent untrusted content — user messages, tool output, fetched web pages, uploaded files — from overriding the instructions that govern Penny and her agents. The defense is built from three XML-style markers that separate system-role content from user-role content.

## Why It Exists

Large language models are instruction-following systems. If a user message, a malicious web page, or a cleverly crafted document says "ignore previous instructions," the model might comply unless the architecture makes that impossible. Boundary markers enforce a structural answer: system instructions live on one side of a hard line, and everything after that line is treated as untrusted input.

This matters for agents in particular because agents read files, search the web, and process external data. Without boundary enforcement, an adversarial file in the project could rewrite an agent's role.

## How the Boundaries Work

The prompt is assembled in layers, with markers between them:

| Boundary | Role | What It Separates |
| ---------- | ---- | ----------------- |
| **`<system_directives>`** | System | Immutable security rules at the very top. These override all other instructions. |
| **`<system_context>`** | System | The Cognitive Frame — how Penny thinks in general. |
| **Agent body + skill context** | System | The agent's role definition and any domain guidance from the skill. |
| **`<agent_boundary>`** | System end | The end of the agent's trusted system instructions. |
| **Reinforcement + project index + invocation context** | User-side system | AGENTS.md context, date, working directory — necessary but not authoritative. |
| **`<system_boundary>`** | Absolute system end | The final marker before all system-role content ends. |
| **User/task message** | User | The actual untrusted input for this turn. |

Everything after `<agent_boundary>` and especially after `<system_boundary>` is treated as user-role content. User-role content cannot override system-role content.

## Why the Markers Are Effective

The markers work because the architecture treats position as privilege. The model knows that content above `<agent_boundary>` and `<system_boundary>` is system-role and authoritative. Even if a user message contains spoofed tags like "<system_directives>" or claims of admin override, those tags appear after the real boundaries and are therefore in user-role territory.

## What Skill Prompts Must Avoid

Skill Domain Guidance prompts are injected inside the system-role region, before `<agent_boundary>`. Because of that privileged position, they must not contain:

- Template variables such as `{{goal}}` or `{{session_id}}`, which would be filled at runtime from untrusted sources.
- Reserved boundary tags, which would confuse or break the security architecture.
- Instructions that try to relax the immutable security rules.

Dynamic values belong in the task message, which sits safely in user-role space after `<system_boundary>`.

## Learn More

- [Agents Overview](overview.md): Why agents need this protection.
- [Agent Definition Format](definition-format.md): Where `<agent_boundary>` lives in an agent file.
- [Invocation](invocation.md): How task messages are placed after the boundaries.
- Agent-facing reference: [System Prompt Security](../../agents/agents/system-prompt-security.md)
