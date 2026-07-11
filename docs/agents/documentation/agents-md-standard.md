# AGENTS.md Standard

## Purpose

AGENTS.md files are **indexes only**. They reference documentation, never contain it. This conserves context windows — Penny and agents read ONLY the specific document they need, never the entire index.

## Rules

1. **AGENTS.md = lookup table.** Contains document names, paths (relative), and one-line descriptions. Nothing else.
2. **No content in AGENTS.md.** No rules, no standards, no explanations, no cross-cutting references, no architecture descriptions, no quick-reference summaries. Those belong in individual documents.
3. **Relative paths.** Links use relative paths from the AGENTS.md file location. E.g., `agents/AGENTS.md` links to `overview.md`, not `docs/agents/agents/overview.md`.
4. **One entry per document.** List format: `- [Document Title](filename.md): One-line description`
5. **Direct children only.** An AGENTS.md may only reference its immediate directory contents:
   - A leaf `.md` file in the same directory.
   - A subdirectory's `AGENTS.md` that is a direct child of the current directory.
   - Never link across directories (e.g., `../other/file.md`) and never skip levels (e.g., `subdir/nested/file.md`).
6. **Keep current.** When a document is added, moved, or removed, update the index immediately. Stale indexes waste agent time.

## Why

- **Context conservation**: Penny and agents have limited context windows. Loading an entire index + all documents forces the model to process irrelevant content.
- **Precise retrieval**: An agent needing "how to write a skill prompt" reads `prompts/role-and-domain-standards.md`, not the entire prompts index.
- **Maintenance clarity**: When the index IS the documentation, it becomes impossible to tell what's index and what's content. Keep the boundary strict.

## Reading Documentation Discipline

AGENTS.md files are navigation, not instruction. The following discipline governs how Penny and agents consume them:

**Default discipline (most docs):** Read only files relevant to the current task. Do not greedily follow all index references — use the descriptions to identify the 1–2 features needed, then drill down.

**Load-bearing exception (system docs):** When drilling into a system documentation file (architecture, capability pages, prompt standards, coding standards), the following applies:
- Read the file completely before acting on it. Partial reads miss cross-references that make the guidance work.
- Follow `.md` cross-references as they are encountered. They are load-bearing, not decorative.

**Gated protocol docs:** Files in `docs/penny/` are trigger-gated — loaded only when the trigger condition in the system prompt is met. All other system docs follow the default discipline + load-bearing exception.

The default discipline protects context window. The exception protects correctness once a doc is in scope.

## Paths live in the index chain, never in SYSTEM.md

`.pi/SYSTEM.md` (the always-on Cognitive Frame) carries **triggers and reasoning only — never file paths**. When a cognitive rule needs a companion doc, SYSTEM.md names it by trigger ("run the clarification protocol"); the **file path lives in the AGENTS.md index chain**, and Penny resolves it there:

`SYSTEM.md trigger → root AGENTS.md (always in context) → sub-index AGENTS.md → the leaf AGENTS.md that lists the actual docs → the doc`

Each `AGENTS.md` points only to the next level down; the leaf `AGENTS.md` (the one sitting in the directory where the source docs live) is the single source of truth for those paths. This is deliberate and load-bearing: **embedding knowledge paths in SYSTEM.md is the primary cause of Cognitive-Frame bloat** — every path added there is paid on every turn and multiplied into every subagent. Keep them in the index chain, where they cost nothing until the moment they're needed.

## Docs reflect current state — no deprecation ledgers

Documentation describes the system as it is **now**, not its history. Do not keep
deprecation ledgers, "removed in vX" notes, or migration-tracking tables in the
docs tree — they add permanent context-noise, drift out of sync, and duplicate
what version control already records. When something is removed or replaced,
**update or delete its docs in the same change** so docs, code, and other files
stay in sync. Point-in-time planning/research under `research/` is a historical
archive and is exempt: it records what was decided at a moment in time and may
reference things later removed.

## docs/humans/ carries no AGENTS.md

`docs/humans/` is written for **people to read and navigate directly** — not for
Penny's on-demand index walk. It therefore has **no `AGENTS.md` index files** and
is **not linked from the `docs/agents/` index chain or the root `AGENTS.md`**.
Human navigation relies on prose and `index.md` files, not the agent-facing
lookup tables.

The two trees stay deliberately parallel: `docs/agents/` is **HOW** Penny and her
agents work (agent-facing, index-walked), `docs/humans/` is **WHAT/WHY** for a
human audience. When a change touches a concept documented in both, update both
so they do not drift.

This is machine-enforced by `scripts/system/checks/check_agents_links.py`, which
fails if any `AGENTS.md` appears anywhere under `docs/humans/`.

## Pi Auto-Discovery Behavior

Pi loads AGENTS.md by walking UP from the current working directory to the filesystem root, not DOWN into subdirectories. This means:
- The root `AGENTS.md` is always loaded (it's on the upward path) — it is the entry point of the index chain above.
- Nested `docs/**/AGENTS.md` files are **never auto-loaded by Pi** — they are read on demand by Penny's `read` tool as it walks the chain.
- The root AGENTS.md is the entry point; nested AGENTS.md files are navigation within a sub-tree.

## Example

```markdown
# Prompts Feature Index

- [Architecture](architecture.md): Layer structure, token budgets, compliance principles
- [Layer Reference](layer-reference.md): Named layers, responsibilities, interaction circumstances
```

That is the entire file. No more, no less.
