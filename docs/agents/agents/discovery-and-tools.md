# Agent Discovery and Tools — How agents get their capabilities

## What

Agent tool access is declared in YAML frontmatter `tools:` field. Pi parses this and passes it to `--tools`. No other tool declaration mechanism exists or is valid.

## Why

The `tools:` field is the single source of truth. Duplicating tool lists in agent body, extension code, or environment variables creates inconsistency and silent failures.

## Rules

1. **`tools:` in YAML frontmatter is the only tool declaration.** Pi parses it → `--tools` flag.
2. **All four memory tools required** — the canonical list + rationale lives in [memory/integration.md](../memory/integration.md#base-tool-set) (the Memory row below enumerates them).
3. **Extensions are always loaded.** `--no-extensions` is never used. Our tools ARE extensions.
4. **Tool names must match exactly.** Case-sensitive. `memory_smart_search` ≠ `memory_Smart_Search`.

## Tool Categories

| Category | Tools | Purpose |
|----------|-------|---------|
| **Memory** | `memory_smart_search`, `memory_add_drawer`, `memory_check_duplicate`, `memory_kg_add` | Inter-agent communication |
| **Filesystem** | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | Code and file operations |
| **Web** | `web_search`, `web_fetch` | External research |
| **Browser** | `playwright_*` | Browser automation |
| **User** | `questionnaire` | Structured user input |

## Constraints

- **Never add tools to agent body text.** Only YAML frontmatter `tools:` is parsed.
- **Never remove memory tools from any agent.** They are the shared data plane.
- **Tool names are case-sensitive and must match extension registration exactly.**

## Verification

- [ ] All agents have `tools:` in YAML frontmatter
- [ ] All four memory tools present
- [ ] No tool lists duplicated in agent body text
- [ ] Tool names match registered extension tool names

## Files

| File | Purpose |
|------|---------|
| `docs/agents/agents/definition-format.md` | Agent file structure |
| `docs/agents/agents/overview.md` | Agent architecture overview |
