# Phase 5.5: Post-Integration Cleanup

**Uses Atomic Skill:** `orchestrate-analysis`

## Purpose

Apply skill integrations and evaluate learning retention.

## Part A: Apply Integrations

For learnings marked INTEGRATE in Phase 2.5:

1. **Apply Rules to Target Files**
   - Open target skill/protocol file
   - Insert rule at specified location
   - Verify rule integrates properly

2. **Update Learning Metadata**
   - Set `integration_status: applied`
   - Record target file and location
   - Note any adjustments made

## Part B: Retention Evaluation

Evaluate each learning for retention:

| Decision | Criteria |
|----------|----------|
| **KEEP** | Not integrated (standalone) OR provides WHY/context beyond rule |
| **ARCHIVE** | Marginal value, highly domain-specific |
| **REMOVE** | Truly redundant (zero value beyond integrated rule) |

**Default Bias:** KEEP (most integrated learnings provide context beyond rules)

## Retention Decision Tree

```
IF not_integrated:
    KEEP (standalone reference)
ELIF provides_rationale OR provides_examples OR provides_failure_modes:
    KEEP (context value)
ELIF marginal_value AND domain_specific:
    ARCHIVE
ELIF truly_redundant:
    REMOVE
ELSE:
    KEEP (default)
```

## Resources

- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/retention-criteria.md`

## Gate Exit Criteria

- [ ] All INTEGRATE learnings applied
- [ ] Integration metadata updated
- [ ] Retention decisions made
- [ ] ARCHIVE/REMOVE actions executed
- [ ] Final summary generated

## Output

Final report documenting:
- Integrations applied
- Learnings retained
- Learnings archived/removed
- Recommendations for future
