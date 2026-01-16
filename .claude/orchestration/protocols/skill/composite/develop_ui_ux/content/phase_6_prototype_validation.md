# Phase 6: Prototype & Validation

**Type:** REMEDIATION
**Atomic Skill:** orchestrate-validation
**Agent:** validation
**Remediation Target:** Phase 4 (Component Library Design)
**Max Remediation:** 2

## Objective

Validate design system deliverables against quality criteria and requirements. If validation fails, loop back to Phase 4 for remediation.

## Input Context

From Phase 0:
- Design requirements
- Target platforms
- Accessibility level
- Design system scope

From Phase 3:
- Design token architecture
- Three-tier token taxonomy

From Phase 4:
- Component library specifications
- Atomic design hierarchy

From Phase 5:
- Accessibility documentation
- WCAG compliance checklist
- Color contrast report

## Validation Criteria

### 1. Token Architecture Validation

**Structural Integrity:**
- [ ] Three-tier taxonomy maintained (primitive → semantic → component)
- [ ] No hardcoded values in semantic tokens (must reference primitives)
- [ ] No hardcoded values in component tokens (must reference semantic)
- [ ] Token naming conventions followed consistently
- [ ] All required token categories present (color, spacing, typography, etc.)

**Completeness:**
- [ ] Primitive tokens cover full color palette
- [ ] Spacing scale is complete and consistent
- [ ] Typography tokens include all font properties
- [ ] Border radius, elevation, opacity tokens defined
- [ ] All component tokens needed by components exist

**Platform Compatibility:**
- [ ] Token structure works for all target platforms
- [ ] Platform transformation approach documented
- [ ] Platform-specific overrides identified (if needed)

### 2. Component Library Validation

**Atomic Design Coverage:**
- [ ] Minimum 10 atomic components specified
- [ ] Minimum 6 molecular components specified
- [ ] Minimum 4 organism components specified
- [ ] Atomic design hierarchy followed (atoms → molecules → organisms)

**Token Reference Compliance:**
- [ ] All components reference tokens (NO hardcoded values)
- [ ] All styling properties use token references
- [ ] Token references are valid (tokens exist in Phase 3 architecture)

**State Coverage:**
- [ ] All components document default state
- [ ] Interactive components document hover state
- [ ] Interactive components document focus state
- [ ] Interactive components document active state
- [ ] Interactive components document disabled state
- [ ] Form components document error state (if applicable)

**Documentation Quality:**
- [ ] Each component has clear purpose/description
- [ ] Variants documented for all components
- [ ] Composition documented for molecules/organisms
- [ ] Platform-specific notes added (if multi-platform)

### 3. Accessibility Validation

**WCAG Compliance:**
- [ ] WCAG {AA|AAA} checklist complete
- [ ] All text/background combinations meet contrast requirements
- [ ] Focus indicators meet contrast requirements ({AA: 3:1 | AAA: 4.5:1})
- [ ] Color is not sole means of conveying information

**ARIA Documentation:**
- [ ] All components have ARIA roles documented
- [ ] Custom components have appropriate ARIA attributes
- [ ] ARIA states documented for stateful components
- [ ] ARIA properties documented (labels, descriptions, etc.)

**Keyboard Navigation:**
- [ ] All interactive components have keyboard navigation patterns
- [ ] Focus management documented for complex components
- [ ] Keyboard shortcuts documented
- [ ] No keyboard traps identified

**Screen Reader Support:**
- [ ] Screen reader testing guide created
- [ ] Screen reader announcements documented
- [ ] Dynamic content changes have ARIA live regions
- [ ] Landmarks identified (header, nav, main, aside, footer)

### 4. Platform Validation

**For Each Target Platform:**

[PLATFORM:WEB]
- [ ] CSS implementation approach defined
- [ ] Responsive breakpoints specified
- [ ] Browser compatibility documented

[PLATFORM:MOBILE]
- [ ] iOS implementation notes provided
- [ ] Android implementation notes provided
- [ ] Touch target sizes meet minimum (44x44px/dp)
- [ ] Platform-specific design guidelines followed

[PLATFORM:DESKTOP]
- [ ] Desktop implementation approach defined
- [ ] Native OS integration considerations documented
- [ ] Desktop-specific interaction patterns specified

### 5. Requirements Validation

**Against Phase 0 Requirements:**
- [ ] All target platforms addressed
- [ ] Brand identity requirements incorporated (if existing)
- [ ] Accessibility level achieved ({AA|AAA})
- [ ] Design system scope delivered (full/tokens-only/components-only)
- [ ] Visual reference systems incorporated appropriately

## Validation Scoring

### Scoring Weights

| Category | Weight | Pass Threshold |
|----------|--------|----------------|
| Token Architecture | 25% | 90% criteria met |
| Component Library | 30% | 85% criteria met |
| Accessibility | 30% | {AA: 95% | AAA: 100%} criteria met |
| Platform Compatibility | 10% | 90% criteria met |
| Requirements Alignment | 5% | 100% criteria met |

### Overall Score Calculation

```
Overall Score = (Token % × 0.25) + (Component % × 0.30) +
                (Accessibility % × 0.30) + (Platform % × 0.10) +
                (Requirements % × 0.05)
```

### Pass/Fail Thresholds

- **PASS:** Overall score ≥ 90%
- **CONDITIONAL:** Overall score 75-89% (minor issues, document and proceed)
- **FAIL:** Overall score < 75% (remediate to Phase 4)

## Validation Report Format

