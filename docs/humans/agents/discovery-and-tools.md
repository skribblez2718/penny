# Agent Discovery and Tools

## What It Is

Agent discovery is the process by which Pi finds the agent definitions stored in `.pi/agents/` and gives each agent the capabilities declared in its file. There is no central registry or hand-maintained list. Pi walks the directory, reads each `.md` file, parses the YAML frontmatter, and uses what it finds to build the agent subprocess.

## Why It Works This Way

Auto-discovery keeps the roster honest. An agent exists because there is a file for it, and it has exactly the tools its frontmatter declares. There is no risk of an agent being registered in one place but missing or misconfigured in another. This also makes it easy to inspect the entire agent layer: just list the files in `.pi/agents/`.

## How Discovery Works

When Penny or a skill invokes an agent, the subagent extension:

1. Locates the file `.pi/agents/<name>.md`.
2. Parses the YAML frontmatter, especially the `tools:` field.
3. Loads the Markdown body as the agent's role definition.
4. Injects any skill-specific Domain Guidance if one was provided.
5. Spawns a Pi subprocess with the assembled prompt and the declared tools.

If the `tools:` field is malformed or a required memory tool is missing, the agent cannot function correctly. The frontmatter is not decorative — it is the operational source of truth.

## What Tools Agents Get

Every agent's `tools:` list is tailored to its role, but there are common patterns:

| Category | Typical Tools | Purpose |
| -------- | ------------- | ------- |
| **Memory** | `memory_smart_search`, `memory_add_drawer`, `memory_check_duplicate`, `memory_kg_add` | Search, store, deduplicate, and link findings across the system. |
| **Filesystem** | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | Inspect and modify code and documents. |
| **Web** | `web_search`, `web_fetch` | External research and fact checking. |
| **Browser** | `playwright_*` | Automated browser interaction. |
| **User** | `questionnaire` | Structured user input when clarification is needed. |

## Why Memory Tools Are Universal

All eight standard agents must include the four memory tools. They are the shared data plane that lets agents communicate across subprocess boundaries. When one agent finishes investigating, it writes results to mempalace. The next agent can search for those results without anyone having to paste a full report into a task message.

Removing a memory tool from an agent would not make it leaner; it would make it blind. It could no longer look up prior context or contribute to the shared record.

## Why Tool Declarations Stay in Frontmatter

Tools are never declared in the body text, extension code, or environment variables. Putting them only in the YAML frontmatter means Pi has one place to look and one format to parse. Duplicating the list elsewhere invites inconsistency: an agent body might claim it can write files while the frontmatter withholds `write`, leading to confusing failures.

## Learn More

- [Agents Overview](overview.md): How agents are organized and used.
- [Agent Definition Format](definition-format.md): What the frontmatter and body contain.
- [Invocation](invocation.md): How tools are bound to a running agent subprocess.
- [System Prompt Security](system-prompt-security.md): How boundaries protect agent instructions.
- Agent-facing reference: [Agent Discovery and Tools](../../agents/agents/discovery-and-tools.md)
