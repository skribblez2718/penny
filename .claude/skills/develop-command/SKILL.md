---
name: develop-command
description: Create and manage Claude Code slash commands for utility operations
semantic_trigger: create command, slash command, modify command, utility command
not_for: workflow skills, multi-phase operations, cognitive workflows
tags: command-creation, utility, bash, claude-code, automation
type: composite
composition_depth: 0
uses_composites: []
---

# develop-command

**Type:** Composite Skill
**Description:** Create and manage Claude Code slash commands for utility operations
**Status:** production
**Complexity:** simple

## Overview

Creates simple bash/utility commands as modular building blocks. Commands are organized in category subdirectories within `.claude/commands/` and automatically registered in DA.md. Complex commands can orchestrate simpler commands following the composition pattern.

**Key Principles:**
- Commands as reusable building blocks
- Category-based organization (e.g., `clean/`, `git/`, `build/`)
- Dual registration: command file + DA.md entry
- Auto-discovery by Claude Code at startup

## When to Use

Invoke when **utility commands need to be created or modified**:

- **New utility needed:** Create a standalone bash command for a specific operation -> "Create a command to reset logs"
- **Category expansion:** Add a new command to an existing category -> "Add backup to clean category"
- **Composite command:** Build a command that orchestrates other commands -> "Create deploy-all that runs build, test, deploy"
- **DA.md registration:** Ensure command is properly documented -> "Register the new git:squash command"
- **Command maintenance:** Update or fix an existing command -> "Modify state to also clear logs"

## Core Principles

1. **Modularity:** Commands are self-contained, reusable building blocks
2. **Composition:** Complex commands can call simpler commands
3. **Auto-discovery:** Claude Code scans `.claude/commands/` at startup
4. **Dual Registration:** Commands exist as files AND in DA.md Utility Commands section
5. **Category Organization:** Related commands grouped in subdirectories

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `task-command-{command-name}`
- Create workflow metadata per protocol Steps 1-4
- Task domain: technical

### Completion
- Present complete command file
- Verify DA.md registration
- Prompt for develop-learnings invocation
- Finalize workflow per protocol Step 6

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_command/entry.py "{task_id}" --domain technical
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_command/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Requirements Clarification | orchestrate-clarification | LINEAR |
| 1 | Command Generation | orchestrate-generation | LINEAR |
| 2 | Command Validation | orchestrate-validation | LINEAR |

**Execution:** Phases are enforced by `protocols/skill/fsm.py` with state tracked in `protocols/skill/state/`.

## Directory Structure

```
commands/{category}/
|- {command-name}.md      (Command definition file)

skills/develop-command/
|- SKILL.md               (This file)
|- resources/
    |- claude-code-command-reference.md  (Official docs summary)
    |- command-template.md               (Base command template)
    |- frontmatter-reference.md          (All frontmatter fields)
    |- best-practices.md                 (Design patterns)
    |- validation-checklist.md           (Quality criteria)
```

## Command File Structure

```markdown
---
description: Brief description for /help display
---

Explanation of what the command does.

Execute:

```bash
# Command implementation
echo "Command complete"
```
```

## Validation Checklist

Before considering command complete:

### Core Requirements
- [ ] Command has description in frontmatter
- [ ] Command file placed in correct category directory
- [ ] Bash script is syntactically valid
- [ ] Echo statement confirms completion
- [ ] No hardcoded absolute paths (use relative paths)

### Registration Requirements
- [ ] DA.md Utility Commands section updated
- [ ] Category section exists or created in DA.md
- [ ] Command row added to category table

### Safety Requirements
- [ ] Destructive commands preserve .gitkeep files
- [ ] No sensitive data in command output
- [ ] Idempotent where appropriate

**Reference:** See `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/validation-checklist.md` for complete checklist

## Anti-Patterns

| Anti-Pattern | Instead |
|--------------|---------|
| Hardcoded paths | Use relative paths or `${CAII_DIRECTORY}` |
| Missing description | Always include frontmatter description |
| No feedback | Include echo statements |
| Destroying .gitkeep | Preserve with `! -name '.gitkeep'` |
| Monolithic commands | Break into composable units |
| Direct file deletion | Use `find` with proper filters |

## Compositional Command Pattern

Commands can orchestrate other commands:

```markdown
---
description: Deploy everything with full validation
---

Execute complete deployment:

```bash
/clean:state
/build:compile
/test:run-all
/deploy:push
echo "Full deployment complete"
```
```

## References

- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/` - Command templates and patterns
- `${CAII_DIRECTORY}/.claude/commands/clean/` - Example command implementations
- `${CAII_DIRECTORY}/.claude/DA.md` - Utility Commands registration section
- `${CAII_DIRECTORY}/.claude/docs/philosophy.md` - System principles

## Remember

Commands are modular building blocks. Keep them simple, composable, and well-documented.
Each command does one thing well. Complex operations compose simple commands.
