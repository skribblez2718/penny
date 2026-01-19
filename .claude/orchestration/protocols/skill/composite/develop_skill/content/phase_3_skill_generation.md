# Phase 3: Skill Generation (Full Python Integration)

**Uses Atomic Skill:** `orchestrate-generation`

## Purpose

Generate complete skill artifacts including SKILL.md, Python orchestration files, resources directory, and config.py registration code.

## Workflow Mode Handling

Check `metadata.workflow_mode` from Phase 0:

- **CREATE mode:** Generate all artifacts from scratch
- **UPDATE mode:** Generate only artifacts specified in `metadata.update_scope`

---

## Generation Artifacts

### 1. SKILL.md (Skills Side)

**Location:** `${CAII_DIRECTORY}/.claude/skills/{skill-name}/SKILL.md`

**Reference templates from:**
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/simple-skill-template.md`
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/complex-skill-template.md`

**SKILL.md Structure:**

```markdown
---
name: {skill-name}
description: {description}
tags: {comma-separated}
type: composite
composition_depth: {0|1}
uses_composites: [{list}]
---

# {skill-name}

**Type:** Composite Skill
**Description:** {description}
**Status:** production
**Complexity:** {simple|medium|complex}

## Overview
[Skill purpose and when to use]

## When to Use
[5 semantic trigger patterns]

## Core Principles
[Key design principles for this skill]

## Workflow Protocol
### Initialization
### Completion

## MANDATORY Execution
[Python entry command]

## Workflow Phases
| Phase | Name | Atomic Skill | Type |
[Phase table]

## Directory Structure
[File tree]

## Validation Checklist
[Completion criteria]

## References
[Links to documentation]
```

---

### Semantic Trigger Generation (MANDATORY)

When generating the skill registration code, automatically create semantic_trigger by:

1. **Include skill name variants:**
   - Exact name: "my-skill"
   - Space form: "my skill"
   - Action forms: "build my-skill", "create my-skill", "develop my-skill"

2. **Extract keywords from description:**
   - If description contains "authentication" → include "auth", "authentication", "login"
   - If description contains "API" → include "api", "API design", "api development"

3. **Add common action verbs:**
   - For generation skills: "create", "build", "generate", "make"
   - For analysis skills: "analyze", "assess", "evaluate", "break down"
   - For research skills: "research", "investigate", "explore", "find"

**Example - Generating triggers for "develop-dashboard":**

Description: "Create interactive data visualization dashboards"

Generated semantic_trigger:
```
"dashboard, develop dashboard, create dashboard, build dashboard, data visualization, interactive dashboard, visualization dashboard"
```

**Validation:** semantic_trigger field MUST have 7-12 comma-separated phrases including skill name variants.

---

### 2. Python Orchestration Files (Orchestration Side)

**Location:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/`

**Note:** Directory name uses underscores (e.g., `my_skill`), skill name uses hyphens (e.g., `my-skill`).

#### 2.1 entry.py (Self-Configuring Template)

```python
#!/usr/bin/env python3
"""{skill-name} Entry Point"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_entry import skill_entry
    skill_entry(Path(__file__).parent.name.replace("_", "-"), Path(__file__).parent)
```

#### 2.2 complete.py (Self-Configuring Template)

```python
#!/usr/bin/env python3
"""{skill-name} Completion"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_complete import skill_complete
    skill_complete(Path(__file__).parent.name.replace("_", "-"))
```

#### 2.3 __init__.py (Package Init)

```python
"""
{skill-name} Composite Skill

{skill-description}

Phases:
- Phase 0: {phase_0_name}
- Phase 1: {phase_1_name}
...
"""

SKILL_NAME = "{skill-name}"
SKILL_DESCRIPTION = "{skill-description}"

__all__ = ["SKILL_NAME", "SKILL_DESCRIPTION"]
```

#### 2.4 content/ Directory

Create one markdown file per phase:

**Naming Convention:** `phase_{phase_id}_{phase_name_snake_case}.md`

Examples:
- `phase_0_requirements_clarification.md`
- `phase_0_5_atomic_provisioning.md` (for sub-phases)
- `phase_1_complexity_analysis.md`

**Phase Content Template:**

```markdown
# Phase {N}: {Phase Title}

**Uses Atomic Skill:** `orchestrate-{function}`
**Phase Type:** {LINEAR|OPTIONAL|AUTO|ITERATIVE|REMEDIATION|PARALLEL}

## Purpose

{What this phase accomplishes}

## Domain-Specific Extensions

