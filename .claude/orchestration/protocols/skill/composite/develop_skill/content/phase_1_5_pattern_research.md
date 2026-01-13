# Phase 1.5: Pattern Research

**Uses Atomic Skill:** `orchestrate-research`

**Configuration:**
- research_depth: standard

## Purpose

Research similar skill patterns and identify reusable components.

## Domain-Specific Extensions

When researching skill patterns, investigate:

1. **Existing Skill Review**
   - Examine `${CAII_DIRECTORY}/.claude/skills/*/SKILL.md` files
   - Identify similar workflow patterns
   - Note effective phase structures

2. **Cognitive Sequence Patterns**
   - Which agent sequences are proven?
   - What context loading patterns work best?
   - How do successful skills handle gates?

3. **Anti-Pattern Identification**
   - What patterns should be avoided?
   - Common mistakes in skill design?
   - Over-engineering patterns?

4. **Best Practices Documentation**
   - Effective phase naming conventions
   - Clear gate criteria patterns
   - Memory file organization

## Common Cognitive Sequences

| Pattern | Sequence | Use Case |
|---------|----------|----------|
| Discovery | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS | Understanding problems |
| Implementation | GENERATION → VALIDATION | Creating artifacts |
| Full Development | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION | Complete workflows |

## Gate Exit Criteria

- [ ] Similar skills reviewed
- [ ] Reusable patterns identified
- [ ] Anti-patterns documented
- [ ] Best practices noted

## Output

Research findings documented in research memory file.
