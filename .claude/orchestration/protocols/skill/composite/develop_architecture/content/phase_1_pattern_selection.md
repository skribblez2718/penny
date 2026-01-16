# Phase 1: Pattern Selection

**Uses Atomic Skill:** `orchestrate-analysis`
**Phase Type:** LINEAR

## Purpose

Select optimal architecture pattern using evidence-based decision framework.

## Domain-Specific Extensions (Architecture)

**Decision Framework:** Pattern Selection Matrix

**Input Factors (from Phase 0):**
- Team size
- Expected scale
- Domain complexity (analyze from requirements)
- Consistency requirements

**Reference:** `${CAII_DIRECTORY}/.claude/skills/develop-architecture/resources/decision-frameworks/pattern-selection-matrix.md`

**Decision Process:**
1. Apply pattern scoring formula
2. Evaluate event-driven overlays (if async workflows needed)
3. Consider Hexagonal/Clean architecture (if high testability required)
4. Generate ADR documenting selection rationale

**Pattern Scoring:**
```
Score = (0.30 × Team Fit) + (0.30 × Scale Fit) + (0.25 × Complexity Fit) + (0.15 × Expertise Fit)
```

## Gate Exit Criteria

- [ ] Architecture pattern selected with confidence score
- [ ] ADR created for pattern selection (use template)
- [ ] Trade-off analysis of alternatives documented
- [ ] Event-driven overlay decision made (if applicable)
- [ ] Migration path defined (if transitioning from existing)

## Output

- Selected pattern with rationale
- ADR-001-pattern-selection.md
- Pattern score breakdown
- Alternatives considered table

## MANDATORY Agent Invocation

```bash
Task tool with subagent_type: "orchestrate-analysis"
```

Produces: `.claude/memory/{task_id}-analysis-memory.md`
