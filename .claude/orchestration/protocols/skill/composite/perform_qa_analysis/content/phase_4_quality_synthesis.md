# Phase 4: Quality Synthesis & Validation

**Objective:** Aggregate all test results, calculate quality score, validate gate G4, and generate comprehensive QA report.

## Agent Invocation

You will invoke the **validation** agent to synthesize results and validate quality gates.

## Context to Provide

Load from all prior phase memories:
- Phase 0: Configuration (platform, mode, thresholds, pyramid ratios)
- Phase 1: Unit test results (coverage, pass rate)
- Phase 2: Integration test results (pass rate)
- Phase 3: E2E test results (pass rate, diagnostics)

## Agent Prompt Template

```markdown
# Agent Invocation: validation

## Task Context
- **Task ID:** task-perform-qa-analysis-synthesis
- **Skill:** perform-qa-analysis
- **Phase:** 4
- **Domain:** technical
- **Agent:** validation

## Role Extension

Focus on:
- Aggregating results from all test layers
- Calculating overall quality score
- Validating quality gate G4
- Checking testing pyramid compliance
- Generating comprehensive QA report
- Providing actionable recommendations

## Prior Context

From Phase 0:
- Platform: {platform_id}
- Mode: {mode}
- Pyramid Ratios: {ratios}
- Quality Thresholds: {thresholds}

From Phase 1:
- Unit Coverage: {percentage}%
- Unit Pass Rate: {percentage}%
- Unit Test Count: {count}

From Phase 2:
- Integration Pass Rate: {percentage}%
- Integration Test Count: {count}

From Phase 3:
- E2E Pass Rate: {percentage}%
- E2E Test Count: {count}
- Failed Tests: {count}

## Task Instructions

### 1. Aggregate Test Results

Compile all test metrics:

```yaml
total_tests: {unit + integration + e2e}
unit_tests: {count}
integration_tests: {count}
e2e_tests: {count}

unit_coverage: {percentage}%
unit_pass_rate: {percentage}%
integration_pass_rate: {percentage}%
e2e_pass_rate: {percentage}%
```

### 2. Validate Pyramid Compliance

Check actual test distribution against configured ratios:

```yaml
expected_ratios:
  unit: {ratio}
  integration: {ratio}
  e2e: {ratio}

actual_ratios:
  unit: {count / total}
  integration: {count / total}
  e2e: {count / total}

compliance:
  unit: {within ±10% tolerance?}
  integration: {within ±10% tolerance?}
  e2e: {within ±10% tolerance?}
```

**Actions:**
- Calculate actual ratios
- Compare to configured ratios
- Flag significant deviations (> ±10%)
- Provide recommendations if non-compliant

### 3. Calculate Quality Score

Use formula:
```
quality_score = (unit_pass_rate * 0.4) + (integration_pass_rate * 0.3) + (e2e_pass_rate * 0.3)
```

**Breakdown:**
- Unit contribution: {unit_pass_rate * 0.4}
- Integration contribution: {integration_pass_rate * 0.3}
- E2E contribution: {e2e_pass_rate * 0.3}
- **Total Score:** {quality_score}

**Quality Score Interpretation:**
- 1.0 - 0.90: Excellent
- 0.89 - 0.75: Good (meets threshold)
- 0.74 - 0.60: Fair (below threshold)
- < 0.60: Poor (needs immediate attention)

### 4. Quality Gate G4 Validation

**Criteria:**
- Quality score ≥ 0.75 (or custom threshold)

**Validation:**
- [ ] Quality score meets threshold
- [ ] All individual gates (G1, G2, G3a, G3b) passed
- [ ] Pyramid compliance within tolerance

**Gate Status Summary:**
| Gate | Criterion | Status | Details |
|------|-----------|--------|---------|
| G1 | Requirements | PASS/FAIL | {details} |
| G2 | Unit tests | PASS/FAIL | {coverage}%, {pass_rate}% |
| G3a | Integration | PASS/FAIL | {pass_rate}% |
| G3b | E2E tests | PASS/FAIL | {pass_rate}% |
| G4 | Quality score | PASS/FAIL | {score} (threshold: {threshold}) |

### 5. Identify Issues and Recommendations

**If quality score < threshold:**
- Identify weakest test layer
- Calculate improvement needed
- Prioritize fixes by impact

**If pyramid non-compliant:**
- Identify over/under-represented layers
- Recommend test additions/removals
- Estimate effort to achieve compliance

**If any tests failed:**
- Categorize failures (unit/integration/e2e)
- Identify common patterns
- Suggest root cause analysis
- Provide fix priorities

### 6. Generate QA Report

Create comprehensive report with:

**Executive Summary:**
- Overall quality score
- Gate pass/fail status
- Critical issues count
- Recommendation count

**Detailed Metrics:**
- Test execution summary
- Coverage analysis
- Pass rate breakdown
- Pyramid compliance

**Failed Tests:**
- Categorized by layer
- Includes diagnostics
- Priority ranking

**Recommendations:**
- Prioritized action items
- Effort estimates
- Impact assessment

## Related Research Terms
- quality score calculation
- testing pyramid compliance
- test aggregation
- QA reporting
- quality metrics
- test pass rates
- coverage analysis
- quality gates
- test recommendations
- quality assessment

## Output Requirements

**Memory File:** `.claude/memory/task-perform-qa-analysis-synthesis-memory.md`

**Structure:**
```markdown
# QA Analysis Report: {platform}

