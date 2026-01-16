# Phase 2: Requirements Specification

**Uses Atomic Skill:** `orchestrate-synthesis`
**Phase Type:** LINEAR

## Purpose

Transform raw requirements from Phase 1 into structured, testable specifications using user stories, acceptance criteria, and SMART non-functional requirements.

## Specification Formats

### User Stories (Functional Requirements)

Use standard user story format:
```
As a [user type],
I want to [action],
So that [benefit/value].
```

**Best Practices:**
- Focus on user value, not implementation
- Keep stories independent when possible
- Make stories negotiable and testable
- Appropriate size for implementation

### Acceptance Criteria (per User Story)

Define testable acceptance criteria using Given-When-Then format:
```
Given [initial context],
When [action occurs],
Then [expected outcome].
```

**Requirements:**
- Criteria must be testable and unambiguous
- Cover happy path and edge cases
- Define what "done" means for each story

### SMART Non-Functional Requirements

Transform NFRs using SMART criteria:
- **S**pecific - Precisely defined
- **M**easurable - Quantifiable metric
- **A**chievable - Realistic given constraints
- **R**elevant - Adds value to project
- **T**ime-bound - When it must be met

**Example:**
```
NFR-001: Performance
The system shall process user requests with a response time of less than 200ms
for 95% of requests during peak load (1000 concurrent users) by release 1.0.
```

## Synthesis Tasks

1. **Group related requirements** into logical features/epics
2. **Transform functional requirements** into user stories
3. **Define acceptance criteria** for each story
4. **Specify NFRs** using SMART format
5. **Resolve conflicts** (if multi-stakeholder mode)
6. **Prioritize** requirements (MoSCoW: Must/Should/Could/Won't)

## Conflict Resolution (Multi-Stakeholder)

If conflicting requirements exist:
1. Document the conflict explicitly
2. Identify affected stakeholders
3. Propose resolution options
4. Get stakeholder input on priority
5. Document final decision and rationale

## Single-Stakeholder Simplification

In single-stakeholder mode:
- No conflict resolution needed
- User is source of truth for priorities
- Validation is direct with user

## Gate Exit Criteria

- [ ] All functional requirements converted to user stories
- [ ] Each story has testable acceptance criteria
- [ ] NFRs follow SMART criteria
- [ ] Requirements prioritized (MoSCoW)
- [ ] Conflicts resolved (if multi-stakeholder)
- [ ] Stories are independent and appropriately sized

## Output

Document structured requirements in the synthesis-agent memory file for use by Phase 3 (Traceability Matrix Creation).

Include:
- **User Stories:** Complete set with As-Want-So format
- **Acceptance Criteria:** Given-When-Then per story
- **NFR Specification:** SMART non-functional requirements
- **Priorities:** MoSCoW prioritization
- **Conflicts & Resolutions:** Documented decisions (if multi-stakeholder)
