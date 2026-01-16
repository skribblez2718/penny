# Phase 4: Requirements Validation

**Uses Atomic Skill:** `orchestrate-validation`
**Phase Type:** REMEDIATION
**Remediation Target:** "1" (Phase 1: Requirements Elicitation)
**Max Remediation:** 2

## Purpose

Validate requirements with stakeholder for completeness, consistency, clarity, and testability. If validation fails, loop back to Phase 1 for additional elicitation (max 2 remediation iterations).

## Validation Criteria

Review requirements against these criteria:

### 1. Completeness
- [ ] All functional requirements captured
- [ ] All NFRs identified and specified
- [ ] No obvious gaps in coverage
- [ ] Edge cases addressed

### 2. Consistency
- [ ] No contradicting requirements
- [ ] Terminology used consistently
- [ ] Priorities make sense
- [ ] NFRs align with functional requirements

### 3. Clarity
- [ ] Requirements are unambiguous
- [ ] User stories follow standard format
- [ ] Acceptance criteria are testable
- [ ] NFRs use measurable metrics

### 4. Testability
- [ ] Each acceptance criterion can be verified
- [ ] NFRs have measurable success criteria
- [ ] Clear definition of "done" for each story

### 5. Feasibility
- [ ] Requirements are achievable given constraints
- [ ] No impossible NFRs (e.g., 0ms response time)
- [ ] Priorities reflect realistic trade-offs

## Validation Method

**Reference:** `${CAII_DIRECTORY}/.claude/skills/develop-requirements/resources/validation-checklist.md`

### Single-Stakeholder Validation
1. Present user stories, acceptance criteria, and NFRs to user
2. Walk through RTM to show complete coverage
3. Review priorities and get confirmation
4. Document any gaps or clarifications needed
5. If gaps exist → trigger remediation (back to Phase 1)

### Multi-Stakeholder Validation
1. Present requirements to each stakeholder
2. Get sign-off from each stakeholder group
3. Resolve any new conflicts discovered
4. Document approval status per stakeholder
5. If gaps or conflicts exist → trigger remediation

## Remediation Loop

If validation identifies gaps:
1. **Identify specific gaps** - what is missing or unclear?
2. **Update Phase 1 focus** - targeted elicitation on gap areas
3. **FSM transitions to Phase 1** - re-execute elicitation
4. **Max 2 remediation loops** - prevent infinite cycling
5. **After 2 loops** - force completion with documented gaps

## Validation Outputs

- **Pass:** Stakeholder approval obtained, proceed to Phase 5
- **Fail (remediation):** Gaps identified, loop to Phase 1 (if iterations remain)
- **Fail (max remediation):** Gaps documented but forced to Phase 5

## Gate Exit Criteria

- [ ] Stakeholder review completed
- [ ] Completeness validated
- [ ] Consistency validated
- [ ] Clarity validated
- [ ] Testability validated
- [ ] Feasibility validated
- [ ] Stakeholder approval obtained OR gaps documented with rationale

## Output

Document validation results in validation-agent memory file.

Include:
- **Validation Status:** Pass, Fail (remediation needed), Fail (max remediation reached)
- **Validation Scores:** Per criterion (Completeness, Consistency, Clarity, Testability, Feasibility)
- **Gaps Identified:** Specific missing or unclear requirements
- **Stakeholder Feedback:** Comments from validation session
- **Remediation Plan:** If looping back to Phase 1, what to focus on
- **Approval Record:** Stakeholder sign-off status
