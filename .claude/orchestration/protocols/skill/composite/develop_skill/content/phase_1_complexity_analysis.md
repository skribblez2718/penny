# Phase 1: Complexity Analysis

**Uses Atomic Skill:** `orchestrate-analysis`

## Purpose

Analyze skill complexity and dependencies to inform design decisions.

## Domain-Specific Extensions

When analyzing skill complexity, focus on:

1. **Complexity Scoring**
   - Simple: Single cognitive sequence, no branching
   - Medium: Multiple phases, some optional paths
   - Complex: Iterative phases, remediation loops, sub-phases

2. **Dependency Mapping**
   - What existing skills are similar?
   - What patterns can be reused?
   - What new patterns are needed?

3. **Risk Assessment**
   - What could go wrong during skill execution?
   - What edge cases need handling?
   - Where might clarification loops occur?

4. **Phase Complexity**
   - Which phases are straightforward?
   - Which phases need special handling (optional, iterative)?
   - Where are the quality gates?

## Analysis Framework

| Dimension | Simple | Medium | Complex |
|-----------|--------|--------|---------|
| Phases | 2-3 | 4-6 | 7+ |
| Branching | None | Optional phases | Iterative/Remediation |
| Dependencies | None | Same-domain | Cross-domain |
| Configuration | Fixed | Some params | Dynamic config |

## Gate Exit Criteria

- [ ] Complexity score assigned
- [ ] Dependencies mapped
- [ ] Risks identified
- [ ] Phase complexity assessed
- [ ] Quality gates identified

## Output

Analysis results documented in analysis memory file.
