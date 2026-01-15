# Phase 1: Parallel Research Execution

**Uses Atomic Skill:** `orchestrate-research` (3 parallel branches)
**Phase Type:** PARALLEL

## Configuration

- `research_depth`: Read from `state.metadata["depth"]` (quick|standard|comprehensive)

## Purpose

Gather information through parallel execution of three independent research branches:
- Branch 1A: Native web search (WebSearch + WebFetch)
- Branch 1B: Perplexity AI search
- Branch 1C: Tavily AI search

## Parallel Branch Architecture

```
Phase 1: PARALLEL_RESEARCH (PARALLEL)
├── Branch 1A: orchestrate-research (native mode) → memory file 1A
├── Branch 1B: orchestrate-research (perplexity mode) → memory file 1B
└── Branch 1C: orchestrate-research (tavily mode) → memory file 1C
         ↓
Phase 1.5: RESULT_SYNTHESIS
└── orchestrate-synthesis (merges memory files 1A + 1B + 1C)
```

## Branch Details

### Branch 1A: Native Web Search
**Atomic Skill:** `orchestrate-research`
**Tools:** WebSearch, WebFetch
**Output:** `.claude/memory/task-{id}-1A-orchestrate-research-memory.md`

**Instructions for orchestrate-research:**
- Use WebSearch for broad queries
- Use WebFetch for specific document retrieval
- Apply query decomposition based on depth
- Catalog sources with metadata (URL, title, date, type)
- Extract relevant passages and data points

**Query Targets:**
- quick: 3-7 queries
- standard: 10-15 queries
- comprehensive: 20-30 queries

### Branch 1B: Perplexity AI Search
**Atomic Skill:** `orchestrate-research`
**Tools:** `/search:perplexity` slash command
**Output:** `.claude/memory/task-{id}-1B-orchestrate-research-memory.md`

**Instructions for orchestrate-research:**
- Use `/search:perplexity [query]` slash command
- Leverage Perplexity AI for synthesized results with citations
- Focus on academic and authoritative sources
- Extract AI-generated summaries and source attributions

**Query Targets:**
- quick: 2-3 queries
- standard: 5-8 queries
- comprehensive: 10-15 queries

**Note:** If PERPLEXITY_API_KEY is not set, this branch will fail gracefully. The workflow continues with remaining branches.

### Branch 1C: Tavily AI Search
**Atomic Skill:** `orchestrate-research`
**Tools:** `/search:tavily` slash command
**Output:** `.claude/memory/task-{id}-1C-orchestrate-research-memory.md`

**Instructions for orchestrate-research:**
- Use `/search:tavily [query]` slash command
- Leverage Tavily AI for relevance-scored results
- Capture AI summaries and relevance scores
- Prioritize high-scoring results (score > 0.8)

**Query Targets:**
- quick: 2-3 queries
- standard: 5-8 queries
- comprehensive: 10-15 queries

**Note:** If TAVILY_API_KEY is not set, this branch will fail gracefully. The workflow continues with remaining branches.

## Error Handling

All branches have `fail_on_error: false` for resilience.

| Scenario | Behavior |
|----------|----------|
| Branch 1A fails | Continue with 1B and 1C results |
| Branch 1B fails | Continue with 1A and 1C results |
| Branch 1C fails | Continue with 1A and 1B results |
| Two branches fail | Continue with remaining branch |
| All three fail | Halt phase, return error |
| At least one succeeds | Proceed to Phase 1.5 |

## Memory File Format (Per Branch)

Each branch should produce a memory file with:

```markdown
## Section 1: Findings by Subtopic

### Subtopic A
- Finding 1 [confidence: HIGH|MEDIUM|LOW]
  - Source: [URL or citation]
  - Evidence: [Supporting detail]

### Subtopic B
...

## Section 2: Source Catalog

| URL/Citation | Title | Type | Quality Tier | Date |
|--------------|-------|------|--------------|------|
| ... | ... | ... | 1-5 | ... |

## Section 3: Gaps Identified

- Gap 1: [Description of unanswered question]
- Gap 2: [Description of missing information]

## Section 4: Conflicts Found

- Conflict 1: Source A says X, Source B says Y
```

## Gate Exit Criteria

- [ ] All three branches initiated
- [ ] At least one branch completed successfully
- [ ] Each successful branch produced a memory file
- [ ] Query targets met (or branch failed gracefully)
- [ ] Ready for Phase 1.5 (Result Synthesis)

## Output

Three memory files (or subset if branches failed):
- `.claude/memory/task-{id}-1A-orchestrate-research-memory.md`
- `.claude/memory/task-{id}-1B-orchestrate-research-memory.md`
- `.claude/memory/task-{id}-1C-orchestrate-research-memory.md`

Phase 1.5 will merge these results.
