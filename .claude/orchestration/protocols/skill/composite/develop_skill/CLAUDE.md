# develop-skill

Meta-skill for creating and updating workflow skills in the orchestration system.

## Phases

| Phase | Name | Atomic Skill |
|-------|------|--------------|
| 0 | Requirements Clarification | orchestrate-clarification |
| 0.5 | Atomic Provisioning | orchestrate-generation |
| 0.6 | Composite Validation | orchestrate-validation |
| 1 | Complexity Analysis | orchestrate-analysis |
| 1.5 | Pattern Research | orchestrate-research |
| 2 | Design Synthesis | orchestrate-synthesis |
| 3 | Skill Generation | orchestrate-generation |
| 4 | Skill Validation | orchestrate-validation |
| 5 | DA Registration | orchestrate-generation |

## Routing

**Semantic Trigger:** create skill, modify skill, update workflow, new skill

**NOT for:** system modifications, direct code execution, architecture changes

> This skill is exclusively for creating and modifying workflow skills. It is NOT used for general system work, agent modifications, or architecture changes.

## Key Outputs

- Skill definition file (SKILL.md or config entries)
- Updated DA.md registration
- Phase content files

## Phase Config Location

`../config.py` → `DEVELOP_SKILL_PHASES`
