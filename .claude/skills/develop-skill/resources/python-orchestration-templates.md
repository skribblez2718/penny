# Python Orchestration Templates

## Overview

Templates for generating the Python orchestration files required for composite skills to integrate with the orchestration system.

**Target Directory:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/`

**Note:** Directory uses underscores (e.g., `my_skill`), skill name uses hyphens (e.g., `my-skill`).

---

## 1. entry.py Template

**Purpose:** Self-configuring entry point that initializes skill execution and prints the first phase directive.

### Standard Template (No Custom Args)

```python
#!/usr/bin/env python3
"""{skill-name} Entry Point"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_entry import skill_entry
    skill_entry(Path(__file__).parent.name.replace("_", "-"), Path(__file__).parent)
```

### Template with Custom Arguments

```python
#!/usr/bin/env python3
"""{skill-name} Entry Point"""
if __name__ == "__main__":
    import argparse; import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_entry import skill_entry

    def add_custom_args(parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--{arg-name}", default="{default}",
                          choices=["{choice1}", "{choice2}"],
                          help="{Help text}")

    skill_entry(
        Path(__file__).parent.name.replace("_", "-"),
        Path(__file__).parent,
        add_extra_args=add_custom_args
    )
```

### Placeholder Substitutions

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{skill-name}` | Hyphenated skill name | `my-new-skill` |
| `{arg-name}` | Custom argument name | `depth` |
| `{default}` | Default value | `standard` |
| `{choice1}`, `{choice2}` | Allowed values | `quick`, `comprehensive` |

---

## 2. complete.py Template

**Purpose:** Self-configuring completion handler that aggregates outputs and signals skill completion.

### Standard Template (No Custom Logic)

```python
#!/usr/bin/env python3
"""{skill-name} Completion"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_complete import skill_complete
    skill_complete(Path(__file__).parent.name.replace("_", "-"))
```

### Template with Custom Completion Logic

```python
#!/usr/bin/env python3
"""{skill-name} Completion"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_complete import skill_complete

    # Standard completion
    skill_complete(Path(__file__).parent.name.replace("_", "-"))

    # Custom post-completion logic
    # Example: cleanup, additional outputs, etc.
    {custom_logic}
```

---

## 3. __init__.py Template

**Purpose:** Package initialization with skill metadata.

```python
"""
{skill-name} Composite Skill

{skill-description}

Phases:
- Phase 0: {phase_0_title}
- Phase 1: {phase_1_title}
- Phase 2: {phase_2_title}
{additional_phases}
"""

SKILL_NAME = "{skill-name}"
SKILL_DESCRIPTION = "{skill-description}"

__all__ = ["SKILL_NAME", "SKILL_DESCRIPTION"]
```

### Placeholder Substitutions

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{skill-name}` | Hyphenated skill name | `my-new-skill` |
| `{skill-description}` | One-line description | `Process and validate user requests` |
| `{phase_N_title}` | Human-readable phase title | `Requirements Clarification` |
| `{additional_phases}` | Additional phase lines | `- Phase 3: Validation` |

---

## 4. Phase Content Template

**Location:** `content/phase_{phase_id}_{phase_name_snake_case}.md`

### Naming Convention

| Phase ID | Phase Name | Filename |
|----------|------------|----------|
| 0 | Requirements Clarification | `phase_0_requirements_clarification.md` |
| 0.5 | Atomic Provisioning | `phase_0_5_atomic_provisioning.md` |
| 1 | Complexity Analysis | `phase_1_complexity_analysis.md` |
| 2 | Design Synthesis | `phase_2_design_synthesis.md` |

### Standard Phase Template

```markdown
# Phase {phase_id}: {Phase Title}

**Uses Atomic Skill:** `orchestrate-{function}`
**Phase Type:** {LINEAR|OPTIONAL|AUTO|ITERATIVE|REMEDIATION|PARALLEL}

## Purpose

{Clear statement of what this phase accomplishes and why it matters in the workflow}

## Domain-Specific Extensions

{Skill-specific instructions for the agent executing this phase}

1. **{Extension Category 1}**
   - {Specific instruction}
   - {Specific instruction}

2. **{Extension Category 2}**
   - {Specific instruction}
   - {Specific instruction}

## Gate Exit Criteria

- [ ] {Criterion 1 - specific, measurable}
- [ ] {Criterion 2 - specific, measurable}
- [ ] {Criterion 3 - specific, measurable}

## Output

{Description of what is produced and where it is stored}
- Primary output: {description}
- Memory file: `{task_id}-{agent}-memory.md`
```

### AUTO Phase Template (No Agent)

```markdown
# Phase {phase_id}: {Phase Title}

**Phase Type:** AUTO (no agent)

## Purpose

{What this automated phase accomplishes}

## Actions

{Python script actions - no cognitive agent involved}

1. {Action 1}
2. {Action 2}
3. {Action 3}

## Gate Exit Criteria

- [ ] {Criterion 1}
- [ ] {Criterion 2}

## Output

{What is produced by the automated phase}
```

### OPTIONAL Phase Template

```markdown
# Phase {phase_id}: {Phase Title}

**Uses Atomic Skill:** `orchestrate-{function}`
**Phase Type:** OPTIONAL

## Trigger Condition

{Condition that determines if this phase executes}

**Skip if:** {condition that causes skip}
**Execute if:** {condition that causes execution}

## Purpose

{What this phase accomplishes when executed}

## Domain-Specific Extensions

{Instructions for when phase executes}

## Gate Exit Criteria

- [ ] {Criterion 1}
- [ ] {Criterion 2}

## Output

{What is produced, noting it may be empty if skipped}
```

---

## 5. Directory Structure Template

After generation, the skill should have this structure:

```
orchestration/protocols/skill/composite/{skill_name}/
├── __init__.py           # Package init with metadata
├── entry.py              # Self-configuring entry point
├── complete.py           # Self-configuring completion
└── content/              # Phase instruction markdown
    ├── phase_0_{name}.md
    ├── phase_0_5_{name}.md   # Sub-phases if needed
    ├── phase_1_{name}.md
    ├── phase_2_{name}.md
    └── ...
```

---

## 6. Generation Checklist

When generating Python orchestration files:

- [ ] Directory created with underscored name
- [ ] entry.py uses standard template (or custom args if needed)
- [ ] complete.py uses standard template (or custom logic if needed)
- [ ] __init__.py includes accurate phase list
- [ ] content/ directory created
- [ ] One phase_*.md file per phase in config
- [ ] Phase filenames match phase IDs exactly
- [ ] All templates have placeholders substituted
- [ ] No trailing whitespace or encoding issues

---

## References

- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/common_skill_entry.py` - Entry logic
- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/common_skill_complete.py` - Completion logic
- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/CLAUDE.md` - Composite skill protocol