## Executive Summary

**Overall Quality Score:** {score} / 1.0
**Status:** {Excellent|Good|Fair|Poor}
**Quality Gate G4:** {PASS|FAIL}

**Critical Issues:** {count}
**Total Recommendations:** {count}

---

## Test Execution Summary

| Layer | Tests | Passed | Failed | Pass Rate | Coverage |
|-------|-------|--------|--------|-----------|----------|
| Unit | {count} | {count} | {count} | {%} | {%} |
| Integration | {count} | {count} | {count} | {%} | N/A |
| E2E | {count} | {count} | {count} | {%} | N/A |
| **Total** | {count} | {count} | {count} | {%} | {%} |

---

## Quality Gates Status

| Gate | Criterion | Threshold | Actual | Status |
|------|-----------|-----------|--------|--------|
| G1 | Requirements | N/A | {validated} | ✓ PASS |
| G2 | Unit Coverage | {threshold}% | {actual}% | {PASS/FAIL} |
| G2 | Unit Pass Rate | 100% | {actual}% | {PASS/FAIL} |
| G3a | Integration Pass | 100% | {actual}% | {PASS/FAIL} |
| G3b | E2E Pass | 100% | {actual}% | {PASS/FAIL} |
| G4 | Quality Score | {threshold} | {actual} | {PASS/FAIL} |

---

## Testing Pyramid Compliance

**Configured Ratios:**
- Unit: {ratio}
- Integration: {ratio}
- E2E: {ratio}

**Actual Ratios:**
- Unit: {actual_ratio} ({compliant/non-compliant})
- Integration: {actual_ratio} ({compliant/non-compliant})
- E2E: {actual_ratio} ({compliant/non-compliant})

**Compliance Status:** {COMPLIANT|NON-COMPLIANT}
**Deviation:** {details if non-compliant}

---

## Quality Score Breakdown

```
Quality Score = (Unit * 0.4) + (Integration * 0.3) + (E2E * 0.3)
              = ({unit_pass_rate} * 0.4) + ({integration_pass_rate} * 0.3) + ({e2e_pass_rate} * 0.3)
              = {score}
```

**Interpretation:** {Excellent|Good|Fair|Poor}

---

## Failed Tests Detail

{if any failures}

### Unit Test Failures ({count})
- {test_name}: {error_summary} ({file}:{line})

### Integration Test Failures ({count})
- {test_name}: {error_summary} ({file}:{line})

### E2E Test Failures ({count})
- {test_name}: {error_summary} ({file}:{line})
  - Screenshot: {path}
  - Console Errors: {list}

---

## Recommendations

### Priority 1 (Critical)
{if quality score < threshold or any gates failed}
1. {recommendation with effort estimate}
2. {recommendation with effort estimate}

### Priority 2 (Important)
{if pyramid non-compliant}
1. {recommendation with effort estimate}

### Priority 3 (Enhancement)
{if score between threshold and 0.90}
1. {recommendation with effort estimate}

---

## Artifacts Generated

- Unit coverage report: {path}
- Integration test logs: {path}
- E2E screenshots: {path}
- Quality report: This file

---

## Conclusion

{Summary of QA status and next steps}

---
**VALIDATION_COMPLETE**
```
```

## Quality Gate G4

**Criteria:**
- Quality score ≥ 0.75 (or custom threshold)

**Actions:**
- If G4 passes: Skill completes successfully
- If G4 fails: Return report with recommendations, mark skill as partial success

**Note:** Unlike G1-G3b, G4 failure does NOT halt the workflow. The report is still generated to provide actionable insights.

## Output Modes

**Mode = testing:**
- Generate basic report
- No recommendations

**Mode = standalone:**
- Generate full report
- Include recommendations
- Skip validation agent features

**Mode = full:**
- Generate comprehensive report
- Include detailed recommendations
- Use validation agent for quality assessment
- Provide effort estimates

## Next Phase

This is the final phase. Upon completion:
- Memory file created with full QA report
- Skill status: COMPLETED
- Quality gate G4 status: {PASS|FAIL}
