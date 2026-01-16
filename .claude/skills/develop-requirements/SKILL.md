---
name: develop-requirements
description: Platform-agnostic requirements engineering workflow with single-stakeholder default
tags: requirements, user-stories, acceptance-criteria, nfr, traceability, validation
type: composite
composition_depth: 0
uses_composites: []
---

# develop-requirements

**Type:** Composite Skill
**Description:** Platform-agnostic requirements engineering workflow with single-stakeholder default emphasis
**Status:** production
**Complexity:** medium

## Overview

Orchestrates complete requirements engineering lifecycle from elicitation through validation with built-in traceability and change management setup.

**Cognitive Pattern:** CLARIFICATION (MANDATORY) → ELICITATION (ITERATIVE) → SPECIFICATION → TRACEABILITY → VALIDATION (with remediation loop) → CHANGE MANAGEMENT SETUP

**Key Capabilities:**
- **Single-stakeholder default** - assumes user is sole stakeholder unless multi-stakeholder mode specified
- Full requirements elicitation using interviews, observation, document analysis, prototyping
- Structured specification with user stories, acceptance criteria, and SMART NFRs
- Requirements Traceability Matrix (RTM) generation
- **Validation with remediation** - loops back to elicitation if requirements incomplete (max 2 iterations)
- Change management process setup for requirements evolution

**Default Behavior:** Treats user as the sole stakeholder. Multi-stakeholder mode requires explicit configuration.

## When to Use

Invoke this skill when queries match these semantic triggers:

- **Requirements gathering** - "gather requirements", "collect requirements"
- **Requirements elicitation** - "elicit requirements", "discover what users need"
- **User story writing** - "write user stories", "create stories for..."
- **Acceptance criteria definition** - "define acceptance criteria", "what makes this done?"
- **Requirements specification** - "document requirements", "requirements spec"
- **Requirements validation** - "validate requirements", "review requirements with stakeholder"
- **What do I need to build** - "what should I build?", "what features are needed?"

## NOT for

Do NOT invoke this skill for:

- **Implementation details** - use design/architecture skills instead
- **Technology selection** - use research/analysis skills instead
- **Code development** - use generation skills instead
- **Testing execution** - use validation skills for artifact testing

## Core Principles

1. **Single-stakeholder default** - User is assumed to be the sole stakeholder unless multi-stakeholder mode is explicitly configured
2. **Full elicitation techniques** - Uses interviews, observation, document analysis, and prototyping approaches
3. **Complete documentation** - Generates user stories with acceptance criteria, SMART NFRs, and RTM
4. **Platform-agnostic** - No technology-specific patterns; works for any domain
5. **Validation-driven** - Includes stakeholder sign-off with remediation loop if incomplete

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `task-requirements-{project-keywords}`
- Create workflow metadata per protocol
- Task domain: varies (technical/personal/creative/professional)
- Detect stakeholder mode (single/multi)

### Completion
- Aggregate all deliverables (user stories, RTM, change process)
- Review Unknown Registry for gaps
- Present completion summary with traceability
- Finalize workflow per protocol

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_requirements/entry.py "{task_id}"
```

Optional parameters:
```bash
--stakeholder-mode {single|multi}  # Default: single
--skip-change-management          # Skip Phase 5 if no CM needed
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_requirements/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Requirements Clarification | orchestrate-clarification | **LINEAR** (MANDATORY) |
| 1 | Requirements Elicitation | orchestrate-research | **ITERATIVE** |
| 2 | Requirements Specification | orchestrate-synthesis | LINEAR |
| 3 | Traceability Matrix Creation | orchestrate-generation | LINEAR |
| 4 | Requirements Validation | orchestrate-validation | **REMEDIATION** |
| 5 | Change Management Setup | orchestrate-generation | LINEAR |

**Execution:** Phases are enforced by `protocols/skill/core/fsm.py` with state tracked in `protocols/skill/state/`.

