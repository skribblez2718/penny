# Phase 3: Traceability Matrix Creation

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR

## Purpose

Create a Requirements Traceability Matrix (RTM) that links each requirement to its user story, acceptance criteria, and original source. Enables impact analysis for changes and ensures no requirements are lost.

## RTM Structure

The RTM shall include these columns:

| Req ID | Requirement | Source | User Story | Acceptance Criteria | Priority | Status |
|--------|-------------|--------|------------|---------------------|----------|--------|
| REQ-001 | [description] | [source] | US-001 | AC-001, AC-002 | Must | Draft |

### Column Definitions

- **Req ID:** Unique identifier (e.g., REQ-001, NFR-001)
- **Requirement:** Brief description of the requirement
- **Source:** Where requirement came from (user, stakeholder, document, observation)
- **User Story:** Linked story ID(s)
- **Acceptance Criteria:** Linked AC ID(s)
- **Priority:** MoSCoW priority (Must/Should/Could/Won't)
- **Status:** Draft, Validated, Approved, Implemented

## Traceability Tasks

1. **Assign IDs** to all requirements, stories, and acceptance criteria
2. **Create forward traceability** - requirement → story → AC
3. **Create backward traceability** - AC → story → requirement
4. **Document sources** - where each requirement originated
5. **Establish versioning** - track requirement changes over time
6. **Link to artifacts** - connect to design docs, tests (if applicable)

## Version Control

Include version metadata in RTM:
- **Document Version:** e.g., v1.0
- **Last Updated:** Timestamp
- **Change History:** What changed from previous version
- **Approver:** Who validated this version

## Single vs Multi-Stakeholder Tracing

**Single-Stakeholder:**
- Source column typically "User" or "Interview"
- Simpler traceability chain
- No stakeholder conflict tracking needed

**Multi-Stakeholder:**
- Source column identifies specific stakeholder
- Track which stakeholder owns which requirement
- Enable stakeholder-specific views of RTM

## Gate Exit Criteria

- [ ] All requirements have unique IDs
- [ ] All user stories have unique IDs
- [ ] All acceptance criteria have unique IDs
- [ ] Forward traceability established (req → story → AC)
- [ ] Backward traceability established (AC → story → req)
- [ ] Sources documented for all requirements
- [ ] Version metadata included
- [ ] RTM artifact created and formatted

## Output

Generate RTM artifact and document in generation-agent memory file for use by Phase 4 (Requirements Validation).

**Artifact:** `.claude/requirements/{project-name}/traceability-matrix.md`

Include:
- **RTM Table:** Complete matrix with all requirements traced
- **Version Metadata:** Document version, date, change history
- **Traceability Summary:** Statistics (total reqs, coverage, gaps)
- **Orphan Report:** Any requirements not linked to stories (should be zero)
