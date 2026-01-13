# Phase 3: Consolidation

**Uses Atomic Skill:** `orchestrate-synthesis`

## Purpose

Merge overlapping entries, ensure consistent IDs/tags, produce final diffs.

## Domain-Specific Extensions

When consolidating learnings:

1. **Identify Overlaps**
   - Compare entries across functions
   - Find semantically similar learnings
   - Detect cross-function duplicates

2. **Merge Overlapping Entries**
   - Combine similar learnings into unified entries
   - Preserve best aspects of each
   - Maintain attribution to all sources

3. **Ensure ID Consistency**
   - Generate unique IDs following schema
   - Verify no ID collisions
   - Maintain ID format: `{function}-{type}-{number}`

4. **Verify Pattern Type Categorization**
   - heuristics: Rules of thumb, best practices
   - anti-patterns: What NOT to do
   - checklists: Step-by-step verification
   - domain-snippets: Code or config templates

5. **Attach Integration Decisions**
   - Link INTEGRATE decisions from Phase 2.5
   - Specify target files and locations

## Cross-Function Duplicate Check

| Check | Action |
|-------|--------|
| Exact duplicate | Keep one, reference from others |
| Similar concept | Merge into primary function |
| Complementary | Keep both, add cross-reference |

## Gate Exit Criteria

- [ ] Overlaps identified and merged
- [ ] IDs consistent and unique
- [ ] Pattern types verified
- [ ] Cross-function duplicates resolved
- [ ] Integration decisions attached
- [ ] Final diffs prepared

## Output

Document consolidated learnings in the synthesis memory file for use by Phase 4 (Validation).
