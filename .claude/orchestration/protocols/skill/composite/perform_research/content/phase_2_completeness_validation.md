# Phase 2: Completeness Validation

**Uses Atomic Skill:** `orchestrate-validation`
**Phase Type:** REMEDIATION (max 2 loops)

## Configuration

- `remediation_target`: Phase "1" (re-execute parallel research)
- `max_remediation`: 2 loops
- `validation_rubric`: `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/validation-rubric.md`

## Purpose

Verify research quality through cross-source validation before final synthesis.

## Gate Logic

| Condition | Action |
|-----------|--------|
| Score ≥ 0.75 AND no critical failures | **PASS** → Proceed to Phase 3 |
| Score < 0.75 AND attempts < 2 | **REMEDIATE** → Loop back to Phase 1 with guidance |
| Score < 0.75 AND attempts ≥ 2 | **ABORT** → Halt with quality report |
| Critical failure detected | **ABORT** → Halt immediately |

## Quality Criteria

Reference: `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/validation-rubric.md`

| Criterion | Weight | Pass Threshold | Evaluation Method |
|-----------|--------|----------------|-------------------|
| **Factual Accuracy** | 0.30 | 0.75 | Sample 20% of claims, verify against cited sources |
| **Citation Accuracy** | 0.25 | 0.80 | Test URLs, verify attribution, check formatting |
| **Source Quality** | 0.25 | 0.70 | Apply tier hierarchy, calculate % Tier 1-2 sources |
| **Completeness** | 0.15 | 0.75 | Verify all subtopics addressed, assess gap coverage |
| **Conflict Resolution** | 0.05 | 0.70 | Check contradictions documented and resolved |

**Overall Pass Threshold:** 0.75

**Critical Failures (immediate abort):**
- Any claim directly contradicts its cited source
- >40% of sources inaccessible
- Reliance on Tier 5 (discredited) sources for major claims
- Core research questions entirely unaddressed

## Domain-Specific Extensions

When validating research quality:

1. **Factual Verification**
   - Sample 20% of major claims (30% for comprehensive depth)
   - Cross-check each claim against its cited source
   - Verify statistics, data points, and technical details
   - Flag any misrepresentations or misattributions
   - **Critical:** Any claim contradicting its source = ABORT

2. **Citation Audit**
   - Test accessibility of sampled URLs (all academic sources for comprehensive depth)
   - Verify author and date accuracy
   - Check citation format consistency
   - Count broken links (threshold: 2-3 acceptable for quick, 1-2 for standard, 0 for comprehensive academic sources)
   - **Critical:** >40% broken links = ABORT

3. **Source Quality Assessment**
   - Apply source quality criteria from `source-quality-criteria.md`
   - Classify each source by tier (1-5)
   - Calculate tier distribution percentage
   - **Pass threshold:** ≥40% Tier 1-2 (quick), ≥60% (standard), ≥70% (comprehensive)
   - **Critical:** Tier 5 sources for major claims = ABORT

4. **Completeness Check**
   - Compare findings to research questions from Phase 0
   - Verify all defined subtopics addressed
   - Assess depth appropriate to research_depth parameter
   - Check query count targets met
   - Identify remaining gaps
   - **Critical:** Core questions unaddressed = ABORT

5. **Conflict Resolution Check**
   - Verify contradictions are documented
   - Assess resolution approaches used
   - Check multiple perspectives presented fairly
   - Ensure conflicts not hidden or misrepresented
   - **Critical:** Major contradictions hidden = ABORT

## Depth-Specific Adjustments

### Quick Depth
- Factual accuracy sampling: 10% (vs 20% standard)
- Broken link tolerance: 2-3 links
- Source quality: ≥40% Tier 1-2
- Completeness: Major themes covered (not exhaustive)

### Standard Depth
- Use standard criteria as defined above
- Factual accuracy sampling: 20%
- Broken link tolerance: 1-2 links
- Source quality: ≥60% Tier 1-2
- Completeness: All subtopics covered

### Comprehensive Depth
- Factual accuracy sampling: 30% (vs 20% standard)
- Broken link tolerance: 0 for academic sources
- Source quality: ≥70% Tier 1-2, prioritize Tier 1
- Completeness: Exhaustive coverage required

## Scoring Formula

```python
overall_score = (
    factual_accuracy * 0.30 +
    citation_accuracy * 0.25 +
    source_quality * 0.25 +
    completeness * 0.15 +
    conflict_resolution * 0.05
)

# Individual criterion scoring (0.0-1.0):
# 1.0: Excellent, exceeds threshold
# 0.8: Good, meets threshold with minor issues
# 0.6: Fair, below threshold but usable
# 0.4: Poor, significant issues
# 0.0: Critical failure
```

## Remediation Guidance (on FAIL)

When validation fails, provide **specific, actionable guidance** for Phase 1 re-execution:

### Factual Accuracy Issues
- List specific claims needing re-verification
- Identify sources that were misrepresented
- Suggest additional cross-reference sources

### Citation Accuracy Issues
- List broken URLs (suggest archive.org lookup)
- Identify uncited claims requiring sources
- Specify formatting corrections needed

### Source Quality Issues
- List Tier 4-5 sources to replace
- Suggest specific Tier 1-2 source types to target
- Identify outdated sources needing current alternatives
- For comprehensive depth: recommend academic databases

### Completeness Issues
- List specific subtopics requiring additional research
- Specify minimum query count needed
- Suggest information gaps to address
- Recommend query refinements

### Conflict Resolution Issues
- List unacknowledged conflicts
- Suggest resolution approaches (source hierarchy, multiple perspectives)
- Identify biased presentations needing balance

## Remediation Loop Tracking

State metadata tracks:
- `remediation_count`: Current iteration (0, 1, or 2)
- `remediation_history`: Previous failure reasons
- `focused_queries`: Specific areas to re-research

Each remediation adds 30-50% to time budget.

## Gate Exit Criteria

- [ ] All quality criteria scored with evidence
- [ ] Overall quality score calculated
- [ ] Critical failures checked
- [ ] Pass/Fail/Remediate determination made
- [ ] Remediation guidance provided (if failing)
- [ ] Validation confidence assessed (HIGH/MEDIUM/LOW)
- [ ] Quality report documented in memory file

## Output

Document validation results in memory file:

```markdown
## Validation Summary

**Overall Score:** X.XX / 1.00
**Verdict:** PASS / FAIL / ABORT

## Per-Criterion Scores

| Criterion | Score | Threshold | Status | Evidence |
|-----------|-------|-----------|--------|----------|
| Factual Accuracy | X.X | 0.75 | PASS/FAIL | [Details] |
| Citation Accuracy | X.X | 0.80 | PASS/FAIL | [Details] |
| Source Quality | X.X | 0.70 | PASS/FAIL | [Details] |
| Completeness | X.X | 0.75 | PASS/FAIL | [Details] |
| Conflict Resolution | X.X | 0.70 | PASS/FAIL | [Details] |

## Critical Failures

- [None] OR [List of critical failures that triggered ABORT]

## Remediation Guidance (if FAIL)

### Priority 1: [Criterion that failed worst]
- Specific action 1
- Specific action 2

### Priority 2: [Next criterion]
- Specific action 1

## Validation Confidence

**Confidence Level:** HIGH / MEDIUM / LOW
**Reasoning:** [Why this confidence level]
```

Memory file: `.claude/memory/task-{id}-orchestrate-validation-memory.md`
