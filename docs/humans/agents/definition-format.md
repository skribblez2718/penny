# Agent Definition Format

## What It Is

Every agent is defined by a single Markdown file in `.pi/agents/<name>.md`. The file has two parts: a short YAML frontmatter block at the top, followed by a human-readable body that describes the agent's purpose, rules, and output format. This structure is the contract between the people who design agents and the Pi runtime that loads them.

## Why This Format Was Chosen

Putting tool declarations in YAML frontmatter and role guidance in Markdown body gives each section a single, unambiguous job. Pi can parse the frontmatter mechanically to decide which tools an agent receives. Humans and models can read the Markdown body to understand the agent's behavior. If the same information were scattered across code, comments, and separate config files, agents would silently break when one copy drifted out of sync.

The format also mirrors how skills and prompts are structured across the project, so there is one consistent pattern for defining reusable reasoning components.

## How the File Is Structured

### YAML Frontmatter

The top of the file is a YAML block between triple dashes. It declares:

| Field | What It Tells Pi |
| ----- | ---------------- |
| `name` | The internal identifier used when invoking the agent. |
| `description` | A one-line routing hint: what the agent is, what to use it for, and what not to use it for. |
| `tools` | The exact list of tools the agent is allowed to call. |
| `model` | Which model runs the agent subprocess. |

The `tools` list is the single source of truth. Pi reads it and passes it to the runtime. Nothing in the agent body can grant or remove tools.

### The Body Sections

After the frontmatter, the body explains the agent in plain language. The standard sections are:

| Section | What It Covers |
| --------- | -------------- |
| **Purpose** | The agent's cognitive domain — what it is, what it does, what it does *not* do, and the standing rule that domain criteria come from the skill's guidance, never baked in. |
| **Working Discipline** | A compact block of "wire formats": read/write through mempalace, one role-specific honesty rule, the confidence vocabulary the engine parses, and the `needs_clarification` escape hatch. |
| **Non-Negotiables** | The durable rules only this agent needs — consequence boundaries (read-only, no-execution), evidence contracts, honesty contracts — stated as outcomes, never as step-by-step procedure. |
| **Output** | The generic shape of what the agent produces; the exact schema comes from the skill's Domain Guidance. |
| **`<agent_boundary>`** | A security marker at the very end that separates agent system instructions from invocation context. |

## What Each Section Does

**Purpose** is the agent's identity in one sentence. It answers the question "What kind of thinker is this?" rather than "What tasks can it do today?"

**Mempalace-First Protocol** is the agent's workflow for memory hygiene. Before acting, it searches for relevant prior work. After acting, it stores outcomes and links them into the knowledge graph so future agents can find them.

**Working Discipline** carries only what the orchestration engine actually consumes — the confidence vocabulary (CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN), the `needs_clarification` signal, and the mempalace read/write cycle — plus one honesty rule specific to the role (for the verifier: "passes carry evidence too"; for the explorer: "found and not-found are both findings"). An earlier design restated the universal frame's disciplines inside every agent ("surface assumptions, declare confidence, verify before delivering"); that section was retired because it repeated per-agent what the always-on frame already says — tokens spent restating what a capable model already carries.

**Non-Negotiables** are the agent's special constraints. For example, Carren is read-only and never rewrites; Skribble must write generated files to `/tmp/` or mempalace unless the task explicitly names a project path. These rules belong in the agent definition because they are tied to the role, not to any particular skill — and they are written as *outcomes that must hold*, not instructions on how to work. Consequence boundaries (read-only, no-execution, scope limits) are permanent; anything that merely compensates for a current model's weakness is treated as temporary and is re-measured when models improve.

**Output** sets expectations. Agents typically write full output to mempalace and return a small structured SUMMARY that tells Penny whether the task succeeded, what confidence level applies, and where to find details.

## Why Domain-Specific Details Stay Out

Agent definitions intentionally avoid domain-specific checklists or templates. Those belong in a skill's Domain Guidance prompts. Keeping agents domain-agnostic means the same Carren can review a security plan, an architecture document, or a research summary. The skill supplies the domain lens; the agent supplies the critical eye.

## Learn More

- [Agents Overview](overview.md): How agents fit into the broader system.
- [Discovery and Tools](discovery-and-tools.md): How Pi reads these files and assigns tools.
- [Invocation](invocation.md): How the body is assembled into a running agent prompt.
- [System Prompt Security](system-prompt-security.md): Why the boundary marker matters.
- Agent-facing reference: [Agent Definition Format](../../agents/agents/definition-format.md)
