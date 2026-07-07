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

- [Agents](docs/agents/agents/AGENTS.md): Agent architecture, lifecycle, and invocation patterns
- [Architecture](docs/agents/architecture/AGENTS.md): Canonical implementations, Pi alignment, coding standards
- [Capabilities](docs/agents/capabilities/AGENTS.md): Penny features — skills, extensions, tooling, and workflows
- [Coding](docs/agents/coding/AGENTS.md): Python and TypeScript best practices, security anti-patterns
- [Documentation](docs/agents/documentation/AGENTS.md): AGENTS.md indexing rules and standards
- [Extensions](docs/agents/extensions/AGENTS.md): Extension creation procedure and conventions
- [Memory](docs/agents/memory/AGENTS.md): MemPalace tools and knowledge graph patterns
- [Orchestration](docs/agents/orchestration/AGENTS.md): Shared FSM execution engine — BasePlaybook subclasses, checkpointer, self-recovery
- [Prompts](docs/agents/prompts/AGENTS.md): Prompt architecture standards
- [Skills](docs/agents/skills/AGENTS.md): Skill authoring standards and examples
- [Penny Protocols](docs/penny/AGENTS.md): trigger-gated procedural docs — clarification, compaction-resume, routing/delegation, tool-usage (SYSTEM.md names the trigger; paths resolve here)

`.pi/` resources (agents, extensions, skills, prompts, types, settings) are loaded automatically by Pi and are not duplicated in this index.
