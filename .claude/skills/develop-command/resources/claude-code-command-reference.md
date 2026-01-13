# Claude Code Custom Slash Commands Reference

This document summarizes official Claude Code documentation for custom slash commands.

## Official Documentation Sources

| Source | URL | Last Verified |
|--------|-----|---------------|
| Slash Commands Docs | https://code.claude.com/docs/en/slash-commands | 2025-01 |
| Custom Skills Guide | https://support.claude.com/en/articles/12512198-how-to-create-custom-skills | 2025-01 |
| Agent SDK Reference | https://platform.claude.com/docs/en/agent-sdk/slash-commands | 2025-01 |

## Command Location and Discovery

### File Locations

| Scope | Location | Precedence |
|-------|----------|------------|
| Project | `.claude/commands/` | Higher (overrides personal) |
| Personal | `~/.claude/commands/` | Lower |

### Auto-Discovery
- Claude Code scans command directories at startup
- Commands appear automatically in `/help`
- Subdirectories create category namespaces
- File extension must be `.md`

### Invocation Syntax

```
/category:command-name [arguments]
```

**Examples:**
- `/clean:state` - Invoke state from clean category
- `/git:squash 5` - Invoke squash with argument "5"

**Known Bug:** The full namespace syntax `/project:category:command` doesn't work (GitHub #2422). Use `/category:command` instead.

## Command File Format

### Basic Structure

```markdown
---
description: Brief description shown in /help
---

Human-readable explanation of what the command does.

Execute:

```bash
# Bash commands here
echo "Complete"
```
```

### Argument Handling

| Variable | Description | Example |
|----------|-------------|---------|
| `$ARGUMENTS` | All arguments as single string | `"arg1 arg2 arg3"` |
| `$1` | First positional argument | `"arg1"` |
| `$2` | Second positional argument | `"arg2"` |
| `$3`, `$4`, etc. | Additional positional arguments | ... |

**Example with arguments:**

```markdown
---
description: Squash last N commits
argument-hint: <number-of-commits>
---

Squash the last $1 commits into one.

```bash
git rebase -i HEAD~$1
```
```

## YAML Frontmatter Fields

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Brief description shown in `/help` |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed-tools` | array | all | Restrict which tools command can use |
| `argument-hint` | string | none | Placeholder text for autocomplete |
| `model` | string | session model | Override model (opus/sonnet/haiku) |
| `disable-model-invocation` | boolean | false | Run bash only, skip LLM processing |
| `hooks` | object | none | Pre/post execution hooks |
| `version` | string | none | Command version for tracking |
| `mode` | string | none | Execution mode |

### Tool Restriction Example

```yaml
---
description: Safe file listing
allowed-tools:
  - Read
  - Glob
---
```

### Model Override Example

```yaml
---
description: Complex analysis task
model: opus
---
```

**Note:** Model field is optional. Commands use the session's active model by default. Use short names: `opus`, `sonnet`, `haiku`.

## Token Limits

| Limit | Value |
|-------|-------|
| Single file read | 25,000 tokens |
| Output | 64,000 tokens |
| Context window | 200,000 tokens (500K Enterprise Sonnet 4) |

## Directory Organization

### Category Pattern

```
.claude/commands/
├── clean/
│   ├── state.md
│   ├── plans.md
│   ├── research.md
│   ├── memories.md
│   └── all.md
├── git/
│   ├── squash.md
│   └── amend.md
└── build/
    ├── compile.md
    └── test.md
```

### Naming Conventions

- **Directory names:** lowercase, verb form (e.g., `clean`, `build`, `git`)
- **File names:** lowercase, noun form with `.md` extension (e.g., `state.md`, `plans.md`)
- **Command names:** Match filename without extension (e.g., `state`, `plans`)

## Skills vs Commands vs CLAUDE.md

| Type | Location | Invocation | Purpose |
|------|----------|------------|---------|
| Commands | `.claude/commands/` | `/category:name` | Manual utilities |
| Skills | `.claude/skills/` | `/skill-name` | Cognitive workflows |
| CLAUDE.md | `.claude/` | Always loaded | Project context |

## Limitations and Known Issues

1. **Namespace Bug (GitHub #2422):** `/project:category:command` syntax doesn't work
2. **Subdirectory Duplication:** Commands may appear twice in `/help` with subdirectories
3. **No Conditional Execution:** Commands run entirely or not at all
4. **Limited Error Handling:** Bash errors may not surface clearly

## Best Practices (from Documentation)

1. Use frontmatter description for all production commands
2. Keep commands abstract but contextual for reusability
3. Restrict `allowed-tools` for sensitive operations
4. Share project commands via git for team consistency
5. Use subdirectories for logical organization
