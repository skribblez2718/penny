# Phase 4: Validation

**Uses Atomic Skill:** `orchestrate-validation`

## Configuration

- `validation_target`: synthesis (Phase 3)
- `quality_criteria`: see `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/learnings-update-rubric.md`

## Purpose

Validate learnings against update rubric.

## Validation Criteria

| Criterion | Description |
|-----------|-------------|
| **Generalizability** | Reusable beyond specific task |
| **Accuracy** | True reflection of what happened |
| **Non-contradiction** | No conflict with existing learnings |
| **Conciseness** | Token-efficient expression |
| **Proper categorization** | Correct function and pattern type |
| **Complete schema** | All required fields present |

## Gate Logic

| Condition | Action |
|-----------|--------|
| All PASS | Proceed to Phase 5 |
| Any FAIL AND remediation_count < 1 | Loop to Phase 2 for targeted agents |
| Any FAIL AND remediation_count ≥ 1 | Halt, require manual review |

**Max Remediation Loops:** 1

## Token Budget Check

INDEX sections must remain <300 tokens after additions.

## Domain-Specific Extensions

When validating learnings:

1. **Generalizability Check**
   - Would this help on future tasks?
   - Is it too specific to current context?

2. **Accuracy Verification**
   - Does it match what actually happened?
   - Is the attribution correct?

3. **Contradiction Scan**
   - Check against existing learnings
   - Verify no conflicting advice

4. **Token Efficiency**
   - Is it expressed concisely?
   - Can it be shortened without losing meaning?

## Resources

- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/learnings-update-rubric.md`

## Gate Exit Criteria

- [ ] All criteria evaluated
- [ ] Pass/Fail determined per learning
- [ ] Token budget verified
- [ ] Remediation guidance provided (if needed)
- [ ] Ready for commit

## Output

Document validation results in the validation memory file for use by Phase 5 (Commit).
