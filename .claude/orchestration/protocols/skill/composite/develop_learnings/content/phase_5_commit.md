# Phase 5: Commit

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR

## Purpose

Write approved learnings to learnings files using the generation agent.

## Execution Steps

1. **Write Learnings**
   For each PASS entry:
   - Append to target file (`heuristics.md`, `anti-patterns.md`, etc.)
   - Follow existing file format
   - Preserve file structure

2. **Update INDEX Sections**
   - Add new references to INDEX
   - Verify INDEX stays under 300 tokens
   - Update cross-references if needed

3. **Track Modifications**
   - Record all file changes
   - Note additions and updates
   - Document skipped entries

4. **Report Completion**
   - Summarize learnings committed
   - List files modified
   - Note any issues encountered

## File Structure

```
${CAII_DIRECTORY}/.claude/learnings/{function}/
├── heuristics.md        # Rules of thumb
├── anti-patterns.md     # What NOT to do
├── checklists.md        # Step-by-step verification
└── domain-snippets/     # Code/config templates
```

## Commit Format

Each learning entry should include:
```markdown
### {ID}: {Title}

**Source:** {task-id}
**Domain:** {domain-tags}

{Learning content}
```

## Gate Exit Criteria

- [ ] All PASS learnings written
- [ ] INDEX sections updated
- [ ] File modifications tracked
- [ ] Completion summary generated
- [ ] Ready for post-integration

## Output

Learnings committed to files, ready for Phase 5.5 (Post-Integration Cleanup).
