# Phase 2: Command Validation

## Objective

Validate the generated command file and update DA.md with the command registration.

## Context Loading

Load from Phase 1 memory:
- Path to created command file
- Category and command name
- Expected DA.md section format

Load resources:
- `${CAII_DIRECTORY}/.claude/skills/develop-command/resources/validation-checklist.md` - Validation criteria
- `${CAII_DIRECTORY}/.claude/DA.md` - Current DA.md content

## Validation Steps

### Step 1: Validate Command File

Read the generated command file and verify:

#### Frontmatter Validation
- [ ] `description` field present
- [ ] Description is clear and actionable
- [ ] Description under 80 characters
- [ ] Additional fields valid if present (argument-hint, allowed-tools, model)

#### Structure Validation
- [ ] File has proper markdown structure
- [ ] Bash code block present
- [ ] Explanation text before code block

#### Bash Script Validation
- [ ] No obvious syntax errors
- [ ] Uses proper variable quoting
- [ ] Includes completion echo statement
- [ ] No hardcoded absolute paths

#### Safety Validation
- [ ] Cleanup operations preserve `.gitkeep`
- [ ] No dangerous operations (rm -rf /)
- [ ] Paths are appropriately scoped

### Step 2: Update DA.md

#### Locate Utility Commands Section

Find the "# Utility Commands" section in DA.md.

#### Find or Create Category Section

Look for existing category section:
```markdown
## {Category} Commands

| Command | Description |
|---------|-------------|
```

If category section doesn't exist, create it after the last command section.

#### Add Command Row

Add row to category table (maintain alphabetical order):
```markdown
| `/{category}:{command-name}` | {description} |
```

#### DA.md Edit Pattern

```markdown
## {Category} Commands

| Command | Description |
|---------|-------------|
| `/{category}:existing-command-1` | Existing description |
| `/{category}:{new-command}` | New command description |  <!-- ADD THIS ROW -->
| `/{category}:existing-command-2` | Existing description |
```

### Step 3: Final Verification

After DA.md update:
- [ ] Read back DA.md to confirm edit applied
- [ ] Verify table formatting is intact
- [ ] Verify command appears in correct position

## Output Requirements

### Memory File Content

#### Section 1: Validation Summary
```
Command File: .claude/commands/{category}/{command-name}.md
Validation Status: PASS | FAIL
Issues Found: {list or "None"}
DA.md Updated: yes | no
Category Section: existing | created
```

#### Section 2: Johari Summary
- Known Knowns: Command validated, DA.md updated
- Known Unknowns: Runtime testing (user will verify)
- Unknown Unknowns: Edge cases in actual usage

#### Section 3: Completion Summary
```
COMMAND CREATED SUCCESSFULLY

Command: /{category}:{command-name}
Location: .claude/commands/{category}/{command-name}.md
Description: {description}

To use: /{category}:{command-name} {arguments if any}

DA.md registration: Complete
```

## Exit Criteria

- [ ] Command file passes all validation checks
- [ ] DA.md Utility Commands section updated
- [ ] Category table exists and is properly formatted
- [ ] Command row added in alphabetical order
- [ ] No validation errors or warnings

## Validation Failure Handling

If validation fails:

1. **Frontmatter Issues:** Report specific missing/invalid fields
2. **Structure Issues:** Report what's missing or malformed
3. **Bash Issues:** Report syntax concerns
4. **Safety Issues:** Report dangerous patterns found

Do NOT proceed to DA.md update if command file validation fails.

## Completion Signal

Upon successful validation and DA.md update:

```
DEVELOP_COMMAND_VALIDATION_COMPLETE

Command /{category}:{command-name} is ready for use.
Invoke with: /{category}:{command-name}
```
