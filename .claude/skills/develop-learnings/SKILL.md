---
name: develop-learnings
description: Transform completed workflow experiences into structured, reusable learnings organized by cognitive function
semantic_trigger: capture learnings, document insights, preserve knowledge, post-workflow capture
not_for: mid-workflow tasks, skill creation, active execution
tags: learnings, reflection, continuous-improvement, knowledge-capture
type: composite
composition_depth: 0
uses_composites: []
---

# develop-learnings

**Type:** Composite Skill
**Description:** Transform resolved Unknowns and discoveries into reusable learnings using each cognitive agent to maintain its own body of practice
**Status:** production
**Complexity:** complex

## Overview

Embodies "reflection-driven growth" - systematically capturing what was unknown at workflow start but became known, distilling discoveries into reusable patterns organized by cognitive function.

**Core Philosophy:**
- Agents own their learnings (SRP maintained)
- The orchestrator coordinates, agents author
- Learnings are token-efficient, progressively disclosed
- Focus on generalization over task-specific details

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `learnings-{source-task-id}`
- Create workflow metadata per protocol Steps 1-4
- Task domain: technical (learning capture is a technical task)

### Completion
- Report learnings committed
- Summarize integrations applied
- Report retention decisions
- Finalize workflow per protocol Step 6

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_learnings/entry.py "{task_id}" --domain technical
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_learnings/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 1 | Discovery | orchestrate-analysis | LINEAR |
| 2 | Per-Function Authoring | (6 agents sequential) | ITERATIVE |
| 2.5 | Integration Analysis | orchestrate-synthesis | LINEAR |
| 3 | Consolidation | orchestrate-synthesis | LINEAR |
| 4 | Validation | orchestrate-validation | REMEDIATION |
| 5 | Commit | orchestrate-generation | LINEAR |
| 5.5 | Post-Integration Cleanup | orchestrate-analysis | LINEAR |

**Note:** This skill starts at Phase 1 (no Phase 0) because it requires a completed source workflow.

**Execution:** Phases are enforced by `protocols/skill/fsm.py` with state tracked in `protocols/skill/state/`.

## State Management

| State Field | Description |
|-------------|-------------|
| current_phase | discovery → authoring → integration-analysis → consolidation → validation → commit → post-integration |
| authoring_agents_completed | Tracks which agents finished Phase 2 |
| validation_status | pending → pass → fail |
| remediation_count | Max 1 loop |
| integration_decisions | INTEGRATE vs STANDALONE per learning |

## Decision Trees

### Attribution (Phase 1)
- Resolved via questioning → CLARIFICATION
- Resolved via information gathering → RESEARCH
- Resolved via pattern recognition → ANALYSIS
- Resolved via design decisions → SYNTHESIS
- Resolved during implementation → GENERATION
- Resolved via quality checks → VALIDATION

### Entry Action (Phase 2)
- Too task-specific → SKIP
- Duplicates existing → SKIP
- Enhances existing → EXTEND
- Novel and generalizable → ADD

### Integration (Phase 2.5)
- Universal + Blocking + Concise + Core → INTEGRATE
- Any criterion fails → STANDALONE

### Retention (Phase 5.5)
- Not integrated → KEEP
- Provides rationale/examples/failure-modes → KEEP
- Truly redundant with rule → REMOVE

## Required Resources

- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/learnings-schema.md` - Learning entry template
- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/learnings-update-rubric.md` - Validation criteria
- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/candidate-extraction-guidelines.md` - Identification guidelines
- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/integration-criteria.md` - Integration decision criteria
- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/retention-criteria.md` - Retention decision criteria

## Required Directory Structure

```
${CAII_DIRECTORY}/.claude/learnings/{function}/
├── heuristics.md
├── anti-patterns.md
├── checklists.md
└── domain-snippets/
```

(Repeated for: clarification, research, analysis, synthesis, generation, validation)

## References

- `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/skill/` - Workflow lifecycle
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Agent execution
- `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` - Memory format reference
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/agent-invocation-template.md` - Invocation patterns

## Performance

- **Execution time:** 5-20 minutes
- **Token efficiency:** Agents see INDEX only (saves 2,000-5,000 tokens per agent)
- **Johari limit:** 1,200 tokens maximum

## Success Metrics

- Learnings immediately usable by agents
- INDEX < 300 tokens per file
- Generalization rate > 60%
- No duplicate learnings across functions
- Validation pass rate > 80% first attempt
- Agent ownership maintained
