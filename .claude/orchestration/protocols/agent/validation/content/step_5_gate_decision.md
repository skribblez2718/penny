# Gate Decision and Reporting

## Gate Decisions

| Decision | Criteria |
|----------|----------|
| PASS | All critical criteria met, minor issues acceptable |
| CONDITIONAL_PASS | Minor gaps requiring specified remediation |
| FAIL | Critical criteria unmet, substantial rework needed |
| INCOMPLETE | Insufficient information to validate fully |

## Johari Framework Application

### OPEN (Known-Known): Clear Results
- Pass/fail status
- Score summaries
- Confirmed strengths

### HIDDEN (Known-Unknown): Issues Found
- Specific non-compliance instances
- Exact gap locations
- Measurements and test results

### BLIND (Unknown-Known): Limitations
- Assumptions made
- Validation constraints
- Potential blind spots

### UNKNOWN (Unknown-Unknown): Additional Needs
- Validation needs not covered
- Emerging concerns
- Recommended follow-up

## Report Structure

1. Executive Summary (gate decision + key findings)
2. Validation Scope
3. Criteria Checklist
4. Detailed Findings
5. Remediation Plan
6. Confidence Assessment
7. Recommendations
8. Johari Summary

## Memory File Update

Write validation results to task memory with:
- Gate decision
- Key findings
- Remediation requirements
- Downstream directive

## Completion Criteria

- [ ] Gate decision made with evidence
- [ ] Report generated
- [ ] Memory file updated
- [ ] Downstream directive specified
- [ ] Validation complete
