# Phase 0: Requirements Clarification (MANDATORY)

**Uses Atomic Skill:** `orchestrate-clarification`
**Phase Type:** LINEAR (Mandatory)

## ENFORCEMENT

This phase ALWAYS executes. No skip conditions apply.
Clarification is essential for first-attempt success.

## Purpose

Clarify skill requirements through systematic Socratic questioning to transform vague inputs into actionable specifications.

## MANDATORY: Load System Philosophy

**Before any clarification work, load and internalize system principles:**

**File:** `${CAII_DIRECTORY}/.claude/docs/philosophy.md`

Read and apply:
- **Cognitive Domain Separation:** Agents organized by cognitive function, NOT task domains
- **Orchestration-Implementation Decoupling:** Skills define WHAT, agents define HOW
- **Reference Over Duplication:** Single source of truth, reference don't duplicate
- **Single Point of Change:** One canonical location for each concept
- **Minimal Size Without Sacrificing Detail:** Concise but complete

**This is especially critical for system modifications** (skills, agents, protocols, architecture).

## Workflow Mode Detection (FIRST STEP)

**Before clarifying requirements, determine the workflow mode:**

### 1. Check Skill Existence

```
Path: ${CAII_DIRECTORY}/.claude/skills/{skill-name}/SKILL.md
```

- **If file EXISTS** → **UPDATE workflow** (modify existing skill)
- **If file DOES NOT exist** → **CREATE workflow** (new skill)

### 2. For CREATE Workflow

Proceed to Domain-Specific Extensions below to gather all requirements for new skill creation.

**Key CREATE outputs:**
- Full skill specification
- All phase definitions
- Complete Python orchestration requirements
- All documentation entries

### 3. For UPDATE Workflow - Scope Determination

If modifying an existing skill, clarify the scope of changes:

| Component | Modification Needed? |
|-----------|---------------------|
| Phases (add/remove/modify) | [ ] Yes / [ ] No |
| config.py registration | [ ] Yes / [ ] No |
| resources/ files | [ ] Yes / [ ] No |
| Python orchestration files | [ ] Yes / [ ] No |
| SKILL.md updates | [ ] Yes / [ ] No |
| Documentation updates | [ ] Yes / [ ] No |

**Additional UPDATE considerations:**
- Backwards compatibility requirements?
- Migration considerations for existing state files?
- Impact on skills that reference this skill?

**Store workflow_mode in metadata:** `CREATE` or `UPDATE`
**Store update_scope if UPDATE:** List of components being modified

---

## Domain-Specific Extensions

When clarifying skill requirements, specifically address:

1. **Skill Type Determination**
   - Simple (single sequence) or complex (multi-phase)?
   - What triggers the skill?
   - What are the success criteria?

2. **Cognitive Agent Selection**
   - Which of the 6 universal agents are needed?
   - What is the optimal sequence?
   - Are there phases that can be skipped?

3. **Atomic Skill References**
   - Which atomic skills will be used?
   - Are all required atomics available?
   - Any custom configuration needed?

4. **Composite Skill Composition**
   - Will this skill leverage existing composites as building blocks?
   - What is the composition depth (0 if atomics only, 1 if composites used)?
   - What configuration parameters need to be passed?

5. **Context Requirements**
   - What input context is required?
   - What output artifacts are expected?
   - What quality standards apply?

## Gate Exit Criteria

### Workflow Mode (ALL skills)
- [ ] Workflow mode determined (CREATE or UPDATE)
- [ ] If UPDATE: scope of changes documented

### For CREATE Workflow
- [ ] Skill purpose clearly defined
- [ ] Skill type determined (simple/complex)
- [ ] Required cognitive agents identified
- [ ] Atomic skill references validated
- [ ] Composite skill references identified (if any)
- [ ] Context requirements documented
- [ ] Success criteria established

### For UPDATE Workflow
- [ ] Existing skill analyzed
- [ ] Specific components to modify identified
- [ ] Backwards compatibility requirements documented
- [ ] Impact assessment completed

## Output

Document clarified requirements in the clarification memory file for use by subsequent phases.
