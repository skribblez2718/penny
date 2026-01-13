# Retention Criteria Guidelines

## Purpose

This document provides detailed guidance for evaluating whether committed learnings should be KEPT, ARCHIVED, or REMOVED after integration into skills/protocols.

## Core Philosophy

**Default Bias: KEEP**

The overwhelming majority of learnings should be KEPT, even if they've been integrated into skills. This is because:

- **Skills provide WHAT** (the rule to follow)
- **Learnings provide WHY** (rationale, context, consequences)
- **Both are complementary**, not redundant

**Only remove learnings that are truly redundant** - providing zero value beyond what's now in the skill.

## Retention Decision Framework

### The Retention Evaluation Process

For each committed learning, evaluate in this order:

#### Step 1: Check Integration Status

```
IF learning was NOT integrated (integration_status = "standalone")
  THEN → KEEP (automatic, no further evaluation needed)
  REASON: This is the primary reference for this knowledge
```

For learnings that WERE integrated, proceed to Step 2.

#### Step 2: Evaluate Added Value Beyond Skill Rule

Ask: **Does this learning provide value BEYOND the concise rule now in the skill?**

Check for:

**A. Detailed Rationale**
- Does the learning explain WHY the rule exists?
- Does it provide reasoning beyond "this is the rule"?
- Does it explain the consequences or benefits?

**B. Concrete Examples**
- Does the learning show the pattern in action?
- Are there code samples, before/after comparisons?
- Does it illustrate correct vs. incorrect approaches?

**C. Failure Modes**
- Does the learning explain what goes wrong if the rule is ignored?
- Are specific error messages, symptoms, or consequences documented?
- Does it help with troubleshooting?

**D. Domain-Specific Nuances**
- Does the learning provide context for different scenarios?
- Are there edge cases, exceptions, or conditional guidance?
- Does it include decision trees or complex logic?

**E. Historical Context**
- Does the learning document how/why this pattern emerged?
- Is there source task information useful for future reference?
- Does it connect to broader architectural decisions?

```
IF any of A-E = YES
  THEN → KEEP
  REASON: Learning provides context/understanding beyond the rule

IF all of A-E = NO
  THEN → Proceed to Step 3 (removal consideration)
```

#### Step 3: Removal Consideration (Rare)

Only reach this step if:
- Learning was integrated into a skill
- Learning provides NO additional value beyond the skill rule
- No rationale, no examples, no failure modes, no context

**Final Checks Before Removal:**

1. **Is the learning principle identical to the skill rule?**
   - Learning: "Use absolute imports"
   - Skill: "Use absolute imports"
   - No other content → Consider removal

2. **Does the learning have any metadata value?**
   - Source task references?
   - Origin unknown tracking?
   - Historical significance?
   - If YES → KEEP for metadata alone

3. **Could this learning help troubleshooting?**
   - Even minimal context can help debugging
   - If uncertain → KEEP (bias toward retention)

```
IF learning is truly redundant (rule only, no context, no metadata value)
  THEN → REMOVE
  REASON: Provides zero value beyond skill rule

ELSE
  THEN → KEEP
  REASON: When in doubt, keep it
```

## Retention Classifications

### KEEP (Most Common)

**Characteristics:**
- Provides WHY/context beyond skill rule's WHAT
- Includes examples, failure modes, or detailed rationale
- Serves as troubleshooting reference
- Contains domain-specific nuances
- Has historical/metadata value

**Action:** No changes to learning file. Update metadata:
- Confirm `integration_status: "integrated"`
- Confirm `integrated_into: [...]` field populated

