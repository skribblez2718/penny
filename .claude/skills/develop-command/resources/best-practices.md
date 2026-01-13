# Command Best Practices

Design patterns and guidelines for creating effective Claude Code slash commands.

## Core Principles

### 1. Single Responsibility

Each command should do one thing well.

**Good:**
```markdown
---
description: Clean state files
---
```

**Avoid:**
```markdown
---
description: Clean state files, rebuild cache, and restart services
---
```

### 2. Composability

Complex operations should compose simple commands.

**Good:**
```bash
# deploy-all.md
/clean:state
/build:compile
/test:run-all
/deploy:push
```

**Avoid:**
```bash
# deploy-all.md - 200 lines of monolithic bash
```

### 3. Idempotency

Commands should be safe to run multiple times.

**Good:**
```bash
# Creates directory only if it doesn't exist
mkdir -p .claude/cache
```

**Avoid:**
```bash
# Fails if directory exists
mkdir .claude/cache
```

## Category Organization

### Naming Categories

| Pattern | Examples | Use For |
|---------|----------|---------|
| Action-based | `clean/`, `build/`, `deploy/` | Operation types |
| Domain-based | `git/`, `docker/`, `db/` | Tool/domain specific |
| Scope-based | `project/`, `system/`, `user/` | Scope of impact |

### When to Create New Category

Create a new category when:
- You have 2+ related commands
- Commands share a common domain
- Logical grouping aids discovery

### Category Naming Rules

- Use lowercase
- Use kebab-case for multi-word names
- Keep names short (1-2 words)
- Be specific, not generic

## Argument Handling

### Required Arguments

```bash
if [ -z "$1" ]; then
    echo "Error: argument required"
    echo "Usage: /category:command <argument>"
    exit 1
fi
```

### Optional Arguments with Defaults

```bash
TARGET=${1:-"default-value"}
echo "Using target: $TARGET"
```

### Multiple Arguments

```bash
FILE=$1
COUNT=${2:-10}
echo "Processing $FILE with count $COUNT"
```

## Error Handling

### Validate Inputs

```bash
# Check file exists
if [ ! -f "$1" ]; then
    echo "Error: File not found: $1"
    exit 1
fi

# Check directory exists
if [ ! -d "$1" ]; then
    echo "Error: Directory not found: $1"
    exit 1
fi
```

### Graceful Failure

```bash
# Use || to handle failures
rm -f temp.txt || echo "Warning: Could not remove temp.txt"

# Use set -e for strict mode (stops on first error)
set -e
```

## Feedback Patterns

### Progress Indicators

```bash
echo "Step 1: Cleaning cache..."
rm -rf .cache/*

echo "Step 2: Rebuilding index..."
./rebuild-index.sh

echo "Complete: Cache cleaned and index rebuilt"
```

### Status Messages

| Pattern | Example | Use For |
|---------|---------|---------|
| Starting | `echo "Starting deployment..."` | Long operations |
| Progress | `echo "Processing file 3 of 10..."` | Iteration |
| Complete | `echo "Deployment complete"` | Final confirmation |
| Warning | `echo "Warning: File skipped"` | Non-fatal issues |
| Error | `echo "Error: Build failed"` | Fatal issues |

## Safety Patterns

### Preserve Important Files

```bash
# Keep .gitkeep files
find .claude/cache -type f ! -name '.gitkeep' -delete
```

### Dry Run Option

```bash
if [ "$1" = "--dry-run" ]; then
    echo "Would delete: $(find .cache -type f | wc -l) files"
else
    find .cache -type f -delete
    echo "Deleted files"
fi
```

### Confirmation for Destructive Operations

```bash
echo "This will delete all cached files."
echo "Press Enter to continue or Ctrl+C to cancel..."
read
```

## Performance Considerations

### Efficient File Operations

```bash
# Good: Single find command
find . -name "*.tmp" -delete

# Avoid: Multiple commands
for f in $(ls *.tmp); do rm $f; done
```

### Limit Scope

```bash
# Good: Specific path
find .claude/orchestration -name "*.json" -delete

# Avoid: Broad search
find . -name "*.json" -delete
```

## Documentation Standards

### Description Quality

| Quality | Example | Issues |
|---------|---------|--------|
| Poor | "Clean stuff" | Vague, unhelpful |
| OK | "Clean files" | Missing specifics |
| Good | "Clean orchestration state files" | Clear and specific |

### Inline Comments

```bash
# Remove state files but preserve directory structure
find .claude/orchestration -path "*/state/*.json" -type f -delete

# Confirm completion with count
echo "Removed $(find .claude/orchestration -path "*/state/*.json" | wc -l) state files"
```

## Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| Hardcoded paths | Breaks portability | Use relative paths |
| No description | Invisible in /help | Always add frontmatter |
| Silent operation | No feedback | Add echo statements |
| Destroy .gitkeep | Breaks directory structure | Exclude with `! -name` |
| Monolithic scripts | Hard to maintain | Compose smaller commands |
| No error handling | Silent failures | Check exit codes |
| Absolute paths | Environment-specific | Use `${CAII_DIRECTORY}` |

## Testing Commands

### Manual Testing Checklist

- [ ] Command appears in `/help`
- [ ] Description is clear and helpful
- [ ] Arguments work as expected
- [ ] Error cases handled gracefully
- [ ] Completion message appears
- [ ] Safe to run multiple times
- [ ] No unintended side effects
