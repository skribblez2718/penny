# Penny Index

## Reading Documentation

**Default discipline (most docs):** Read only files relevant to the current task. Do not greedily follow all index references — use the descriptions to identify the 1–2 features you need, then drill down.

**Load-bearing exception (system docs):** When you do drill into a file — Pi documentation (extensions, themes, skills, TUI, SDK, providers, models, packages) or Penny system documentation (protocol docs, architecture, capability pages, plans, research) — the following disciplines apply:

- **Read the file completely before acting on it.** Partial reads miss the cross-references that make the guidance work.
- **Follow `.md` cross-references as you encounter them.** They are load-bearing, not decorative.
- **Use `When asked about: ...` and trigger conditions as search anchors, not gates** — the file's structure tells you the rest.

The default discipline protects context window. The exception protects correctness once a doc is in scope. Both are needed.

### Gated protocol docs (exception to the exception)

Penny's procedural protocols live in `docs/penny/` and are indexed in [docs/penny/AGENTS.md](docs/penny/AGENTS.md). SYSTEM.md names each protocol by its **trigger** (e.g. "run the clarification protocol") and carries **no file paths** — resolve the path from that index, then `read` the protocol only when its trigger fires. This is deliberate: file paths to additional knowledge belong in the AGENTS.md index chain, never in the always-on Cognitive Frame. Do not eagerly load these docs.

## Pi Platform

Documentation for the pi agent runtime that Penny is built on. Trigger: the user asks about pi itself (extensions, themes, skills, TUI, SDK, providers, models, packages) — *not* when using those features to do other work.

- Main documentation: `${PI_PACKAGE_DIR}/README.md`
- Additional docs: `${PI_PACKAGE_DIR}/docs`
- Examples: `${PI_PACKAGE_DIR}/examples` (extensions, custom tools, SDK)

**When asked about:**

- **Extensions** → `docs/extensions.md`, `examples/extensions/`
- **Themes** → `docs/themes.md`
- **Skills** → `docs/skills.md`
- **Prompt templates** → `docs/prompt-templates.md`
- **TUI components** → `docs/tui.md` (and its cross-references to `themes.md` / `extensions.md`)
- **Keybindings** → `docs/keybindings.md`
- **SDK integrations** → `docs/sdk.md`
- **Custom providers** → `docs/custom-provider.md`
- **Adding models** → `docs/models.md`
- **Pi packages** → `docs/packages.md`

When working on pi topics, read the docs and examples, and follow `.md` cross-references before implementing. The "load-bearing exception" in the Reading Documentation section applies — these files are densely cross-linked and partial reads miss the links that make the guidance work.

## Index

The documentation is a tree of indexes. This root points only to the two
next-level sub-indexes; each `AGENTS.md` links only to the level below it until
you reach the leaf index that lists the source docs. Drill down — do not expect
every topic to be enumerated here.

- [Agent Documentation](docs/agents/AGENTS.md): everything Penny and her agents follow when performing tasks — agent architecture, capabilities, coding standards, documentation rules, extensions, memory, observability, orchestration, prompts, skills, and state management.
- [Penny Protocols](docs/penny/AGENTS.md): trigger-gated procedural docs — clarification, compaction-resume, routing/delegation, tool-usage (SYSTEM.md names the trigger; paths resolve here).

`.pi/` resources (agents, extensions, skills, prompts, types, settings) are loaded automatically by Pi and are not duplicated in this index. `docs/humans/` is a separate, human-facing tree (WHAT/WHY) and is intentionally NOT part of this agent-facing index chain.
