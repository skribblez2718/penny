# The Skill Standard

## What It Is

The skill standard is the contract that every Penny skill must satisfy. It covers four things: the SKILL.md manifest format, the orchestrator protocol, the Domain Guidance prompts, and the testing requirements. Following the standard ensures Pi can discover the skill, Penny can route to it correctly, and the agents inside it receive the right instructions.

## Why Standards Matter

Skills run inside a larger system. Pi reads their manifests to decide when to invoke them. Penny trusts their orchestrators to emit valid action directives. Agents rely on their Domain Guidance prompts for context. If every skill invented its own conventions, the integration points would break constantly.

A common standard also makes skills easier to write and easier to maintain. New skills start from a scaffold, so authors spend time on the workflow logic, not on boilerplate.

## What the Standard Covers

### 1. SKILL.md Manifest

Every skill has a `SKILL.md` file at its root. The file contains:

- YAML frontmatter with the skill name, description, version, and metadata flags.
- A Markdown body explaining when to use the skill, when not to use it, and the invocation syntax.

The manifest is the Project Index layer: it tells Penny when to reach for the skill. It is not the place for deep domain guidance; that lives in `assets/prompts/`.

### 2. Orchestrator Protocol

The `scripts/orchestrate.py` file is a Python state machine that communicates with Penny through JSON action directives printed to stdout. It must support at least:

- `start`: initialize the workflow and return the first action.
- `step`: accept the result of the previous action and return the next action.
- `status` (or `result`): report the final outcome.

This protocol decouples the skill's logic from Penny's execution engine. The skill decides what to do next; Penny handles how to invoke the requested agents and tools.

### 3. Domain Guidance Prompts

For every agent role a skill uses, there is a matching prompt file in `assets/prompts/`. These prompts provide the domain-specific instructions that transform a generic agent into a domain expert for this workflow. They are injected at invocation time and sit before the agent's `<agent_boundary>`.

### 4. Testing Requirements

Every skill must have unit, integration, and E2E tests. This is not optional. Skills are too complex to verify by inspection alone; the state machine, serialization, and agent interactions all need automated coverage.

## What Makes a Well-Formed Skill

A well-formed skill is one you can hand to another maintainer and they will immediately know:

- What problem it solves.
- When Penny should use it.
- Which agents are involved and what each one does.
- How to run and test it.
- Where the state is stored and how it recovers from failure.

That clarity comes from following the standard layout, writing a clear manifest, and including comprehensive tests.

## Learn More

- [Skills Overview](overview.md): What skills are and how they compare to agents.
- [Orchestration](orchestration.md): How the orchestrator protocol works.
- [Testing](testing.md): How skills are tested.
- Agent-facing reference: [Skill Standard](../../agents/skills/skill-standard.md)