{Skill-specific instructions for the agent}

## Gate Exit Criteria

- [ ] {Criterion 1}
- [ ] {Criterion 2}
- [ ] {Criterion 3}

## Output

{What is produced and where it is stored}
```

---

### 3. Resources Directory (Skills Side)

**Location:** `${CAII_DIRECTORY}/.claude/skills/{skill-name}/resources/`

**Always create:**

#### validation-checklist.md

```markdown
# {skill-name} Validation Checklist

## Core Requirements
- [ ] {Skill-specific requirement 1}
- [ ] {Skill-specific requirement 2}
- [ ] All phases execute successfully
- [ ] Memory files created for each phase

## Quality Standards
- [ ] {Quality criterion 1}
- [ ] {Quality criterion 2}

## Completion Criteria
- [ ] {Final validation 1}
- [ ] {Final validation 2}
```

**Create additional resources as determined by synthesis phase** (templates, references, protocols).

---

### 4. config.py Registration Code

**Location:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/config/config.py`

**Generate registration code for MANUAL insertion:**

#### 4.1 COMPOSITE_SKILLS Entry

```python
# Add to COMPOSITE_SKILLS dict
"{skill-name}": {
    "description": "{description}",
    "composition_depth": {0|1},
    "phases": "{SKILL_NAME_UPPER}_PHASES",
},
```

#### 4.2 Phase Definition Dict

```python
# Add new phase definition dict (before SKILL_PHASES)
{SKILL_NAME_UPPER}_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": None,
        "content": "phase_0_requirements_clarification.md",
        "next": "1",
        "description": "Clarify requirements via Johari discovery",
    },
    "1": {
        "name": "{PHASE_1_NAME}",
        "title": "{Phase 1 Title}",
        "type": PhaseType.{TYPE},
        "uses_atomic_skill": "orchestrate-{function}",
        "script": None,
        "content": "phase_1_{name}.md",
        "next": "{next_phase_or_None}",
        "description": "{What this phase does}",
    },
    # ... additional phases
}
```

#### 4.3 SKILL_PHASES Mapping

```python
# Add to SKILL_PHASES dict
"{skill-name}": {SKILL_NAME_UPPER}_PHASES,
```

**IMPORTANT:** Present this registration code in the generation output for manual review and insertion. Do NOT auto-inject into config.py.

---

## Domain-Specific Extensions

When generating skill artifacts:

1. **Apply Skill Templates**
   - Use templates from `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/`
   - Reference `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/python-orchestration-templates.md`
   - Select simple vs complex template based on Phase 1 analysis

2. **Include Context Loading Patterns**
   - Reference context-loading-patterns.md
   - Specify pattern per phase
   - Document context dependencies

3. **Reference Documentation**
   - Reference (don't duplicate) existing docs
   - Link to agent-protocol-reference.md
   - Link to relevant skill resources

4. **Include Skill References**
   - List atomic skills with configuration
   - List composite skills if depth=1
   - Document configuration parameters

5. **Set Frontmatter Metadata**
   - name, description, tags
   - type: atomic | composite
   - composition_depth: 0 | 1
   - uses_composites: []

---

## Gate Exit Criteria

### Core Artifacts (CREATE mode requires all; UPDATE mode requires per scope)

- [ ] SKILL.md generated with all required sections
- [ ] Frontmatter complete and valid
- [ ] All phases documented in SKILL.md

### Python Orchestration (CREATE mode)

- [ ] entry.py generated (self-configuring template)
- [ ] complete.py generated (self-configuring template)
- [ ] __init__.py generated with skill metadata
- [ ] content/phase_*.md files generated for each phase
- [ ] Directory structure created: `composite/{skill_name}/content/`

### Resources (CREATE mode)

- [ ] resources/ directory created
- [ ] validation-checklist.md created
- [ ] Skill-specific templates created (if any)

### Registration (CREATE and UPDATE modes)

- [ ] config.py registration code generated
- [ ] Registration code presented for manual review

---

## Output

1. **Files Created:**
   - `${CAII_DIRECTORY}/.claude/skills/{skill-name}/SKILL.md`
   - `${CAII_DIRECTORY}/.claude/skills/{skill-name}/resources/validation-checklist.md`
   - `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/entry.py`
   - `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/complete.py`
   - `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/__init__.py`
   - `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/content/phase_*.md`

2. **Registration Code:**
   - config.py entries (presented for manual insertion)

3. **Memory File:**
   - Document all generated file paths in generation memory file
   - Include config.py registration code in memory file for Phase 5 reference