**Example:**
```markdown
### G-H-001: Use Absolute Imports Only in Python Projects

**Integration status:** integrated
**Integrated into:** ["${CAII_DIRECTORY}/.claude/skills/develop-mcp-server/SKILL.md:Phase4:Step3"]

**Rationale:**
- Eliminates import path ambiguity
- Prevents "attempted relative import" errors
- Makes refactoring safer
- Required for proper pytest execution
- Compatible with all Python execution contexts

**Example:**
[Correct and incorrect import patterns...]

**Failure Mode:**
Using relative imports causes ImportError when running scripts directly, pytest collection failures, import errors in different execution contexts...

**Decision:** KEEP - provides detailed rationale, examples, and failure modes beyond the skill's concise rule
```

### ARCHIVE (Occasional)

**Characteristics:**
- Was integrated into skill
- Has marginal value (some context but not essential)
- Highly domain-specific and task-specific
- Useful for historical reference but not active guidance

**Action:** Move to `${CAII_DIRECTORY}/.claude/learnings/archive/{function}/{date}/` with metadata
- Preserves historical record
- Removes from active learning files
- Can be retrieved if needed

**When to Archive:**
- Learning is very specific to one historical task
- Integration fully captures the reusable pattern
- Keeping it adds noise to active learnings
- Historical value only

**Example:**
A learning about a specific API's authentication quirk that was generalized into a broader authentication pattern now in the skill. The specific API details have historical value but aren't actively useful.

### REMOVE (Rare)

**Characteristics:**
- Truly redundant with integrated skill rule
- No rationale beyond "this is the rule"
- No examples provided
- No failure modes documented
- No domain context or nuances
- No metadata value

**Action:** Delete entry from learning file, update INDEX

**When to Remove:**
- Learning is literally just the rule now in the skill
- No additional content whatsoever
- No troubleshooting value

**Example:**
```markdown
### C-H-099: Ask clarifying questions

**Principle:** Ask clarifying questions when requirements are ambiguous.

**Integration status:** integrated
**Integrated into:** ["${CAII_DIRECTORY}/.claude/skills/develop-project/SKILL.md:Phase1:Step2"]

(No rationale, no examples, no failure modes, no additional content)

**Decision:** REMOVE - provides zero value beyond skill rule
```

## Decision Tree

```
FOR each committed learning:

┌─ Was learning integrated into skill/protocol?
│  ├─ NO → KEEP (primary reference)
│  └─ YES → Continue evaluation

├─ Does learning include detailed rationale explaining WHY?
│  ├─ YES → KEEP
│  └─ NO → Continue

├─ Does learning include concrete examples or code samples?
│  ├─ YES → KEEP
│  └─ NO → Continue

├─ Does learning document failure modes or consequences?
│  ├─ YES → KEEP
│  └─ NO → Continue

├─ Does learning include domain-specific nuances or decision trees?
│  ├─ YES → KEEP
│  └─ NO → Continue

├─ Does learning have historical/metadata value (source tasks, unknowns)?
│  ├─ YES → KEEP
│  └─ NO → Continue

├─ Is learning highly domain-specific with marginal value?
│  ├─ YES → ARCHIVE
│  └─ NO → Continue

└─ Is learning truly redundant (no value beyond skill rule)?
   ├─ YES → REMOVE
   └─ NO (uncertain) → KEEP (default bias)
```

## Common Scenarios

### Scenario 1: Integrated Heuristic with Full Context

**Learning:** G-H-001 (Absolute Imports)
- **Integrated:** Yes, concise rule added to skill
- **Rationale:** Detailed (5 reasons why)
- **Examples:** Before/after code samples
- **Failure Modes:** Specific error messages and contexts
- **Decision:** KEEP - skill has rule, learning provides deep understanding

### Scenario 2: Integrated Anti-Pattern with Examples

**Learning:** G-A-002 (Installing Tools for Root User)
- **Integrated:** Yes, rule added to deployment phase
- **Rationale:** Security and accessibility explanation
- **Examples:** Correct installation pattern with sudo -i -u
- **Failure Modes:** "Command not found" scenarios
- **Decision:** KEEP - helps troubleshooting and understanding

### Scenario 3: Integrated Minimal Checklist Item

