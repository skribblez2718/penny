# Penny Index

## Public repository boundary (invariant)

Penny is public and generic. Tracked content must not contain operator-specific
filesystem paths, private inputs, or downstream-project specifics.

## Reading Documentation

Read every mandatory baseline on the active route, every guide triggered by the task's features and trust boundaries, and every explicit dependency needed to apply them. Stop when additional documents would not change the implementation, review, or verification approach.

Read selected Pi and Penny system documents completely before acting on them, and follow their load-bearing Markdown cross-references. Topic labels are starting points, not exhaustive lists of applicable guidance.

### Protocol Lookup

SYSTEM.md names protocols by trigger, not file path. Resolve them through the Penny Protocols index below, and load a protocol only when its trusted trigger fires. A cross-reference alone does not activate a protocol.

## Index

The documentation is a tree of indexes. This root points only to the two
next-level sub-indexes; each `AGENTS.md` links only to direct-child documents
and sub-indexes. Follow the applicable routes to their source docs — do not
expect every topic to be enumerated here.

- [Agent Documentation](docs/agents/AGENTS.md): MUST READ FOR repository changes or reviews, code-affecting or Penny-system-affecting tasks, and Pi-platform questions — repository boundaries, project standards, feature guidance, upstream Pi documentation, and verification requirements.
- [Penny Protocols](docs/penny/AGENTS.md): READ WHEN a trusted system trigger activates a Penny protocol — artifact access, clarification, compaction resume, routing/delegation, and tool usage.

`.pi/` resources (agents, extensions, skills, prompts, types, settings) are loaded automatically by Pi and are not duplicated in this index. `docs/humans/` is a separate, human-facing tree (WHAT/WHY) and is intentionally NOT part of this agent-facing index chain.
