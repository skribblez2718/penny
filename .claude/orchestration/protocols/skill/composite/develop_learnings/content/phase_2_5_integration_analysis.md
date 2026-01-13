# Phase 2.5: Integration Analysis

**Uses Atomic Skill:** `orchestrate-synthesis`

## Purpose

Determine which learnings should integrate into skills/protocols.

## Integration Criteria

All 4 criteria must be YES to mark as INTEGRATE:

| Criterion | Question |
|-----------|----------|
| **Universal Applicability** | Does this apply to >70% of agent's tasks? |
| **Blocking Impact** | Would ignoring this cause failures? |
| **Concise Rule** | Can it be expressed in 1-2 sentences? |
| **Core Workflow** | Is it fundamental to function execution? |

## Decision Logic

```
IF all 4 criteria = YES:
    INTEGRATE → embed in skill/protocol
ELSE:
    STANDALONE → remain as reference learning
```

## Domain-Specific Extensions

When analyzing integration:

1. **Apply Integration Criteria**
   - Evaluate each learning against all 4 criteria
   - Document reasoning for each decision

2. **Categorize Results**
   - INTEGRATE: Learnings to embed in workflows
   - STANDALONE: Learnings to keep as references

3. **Plan Integration Targets**
   For INTEGRATE learnings, specify:
   - Target file (skill/protocol)
   - Location in file
   - Proposed rule text

## Resources

- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/integration-criteria.md`

## Gate Exit Criteria

- [ ] All learnings evaluated against criteria
- [ ] INTEGRATE vs STANDALONE determined
- [ ] Integration targets specified for INTEGRATE
- [ ] Ready for consolidation

## Output

Document integration decisions in the synthesis memory file for use by Phase 3 (Consolidation).
