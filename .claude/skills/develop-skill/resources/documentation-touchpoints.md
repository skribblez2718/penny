# Documentation Touchpoints Reference

## Overview

Complete list of documentation files that must be updated when creating or modifying skills. Use this reference to ensure all touchpoints are addressed for system-wide consistency.

---

## Required Updates (All Skills)

These files MUST be updated for every new skill creation:

### 1. DA.md (System Identity)

**Path:** `${CAII_DIRECTORY}/.claude/DA.md`

**Purpose:** Primary system identity file defining the system's execution routing

**Section to Update:** "Execution Routing" → "Composite Skills" or "Atomic Skills"

**Entry Requirements:**
- Skill name (hyphenated)
- Purpose (one-line description)
- "When to Use" section with 5 semantic triggers

**Format:**
```markdown
#### {skill-name}

**Purpose:** {description}

**When to Use:** Invoke when **{primary trigger}**:

- **{Trigger 1}:** {Description} → "{Example}"
- **{Trigger 2}:** {Description} → "{Example}"
- **{Trigger 3}:** {Description} → "{Example}"
- **{Trigger 4}:** {Description} → "{Example}"
- **{Trigger 5}:** {Description} → "{Example}"
```

---

### 2. skill-catalog.md (Quick Reference)

**Path:** `${CAII_DIRECTORY}/.claude/docs/skill-catalog.md`

**Purpose:** Quick reference catalog of all available skills

**Section to Update:** "Composite Skills" or "Atomic Skills"

**Entry Requirements:**
- Skill name
- Purpose
- Type
- When to Use (3+ examples)
- Location
- Orchestration path

**Format:**
```markdown
### {skill-name}

**Purpose:** {description}

**Type:** {composite|atomic}

**When to Use:**
- {Use case 1}
- {Use case 2}
- {Use case 3}

**Location:** `.claude/skills/{skill-name}/`

**Orchestration:** `.claude/orchestration/protocols/skill/composite/{skill_name}/`
```

---

### 3. composite/CLAUDE.md (Skill Registry)

**Path:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/CLAUDE.md`

**Purpose:** Documentation for composite skill protocol

**Section to Update:** "Registered Composite Skills" table

**Entry Requirements:**
- Skill name
- Phase count
- Purpose
- Key phases (abbreviated flow)

**Format:**
```markdown
| {skill-name} | {N} | {purpose} | {phase1} → {phase2} → {phaseN} |
```

---

### 4. config.py (Master Registry)

**Path:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/config/config.py`

**Purpose:** Python source of truth for all skills

**Updates Required:**
1. COMPOSITE_SKILLS dictionary entry
2. Phase definition dictionary (e.g., MY_SKILL_PHASES)
3. SKILL_PHASES mapping

**Note:** This is a MANUAL update. See `config-registration-template.md` for templates.

---

## Conditional Updates

These files should be updated when specific conditions apply:

### 5. protocols/skill/CLAUDE.md

**Path:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/CLAUDE.md`

**Update When:**
- New phase types introduced
- New execution patterns established
- Significant changes to skill execution flow

**Sections to Update:**
- "Composite Skills" table
- Phase type documentation (if new types)
- Call chain diagrams (if flow changed)

---

### 6. agent-registry.md

**Path:** `${CAII_DIRECTORY}/.claude/docs/agent-registry.md`

**Update When:**
- Skill introduces new agent interaction patterns
- New context loading patterns used
- Custom agent configurations added

---

### 7. execution-protocols.md

**Path:** `${CAII_DIRECTORY}/.claude/docs/execution-protocols.md`

**Update When:**
- Skill introduces new execution patterns
- New protocol types created
- Routing logic changes

---

### 8. cognitive-function-taxonomy.md

**Path:** `${CAII_DIRECTORY}/.claude/docs/cognitive-function-taxonomy.md`

**Update When:**
- Skill reveals new cognitive function patterns
- New function combinations established
- Function definitions need refinement

---

## Per-Skill Documentation

These files are created/updated for the specific skill:

### 9. SKILL.md (Skill Definition)

**Path:** `${CAII_DIRECTORY}/.claude/skills/{skill-name}/SKILL.md`

**Purpose:** Primary skill definition and trigger patterns

**Contents:**
- YAML frontmatter (name, description, tags, type, composition_depth)
- Overview
- When to Use (5+ triggers)
- Core Principles
- Workflow Protocol
- Workflow Phases table
- Directory Structure
- Validation Checklist
- References

---

### 10. Skill Resources

**Path:** `${CAII_DIRECTORY}/.claude/skills/{skill-name}/resources/`

**Contents (minimum):**
- `validation-checklist.md` - Skill-specific validation criteria

**Additional Resources (as needed):**
- Templates
- Protocols
- References
- Examples

---

### 11. Skill Orchestration CLAUDE.md (Optional)

**Path:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/CLAUDE.md`

**Purpose:** Skill-specific orchestration documentation

**Create When:**
- Complex phase logic
- Custom phase scripts
- Non-standard patterns

**Contents:**
- Phases table
- When Used
- Key Outputs
- Phase Config Location

---

## Update Order

When creating a new skill, update documentation in this order:

1. **SKILL.md** - Define the skill first
2. **resources/** - Create supporting resources
3. **Python orchestration** - entry.py, complete.py, content/*.md
4. **config.py** - Register in master registry (MANUAL)
5. **DA.md** - Add to system routing
6. **skill-catalog.md** - Add to catalog
7. **composite/CLAUDE.md** - Add to registry table
8. **Conditional docs** - Update if applicable

---

## Consistency Checklist

Before completing documentation updates:

- [ ] Skill name consistent everywhere (hyphenated)
- [ ] Description consistent across all files
- [ ] Phase count matches between SKILL.md, config.py, CLAUDE.md
- [ ] "When to Use" triggers are meaningful and distinct
- [ ] All cross-references use valid paths
- [ ] Alphabetical ordering maintained in lists/tables
- [ ] No duplicate entries created
- [ ] Formatting matches existing entries

---

## Update Templates by File

### DA.md Entry
```markdown
#### {skill-name}

**Purpose:** {description}

**When to Use:** Invoke when **{trigger}**:

- **{T1}:** {Desc} → "{Example}"
- **{T2}:** {Desc} → "{Example}"
- **{T3}:** {Desc} → "{Example}"
- **{T4}:** {Desc} → "{Example}"
- **{T5}:** {Desc} → "{Example}"
```

### skill-catalog.md Entry
```markdown
### {skill-name}

**Purpose:** {description}
**Type:** composite
**When to Use:**
- {Use 1}
- {Use 2}
- {Use 3}
**Location:** `.claude/skills/{skill-name}/`
**Orchestration:** `.claude/orchestration/protocols/skill/composite/{skill_name}/`
```

### composite/CLAUDE.md Table Row
```markdown
| {skill-name} | {phases} | {purpose} | {flow} |
```

---

## References

- `${CAII_DIRECTORY}/.claude/DA.md` - System identity
- `${CAII_DIRECTORY}/.claude/docs/` - Documentation directory
- `${CAII_DIRECTORY}/.claude/orchestration/` - Orchestration root
