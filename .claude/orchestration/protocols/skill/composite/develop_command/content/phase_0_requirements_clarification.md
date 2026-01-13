# Phase 0: Requirements Clarification

## Objective

Clarify all requirements for the command to be created, including name, category, purpose, arguments, and behavior.

## Context Loading

Load the following resources:
- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/claude-code-command-reference.md` - Official docs
- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/command-template.md` - Templates
- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/frontmatter-reference.md` - Frontmatter fields

## Clarification Questions

### Required Information

1. **Command Name:** What should the command be called?
   - Must be lowercase, kebab-case
   - Should be descriptive but concise
   - Example: `clean-logs`, `squash-commits`, `deploy-staging`

2. **Category:** Which category directory should contain this command?
   - Existing categories: `clean/`
   - Or create new category
   - Example: `git/`, `build/`, `deploy/`

3. **Description:** What does this command do?
   - Brief, clear description for `/help`
   - Starts with action verb
   - Under 80 characters

4. **Purpose:** What problem does this command solve?
   - Why is this command needed?
   - Who will use it?
   - When should it be used?

### Optional Information

5. **Arguments:** Does this command need arguments?
   - Required arguments: `<arg-name>`
   - Optional arguments: `[arg-name]`
   - Example: `<file-path> [--force]`

6. **Composition:** Does this command call other commands?
   - List commands to orchestrate
   - Define execution order
   - Handle failures between commands

7. **Tool Restrictions:** Should this command be restricted?
   - `allowed-tools` for security-sensitive operations
   - Default: all tools available

8. **Model Override:** Does this command need a specific model?
   - Default: session model
   - Override for complex analysis: `claude-opus-4-20250514`

## Workflow Detection

Determine the workflow mode:

### CREATE Mode
- New command being created
- New category may need creation
- Full command file generation needed

### UPDATE Mode
- Existing command being modified
- Category already exists
- Targeted edits to existing file

## Output Requirements

Document the following in memory file:

### Section 1: Command Specification
```
Command Name: {name}
Category: {category}
Description: {description}
Arguments: {arguments or "None"}
Composition: {list of commands or "None"}
Tool Restrictions: {list or "None"}
Model Override: {model or "None"}
Workflow Mode: CREATE | UPDATE
```

### Section 2: Johari Summary
- Known Knowns: Clear requirements established
- Known Unknowns: Questions for later phases
- Unknown Unknowns: Potential issues to watch for

### Section 3: Downstream Directives
Instructions for Phase 1 (Command Generation):
- Exact file path to create
- Frontmatter fields to include
- Bash script requirements
- Composition structure if applicable

## Exit Criteria

- [ ] Command name determined and valid
- [ ] Category determined (existing or new)
- [ ] Description written (clear, concise, actionable)
- [ ] Arguments documented if needed
- [ ] Composition pattern identified if applicable
- [ ] Memory file written with complete specification
