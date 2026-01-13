# Frontmatter Reference

Complete reference for YAML frontmatter fields in Claude Code slash commands.

## Required Fields

### description

**Type:** string
**Required:** Yes

Brief description shown in `/help` and used for command matching.

```yaml
---
description: Clean all orchestration state files
---
```

**Best Practices:**
- Keep under 80 characters
- Start with action verb (Clean, Generate, Run, Deploy)
- Be specific about what the command does
- Avoid technical jargon in descriptions

## Optional Fields

### allowed-tools

**Type:** array of strings
**Default:** All tools available

Restricts which tools the command can use for security.

```yaml
---
description: Read-only file inspection
allowed-tools:
  - Read
  - Glob
  - Grep
---
```

**Available Tools:**
- `Read` - Read file contents
- `Write` - Write files
- `Edit` - Edit existing files
- `Glob` - Pattern-based file search
- `Grep` - Content search
- `Bash` - Execute shell commands
- `WebFetch` - Fetch web content
- `WebSearch` - Search the web
- `Task` - Launch subagents
- `TodoWrite` - Manage todo list

**Use Cases:**
- Restrict destructive operations
- Create read-only inspection commands
- Limit scope for sensitive directories

### argument-hint

**Type:** string
**Default:** None

Placeholder text shown in autocomplete to guide argument usage.

```yaml
---
description: Squash last N commits
argument-hint: <number-of-commits>
---
```

**Format Conventions:**
- `<required-arg>` - Required argument
- `[optional-arg]` - Optional argument
- `<arg1> <arg2>` - Multiple arguments
- `<file-path>` - Descriptive placeholder

### model

**Type:** string
**Default:** Session default model
**Required:** No - commands use the active session's model by default

Override the model used for this command. This field is **optional**; if omitted, the command executes using whatever model is active in the current Claude Code session.

```yaml
---
description: Complex code analysis
model: opus
---
```

**Available Models (short names preferred):**
- `opus` - Most capable
- `sonnet` - Balanced (default for most sessions)
- `haiku` - Fast/efficient

**Note:** Full model IDs (e.g., `claude-opus-4-20250514`) also work but short names are simpler and automatically use the latest model version.

**Use Cases:**
- Complex analysis requiring Opus
- Quick utilities using Haiku (runs almost instantly)
- Specific capability requirements

### disable-model-invocation

**Type:** boolean
**Default:** false

When true, executes bash directly without LLM processing.

```yaml
---
description: Quick file listing (no AI)
disable-model-invocation: true
---

```bash
ls -la
```
```

**Use Cases:**
- Pure bash utilities
- Performance-critical operations
- Deterministic outputs

### hooks

**Type:** object
**Default:** None

Define pre/post execution hooks.

```yaml
---
description: Command with hooks
hooks:
  pre:
    - type: command
      command: echo "Starting..."
  post:
    - type: command
      command: echo "Finished!"
---
```

**Hook Types:**
- `command` - Run a shell command
- `script` - Run a script file

### version

**Type:** string
**Default:** None

Version tracking for the command.

```yaml
---
description: Build project
version: "1.2.0"
---
```

**Use Cases:**
- Track command evolution
- Coordinate team updates
- Document breaking changes

### mode

**Type:** string
**Default:** None

Execution mode specification.

```yaml
---
description: Planning command
mode: plan
---
```

**Available Modes:**
- `plan` - Planning mode
- `execute` - Direct execution

## Complete Example

```yaml
---
description: Deploy application to production
argument-hint: <environment> [--force]
allowed-tools:
  - Bash
  - Read
  - Write
model: sonnet
version: "2.0.0"
hooks:
  pre:
    - type: command
      command: echo "Validating deployment..."
  post:
    - type: command
      command: echo "Deployment complete!"
---
```

## Validation Rules

1. **description is required** - Commands without description won't appear in `/help`
2. **allowed-tools must exist** - Invalid tool names cause errors
3. **model must be valid** - Unknown models fall back to default
4. **hooks commands must be safe** - Avoid destructive pre-hooks
