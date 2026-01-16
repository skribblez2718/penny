# Phase 5: Change Management Setup

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR
**Optional:** Can be skipped via `--skip-change-management` flag

## Purpose

Establish a change management process for requirements evolution. Define how requirements changes are requested, evaluated, approved, and implemented.

## Change Process Components

### 1. Change Request (CR) Template
Define standard format for requesting requirement changes:
- **CR ID:** Unique identifier
- **Requestor:** Who is requesting the change
- **Date Requested:** When CR was submitted
- **Affected Requirements:** Which req IDs are impacted
- **Change Description:** What needs to change and why
- **Justification:** Business reason for change
- **Priority:** Critical, High, Medium, Low

### 2. Impact Assessment Workflow
Define how changes are analyzed:
- **Traceability Analysis:** Use RTM to identify impacted stories/AC
- **Effort Estimation:** Time/cost to implement change
- **Risk Assessment:** What could go wrong
- **Dependencies:** What else is affected
- **Alternatives:** Other ways to address need

### 3. Approval Gates
Define who approves changes:
- **Minor Changes:** Clarifications, typo fixes (auto-approve or quick review)
- **Major Changes:** New requirements, scope changes (stakeholder approval required)
- **Critical Changes:** Architecture impact (full team review)

**Single-Stakeholder:** User is sole approver
**Multi-Stakeholder:** Define approval matrix (which stakeholder approves what)

### 4. Implementation Process
Define how approved changes are applied:
1. Update requirements documents (stories, AC, NFRs)
2. Update RTM with new traceability
3. Increment document version
4. Document change in version history
5. Communicate change to affected parties
6. Re-validate if change is significant

### 5. Change Tracking
Define how changes are tracked over time:
- **Change Log:** All approved changes with dates
- **Version History:** Document version progression
- **Metrics:** Number of changes, change velocity, stability trends

## Artifacts to Generate

Create change management documentation:

**Artifact 1:** `.claude/requirements/{project-name}/change-process.md`
- Change request template
- Impact assessment workflow
- Approval gates definition
- Implementation process
- Change tracking method

**Artifact 2:** `.claude/requirements/{project-name}/change-log.md` (empty template)
- Headers for tracking changes
- Template entry format
- Ready for first change request

## Single vs Multi-Stakeholder CM

**Single-Stakeholder:**
- Simplified approval (user only)
- Faster change cycles
- Less formal process acceptable

**Multi-Stakeholder:**
- Formal approval matrix
- Conflict resolution process
- Communication plan per stakeholder group

## When to Skip This Phase

Skip Phase 5 (`--skip-change-management` flag) when:
- Requirements are final and frozen
- Project is one-time with no evolution
- Change management exists at organizational level
- Quick prototype with no formal process needed

## Gate Exit Criteria

- [ ] Change request template defined
- [ ] Impact assessment workflow documented
- [ ] Approval gates established
- [ ] Implementation process defined
- [ ] Change tracking method documented
- [ ] Artifacts generated (change-process.md, change-log.md)

## Output

Document change management process in generation-agent memory file.

Include:
- **Change Process Document:** Complete workflow description
- **Template Artifacts:** CR template and change log template
- **Approval Matrix:** Who approves what (if multi-stakeholder)
- **Communication Plan:** How changes are communicated
