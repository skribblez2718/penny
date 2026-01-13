---
name: develop-skill
description: Meta-skill for creating and updating workflow skills with full Python orchestration integration
semantic_trigger: create skill, modify skill, update workflow, new skill
not_for: system modifications, direct code execution, architecture changes
tags: meta-skill, skill-creation, workflow-design, orchestration, python-integration
type: composite
composition_depth: 0
uses_composites: []
---

# develop-skill

**Type:** Composite Skill
**Description:** Meta-skill for creating and updating workflow skills with full Python orchestration integration
**Status:** production
**Complexity:** medium

## Overview

Guides creation and modification of workflow skills within the system. Supports both CREATE (new skill) and UPDATE (modify existing) workflows. Generated skills include:

- Complete SKILL.md definition
- Full Python orchestration (entry.py, complete.py, __init__.py, content/*.md)
- Resources directory with validation checklist
- config.py registration code
- All documentation updates (DA.md, skill-catalog.md, CLAUDE.md)

## Critical Distinction

**Skills define ONLY orchestration - the WHAT and WHEN, never the HOW.**

- **Skills specify:** Workflows, cognitive sequences, agent invocation order, context requirements
- **Skills DO NOT specify:** Implementation details, execution methods, agent internals
- **The HOW is defined in:** Agent definitions, execution protocols, context format specs

## When to Use

Invoke when **workflow orchestration itself** needs to be created or modified:

### CREATE Workflow (New Skills)

- **New workflow pattern needed:** The system needs new orchestration capability for a task type → "Create a skill for code review workflows"
- **Agent sequencing design:** Need to define how cognitive agents should be coordinated for new task types → "Design a workflow for automated testing"
- **System capability extension:** The system needs new skill to handle previously unsupported task patterns → "Add capability to handle data pipeline workflows"
- **Composite skill composition:** Need to build a skill that uses existing composite skills as building blocks → "Create a skill that uses develop-learnings for multiple topics"

### UPDATE Workflow (Existing Skills)

- **Skill evolution required:** Existing skill needs enhancement or modification → "Update develop-skill to include security scanning phase"
- **Phase modifications:** Need to add, remove, or reorder phases in existing skill → "Add a validation phase before generation"
- **Resource updates:** Skill resources need enhancement → "Add new templates to develop-skill resources"
- **Documentation sync:** Skill documentation needs updating to match changes → "Update the skill-catalog entry for this skill"

### System Modifications

- **System modifications:** Any changes to skills, agents, protocols, or architecture → "Modify the routing system", "Update agent protocols"
- **Meta-work on workflows:** Task is about creating or modifying workflows themselves, not executing them → "Create a new skill"

## Core Principles

1. **Orchestration Only:** Skills define workflows, not implementations
2. **Sequential Execution:** All agent invocations must be sequential
3. **Reference Over Duplication:** Reference existing documentation, don't duplicate
4. **Modularity:** Skills are self-contained, composable units
5. **Composition Hierarchy:** Skills can use both atomic and composite skills as building blocks (max depth: 1)
6. **Philosophy First:** For system modifications, always load `philosophy.md` principles first

**Reference:** For efficiency principles, see `${CAII_DIRECTORY}/.claude/docs/philosophy.md`

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `task-skill-{skill-name}`
- Create workflow metadata per protocol Steps 1-4
- Task domain: technical

### Completion
- Present complete skill file
- Validate against orchestration-only checklist
- Prompt for develop-learnings invocation
- Finalize workflow per protocol Step 6

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_skill/entry.py "{task_id}" --domain technical
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_skill/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Requirements Clarification | orchestrate-clarification | LINEAR |
| 0.5 | Atomic Skill Provisioning | orchestrate-generation | LINEAR |
| 0.6 | Composite Skill Validation | orchestrate-validation | LINEAR |
| 1 | Complexity Analysis | orchestrate-analysis | LINEAR |
| 1.5 | Pattern Research | orchestrate-research | LINEAR |
| 2 | Design Synthesis | orchestrate-synthesis | LINEAR |
| 3 | Skill Generation | orchestrate-generation | LINEAR |
| 4 | Skill Validation | orchestrate-validation | LINEAR |
| 5 | DA.md Registration | orchestrate-generation | LINEAR |

**Execution:** Phases are enforced by `protocols/skill/fsm.py` with state tracked in `protocols/skill/state/`.

## Directory Structure

```
skills/develop-skill/
|- SKILL.md                    (This file)
|- resources/
    |- create-simple-skill.md           (Protocol for simple skill creation)
    |- create-complex-skill.md          (Protocol for complex skill creation)
    |- create-atomic-skill.md           (Protocol for atomic skill creation)
    |- update-skill.md                  (Protocol for updating existing skills)
    |- simple-skill-template.md         (Template for simple skills)
    |- complex-skill-template.md        (Template for complex skills)
    |- atomic-skill-template.md         (Template for atomic skills)
    |- composite-skill-reference.md     (Protocol for composite-to-composite refs)
    |- validation-checklist.md          (Skill validation criteria)
    |- python-orchestration-templates.md (Templates for entry.py, complete.py, etc.)
    |- config-registration-template.md  (Templates for config.py registration)
    |- documentation-touchpoints.md     (All documentation update points)
    |- agent-invocation-template.md     (Agent invocation patterns)
```

## Validation Checklist

Before considering skill complete:

### Core Requirements
- [ ] Defines cognitive sequences (which agents, what order)
- [ ] All sequences are sequential (no parallel agent calls)
- [ ] Includes domain classification approach
- [ ] Specifies context requirements (standards, artifacts, criteria)
- [ ] Every agent specifies context loading pattern
- [ ] References documentation instead of duplicating
- [ ] Zero implementation details (100% orchestration)
- [ ] Gate criteria defined (if multi-phase)
- [ ] All referenced atomic skills exist (type: atomic in frontmatter)
- [ ] No duplicate atomic skill functionality

### Python Orchestration Requirements (CREATE mode)
- [ ] entry.py generated with self-configuring template
- [ ] complete.py generated with self-configuring template
- [ ] __init__.py generated with skill metadata
- [ ] content/phase_*.md files generated for each phase
- [ ] Directory structure created: `composite/{skill_name}/content/`

### Resources Requirements (CREATE mode)
- [ ] resources/ directory created
- [ ] validation-checklist.md created for skill
- [ ] Skill-specific templates created (if any)

### Registration Requirements
- [ ] config.py registration code generated for manual insertion
- [ ] Skill registered in DA.md with 5 semantic triggers
- [ ] Skill added to skill-catalog.md
- [ ] composite/CLAUDE.md table updated

### Composition Requirements (if using composite skills)
- [ ] `composition_depth` correctly set in frontmatter (1 if composites used)
- [ ] `uses_composites` list matches actual composite references
- [ ] All referenced composite skills have `composition_depth: 0`
- [ ] Configuration parameters match child skill interfaces
- [ ] Sub-workflow mode specified for each composite reference
- [ ] No circular references in skill dependency graph

**Reference:** See `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/validation-checklist.md` for complete checklist

## Anti-Patterns

| Anti-Pattern | Instead |
|--------------|---------|
| Parallel agent invocation | Sequential phases |
| Implementation details in skill | Orchestration only |
| Duplicating documentation | Reference docs |
| Verbose context loading blocks | Use `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` |
| Referencing depth-1 composites | Only reference base composites (depth 0) |
| Mixing atomic and composite in same phase | One skill type per phase |
| Circular skill references | Build acyclic dependency graph |
| Using PhaseType.AUTO | All phases must use agents (AUTO is deprecated) |
| Direct execution (uses_atomic_skill: None) | Always specify appropriate orchestrate-* agent |

## Cognitive Sequence Patterns

| Pattern | Sequence |
|---------|----------|
| discovery | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS |
| implementation | GENERATION → VALIDATION |
| full-development | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION |

## References

- `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/skill/` - Workflow lifecycle
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Agent execution
- `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` - Memory format reference
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/agent-invocation-template.md` - Invocation patterns
- `${CAII_DIRECTORY}/.claude/docs/agent-registry.md` - Agent capabilities
- `${CAII_DIRECTORY}/.claude/docs/philosophy.md` - System principles
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/composite-skill-reference.md` - Composite-to-composite composition protocol

## Remember

Skills orchestrate cognitive agents. Agents execute cognitive functions.
Skills define WHAT. Agents define HOW.
Keep this boundary sacred.
