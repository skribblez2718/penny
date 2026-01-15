---
name: perform-research
description: Production-grade research with adaptive depth and quality validation
tags: research, validation, synthesis, citations, quality-gates
type: composite
composition_depth: 0
uses_composites: []
---

# perform-research

**Type:** Composite Skill
**Description:** Production-grade research with adaptive depth (quick/standard/comprehensive) and quality validation
**Status:** production
**Complexity:** medium

## Overview

Orchestrates research workflows with adaptive depth handling, multi-pass information gathering, cross-source validation, and citation-backed synthesis.

**Cognitive Pattern:** CLARIFICATION (MANDATORY) → RESEARCH (PARALLEL) → CONSOLIDATION → VALIDATION → SYNTHESIS (with remediation loop) → GENERATION

**Key Capabilities:**
- **Mandatory Johari Window clarification** - discovers unknown unknowns that users may miss due to cognitive blocks
- Adaptive depth inference (quick/standard/comprehensive)
- **Parallel search execution** (native WebSearch + Perplexity AI + Tavily AI)
- Multi-pass information gathering with source cataloging
- Cross-source validation with confidence scoring (triple/dual/single source)
- Contradiction resolution and citation accuracy
- **REQUIRED report generation** to `.claude/research/` directory

**Why Clarification is Mandatory:** Humans suffer from cognitive blocks that can prevent them from including
necessary context without realizing it. Even queries that seem straightforward may have hidden ambiguities,
assumptions, or gaps. The Johari Window framework systematically explores what we don't know we don't know,
transforming unknown unknowns into known knowns before research begins.

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `task-research-{topic-keywords}`
- Create workflow metadata per protocol
- Task domain: varies (technical/personal/creative/professional/recreational)
- Include research depth in metadata (quick/standard/comprehensive)

### Completion
- Aggregate all deliverables
- Review Unknown Registry for information gaps
- Present completion summary with confidence ratings
- Finalize workflow per protocol

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/perform_research/entry.py "{task_id}" --depth {quick|standard|comprehensive}
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/perform_research/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Requirements Clarification | orchestrate-clarification | **LINEAR** (MANDATORY) |
| 1 | Parallel Research | orchestrate-research | **PARALLEL** |
| 1A | └─ Native Web Search | orchestrate-research | (branch) |
| 1B | └─ Perplexity AI Search | orchestrate-research | (branch) |
| 1C | └─ Tavily AI Search | orchestrate-research | (branch) |
| 1.5 | Result Synthesis | orchestrate-synthesis | LINEAR |
| 2 | Completeness Validation | orchestrate-validation | **REMEDIATION** |
| 3 | Synthesis | orchestrate-synthesis | LINEAR |
| 4 | Report Generation | orchestrate-generation | **LINEAR** (REQUIRED) |

**Execution:** Phases are enforced by `protocols/skill/core/fsm.py` with state tracked in `protocols/skill/state/`.

### Parallel Search Architecture

Phase 1 executes three parallel branches:
```
Phase 1: PARALLEL_RESEARCH (PARALLEL)
├── 1A: orchestrate-research (WebSearch + WebFetch) → native memory file
├── 1B: orchestrate-research (search:perplexity) → perplexity memory file
└── 1C: orchestrate-research (search:tavily) → tavily memory file
         ↓
Phase 1.5: RESULT_SYNTHESIS
└── orchestrate-synthesis (merges all memory files)
```

**Error Handling:**
- If native search (1A) fails: Continue with Perplexity and Tavily results
- If Perplexity (1B) fails: Continue with native and Tavily results (branch marked as failed)
- If Tavily (1C) fails: Continue with native and Perplexity results (branch marked as failed)
- All branches have `fail_on_error: false` for resilience

## Depth Configuration

| Depth | Native Queries | Perplexity Queries | Tavily Queries | Format | Time |
|-------|---------------|-------------------|----------------|--------|------|
| quick | 3-7 | 2-3 | 2-3 | Bullet points | 3-7 min |
| standard | 10-15 | 5-8 | 5-8 | Structured narrative | 15-30 min |
| comprehensive | 20-30 | 10-15 | 10-15 | Literature review | 60-120 min |

**Depth Inference Keywords:**
- **quick:** "quick look", "brief", "overview", "summarize"
- **standard:** "research", "investigate", "analyze", "explore"
- **comprehensive:** "deep dive", "comprehensive", "doctoral", "thesis", "literature review"

**Reference:** See `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/depth-parameters.md` for complete configuration

## Quality Gate

| Criterion | Weight | Pass Threshold |
|-----------|--------|----------------|
| Factual accuracy | 0.30 | 0.75 |
| Citation accuracy | 0.25 | 0.80 |
| Source quality | 0.25 | 0.70 |
| Completeness | 0.15 | 0.75 |
| Conflict resolution | 0.05 | 0.70 |

**Overall Pass Threshold:** 0.75

**Max Remediation Loops:** 2

**Reference:** See `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/validation-rubric.md` for complete rubric

## Error Recovery

| Error | Recovery | Fallback |
|-------|----------|----------|
| Insufficient sources | Broaden search terms | Proceed with lower confidence |
| Conflicting sources | Prioritize primary sources | Present multiple perspectives |
| Max loops reached | Abort with quality report | Recommend manual research |
| Tool unavailable | Retry alternatives | Use cached knowledge |
| Citation broken | Try archive.org | Mark unverifiable |

## Output Directory

Research outputs are saved to: `${CAII_DIRECTORY}/.claude/research/`

**Naming Convention:** `research-{topic}-{date}.md`
- Topic extracted from task ID or clarification
- Date timestamp appended for uniqueness

## Required Resources

- `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/validation-rubric.md` - Research quality criteria
- `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/source-quality-criteria.md` - Primary vs secondary rankings
- `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/depth-parameters.md` - Query counts and output formats

## Required Tools

- WebSearch - Broad web search
- WebFetch - Document retrieval
- `/search:perplexity` - Academic/deep research (via slash command)
- `/search:tavily` - AI-powered search with relevance scoring (via slash command)

## Semantic Triggers

This skill is invoked when user queries match these semantic patterns:
- deep research
- comprehensive investigation
- multi-source research
- literature review
- research with validation
- academic research
- thorough research

**NOT for:**
- quick lookups
- simple searches
- single-source queries
- "what is X" questions (use native search directly)

## Testing Protocol

| Test Case | Input | Expected |
|-----------|-------|----------|
| Quick + clear | "Quick overview of Docker" | Johari Window clarification, 6-8 turns, <7 min |
| Standard + conflicts | "Research intermittent fasting" | Clarification + multiple perspectives, conflicts documented |
| Comprehensive + validation fail | "Comprehensive quantum computing research" | Clarification + remediation loop, 12-18 turns, literature format |

**NOTE:** Phase 0 (Clarification) is MANDATORY for all research workflows. The Johari Window framework
helps discover unknown unknowns that humans may miss due to cognitive blocks, even for queries that
appear straightforward.
