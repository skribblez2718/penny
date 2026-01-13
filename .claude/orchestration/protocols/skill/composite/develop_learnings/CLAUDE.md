# develop-learnings

Transform completed workflow experiences into structured, reusable learnings.

## Phases

| Phase | Name | Atomic Skill |
|-------|------|--------------|
| 1 | Discovery | orchestrate-analysis |
| 2 | Per-Function Authoring | ITERATIVE (all 6 agents) |
| 2.5 | Integration Analysis | orchestrate-synthesis |
| 3 | Consolidation | orchestrate-synthesis |
| 4 | Validation | orchestrate-validation (REMEDIATION) |
| 5 | Commit | orchestrate-generation |
| 5.5 | Post-Integration Cleanup | orchestrate-analysis |

## Routing

**Semantic Trigger:** capture learnings, document insights, preserve knowledge, post-workflow capture

**NOT for:** mid-workflow tasks, skill creation, active execution

> This skill is for post-workflow knowledge capture. It should NOT be invoked during active execution.

## Learning Types

- Heuristics
- Anti-patterns
- Checklists
- Domain snippets

## Output Locations

- `.claude/learnings/{cognitive-function}/heuristics.md`
- `.claude/learnings/{cognitive-function}/anti-patterns.md`
- `.claude/learnings/{cognitive-function}/checklists.md`

## Phase Config Location

`../config.py` → `DEVELOP_LEARNINGS_PHASES`
