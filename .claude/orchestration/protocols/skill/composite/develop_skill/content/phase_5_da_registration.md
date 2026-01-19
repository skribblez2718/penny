# Phase 5: Documentation Registration (Comprehensive)

**Agent:** generation (via orchestrate-generation)
**Phase Type:** LINEAR

## Purpose

Generate documentation updates to register the new/updated skill across ALL documentation touchpoints, ensuring system-wide consistency and discoverability.

## Workflow Mode Handling

Check `metadata.workflow_mode` from Phase 0:

- **CREATE mode:** Add new entries to all required documentation
- **UPDATE mode:** Update existing entries based on `metadata.update_scope`

---

## Documentation Updates

### 1. DA.md Registration (REQUIRED)

**Location:** `${CAII_DIRECTORY}/.claude/DA.md`

**Actions:**
1. Read DA.md and locate the "Skill Routing Table" section
2. Find appropriate table:
   - If `type: atomic` → "Atomic Skills" table
   - If `type: composite` → "Composite Skills" table
3. Add table row in alphabetical order

**Entry Format for Composite Skills Table:**

```markdown
| {skill-name} | {semantic_trigger} | {not_for} |
```

**Entry Format for Atomic Skills Table:**

```markdown
| {skill-name} | {COGNITIVE_FUNCTION} | {semantic_trigger} | {not_for} |
```

**Field Definitions:**
- **semantic_trigger:** Comma-separated list of trigger phrases (5-10 words total). Captures the semantic essence of when to use this skill.
- **not_for:** Comma-separated list of exclusion criteria. Explicitly states what this skill should NOT be used for.

**Examples:**

Composite skill:
```markdown
| my-new-skill | task creation, workflow automation, process design | simple edits, one-off tasks |
```

Atomic skill:
```markdown
| orchestrate-planning | PLANNING | plan creation, strategy design | execution tasks |
```

**IMPORTANT:** Both semantic_trigger and not_for fields are required. Keep triggers concise (5-10 words) while capturing semantic intent.

---

### 2. skill-catalog.md Registration (REQUIRED)

**Location:** `${CAII_DIRECTORY}/.claude/docs/skill-catalog.md`

**Actions:**
1. Read skill-catalog.md
2. Find appropriate section (Composite Skills or Atomic Skills)
3. Add entry in alphabetical order

**Entry Format:**

```markdown
### {skill-name}

**Purpose:** {one-line description}

**Type:** {composite|atomic}

**When to Use:**
- {Use case 1}
- {Use case 2}
- {Use case 3}

**Location:** `.claude/skills/{skill-name}/`

**Orchestration:** `.claude/orchestration/protocols/skill/composite/{skill_name}/`
```

---

### 3. composite/CLAUDE.md Update (REQUIRED for composite skills)

**Location:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/CLAUDE.md`

**Actions:**
1. Find the "Registered Composite Skills" table
2. Add new row in alphabetical order

**Table Entry Format:**

```markdown
| {skill-name} | {phase_count} | {purpose} | {key_phases} |
```

**Example:**
```markdown
| my-skill | 5 | Process user requests | clarification → analysis → generation |
```

---

### 4. protocols/skill/CLAUDE.md Update (CONDITIONAL)

**Location:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/CLAUDE.md`

**Update if:**
- New phase types introduced
- New execution patterns established
- Significant changes to skill execution flow

**Actions if updating:**
1. Update "Composite Skills" table in the registries section
2. Add any new phase type documentation
3. Update call chain diagrams if flow changed

---

### 5. Other Documentation (CONDITIONAL)

Check and update if relevant:

#### agent-registry.md
**Location:** `${CAII_DIRECTORY}/.claude/docs/agent-registry.md`
**Update if:** Skill introduces new agent interaction patterns

#### execution-protocols.md
**Location:** `${CAII_DIRECTORY}/.claude/docs/execution-protocols.md`
**Update if:** Skill introduces new execution patterns

#### cognitive-function-taxonomy.md
**Location:** `${CAII_DIRECTORY}/.claude/docs/cognitive-function-taxonomy.md`
**Update if:** Skill reveals new cognitive function patterns

---

### 6. config.py Registration (MANUAL - from Phase 3)

**Location:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/config/config.py`

**Actions:**
1. Retrieve config.py registration code from Phase 3 generation output
2. Present code for manual review
3. Instruct user to insert:
   - COMPOSITE_SKILLS entry
   - Phase definition dict
   - SKILL_PHASES mapping

**IMPORTANT:** This is a MANUAL step. Do not auto-inject into config.py.

---

## Documentation Consistency Checklist

Before completing this phase, verify:

- [ ] All documentation uses consistent skill name (hyphenated)
- [ ] All documentation uses consistent description
- [ ] Alphabetical ordering maintained in all lists/tables
- [ ] No duplicate entries created
- [ ] All cross-references are valid
- [ ] Formatting matches existing entries

---

## Semantic Trigger Validation (MANDATORY)

Before completing Phase 5, verify the semantic_trigger field:

1. **Name variants included:** Does semantic_trigger include the skill name with/without hyphens?
   - Example: "my-skill" should have "my-skill", "my skill"

2. **Action verbs included:** Does semantic_trigger include "create/build/develop {skill-name}"?
   - Example: "create my-skill", "build my-skill", "develop my-skill"

3. **Domain keywords included:** Does semantic_trigger include domain-specific terms from the description?
   - Example: If description mentions "dashboard", triggers should include "dashboard"

4. **Minimum count:** Does semantic_trigger have at least 7 comma-separated phrases?
   - Count the phrases: must be >= 7

**If ANY check fails, update the semantic_trigger before proceeding.**

---

## Gate Exit Criteria

### CREATE Mode - All Required
- [ ] DA.md Skill Routing Table updated with table row
- [ ] DA.md entry includes semantic_trigger and not_for fields
- [ ] **Semantic trigger has 7+ phrases including skill name variants**
- [ ] skill-catalog.md updated with entry
- [ ] composite/CLAUDE.md table updated (if composite)
- [ ] config.py registration code presented for manual insertion (includes semantic_trigger and not_for)
- [ ] All formatting consistent with existing entries
- [ ] Alphabetical ordering maintained

### UPDATE Mode - Per Scope
- [ ] All documentation in update_scope has been modified
- [ ] Changes are consistent across all updated files
- [ ] No orphaned references created
- [ ] **Any semantic_trigger updates include skill name variants**

---

## Output

1. **Documentation Updates Completed:**
   - List all files modified with specific changes made

2. **Manual Steps Required:**
   - config.py registration (present code for insertion)

3. **Verification:**
   - Confirm all gate exit criteria met
   - Document any issues or warnings

4. **Memory File:**
   - Record all documentation updates in memory file
   - Note any follow-up actions required