**Learning:** "Verify file exists before reading"
- **Integrated:** Yes, added to validation checklist
- **Rationale:** None (just states the check)
- **Examples:** None
- **Failure Modes:** None
- **Context:** None
- **Decision:** REMOVE - no value beyond checklist item in skill

### Scenario 4: Standalone Domain Snippet

**Learning:** G-DS-001 (systemd ProtectHome)
- **Integrated:** No, too complex for simple rule
- **Content:** Full decision tree with multiple scenarios
- **Decision:** KEEP (automatic) - not integrated, primary reference

### Scenario 5: Integrated but Historically Valuable

**Learning:** API-specific authentication discovery
- **Integrated:** Yes, generalized pattern added to skill
- **Content:** Specific to one historical task/API
- **Metadata:** Documents important discovery process
- **Decision:** ARCHIVE - integrated pattern is what matters, but preserve history

## Evaluation Matrix

| Criterion | KEEP | ARCHIVE | REMOVE |
|-----------|------|---------|--------|
| Integration Status | Standalone OR Integrated with value | Integrated, marginal value | Integrated, no value |
| Rationale Detail | Detailed WHY explanation | Minimal WHY | No rationale |
| Examples | Concrete code/scenarios | Limited examples | No examples |
| Failure Modes | Documented consequences | Brief mention | None |
| Domain Context | Nuanced guidance | Task-specific only | None |
| Metadata Value | Yes | Historical only | None |
| Active Utility | Regularly referenced | Historical reference | Redundant |
| Troubleshooting | Helpful for debugging | Marginal help | Not useful |

## Statistics to Track

Expected distribution across all learnings:

- **KEEP: 80-90%** (most learnings provide value beyond rules)
- **ARCHIVE: 5-10%** (some historical/task-specific entries)
- **REMOVE: 5-10%** (truly redundant entries only)

If REMOVE percentage exceeds 15%, review criteria - may be removing valuable context.

## Metadata Updates

### For KEEP Decisions

Update learning entry to confirm integration status:

```markdown
**Integration status:** integrated
**Integrated into:** ["${CAII_DIRECTORY}/.claude/skills/develop-mcp-server/SKILL.md:Phase4:Step3"]
```

No other changes needed.

### For ARCHIVE Decisions

Move file to archive and add archival metadata:

```markdown
**Integration status:** integrated (archived)
**Integrated into:** ["${CAII_DIRECTORY}/.claude/skills/develop-mcp-server/SKILL.md:Phase4:Step3"]
**Archived:** 2025-11-24
**Archived reason:** Task-specific context, generalized pattern now in skill
```

### For REMOVE Decisions

Delete entry from learning file and remove from INDEX section.

Document removal in Phase 5.5 memory output for audit trail.

## Philosophy Reminder

**Skills and Learnings serve different purposes:**

- **Skill Rule:** "Use absolute imports (see G-H-001)"
  - Concise, actionable, immediate
  - Scans quickly during workflow execution
  - WHAT to do

- **Learning G-H-001:** Full rationale, examples, failure modes
  - Educational, contextual, reference
  - Read when learning or troubleshooting
  - WHY it matters, HOW it fails, WHEN to apply

**Both are valuable.** Removing a learning because it's integrated eliminates the WHY context that helps agents understand and apply the rule correctly.

**When in doubt, KEEP.**

The cost of keeping a learning (a few hundred tokens) is minimal compared to the value it provides when an agent needs to understand the reasoning behind a rule or troubleshoot a related issue.

## Validation Checklist

Before finalizing retention decisions:

- [ ] Every integrated learning evaluated for added value
- [ ] KEEP decisions verified to have WHY/context beyond rule
- [ ] REMOVE decisions verified as truly redundant
- [ ] REMOVE percentage < 15% (most learnings retained)
- [ ] Archive decisions have clear historical-only justification
- [ ] Metadata fields updated correctly for each decision
- [ ] Default bias toward KEEP maintained throughout
