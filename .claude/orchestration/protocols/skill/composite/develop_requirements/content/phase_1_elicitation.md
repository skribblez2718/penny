# Phase 1: Requirements Elicitation

**Uses Atomic Skill:** `orchestrate-research`
**Phase Type:** ITERATIVE
**Iteration Agents:** ["research"]

## Purpose

Gather complete requirements using multiple elicitation techniques: interviews, observation, document analysis, and prototyping.

## Elicitation Techniques

Use all applicable techniques based on project context:

### 1. Interview-Based Elicitation
- Ask stakeholder what they need
- Explore pain points and goals
- Discover hidden requirements through follow-up questions
- Document assumptions and constraints

### 2. Observation-Based Elicitation
- If existing system/process exists, understand current workflow
- Identify inefficiencies and improvement opportunities
- Note unstated requirements from context

### 3. Document Analysis
- Review any existing specs, notes, or documentation
- Extract requirements from user-provided materials
- Identify contradictions or gaps

### 4. Prototyping/Scenarios
- Develop example scenarios to elicit feedback
- Use "what if" questions to explore edge cases
- Validate understanding through concrete examples

## Requirements Categories

Gather both functional and non-functional requirements:

### Functional Requirements
- What the system must do
- User actions and system responses
- Business rules and workflows
- Data requirements

### Non-Functional Requirements (NFRs)
- Performance (speed, throughput, capacity)
- Security (authentication, authorization, encryption)
- Usability (accessibility, user experience)
- Reliability (availability, fault tolerance)
- Maintainability (code quality, documentation)
- Scalability (growth handling)

## Iterative Process

This phase may execute multiple times (orchestrate-research iterations):
1. **First iteration:** Broad requirements gathering
2. **Subsequent iterations:** Deep-dive on specific areas or gaps
3. **Remediation iterations:** Fill gaps identified by Phase 4 validation

## Single vs Multi-Stakeholder Mode

**Single-Stakeholder (default):**
- Treat user as sole source of truth
- No stakeholder conflict resolution needed
- Validate understanding with user directly

**Multi-Stakeholder:**
- Gather requirements from each stakeholder
- Document source for each requirement
- Note conflicting requirements for Phase 2 synthesis

## Gate Exit Criteria

- [ ] All functional requirements elicited and documented
- [ ] Non-functional requirements (NFRs) identified and captured
- [ ] Assumptions documented
- [ ] Constraints identified
- [ ] Edge cases and scenarios explored
- [ ] Requirements sources documented (if multi-stakeholder)

## Output

Document elicited requirements in the research-agent memory file for use by Phase 2 (Requirements Specification).

Include:
- **Functional Requirements:** List of what the system must do
- **Non-Functional Requirements:** Performance, security, usability, etc.
- **Assumptions:** What is being assumed
- **Constraints:** Limitations on solution
- **Elicitation Notes:** Context, rationale, sources
- **Edge Cases:** Unusual scenarios to handle
