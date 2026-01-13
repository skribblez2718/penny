# Command Validation Checklist

Quality criteria for validating Claude Code slash commands before completion.

## Core Requirements

### Frontmatter Validation

- [ ] **description present** - Frontmatter includes `description` field
- [ ] **description quality** - Clear, specific, starts with action verb
- [ ] **description length** - Under 80 characters
- [ ] **valid YAML** - Frontmatter parses without errors

### File Structure Validation

- [ ] **correct location** - File in `.claude/commands/{category}/`
- [ ] **proper extension** - File has `.md` extension
- [ ] **naming convention** - Lowercase, kebab-case filename
- [ ] **category exists** - Parent directory exists or created

### Bash Script Validation

- [ ] **syntax valid** - No obvious bash syntax errors
- [ ] **echo completion** - Includes completion message
- [ ] **proper quoting** - Variables properly quoted
- [ ] **exit codes** - Returns appropriate exit codes

## Registration Requirements

### DA.md Updates

- [ ] **section exists** - Category section in Utility Commands exists or created
- [ ] **table format** - Uses correct markdown table format
- [ ] **command row** - Row added with correct format: `| /category:name | description |`
- [ ] **alphabetical order** - Commands ordered alphabetically within category

### Category Section Format

```markdown
## {Category} Commands

| Command | Description |
|---------|-------------|
| `/category:command-1` | Description 1 |
| `/category:command-2` | Description 2 |
```

## Safety Requirements

### File Operations

- [ ] **preserves .gitkeep** - Cleanup commands preserve `.gitkeep` files
- [ ] **no rm -rf /** - No dangerous recursive deletions
- [ ] **scoped paths** - Operations limited to appropriate directories
- [ ] **relative paths** - Uses relative paths, not absolute

### Security Considerations

- [ ] **no secrets** - No hardcoded credentials or API keys
- [ ] **no sensitive output** - Doesn't expose sensitive information
- [ ] **appropriate tools** - Uses `allowed-tools` if needed for restriction

## Quality Requirements

### Documentation

- [ ] **purpose clear** - Command purpose is obvious from description
- [ ] **arguments documented** - If arguments used, documented in command body
- [ ] **argument-hint** - If arguments required, frontmatter includes `argument-hint`

### Error Handling

- [ ] **required args validated** - Required arguments checked with helpful error
- [ ] **graceful failures** - Errors don't leave system in bad state
- [ ] **informative messages** - Error messages explain what went wrong

### Feedback

- [ ] **progress indicators** - Long operations show progress
- [ ] **completion message** - Clear confirmation when done
- [ ] **status clarity** - User knows what happened

## Composition Requirements (if composite)

### Structure

- [ ] **calls other commands** - Uses `/category:command` syntax
- [ ] **logical sequence** - Commands called in sensible order
- [ ] **dependencies clear** - Order reflects actual dependencies

### Error Handling

- [ ] **component failures** - Handles failures in called commands
- [ ] **partial completion** - User knows which steps completed

## Final Checks

### Discovery

- [ ] **appears in /help** - After restart, command visible in `/help`
- [ ] **correct category** - Listed under correct category heading
- [ ] **description shows** - Description appears correctly

### Execution

- [ ] **runs without error** - Command executes successfully
- [ ] **produces expected result** - Output matches intention
- [ ] **idempotent** - Safe to run multiple times

### Registration

- [ ] **DA.md accurate** - Entry in DA.md matches command
- [ ] **table integrity** - DA.md table formatting preserved

## Validation Process

### Phase 2 (Command Validation) Steps

1. **Read generated command file**
   - Verify frontmatter structure
   - Verify bash syntax

2. **Check category directory**
   - Verify directory exists
   - Verify file placed correctly

3. **Update DA.md**
   - Find or create category section
   - Add command row to table
   - Maintain alphabetical order

4. **Final verification**
   - Read back DA.md to confirm
   - Report completion status

### Common Validation Failures

| Failure | Resolution |
|---------|------------|
| Missing description | Add description to frontmatter |
| Wrong directory | Move file to correct category |
| Invalid bash | Fix syntax errors |
| Missing .gitkeep handling | Add `! -name '.gitkeep'` to find |
| DA.md not updated | Execute DA.md update logic |
| Table formatting broken | Fix markdown table syntax |
