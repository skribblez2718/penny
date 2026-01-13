# Update Skill Protocol

## Overview

Protocol for modifying existing skills while maintaining backwards compatibility and system integrity. Use this when `workflow_mode = UPDATE` is detected in Phase 0.

## When to Use

- Modifying phase structure of an existing skill
- Adding/removing/reordering phases
- Updating skill configuration
- Enhancing skill resources
- Updating documentation for existing skill
- Fixing bugs in skill orchestration

## Update Types

### 1. Phase Modifications

#### Adding New Phases

**Preferred:** Use sub-phase IDs when inserting between existing phases
- Insert between Phase 1 and 2 → Use Phase 1.5
- Insert after Phase 2.5 → Use Phase 2.6
- This preserves existing phase IDs and state file compatibility

**Alternative:** Add at end of workflow
- If logic allows, add new phase after final phase
- Update `next` pointer in previous final phase

**Required Changes:**
- [ ] Add phase to config.py `{SKILL}_PHASES` dict
- [ ] Update `next` pointer in preceding phase
- [ ] Create `content/phase_{id}_{name}.md` file
- [ ] Update SKILL.md Workflow Phases table

#### Modifying Existing Phases

**Safe Modifications:**
- Update phase content markdown (instructions, criteria)
- Add domain-specific extensions
- Update gate exit criteria
- Change phase description

**Requires Testing:**
- Change phase type (LINEAR → OPTIONAL)
- Change uses_atomic_skill
- Add/remove configuration options

**Required Changes:**
- [ ] Update content/phase_*.md file
- [ ] Update config.py if type/skill changed
- [ ] Update SKILL.md if user-facing changes

#### Removing Phases

**Caution:** May break backwards compatibility

**Steps:**
1. Update `next` pointer in preceding phase to skip removed phase
2. Archive (don't delete) content/phase_*.md file
3. Remove from config.py `{SKILL}_PHASES` dict
4. Update SKILL.md Workflow Phases table

**Required Changes:**
- [ ] Update config.py `next` pointers
- [ ] Remove/archive content file
- [ ] Update SKILL.md
- [ ] Test state file migration (if needed)

---

### 2. Config Changes

#### COMPOSITE_SKILLS Entry Updates

**Safe Modifications:**
- Update description
- Change composition_depth (0 → 1 if adding composite refs)

**Required Changes:**
- [ ] Update config.py COMPOSITE_SKILLS entry
- [ ] Update SKILL.md frontmatter to match
- [ ] Update DA.md if description changed

#### Phase Configuration Updates

**Safe Modifications:**
- Update phase name/title/description
- Change content file reference
- Add/modify configuration dict

**Requires Testing:**
- Change phase type
- Change uses_atomic_skill
- Modify next pointer (phase flow)

---

### 3. Resource Updates

#### Adding Resources

**Steps:**
1. Create new file in `${CAII_DIRECTORY}/.claude/skills/{skill-name}/resources/`
2. Update SKILL.md Directory Structure section
3. Reference from relevant phase content files

#### Modifying Resources

**Steps:**
1. Edit existing resource file
2. Verify all references still valid
3. Update version/date comment if present

#### Removing Resources

**Steps:**
1. Search for all references to resource
2. Update/remove references
3. Archive (don't delete) resource file
4. Update SKILL.md Directory Structure

---

### 4. Python Orchestration Updates

#### content/phase_*.md Files

Most common update type - can be modified freely.

**Safe Modifications:**
- Update instructions
- Add domain-specific extensions
- Update gate criteria
- Change output documentation

#### entry.py / complete.py

**Rarely Need Changes** - Self-configuring templates.

**Only Modify If:**
- Adding custom CLI arguments (entry.py)
- Adding custom completion logic (complete.py)
- Changing skill name format (avoid this)

#### __init__.py

**Update When:**
- Skill description changes significantly
- Phase list changes (update docstring)

---

### 5. Documentation Updates

**Always Update When Modifying Skills:**

| Document | Update Trigger |
|----------|---------------|
| SKILL.md | Any user-facing changes |
| DA.md | Description or triggers change |
| skill-catalog.md | Purpose or usage changes |
| composite/CLAUDE.md | Phase count or key phases change |

---

## Backwards Compatibility Checklist

Before completing any update:

### State File Compatibility
- [ ] Existing state files can still be loaded
- [ ] Phase IDs in state files still valid
- [ ] No orphaned phase outputs in existing state

### Memory File Compatibility
- [ ] Memory file paths unchanged (or migration handled)
- [ ] Memory file format unchanged
- [ ] Agent references still valid

### Config Compatibility
- [ ] Phase chain unbroken (every phase has valid `next` or `None`)
- [ ] No orphaned phases (phases without predecessor)
- [ ] All referenced atomic skills exist

### Documentation Consistency
- [ ] SKILL.md matches config.py
- [ ] DA.md matches SKILL.md
- [ ] skill-catalog.md matches DA.md
- [ ] All cross-references valid

---

## Update Validation Checklist

After completing updates:

### Structural Validation
- [ ] config.py `next` chain is unbroken
- [ ] All phase content files exist
- [ ] All referenced resources exist
- [ ] All atomic skill references valid

### Documentation Validation
- [ ] SKILL.md Workflow Phases table matches config.py
- [ ] SKILL.md Directory Structure is accurate
- [ ] DA.md entry is current
- [ ] skill-catalog.md entry is current

### Functional Validation
- [ ] Skill entry.py executes without errors
- [ ] Phase 0 (clarification) runs successfully
- [ ] All phases can transition correctly
- [ ] Skill complete.py executes without errors

---

## Common Update Scenarios

### Scenario 1: Add a validation phase before generation

**Current:** Phase 2 (synthesis) → Phase 3 (generation)
**Desired:** Phase 2 (synthesis) → Phase 2.5 (pre-validation) → Phase 3 (generation)

**Steps:**
1. Add Phase 2.5 to config.py with `next: "3"`
2. Update Phase 2 `next` to "2.5"
3. Create content/phase_2_5_pre_validation.md
4. Update SKILL.md phases table

### Scenario 2: Change phase from LINEAR to OPTIONAL

**Steps:**
1. Update config.py phase type to PhaseType.OPTIONAL
2. Add `trigger` field with skip condition
3. Update content file with trigger documentation
4. Test with both trigger true and false

### Scenario 3: Update skill description and triggers

**Steps:**
1. Update SKILL.md frontmatter description
2. Update SKILL.md "When to Use" section
3. Update config.py COMPOSITE_SKILLS description
4. Update DA.md skill entry
5. Update skill-catalog.md entry

---

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Instead Do |
|--------------|--------------|------------|
| Renumbering all phases | Breaks state files | Use sub-phase IDs (1.5, 2.5) |
| Deleting content files | Loses history | Archive to `_archive/` |
| Changing memory file paths | Breaks predecessor context | Keep paths stable |
| Direct config.py edits without testing | May break all skills | Test changes first |
| Updating docs without code | Creates inconsistency | Update together |
| Skipping backwards compat check | Breaks existing workflows | Always verify |

---

## References

- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/config/config.py` - Master skill registry
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/validation-checklist.md` - Validation criteria
- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/CLAUDE.md` - Skill protocol documentation
