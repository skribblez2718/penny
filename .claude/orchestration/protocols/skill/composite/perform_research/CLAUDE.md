# perform-research Composite Skill

**Type:** Composite Skill
**Composition Depth:** 0 (orchestrates atomic skills only)

## Overview

Production-grade research workflow with adaptive depth, parallel multi-source search, quality validation with remediation loops, and required report generation.

## Phase Architecture

| Phase | Type | Atomic Skill | Purpose |
|-------|------|--------------|---------|
| 0 | LINEAR (MANDATORY) | orchestrate-clarification | Johari Window discovery, scope definition |
| 1 | PARALLEL | orchestrate-research | 3 concurrent branches (native, Perplexity, Tavily) |
| 1.5 | LINEAR | orchestrate-synthesis | Merge and deduplicate parallel results |
| 2 | REMEDIATION | orchestrate-validation | Quality gate with max 2 remediation loops |
| 3 | LINEAR | orchestrate-synthesis | Final synthesis into coherent narrative |
| 4 | LINEAR (REQUIRED) | orchestrate-generation | Generate report to .claude/research/ |

## Parallel Branch Details (Phase 1)

```
Phase 1: PARALLEL_RESEARCH
├── Branch 1A: Native WebSearch
│   └── orchestrate-research → .claude/memory/task-{id}-1A-orchestrate-research-memory.md
├── Branch 1B: Perplexity Search
│   └── orchestrate-research → .claude/memory/task-{id}-1B-orchestrate-research-memory.md
└── Branch 1C: Tavily Search
    └── orchestrate-research → .claude/memory/task-{id}-1C-orchestrate-research-memory.md
```

All branches have `fail_on_error: false` for resilience. Phase 1.5 synthesis merges all available results.

## Depth Configuration

Passed via `--depth` argument to entry.py:

| Depth | Query Target | Time Budget | Output Format |
|-------|-------------|-------------|---------------|
| quick | 3-7 queries | 3-7 min | Bullet points |
| standard | 10-15 queries | 15-30 min | Structured narrative |
| comprehensive | 20-30 queries | 60-120 min | Literature review |

Depth is stored in `state.metadata["depth"]` and referenced by phase content instructions.

## Remediation Flow

Phase 2 validates research quality using:
- Factual accuracy (30% weight)
- Citation accuracy (25% weight)
- Source quality (25% weight)
- Completeness (15% weight)
- Conflict resolution (5% weight)

If validation fails:
1. orchestrate-validation identifies specific gaps
2. FSM transitions back to Phase 1 (remediation_target)
3. Phase 1 re-executes with focused queries
4. Max 2 remediation loops before forced completion

## Output Generation (Phase 4)

orchestrate-generation writes final report to:
```
.claude/research/research-{topic}-{timestamp}.md
```

Format includes:
- Executive summary
- Main findings with citations
- Source quality analysis
- Contradictions documented
- Full reference list

## Local Files

- `entry.py` - Entry point with --depth argument
- `complete.py` - Completion handler
- `content/phase_*.md` - 6 phase content files
- `CLAUDE.md` - This file

## Resources

- `${CAII_DIRECTORY}/.claude/skills/perform-research/SKILL.md` - Skill definition
- `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/depth-parameters.md` - Depth configuration
- `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/source-quality-criteria.md` - Source tiers
- `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/validation-rubric.md` - Quality criteria

## Usage Example

```bash
# Quick research (3-7 minutes)
python3 entry.py task-research-docker --depth quick

# Standard research (15-30 minutes) [DEFAULT]
python3 entry.py task-research-docker --depth standard

# Comprehensive research (60-120 minutes)
python3 entry.py task-research-docker --depth comprehensive
```

## Notes

- Phase 0 clarification is MANDATORY and cannot be skipped
- All parallel branches are resilient (fail_on_error: false)
- Phase 4 report generation is REQUIRED (not optional like legacy)
- API keys for Perplexity/Tavily are optional (branches gracefully fail if missing)
- Remediation loops add 30-50% to time budget
