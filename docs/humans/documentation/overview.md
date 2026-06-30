# The Documentation System

## What It Is

Penny's documentation is split into three categories, each written for a different reader with different needs. The same topics often appear in more than one category, but the tone, depth, and purpose change to match the audience.

| Category | Location | Audience | Purpose |
| -------- | ---------- | -------- | ------- |
| **Agent-facing** | `docs/agents/` | Penny and subagents | Operational HOW-TO: rules, formats, compliance checklists. |
| **Human-facing** | `docs/humans/` | Human users and maintainers | Explanatory WHAT-IS and WHY: concepts, trade-offs, user-visible behavior. |
| **Penny system** | `docs/penny/` | Trigger-gated protocols | Special protocols loaded only when specific conditions are met. |

## How the Categories Differ

### Agent-Facing Docs

Agent-facing docs are written as standards and specifications. They say what must be true, what tools to use, what fields are required, and how to verify compliance. They favor precision over narrative. An agent reading one should know exactly how to behave.

Examples include the agent definition format, the skill standard, and the AGENTS.md standard.

### Human-Facing Docs

Human-facing docs are written as explanations. They describe what something is, why it exists, how it works, and what trade-offs shaped it. They favor concepts over code and include headings like "What It Is," "Why It Matters," and "How It Works."

Examples include this document, the skills overview, and the agents overview.

### Penny System Docs

Penny system docs contain protocols that are loaded only when specific triggers occur. For example, the clarification protocol is read when a task is under-specified or confidence is low. These docs are gated so they do not consume context unless they are actually needed.

## When to Use Which

| Situation | Use |
| --------- | --- |
| You are a human trying to understand Penny's architecture. | `docs/humans/` |
| You are a maintainer writing a new skill or agent. | `docs/agents/` plus the relevant `docs/humans/` overview. |
| Penny needs to know the exact rule for a task. | `docs/agents/` |
| A task is ambiguous, irreversible, or high-stakes. | `docs/penny/` clarification protocol (triggered automatically). |

The two main categories are designed to complement each other. The human docs explain the ideas; the agent docs encode the implementation. Reading only one gives an incomplete picture.

## Why the Split Exists

Humans and agents have different context needs. A human benefits from narrative, history, and rationale. An agent benefits from terse rules and checklists. Trying to serve both audiences with one document usually serves neither well: humans get buried in syntax, and agents get distracted by prose.

By separating the categories, each document can do its job well. Cross-references link them together so readers can move from concept to specification and back again.

## Learn More

- [AGENTS.md Files](agents-md-standard.md): The indexing standard that ties the documentation tree together.
- Agent-facing references: [Agent Docs](../../agents/agents/overview.md), [Skill Docs](../../agents/skills/overview.md), [Documentation Standard](../../agents/documentation/agents-md-standard.md)
