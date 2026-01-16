# Phase 0: Requirements Clarification (MANDATORY)

**Uses Atomic Skill:** `orchestrate-clarification`
**Phase Type:** LINEAR (Mandatory)

## ENFORCEMENT

This phase ALWAYS executes. No skip conditions apply.
Clarification is essential for requirements engineering success.

## Purpose

Transform ambiguous project requests into explicit requirements context using the Johari Window Discovery framework. Detect stakeholder mode (single/multi) and establish project boundaries.

## Domain-Specific Extensions

When clarifying requirements context, specifically address:

1. **Stakeholder Mode Detection**
   - Who are the stakeholders? (default: user is sole stakeholder)
   - Is this single-stakeholder (user only) or multi-stakeholder?
   - What stakeholder involvement is expected?

2. **Project Context**
   - What problem is being solved?
   - What is the expected outcome?
   - What constraints exist (time, budget, technology)?

3. **Scope Definition**
   - What should be included in scope?
   - What should be explicitly excluded?
   - What are the project boundaries?

4. **Domain Identification**
   - Technical, personal, creative, or professional domain?
   - What domain-specific requirements patterns apply?

5. **Success Criteria**
   - What makes requirements "complete"?
   - How will requirements be validated?
   - What format is expected for deliverables?

## Single-Stakeholder Default

**IMPORTANT:** Unless explicitly specified otherwise, assume **single-stakeholder mode** where:
- User is the sole stakeholder
- User speaks for all needs/wants
- Validation is with user only
- No stakeholder conflict resolution needed

Only switch to multi-stakeholder mode if:
- User explicitly mentions multiple stakeholders
- Conflicting requirements from different sources are evident
- User requests multi-stakeholder requirements gathering

## Gate Exit Criteria

- [ ] Stakeholder mode determined (single or multi)
- [ ] Project context and problem statement clarified
- [ ] Scope boundaries established (inclusions/exclusions)
- [ ] Domain identified (technical/personal/creative/professional)
- [ ] Success criteria documented
- [ ] Initial constraints captured

## Output

Document clarified context in the clarification-agent memory file for use by Phase 1 (Requirements Elicitation).

Include:
- **Stakeholder Mode:** single or multi
- **Project Context:** Problem statement and expected outcome
- **Scope:** Explicit inclusions and exclusions
- **Domain:** technical/personal/creative/professional
- **Success Criteria:** What constitutes complete requirements
- **Constraints:** Time, budget, technology, other limitations
