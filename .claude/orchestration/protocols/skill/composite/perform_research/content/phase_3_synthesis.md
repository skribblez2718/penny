# Phase 3: Synthesis

**Uses Atomic Skill:** `orchestrate-synthesis`
**Phase Type:** LINEAR

## Purpose

Integrate validated research findings into a coherent, well-structured narrative appropriate to the research depth.

## Input

Read consolidated and validated research from Phase 1.5 memory file:
- `.claude/memory/task-{id}-orchestrate-synthesis-memory.md` (from Phase 1.5)

Also reference:
- Phase 0 clarification (research questions, scope, success criteria)
- Phase 2 validation results (quality scores, remaining gaps)
- Depth parameter from `state.metadata["depth"]`

## Domain-Specific Extensions

When synthesizing research findings:

1. **Depth-Appropriate Structuring**

   Reference: `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/depth-parameters.md`

   | Depth | Output Format | Target Length |
   |-------|---------------|---------------|
   | quick | Bullet points with key findings | 800-1,200 tokens |
   | standard | Structured narrative with sections | 1,500-2,500 tokens |
   | comprehensive | Literature review with analysis | 3,000-5,000 tokens |

2. **Citation Integration**
   - Apply consistent citation style (numbered inline: [1], [2], etc.)
   - Include full bibliography with source details
   - Link every major claim to supporting sources
   - Use multi-source citations for key findings: [1][2][3]

3. **Confidence Communication**
   - Assign confidence ratings to major claims
   - **HIGH:** Triple-source or Tier 1 primary source
   - **MEDIUM:** Dual-source or Tier 2 sources
   - **LOW:** Single-source or Tier 3-4 sources
   - Distinguish facts from opinions/interpretations
   - Mark consensus vs controversial findings

4. **Gap and Limitation Documentation**
   - Clearly state remaining uncertainties
   - Document limitations of the research
   - Note areas requiring further investigation
   - Be transparent about what wasn't found

5. **Conflict Presentation**
   - Present resolved conflicts with resolution rationale
   - Document unresolved conflicts as multiple perspectives
   - Explain why some conflicts couldn't be resolved
   - Provide confidence levels for contested claims

## Output Structure by Depth

### Quick (Bullet Points Format)

```markdown
## [Research Topic]

### Key Findings
- Finding 1 [confidence: HIGH] [1][2]
- Finding 2 [confidence: MEDIUM] [3]
- Finding 3 [confidence: HIGH] [4][5][6]

### Core Themes
1. **Theme 1**: Brief description [7]
2. **Theme 2**: Brief description [8]

### Key Sources
- [1] Source title - URL (Tier X)
- [2] Source title - URL (Tier X)
...

### Limitations
- Limitation 1
- Limitation 2

### Main Takeaway
[1-2 sentence summary of most important insight]
```

### Standard (Structured Narrative Format)

```markdown
## [Research Topic]

### Executive Summary
[2-3 sentence overview of key findings and implications]

### Introduction
[Context and research scope definition, reference Phase 0 clarification]

### Main Findings

#### [Subtopic 1]
[Detailed findings with inline citations[1][2]]

**Key Insights:**
- Insight 1 [confidence: HIGH]
- Insight 2 [confidence: MEDIUM]

#### [Subtopic 2]
[Detailed findings with inline citations[3][4][5]]

**Key Insights:**
- Insight 1 [confidence: HIGH]

#### [Subtopic 3]
[Detailed findings[6][7]]

### Cross-Cutting Themes
1. **Theme 1**: [Analysis across subtopics]
2. **Theme 2**: [Analysis across subtopics]

### Contradictions and Uncertainties
- **Conflict 1**: Source A claims X[8], Source B claims Y[9]. **Resolution**: Based on source quality (A is Tier 1, B is Tier 3), X is more reliable [confidence: HIGH]
- **Conflict 2**: [Unresolved conflict presented as multiple perspectives]

### Limitations and Gaps
- **Gap 1**: [Description and impact]
- **Gap 2**: [Description and impact]

### Conclusions
[Synthesis of findings with confidence levels, answers to research questions]

### References
[1] Title - Author - URL (Tier X, Date)
[2] Title - Author - URL (Tier X, Date)
...
```

