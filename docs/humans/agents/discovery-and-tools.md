# Agent Discovery and Tools

Pi discovers local worker roles from `.pi/agents/*.md`. That directory is a
catalog: each file's frontmatter declares the name, routing description, model,
and tool allowlist. Reloading Pi refreshes the registered catalog snapshot;
running against a changed snapshot fails instead of silently using stale schema.

The local catalog does not search durable memory, inspect prior runs, or scan the
system for services. Remote harness/service availability belongs to its own
service registry.

## Worker tools

Tools are role-specific. Read-only investigators may receive file, web, and
browser tools; creators may receive scoped write/generation tools. Every role
lists `artifact_read` for exact current-run grants, but the runner suppresses it
when no grant exists.

No worker receives `memory_*` tools. Durable recall, curated writes, the primary
diary, and temporal KG operations stay with the unmarked primary runtime.

Tool visibility is not artifact permission. The artifact service separately
checks the exact ref, consumer, run, digest, expiry, and continuation cursor and
has no list/search/self-grant interface.

## Learn more

- [Agents](overview.md)
- [Definition Format](definition-format.md)
- [Invocation](invocation.md)
- Agent reference: [Discovery and Tools](../../agents/agents/discovery-and-tools.md)
