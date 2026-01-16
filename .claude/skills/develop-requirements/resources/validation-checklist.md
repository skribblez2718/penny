# Requirements Validation Checklist

This checklist is used by Phase 4 (Requirements Validation) to systematically verify requirements quality.

## Validation Criteria Weights

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Completeness | 25% | All requirements captured, no gaps |
| Consistency | 20% | No contradictions, aligned priorities |
| Clarity | 20% | Unambiguous, well-formatted |
| Testability | 25% | Acceptance criteria verifiable |
| Feasibility | 10% | Achievable given constraints |

**Passing Score:** ≥80% overall with no criterion scoring below 60%

## 1. Completeness Checklist (25%)

### Functional Requirements
- [ ] All user actions are covered by user stories
- [ ] All system responses are defined
- [ ] Business rules are documented
- [ ] Data requirements are specified
- [ ] Workflows are complete end-to-end

### Non-Functional Requirements
- [ ] Performance requirements specified with metrics
- [ ] Security requirements identified
- [ ] Usability requirements defined
- [ ] Reliability requirements stated
- [ ] Maintainability considerations documented
- [ ] Scalability requirements addressed (if applicable)

### Coverage
- [ ] Edge cases identified and addressed
- [ ] Error handling scenarios covered
- [ ] Integration points defined
- [ ] No obvious functional gaps

### Scoring
- **100%:** All boxes checked, comprehensive coverage
- **75%:** Minor gaps in edge cases or NFRs
- **50%:** Significant functional gaps
- **25%:** Major missing areas
- **0%:** Critical missing requirements

## 2. Consistency Checklist (20%)

### Internal Consistency
- [ ] No contradicting requirements
- [ ] Terminology used consistently throughout
- [ ] User story formats are uniform
- [ ] Acceptance criteria follow same structure
- [ ] NFR specifications use consistent metrics

### Priority Consistency
- [ ] MoSCoW priorities make sense
- [ ] No conflicting "Must Have" requirements
- [ ] Priorities align with stated goals
- [ ] NFR priorities match functional priorities

### Cross-Artifact Consistency
- [ ] RTM correctly links requirements to stories
- [ ] All stories have corresponding requirements
- [ ] Acceptance criteria match story intent
- [ ] No orphaned requirements or stories

### Scoring
- **100%:** Fully consistent, no contradictions
- **75%:** Minor terminology inconsistencies
- **50%:** Some contradicting priorities
- **25%:** Multiple contradictions found
- **0%:** Severe inconsistencies throughout

## 3. Clarity Checklist (20%)

### Unambiguous Language
- [ ] Requirements use clear, specific language
- [ ] Avoid vague terms like "user-friendly" or "fast"
- [ ] No ambiguous pronouns (it, they, this)
- [ ] Technical terms are defined

### Format Compliance
- [ ] User stories follow "As-Want-So" format
- [ ] Acceptance criteria use "Given-When-Then"
- [ ] NFRs follow SMART criteria
- [ ] IDs follow consistent naming scheme

### Readability
- [ ] Requirements are understandable to stakeholders
- [ ] No jargon without explanation
- [ ] Examples provided where helpful
- [ ] Complex requirements are broken down

### Scoring
- **100%:** Crystal clear, no ambiguity
- **75%:** Minor wording improvements needed
- **50%:** Several ambiguous requirements
- **25%:** Many unclear requirements
- **0%:** Incomprehensible or severely ambiguous

## 4. Testability Checklist (25%)

### Acceptance Criteria Quality
- [ ] Each user story has acceptance criteria
- [ ] Criteria are specific and measurable
- [ ] Clear pass/fail conditions defined
- [ ] Observable outcomes specified
- [ ] Criteria cover both happy path and edge cases

### NFR Testability
- [ ] Performance NFRs have measurable metrics
- [ ] Security NFRs have verification methods
- [ ] Usability NFRs have success criteria
- [ ] All NFRs can be objectively verified

### Definition of Done
- [ ] Clear "done" definition per story
- [ ] Completion criteria are objective
- [ ] No subjective "looks good" criteria
- [ ] Verification method is feasible

### Scoring
- **100%:** All requirements fully testable
- **75%:** Most testable, few soft criteria
- **50%:** Many subjective criteria
- **25%:** Mostly untestable
- **0%:** No testable criteria

## 5. Feasibility Checklist (10%)

### Technical Feasibility
- [ ] Requirements are achievable with available technology
- [ ] No impossible NFRs (e.g., 0ms latency)
- [ ] Dependencies are available or obtainable
- [ ] Integration points are realistic

### Resource Feasibility
- [ ] Requirements fit within time constraints
- [ ] Requirements fit within budget constraints
- [ ] Required expertise is available
- [ ] Tool/platform requirements are met

### Priority Realism
- [ ] "Must Have" requirements are truly essential
- [ ] Priorities reflect realistic trade-offs
- [ ] Scope is achievable given constraints
- [ ] No unrealistic expectations documented

### Scoring
- **100%:** Fully feasible, realistic scope
- **75%:** Minor feasibility concerns
- **50%:** Some unrealistic requirements
- **25%:** Many infeasible requirements
- **0%:** Fundamentally infeasible

## Validation Outcomes

### Pass (≥80% overall, all criteria ≥60%)
- Stakeholder approval obtained
- Requirements ready for implementation
- Proceed to Phase 5 (Change Management Setup)

### Fail - Remediation Needed (<80% or any criterion <60%)
- Identify specific gaps and unclear requirements
- Loop back to Phase 1 (Requirements Elicitation) for focused re-gathering
- Max 2 remediation iterations

### Fail - Max Remediation Reached
- After 2 remediation loops, force completion
- Document remaining gaps in Unknown Registry
- Proceed to Phase 5 with known limitations

## Stakeholder Sign-Off

### Single-Stakeholder Mode
- [ ] User has reviewed all requirements
- [ ] User approves user stories and acceptance criteria
- [ ] User approves NFR specifications
- [ ] User acknowledges priorities
- [ ] User signature/approval recorded

### Multi-Stakeholder Mode
- [ ] Each stakeholder group has reviewed relevant requirements
- [ ] All stakeholder approvals obtained
- [ ] Conflicts resolved with documented decisions
- [ ] Approval matrix completed
- [ ] All signatures/approvals recorded

## Remediation Focus Areas

When looping back to Phase 1, target these specific gaps:

### If Completeness Failed
- Re-elicit missing functional requirements
- Deep-dive on incomplete NFRs
- Explore uncovered edge cases

### If Consistency Failed
- Resolve contradicting requirements
- Standardize terminology
- Align priorities

### If Clarity Failed
- Rewrite ambiguous requirements
- Add examples and definitions
- Improve acceptance criteria specificity

### If Testability Failed
- Add measurable acceptance criteria
- Define NFR verification methods
- Create objective completion criteria

### If Feasibility Failed
- Descope unrealistic requirements
- Revise impossible NFRs
- Re-prioritize with constraint awareness