### Comprehensive (Literature Review Format)

```markdown
## [Research Topic]: A Comprehensive Review

### Abstract
[150-250 word summary: research question, methodology, key findings, implications]

### Introduction
[Detailed context, research motivation, scope definition]
[Reference Phase 0 clarification and research questions]

### Research Methodology
- **Search Strategy**: [Databases/tools used: Native WebSearch, Perplexity, Tavily]
- **Inclusion Criteria**: [From Phase 0 scope]
- **Source Quality Standards**: [Tier 1-2 prioritized, % breakdown]
- **Timeframe**: [Date range of sources]
- **Query Count**: [Total queries across all branches]

### Theoretical Framework
[Relevant theories, models, frameworks underlying the research domain]

### Main Findings

#### [Major Theme 1]
[Comprehensive analysis with extensive citations]

**Seminal Works:**
- Key work 1[citation] - Contribution
- Key work 2[citation] - Contribution

**Recent Developments:**
- Recent advance 1[citation]
- Recent advance 2[citation]

**Empirical Evidence:**
[Table or structured presentation of evidence across sources]

**Critical Analysis:**
- Strength of current understanding
- Limitations identified
- Gaps in literature

#### [Major Theme 2]
[Repeat structure]

### Comparative Analysis
[Cross-theme synthesis, integration of findings]

| Aspect | Approach A | Approach B | Approach C |
|--------|-----------|-----------|-----------|
| Dimension 1 | Finding[X] | Finding[Y] | Finding[Z] |
| Dimension 2 | Finding | Finding | Finding |

### Contradictions and Debates

#### [Debate 1]
- **Position A**: [Description with citations[X][Y]]
- **Position B**: [Description with citations[Z][W]]
- **Current Consensus**: [Analysis with confidence level]

### Research Gaps and Future Directions
1. **Gap 1**: [Detailed description, implications, potential research questions]
2. **Gap 2**: [Detailed description, implications, potential research questions]

### Limitations of This Review
- **Methodological**: [Search limitations, tool constraints]
- **Coverage**: [What wasn't covered, exclusions]
- **Temporal**: [Recency limitations]

### Conclusions
[Comprehensive synthesis with nuanced confidence levels]
[Implications for theory and practice]
[Answers to all research questions from Phase 0]

### References
[Full bibliography with complete citation information, organized alphabetically or by topic]

[1] Author (Year). Title. Journal/Publisher. DOI/URL. (Tier X, Citations: Y)
...

### Appendices (if applicable)
- Appendix A: Search query strings and result counts
- Appendix B: Source quality distribution
- Appendix C: Conflicting findings detailed analysis
```

## Token Budget Management

Reference: `${CAII_DIRECTORY}/.claude/skills/perform-research/resources/depth-parameters.md`

**Compression Techniques:**
- Dense packing: "Tool X: feature A, 99.9% uptime, $20/mo"
- Abbreviations: API, CRUD, ML, AI, REST, TDD, etc.
- Lists over prose
- Quantify: "$305/mo", "<200ms", "10K users"
- Symbols: "→" (flow), "×" (multiply), "±" (variance)
- Tables for comparative data
- Reference sources instead of extensive quotes

## Gate Exit Criteria

- [ ] Output structure matches depth requirements
- [ ] All findings organized by subtopic/theme
- [ ] Citations properly formatted and complete
- [ ] Confidence ratings assigned to major claims
- [ ] Contradictions resolved or documented as unresolved
- [ ] Gaps and limitations clearly stated
- [ ] Research questions from Phase 0 answered
- [ ] Bibliography complete with source tiers noted
- [ ] Token budget target met

## Output

Document synthesized research in memory file:
`.claude/memory/task-{id}-orchestrate-synthesis-memory.md`

**Include:**
- Complete synthesized narrative per depth format
- Integrated citations with full bibliography
- Confidence ratings on all key findings
- Remaining gaps and limitations documented
- Answers to research questions from Phase 0

This memory file will be used by Phase 4 (Report Generation) to produce the final deliverable.

## Note on File Generation

Phase 3 synthesis creates the research content but does NOT write to `.claude/research/`.
Phase 4 (Report Generation) handles file persistence.