```markdown
# Design System Validation Report

## Executive Summary
- Overall Score: {score}%
- Status: {PASS | CONDITIONAL | FAIL}
- Validation Date: {date}
- WCAG Level: {AA|AAA}

## Category Scores

### Token Architecture ({score}%)
**Passed Criteria:** {count}/{total}
**Issues Found:**
- [List any issues]

**Recommendations:**
- [List recommendations]

### Component Library ({score}%)
**Passed Criteria:** {count}/{total}
**Issues Found:**
- [List any issues]

**Recommendations:**
- [List recommendations]

### Accessibility ({score}%)
**Passed Criteria:** {count}/{total}
**Issues Found:**
- [List any issues]

**Recommendations:**
- [List recommendations if WCAG compliance not met]

### Platform Compatibility ({score}%)
**Passed Criteria:** {count}/{total}
**Issues Found:**
- [List any issues]

### Requirements Alignment ({score}%)
**Passed Criteria:** {count}/{total}
**Issues Found:**
- [List any issues]

## Decision

### PASS (Score ≥ 90%)
✅ Design system validation complete. All quality criteria met.

**Next Steps:**
- Finalize documentation
- Prepare handoff package
- Consider implementation phase

### CONDITIONAL (Score 75-89%)
⚠️  Design system validation passed with minor issues.

**Documented Issues:**
- [List issues that prevent full PASS]

**Accepted Risk:**
- [Document why proceeding despite issues]

**Next Steps:**
- Document known issues
- Create backlog for improvements
- Proceed to completion

### FAIL (Score < 75%)
❌ Design system validation failed. Remediation required.

**Critical Issues:**
- [List issues requiring remediation]

**Remediation Plan:**
- Loop back to Phase 4 (Component Library Design)
- Address critical issues
- Re-validate

**Remediation Iteration:** {current}/{max: 2}
**Next Phase:** Phase 4 (Component Library Design)
```

## Remediation Flow

### When Validation Fails (Score < 75%)

1. **Identify Root Causes**
   - Which validation criteria failed?
   - Are issues in tokens, components, or accessibility?

2. **Determine Remediation Target**
   - **Phase 4:** Component library or accessibility issues
   - **NOT Phase 3:** Token architecture is preserved

3. **Loop Back to Phase 4**
   - Maximum 2 remediation iterations
   - Phase 3 token architecture remains unchanged
   - Phase 4 and 5 are regenerated with fixes

4. **Re-validate**
   - Return to Phase 6 with updated artifacts
   - Re-run validation criteria
   - Check if issues resolved

### Remediation Iteration Limit

- **Iteration 1:** First remediation attempt
- **Iteration 2:** Second remediation attempt
- **After 2 Iterations:** Escalate to user for clarification/scope adjustment

**Why Loop to Phase 4, Not Phase 3?**
- Token architecture is the critical path and typically correct
- Most issues are in component specs or accessibility documentation
- Preserving token architecture saves significant rework

## Output Requirements

### Validation Package

```markdown
# Validation Package

## 1. Validation Report
[Complete validation report with scores and decision]

## 2. Issue Log
[Detailed log of all issues found]

## 3. Remediation Plan (if FAIL)
[Plan to address issues in next iteration]

## 4. Sign-off Documentation (if PASS)
[Approval to proceed to completion]

## 5. Known Issues Register (if CONDITIONAL)
[Document accepted issues for future improvement]
```

## Gate Criteria

- [ ] All validation criteria evaluated
- [ ] Scores calculated for all categories
- [ ] Overall score determined
- [ ] Decision made (PASS/CONDITIONAL/FAIL)
- [ ] Validation report generated
- [ ] Remediation plan created (if FAIL)
- [ ] Known issues documented (if CONDITIONAL)

## Downstream Context

### If PASS or CONDITIONAL
- Proceed to skill completion
- Aggregate all deliverables
- Create handoff package

### If FAIL
- Loop back to Phase 4
- Preserve Phase 3 token architecture
- Regenerate Phase 4 (components) and Phase 5 (accessibility)
- Return to Phase 6 for re-validation

## Common Validation Failures

### Token Architecture Issues
- Hardcoded values in semantic/component tokens
- Incomplete token coverage
- Inconsistent naming conventions

### Component Library Issues
- Hardcoded values instead of token references
- Missing state documentation
- Insufficient accessibility documentation
- Incorrect atomic design hierarchy

### Accessibility Issues
- Color contrast failures
- Missing ARIA roles
- Incomplete keyboard navigation
- Screen reader compatibility not documented

### Platform Issues
- Platform-specific constraints not addressed
- Token transformation not defined
- Responsive strategies missing (web)
- Touch targets too small (mobile)

## Validation Resources

See `.claude/skills/develop-ui-ux/resources/validation-checklist.md` for detailed validation criteria.

## Agent Invocation Template

```markdown
# Agent Invocation: validation

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `6`
- **Domain:** `creative/technical`
- **Agent:** `validation`

## Role Extension

**Task-Specific Focus:**
- Validate token architecture (three-tier taxonomy, no hardcoded values)
- Validate component library (token references, state coverage, atomic design)
- Validate WCAG {AA|AAA} accessibility compliance
- Validate platform compatibility for [{target_platforms}]
- Calculate validation scores and make PASS/CONDITIONAL/FAIL decision

## Task

Validate design system deliverables against quality criteria.

Score each category, calculate overall score, and determine if remediation to Phase 4 is needed.

## Related Research Terms

- Design system validation
- WCAG compliance testing
- Token architecture validation
- Component specification review
- Accessibility auditing
- Design system quality criteria
- Remediation planning
- Validation scoring

## Output

Write to: `.claude/memory/{task-id}-validation-memory.md`
```
