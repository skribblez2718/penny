# Phase 0.6: Composite Skill Validation

**Uses Atomic Skill:** `orchestrate-validation`
**Phase Type:** LINEAR

## Purpose

Validate any composite skills referenced as building blocks and calculate composition depth. The validation agent ensures all references are valid.

## Trigger

Phase 0 identifies composite skills to be used as building blocks.

## Actions

The validation agent performs the following validations:

1. **Scan Referenced Composites**
   - Read each referenced composite skill's SKILL.md
   - Extract frontmatter metadata

2. **Validate Each Reference**
   - Verify skill exists
   - Check `composition_depth` in frontmatter (must be 0)
   - Validate skill interface matches configuration parameters

3. **Calculate Composition Depth**
   - If only atomic skills used: depth = 0
   - If any composite skills used: depth = 1
   - Maximum allowed depth is 1 (prevents A→B→C→D chains)

4. **Check for Circular References**
   - Build dependency graph
   - Verify no cycles exist
   - Verify no self-references

5. **Validate Configuration Parameters**
   - Each composite reference includes configuration block
   - Configuration matches child skill's expected interface
   - Required parameters provided

## Composition Rules

```
Base Composites (depth: 0)
└── Use ONLY atomic skills as building blocks

Level-1 Composites (depth: 1)
└── Can use base composites AND atomic skills
└── Referenced composites MUST have depth: 0

PROHIBITED:
├── Referencing depth-1 composites from composites
├── Circular references
└── Self-references
```

## Gate Exit Criteria

- [ ] All referenced composite skills exist
- [ ] All referenced composites have depth: 0
- [ ] No circular references detected
- [ ] All configuration parameters valid
- [ ] Composition depth calculated

## Output

Composition metadata including depth and validated references.
