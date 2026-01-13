# Phase 1: Command Generation

## Objective

Generate the command file with proper frontmatter and bash implementation based on Phase 0 specification.

## Context Loading

Load from Phase 0 memory:
- Command specification (name, category, description, arguments)
- Workflow mode (CREATE or UPDATE)
- Composition requirements if any

Load resources:
- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/command-template.md` - Templates
- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/best-practices.md` - Patterns
- `${CAII_DIRECTORY}/.claude/commands/clean/state.md` - Example implementation

## Generation Steps

### Step 1: Verify/Create Category Directory

If category doesn't exist:
```bash
mkdir -p .claude/commands/{category}
```

### Step 2: Generate Command File

**File Path:** `.claude/commands/{category}/{command-name}.md`

**Structure:**

```markdown
---
description: {description from Phase 0}
{argument-hint: <args> if arguments needed}
{allowed-tools: [...] if restricted}
{model: override if specified}
---

{Human-readable explanation of what the command does}

{If arguments, document them:}
Arguments:
- $1: {first argument description}
- $2: {second argument description}

Execute:

```bash
{bash implementation}
echo "{completion message}"
```
```

### Step 3: Implement Bash Script

Follow these patterns:

#### Simple Command Pattern
```bash
{main operation}
echo "{What} complete"
```

#### Cleanup Command Pattern
```bash
find {path} -type f ! -name '.gitkeep' -delete
echo "{What} cleanup complete"
```

#### Command with Arguments Pattern
```bash
if [ -z "$1" ]; then
    echo "Error: {argument} is required"
    exit 1
fi

{operations using $1, $2, etc.}
echo "{Operation} complete"
```

#### Composite Command Pattern
```bash
# Step 1: {description}
/{category}:{command-1}

# Step 2: {description}
/{category}:{command-2}

echo "All operations complete"
```

### Step 4: Apply Best Practices

Ensure generated command:
- Uses relative paths (not absolute)
- Preserves `.gitkeep` files in cleanup operations
- Includes completion echo statement
- Handles errors gracefully
- Is idempotent where appropriate

## Output Requirements

### Deliverable: Command File

Create the actual command file at:
`.claude/commands/{category}/{command-name}.md`

### Memory File Content

Document in memory file:

#### Section 1: Generation Summary
```
File Created: .claude/commands/{category}/{command-name}.md
Category: {category}
Command: {command-name}
Frontmatter Fields: description, {other fields}
Has Arguments: yes|no
Is Composite: yes|no
```

#### Section 2: Johari Summary
- Known Knowns: File created, structure valid
- Known Unknowns: Runtime behavior verification needed
- Unknown Unknowns: Edge cases to test

#### Section 3: Downstream Directives
Instructions for Phase 2 (Validation):
- Path to created command file
- Expected DA.md section format
- Validation criteria to check

## Exit Criteria

- [ ] Category directory exists
- [ ] Command file created at correct path
- [ ] Frontmatter includes description
- [ ] Bash script syntactically valid
- [ ] Completion echo statement included
- [ ] Best practices applied
- [ ] Memory file documents generation
