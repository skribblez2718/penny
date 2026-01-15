# Phase 1.5: Result Synthesis

**Uses Atomic Skill:** `orchestrate-synthesis`
**Phase Type:** LINEAR

## Purpose

Consolidate and deduplicate findings from the three parallel research branches (1A: Native, 1B: Perplexity, 1C: Tavily).

## Input Sources

Read memory files from Phase 1 branches (check for existence):

| Branch | Memory File | Status |
|--------|-------------|--------|
| 1A (Native) | `task-{id}-1A-orchestrate-research-memory.md` | Check exists |
| 1B (Perplexity) | `task-{id}-1B-orchestrate-research-memory.md` | Check exists |
| 1C (Tavily) | `task-{id}-1C-orchestrate-research-memory.md` | Check exists |

**Note:** One or more files may be missing if branches failed. Proceed with available results.

## Domain-Specific Extensions

When consolidating parallel research results:

1. **Branch Status Assessment**
   - Determine which branches completed successfully
   - Note failed branches and reasons (if documented)
   - Adapt consolidation strategy based on available data

2. **Finding Deduplication**
   - Identify findings that appear across multiple branches
   - Merge duplicate findings with combined source attribution
   - Preserve unique findings from each branch
   - Boost confidence for cross-validated findings

3. **Source Cross-Reference**
   - Build unified source catalog from all branches
   - Match sources cited by multiple branches
   - Note branch-specific sources
   - Apply source quality hierarchy (Tier 1-5)

4. **Conflict Resolution**
   - Identify conflicting information between branches
   - Apply source quality priority: Tier 1 > Tier 2 > Tier 3 > Tier 4 > Tier 5
   - Document unresolvable conflicts for Phase 2 validation
   - Preserve multiple perspectives where appropriate

5. **Confidence Aggregation**
   - **Triple-source (all 3 branches):** HIGH confidence + boost
   - **Dual-source (any 2 branches):** HIGH confidence
   - **Single-source (1 branch):** MEDIUM/LOW confidence (based on source tier)
   - **Failed branch findings:** Mark as UNVERIFIED

## Consolidation Logic

### All Three Branches Succeeded
```
For each finding:
  IF appears in all 3 branches:
    confidence = HIGH + BOOST
    sources = union(sources_1A, sources_1B, sources_1C)
    label = "triple-source validated"
  ELIF appears in 2 branches:
    confidence = HIGH
    sources = union(sources from 2 branches)
    label = "dual-source validated"
  ELSE:
    confidence = original confidence (based on source tier)
    sources = original sources
    label = "single-branch finding"
```

### One or Two Branches Failed
```
IF only 1 branch succeeded:
  Use that branch's results
  All findings labeled "single-branch"
  Flag for extra validation in Phase 2

ELIF 2 branches succeeded:
  Merge those 2 branches
  Cross-validated findings = "dual-source"
  Single-branch findings = "needs verification"
```

### Conflict Resolution Priority

When sources disagree, prioritize:
1. Tier 1 sources (peer-reviewed, government, official docs)
2. Tier 2 sources (academic institutions, research orgs)
3. Perplexity/Tavily AI summaries (with citations)
4. Tier 3 sources (reputable journalism, expert blogs)
5. Tier 4-5 sources (personal blogs, forums)

## Output Format

Create consolidated memory file:

```markdown
# Consolidated Research Results

## Consolidation Summary

| Branch | Status | Findings Count | Sources Count |
|--------|--------|----------------|---------------|
| Native (1A) | COMPLETED/FAILED | X | Y |
| Perplexity (1B) | COMPLETED/FAILED | X | Y |
| Tavily (1C) | COMPLETED/FAILED | X | Y |
| **Merged Total** | - | Z unique | W unique |

**Confidence Distribution:**
- Triple-source (HIGH++): A findings
- Dual-source (HIGH): B findings
- Single-source (MEDIUM): C findings
- Unverified: D findings

## Section 1: Unified Findings

### [Subtopic A]

| Finding | Sources | Validation | Confidence |
|---------|---------|------------|------------|
| Finding 1 | [URL1, URL2, URL3] | ALL branches | HIGH++ |
| Finding 2 | [URL4, URL5] | 1A+1B | HIGH |
| Finding 3 | [URL6] | 1B only | MEDIUM |

### [Subtopic B]
...

## Section 2: Unified Source Catalog

| Source | Type | Quality Tier | Branch(es) | Notes |
|--------|------|--------------|------------|-------|
| [URL] | Academic | 1 | ALL | Cited by all branches |
| [URL] | Official | 1 | 1A, 1C | Primary source |
| [URL] | Blog | 3 | 1A | Secondary context |

## Section 3: Resolved Conflicts

| Conflict | Resolution | Reasoning |
|----------|------------|-----------|
| Source A says X, Source B says Y | Chose X | Source A is Tier 1, Source B is Tier 3 |

## Section 4: Unresolved Conflicts

- **Conflict 1:** [Description of conflicting claims that need Phase 2 validation]
- **Conflict 2:** [Another unresolved conflict]

## Section 5: Remaining Gaps

- **Gap 1:** [Topic/question not fully addressed]
- **Gap 2:** [Missing information]

## Section 6: Branch-Specific Insights

**Native Branch (1A):**
- Unique contributions: [What only native search found]

**Perplexity Branch (1B):**
- Unique contributions: [What only Perplexity found]

**Tavily Branch (1C):**
- Unique contributions: [What only Tavily found]
```

## Gate Exit Criteria

- [ ] All available branch memory files read
- [ ] Findings deduplicated across branches
- [ ] Sources cross-referenced and unified
- [ ] Conflicts identified and resolved (or documented as unresolved)
- [ ] Confidence levels assigned (triple/dual/single source)
- [ ] Source quality tiers applied
- [ ] Consolidated memory file created
- [ ] Ready for Phase 2 (Quality Validation)

## Output

Create unified research findings:
`.claude/memory/task-{id}-orchestrate-synthesis-memory.md`

This file will be used by:
- Phase 2 (Completeness Validation)
- Phase 3 (Synthesis)
- Phase 4 (Report Generation)
