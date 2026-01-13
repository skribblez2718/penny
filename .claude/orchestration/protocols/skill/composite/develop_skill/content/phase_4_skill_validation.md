# Phase 4: Skill Validation

**Uses Atomic Skill:** `orchestrate-validation`

**Configuration:**
- validation_target: orchestrate-generation
- quality_criteria:
  - orchestration-only
  - sequential-agents
  - zero-redundancy
  - atomic-references-valid
  - composite-references-valid
  - depth-constraint-satisfied

## Purpose

Validate generated skill against orchestration checklist and quality criteria.

## Validation Criteria

### Core Requirements
- [ ] Defines cognitive sequences (which agents, what order)
- [ ] All sequences are sequential (no parallel agent calls)
- [ ] Includes domain classification approach
- [ ] Specifies context requirements
- [ ] Every phase specifies context loading pattern
- [ ] References documentation instead of duplicating
- [ ] Zero implementation details (100% orchestration)
- [ ] Gate criteria defined (if multi-phase)

### Atomic Skill Requirements
- [ ] All referenced atomic skills exist
- [ ] Atomic skills have type: atomic in frontmatter
- [ ] No duplicate atomic skill functionality
- [ ] Configuration valid for each atomic

### Composite Skill Requirements (if depth=1)
- [ ] All referenced composite skills exist
- [ ] Referenced composites have depth: 0
- [ ] Configuration parameters match interfaces
- [ ] No circular references
- [ ] Composition depth correctly set

### Documentation Requirements
- [ ] "When to Use" examples provided (5 semantic triggers)
- [ ] References section complete
- [ ] Anti-patterns documented

## Validation Verdicts

| Verdict | Meaning | Action |
|---------|---------|--------|
| GO | All criteria passed | Proceed to Phase 5 |
| CONDITIONAL | Minor issues | Fix and re-validate (max 2 attempts) |
| NO-GO | Critical failures | Return to earlier phase |

## Gate Exit Criteria

- [ ] Validation verdict is GO
- [ ] All criteria checked
- [ ] No outstanding issues

## Output

Validation report in validation memory file.
