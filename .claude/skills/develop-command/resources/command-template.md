# Command Template

Base templates for creating Claude Code slash commands.

## Simple Command Template

```markdown
---
description: {Brief description for /help display}
---

{Human-readable explanation of what the command does}

Execute:

```bash
{bash commands}
echo "{Completion message}"
```
```

## Command with Arguments Template

```markdown
---
description: {Brief description}
argument-hint: <arg1> [arg2]
---

{Explanation of arguments:}
- $1: {First argument description}
- $2: {Second argument description (optional)}

Execute:

```bash
# Validate required argument
if [ -z "$1" ]; then
    echo "Error: {arg1} is required"
    exit 1
fi

{bash commands using $1, $2, etc.}
echo "{Completion message}"
```
```

## Cleanup Command Template

```markdown
---
description: Clean {what is being cleaned}
---

Remove {files/directories} to {purpose}.

Execute:

```bash
# Remove target files (preserving .gitkeep)
find {path} -type f ! -name '.gitkeep' -delete

echo "{What} cleanup complete"
```
```

## Composite Command Template

```markdown
---
description: {Orchestrate multiple operations}
---

Execute {operations} in sequence:

```bash
# Step 1: {description}
/{category}:{command-1}

# Step 2: {description}
/{category}:{command-2}

# Step 3: {description}
/{category}:{command-3}

echo "All operations complete"
```
```

## Tool-Restricted Command Template

```markdown
---
description: {Description of restricted command}
allowed-tools:
  - Read
  - Glob
---

{Explanation - this command can only use Read and Glob tools}

Execute:

```bash
{safe bash commands}
echo "Complete"
```
```

## Model Override Template

```markdown
---
description: {Complex task requiring specific model}
model: opus
---

{Explanation of why specific model is needed}

Execute:

```bash
{bash commands}
echo "Complete"
```
```

**Note:** Model field is optional (defaults to session model). Use short names: `opus`, `sonnet`, `haiku`.

## Template Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{description}` | Brief description for /help | "Clean state files" |
| `{path}` | Target path for operations | `.claude/orchestration` |
| `{category}` | Command category/directory | `clean`, `git`, `build` |
| `{command-name}` | Command file name | `state` |
| `$1`, `$2` | User-provided arguments | File path, count |
| `$ARGUMENTS` | All arguments as string | "arg1 arg2 arg3" |

## Placeholder Conventions

- Use `{placeholder}` for values to be replaced during generation
- Use `$VARIABLE` for runtime arguments from user
- Use `${ENV_VAR}` for environment variables
- Always include completion echo statement
