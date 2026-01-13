# develop-command

Composite skill for creating and managing Claude Code slash commands.

## Phases

| Phase | Name | Atomic Skill |
|-------|------|--------------|
| 0 | Requirements Clarification | orchestrate-clarification |
| 1 | Command Generation | orchestrate-generation |
| 2 | Command Validation | orchestrate-validation |

## Routing

**Semantic Trigger:** create command, slash command, modify command, utility command

**NOT for:** workflow skills, multi-phase operations, cognitive workflows

> This skill is for creating and modifying Claude Code slash commands. It is NOT for workflow skills (use develop-skill for those).

## Key Outputs

- Command definition file (`.claude/commands/{category}/{name}.md`)
- Updated DA.md Utility Commands section

## Phase Config Location

`../config.py` → `DEVELOP_COMMAND_PHASES`

## Command File Structure

```markdown
---
description: Brief description
---

Explanation of command.

```bash
# Command implementation
echo "Complete"
```
```
