# Agent Discovery and Tools

Pi discovers local worker roles from `.pi/agents/*.md`. That directory is a
catalog: each file's frontmatter declares the name, routing description, model,
and tool allowlist. Reloading Pi refreshes the registered catalog snapshot;
running against a changed snapshot fails instead of silently using stale schema.

The local catalog does not search durable memory, inspect prior runs, or scan the
system for services. Remote harness/service availability belongs to its own
service registry.

## Worker tools

Tools are granted through **named authority profiles**, not one at a time. Each role
declares how much authority it may hold and which bundles it draws from; a CI check
asserts the bundles expand to exactly the tool list, so the declared authority and the
real permission envelope cannot drift apart. See
[Tool Authority Profiles](tool-profiles.md) for why this exists and what it does and
does not guarantee.

Read-only investigators receive file, web, and observation-level browser tools;
creators receive scoped write/generation tools. Every role lists `artifact_read` for
exact current-run grants, but the runner suppresses it when no grant exists.

The honest limit: browser authority is enforced structurally, but every agent still
holds `bash`, so a "read-only" role can still change the filesystem. That gap is
documented rather than hidden, and nothing here should be read as claiming read-only is
fully enforced.

No worker receives `memory_*` tools. Durable recall, curated writes, the primary
diary, and temporal KG operations stay with the unmarked primary runtime.

Tool visibility is not artifact permission. The artifact service separately
checks the exact ref, consumer, run, digest, expiry, and continuation cursor and
has no list/search/self-grant interface.

## Tool authority profiles

Each agent also declares `authority` (the maximum authority class: `read`,
``write`, or `inspect`) and `tool_profiles` (the named rungs that expand to its
`tools:` list). The expansion must match exactly; drift fails the build.

See [Tool Authority Profiles](tool-profiles.md) for the full ladder, per-agent
assignment, and the limits of the guarantee.

## Learn more

- [Agents](overview.md)
- [Definition Format](definition-format.md)
- [Tool Authority Profiles](tool-profiles.md)
- [Invocation](invocation.md)
- Agent reference: [Discovery and Tools](../../agents/agents/discovery-and-tools.md)