### Phase Details

#### Phase 0: Requirements Clarification (LINEAR)
- Detect stakeholder mode (single/multi)
- Clarify project context and scope
- Identify initial constraints
- **Gate:** Project context clarified, stakeholder mode determined

#### Phase 1: Requirements Elicitation (ITERATIVE)
- Use multiple elicitation techniques (interviews, observation, docs, prototyping)
- Gather functional and non-functional requirements
- Document assumptions and constraints
- **Gate:** All requirements elicited, NFRs documented

#### Phase 2: Requirements Specification (LINEAR)
- Transform raw requirements into user stories
- Define acceptance criteria (testable)
- Specify SMART non-functional requirements
- **Gate:** User stories complete, acceptance criteria testable

#### Phase 3: Traceability Matrix Creation (LINEAR)
- Generate RTM linking requirements to stories
- Document requirement sources
- Establish requirement IDs and versioning
- **Gate:** RTM created, all requirements traced

#### Phase 4: Requirements Validation (REMEDIATION)
- Review requirements with stakeholder
- Validate completeness, consistency, testability
- If incomplete → loop back to Phase 1 (max 2 remediation iterations)
- **Gate:** Stakeholder validation obtained

#### Phase 5: Change Management Setup (LINEAR)
- Define change request process
- Establish impact assessment workflow
- Document approval gates
- **Gate:** Change management process documented

### Remediation Flow

If Phase 4 validation identifies gaps:
1. orchestrate-validation identifies specific missing/unclear requirements
2. FSM transitions back to Phase 1 (remediation_target)
3. Phase 1 re-executes with focused elicitation
4. Max 2 remediation loops before forced completion

## Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| stakeholder_mode | enum | single | Stakeholder mode: single (default) or multi |
| skip_change_management | boolean | false | Skip Phase 5 if true |

## Output Artifacts

Generated in `.claude/requirements/{project-name}/`:

1. **user-stories.md** - User stories with acceptance criteria
2. **nfr-specification.md** - SMART non-functional requirements
3. **traceability-matrix.md** - RTM linking requirements to stories
4. **change-process.md** - Change management workflow (unless skipped)

## Validation Checklist

**Reference:** `${CAII_DIRECTORY}/.claude/skills/develop-requirements/resources/validation-checklist.md`

- [ ] All functional requirements captured as user stories
- [ ] Acceptance criteria are testable and unambiguous
- [ ] NFRs follow SMART criteria (Specific, Measurable, Achievable, Relevant, Time-bound)
- [ ] RTM covers all requirements
- [ ] Stakeholder validation obtained
- [ ] Change process defined (if not skipped)

## Agent Invocation Format

When atomic skills invoke agents, use the standardized Agent Prompt Template format:

**Required Sections:**
1. **Task Context** - task_id, skill_name, phase_id, domain, agent_name
2. **Role Extension** - 3-5 task-specific focus areas
3. **Johari Context** - Open/Blind/Hidden/Unknown from reasoning protocol
4. **Task Instructions** - Specific cognitive work
5. **Related Research Terms** - 7-10 keywords
6. **Output Requirements** - Memory file path

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/agent-system-prompt.md`

## Related Research Terms

- Requirements engineering
- User story mapping
- Acceptance criteria
- Non-functional requirements
- Requirements traceability
- Stakeholder analysis
- Elicitation techniques
- SMART criteria
- Requirements validation
- Change management

## Notes

- Single-stakeholder mode is DEFAULT - user is assumed to be sole stakeholder
- Multi-stakeholder mode requires explicit `--stakeholder-mode multi` flag
- Phase 1 (ITERATIVE) uses iteration_agents: ["research"] for multiple elicitation rounds
- Phase 4 (REMEDIATION) can loop back to Phase 1 up to 2 times if validation fails
- Phase 5 can be skipped via `--skip-change-management` flag
- Platform-agnostic design works for technical, personal, creative, or professional domains
