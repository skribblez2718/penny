# Research Depth Parameters

## Purpose

This document defines depth-specific parameters for research workflows, including query counts, time budgets, validation rigor, and output formats. These parameters guide agent behavior across different research depths.

## Depth Levels

### Quick Depth

**Use Cases:**
- Rapid landscape scans
- Initial topic exploration
- Quick fact-checking
- "What is X?" queries
- Time-sensitive overviews

**Parameters:**

| Parameter | Value |
|-----------|-------|
| Target Query Count | 3-7 queries |
| Minimum Query Count | 3 queries |
| Time Budget | 3-7 minutes |
| Source Quality Threshold | ≥40% Tier 1-2 sources |
| Multi-Source Verification | 1-2 sources per claim |
| Validation Rigor | Basic cross-check |
| Output Token Budget | 800-1,200 tokens |

**Validation Adjustments:**
- Factual accuracy sampling: 10% (vs 20% standard)
- Broken link tolerance: 2-3 acceptable
- Completeness requirement: Major themes covered (not exhaustive)
- Source currency: More flexible, focus on authoritative sources

**Output Format:**

```markdown
## [Research Topic]

### Key Findings
- [Finding 1] [confidence: HIGH/MEDIUM/LOW]
- [Finding 2] [confidence: HIGH/MEDIUM/LOW]
- [Finding 3] [confidence: HIGH/MEDIUM/LOW]

### Core Themes
1. [Theme 1]: [Brief description]
2. [Theme 2]: [Brief description]
3. [Theme 3]: [Brief description]

### Key Sources
1. [Source title] - [URL] (Tier X)
2. [Source title] - [URL] (Tier X)
3. [Source title] - [URL] (Tier X)

### Limitations
- [Gap or limitation 1]
- [Gap or limitation 2]
```

**Agent Instructions:**
- **research-agent:** Prioritize breadth over depth, execute 3-7 focused queries covering main aspects
- **validation-agent:** Apply reduced rigor, focus on major factual errors and critical failures
- **synthesis-agent:** Produce executive summary format, bullet points with confidence ratings

### Standard Depth

**Use Cases:**
- Typical research requests
- Decision support
- Comprehensive overviews
- Multi-aspect analysis
- Project planning research

**Parameters:**

| Parameter | Value |
|-----------|-------|
| Target Query Count | 8-15 queries |
| Minimum Query Count | 8 queries |
| Time Budget | 15-30 minutes |
| Source Quality Threshold | ≥60% Tier 1-2 sources |
| Multi-Source Verification | 2-3 sources per major claim |
| Validation Rigor | Multi-source verification |
| Output Token Budget | 1,500-2,500 tokens |

**Validation Adjustments:**
- Factual accuracy sampling: 20% (standard)
- Broken link tolerance: 1-2 acceptable
- Completeness requirement: All major subtopics covered
- Source currency: Domain-appropriate standards

**Output Format:**

```markdown
## [Research Topic]

### Executive Summary
[2-3 sentence overview of key findings and implications]

### Introduction
[Context and research scope definition]

### Main Findings

#### [Subtopic 1]
[Detailed findings with inline citations[1][2]]

**Key Insights:**
- [Insight 1] [confidence: HIGH]
- [Insight 2] [confidence: MEDIUM]

#### [Subtopic 2]
[Detailed findings with inline citations[3][4][5]]

**Key Insights:**
- [Insight 1] [confidence: HIGH]

#### [Subtopic 3]
[Detailed findings with inline citations[6][7]]

### Cross-Cutting Themes
1. [Theme 1]: [Analysis across subtopics]
2. [Theme 2]: [Analysis across subtopics]

### Contradictions and Uncertainties
- [Conflict 1]: [Source A claims X, Source B claims Y. Resolution: Based on source quality and recency, X is more reliable][confidence: MEDIUM]

### Limitations and Gaps
- [Gap 1]: [Description and impact]
- [Gap 2]: [Description and impact]

### Conclusions
[Synthesis of findings with confidence levels]

### References
[1] [Source title] - [Author] - [URL] (Tier X)
[2] [Source title] - [Author] - [URL] (Tier X)
...
```

**Agent Instructions:**
- **research-agent:** Balance breadth and depth, execute 8-15 queries with query decomposition
- **validation-agent:** Apply standard validation rubric without adjustments
- **synthesis-agent:** Produce structured narrative with sections, inline citations, comprehensive analysis

### Deep Depth

**Use Cases:**
- Doctoral-level research
- Literature reviews
- Thesis research
- Comprehensive analysis
- Expert-level investigation
- Publication-quality research

**Parameters:**

| Parameter | Value |
|-----------|-------|
| Target Query Count | 15-30+ queries |
| Minimum Query Count | 15 queries |
| Time Budget | 60-120 minutes |
| Source Quality Threshold | ≥70% Tier 1-2 sources, priority on Tier 1 |
| Multi-Source Verification | 3+ sources per major claim |
| Validation Rigor | Doctoral-level rigor, primary source priority |
| Output Token Budget | 3,000-5,000 tokens (may require multi-part output) |

**Validation Adjustments:**
- Factual accuracy sampling: 30% (vs 20% standard)
- Broken link tolerance: Zero for academic sources
- Completeness requirement: Exhaustive coverage, all subtopics deeply explored
- Source currency: Strict currency requirements for recent topics
- Primary source bias: Heavily prioritize Tier 1 sources

**Output Format:**

```markdown
## [Research Topic]: A Comprehensive Literature Review

### Abstract
[150-250 word summary of research question, methodology, key findings, and implications]

### Introduction
[Detailed context, research motivation, scope definition, methodology]

### Literature Review Methodology
- Search strategy: [Databases, keywords, filters used]
- Inclusion/exclusion criteria
- Source quality standards applied
- Timeframe covered

### Theoretical Framework
[Relevant theories, models, frameworks underlying the research domain]

### Main Findings

#### [Major Theme 1]
[Comprehensive analysis with extensive citations]

**Seminal Works:**
- [Key paper 1][citation] - [Contribution]
- [Key paper 2][citation] - [Contribution]

**Recent Developments:**
- [Recent advance 1][citation]
- [Recent advance 2][citation]

**Empirical Evidence:**
[Table or structured presentation of evidence across studies]

**Critical Analysis:**
- [Strength 1 of current understanding]
- [Limitation 1 of current understanding]
- [Gap 1 in literature]

#### [Major Theme 2]
[Repeat structure]

#### [Major Theme 3]
[Repeat structure]

### Comparative Analysis
[Cross-theme synthesis, integration of findings]

| Aspect | Approach A | Approach B | Approach C |
|--------|-----------|-----------|-----------|
| [Dimension 1] | [Finding] | [Finding] | [Finding] |
| [Dimension 2] | [Finding] | [Finding] | [Finding] |

### Contradictions and Debates
#### [Debate 1]
- **Position A:** [Description with citations]
- **Position B:** [Description with citations]
- **Current Consensus:** [Analysis with confidence level]

### Research Gaps and Future Directions
1. [Gap 1]: [Detailed description, implications, potential research questions]
2. [Gap 2]: [Detailed description, implications, potential research questions]

### Limitations of This Review
- [Methodological limitation 1]
- [Coverage limitation 2]
- [Temporal limitation 3]

### Conclusions
[Comprehensive synthesis with nuanced confidence levels, implications for theory and practice]

### References
[Full bibliography with complete citation information, organized alphabetically or by topic]

[1] [Author] ([Year]). [Title]. [Journal/Publisher]. [DOI/URL]. (Tier X, Citations: Y)
...

### Appendices
- Appendix A: Search query strings and results counts
- Appendix B: Source quality distribution analysis
- Appendix C: Conflicting findings detailed analysis
```

**Agent Instructions:**
- **research-agent:** Prioritize depth, execute 15-30+ queries with extensive query decomposition, pursue tangential leads, cross-reference extensively
- **validation-agent:** Apply heightened validation rigor, zero tolerance for Tier 4-5 sources on major claims, require primary sources
- **synthesis-agent:** Produce literature review quality output, comprehensive analysis, theoretical frameworks, comparative analysis, research gaps documented
- **generation-agent:** Often required for formal document formatting with proper academic structure

## Query Decomposition Strategies

### Quick Depth Query Strategy
- **Pattern:** 1 broad overview query + 2-6 targeted queries on key aspects
- **Example:**
  - "What is Docker container technology" (overview)
  - "Docker vs virtual machines comparison" (differentiation)
  - "Docker use cases and benefits" (applications)
  - "Docker getting started tutorial" (practical)

### Standard Depth Query Strategy
- **Pattern:** 1 overview + 2-4 subtopics × 2-3 queries each
- **Example for "AI agent evaluation frameworks":**
  - "AI agent evaluation frameworks overview" (overview)
  - Subtopic 1 (Metrics): "AI agent performance metrics", "AI agent evaluation KPIs"
  - Subtopic 2 (Methods): "AI agent testing methodologies", "AI agent benchmark datasets"
  - Subtopic 3 (Tools): "AI agent evaluation tools", "automated AI agent testing"
  - Subtopic 4 (Best practices): "AI agent evaluation best practices", "industry standards AI agent testing"

### Deep Depth Query Strategy
- **Pattern:** 1 overview + 3-5 subtopics × 3-5 queries each + follow-up queries based on findings
- **Iterative refinement:** Execute initial queries → identify key themes → pursue deeper queries on each theme
- **Cross-reference pursuit:** When high-quality sources cite other works, pursue those citations
- **Example for "Quantum computing algorithms for optimization":**
  - "Quantum computing algorithms overview" (overview)
  - Subtopic 1 (QAOA): "Quantum Approximate Optimization Algorithm QAOA", "QAOA performance analysis", "QAOA implementation challenges", "QAOA vs classical optimization"
  - Subtopic 2 (VQE): "Variational Quantum Eigensolver", "VQE optimization applications", "VQE error mitigation"
  - Subtopic 3 (Grover's): "Grover's algorithm optimization", "Grover's algorithm complexity"
  - Subtopic 4 (Comparative): "quantum vs classical optimization performance", "quantum advantage optimization problems"
  - Follow-ups: Pursue high-cited papers, seminal works, recent breakthroughs mentioned in initial findings

## Time Budget Guidelines

**Quick Depth:**
- Query execution: 2-3 minutes
- Source reading: 1-2 minutes
- Validation: 30-60 seconds
- Synthesis: 1-2 minutes
- **Total:** 3-7 minutes

**Standard Depth:**
- Query execution: 5-10 minutes
- Source reading: 5-10 minutes
- Validation: 2-5 minutes
- Synthesis: 3-5 minutes
- **Total:** 15-30 minutes

**Deep Depth:**
- Query execution: 20-40 minutes
- Source reading: 20-40 minutes
- Validation: 10-20 minutes
- Synthesis: 10-20 minutes
- Generation (if needed): 5-10 minutes
- **Total:** 60-120 minutes

**Notes on Time Budgets:**
- Times are estimates, actual time may vary based on topic complexity
- Remediation loops add 30-50% to time budget
- Extremely complex topics may exceed estimates
- Tool availability affects execution time

## Output Token Budget Management

**Johari Output Limits (Per Agent):**
- All agents: 1,200 tokens maximum (strictly enforced)

**Final Synthesized Output:**
- Quick: 800-1,200 tokens
- Standard: 1,500-2,500 tokens
- Deep: 3,000-5,000 tokens (may require multi-part delivery)

**Token Efficiency Strategies:**
- Use dense packing: "Auth0: superior multi-tenancy, 99.99% SLA, $0.023/MAU"
- Abbreviations: API, CRUD, ML, AI, REST, GraphQL, OWASP
- Lists over prose: Bullet points for findings
- Quantify: "$305/mo", "<200ms", "10K MAU", "3-5d"
- Symbols: "→" for flow, "×" for multiplication, "±" for variance
- Tables: For comparative data instead of paragraphs
- References: Link to sources instead of quoting extensively

## Depth Detection Keywords

**Quick Depth Indicators:**
- "quick look", "brief", "overview", "summary", "what is", "summarize", "quick facts", "explain briefly", "give me a rundown"

**Standard Depth Indicators (Default):**
- "research", "investigate", "explore", "analyze", "understand", "learn about", "tell me about", "information on", "details about"

**Deep Depth Indicators:**
- "deep dive", "comprehensive", "doctoral", "thesis", "literature review", "exhaustive", "in-depth", "thorough analysis", "complete survey", "academic research", "publication-quality"

**Ambiguous Queries:**
- If no depth indicators present → Default to Standard
- If conflicting indicators → Invoke clarification-agent
- If user context suggests specific depth → Use context over keywords

## Validation Rigor Adjustments

| Criterion | Quick | Standard | Deep |
|-----------|-------|----------|------|
| Factual Accuracy Sampling | 10% | 20% | 30% |
| Citation Accuracy | Moderate | Strict | Very Strict |
| Source Quality Threshold | 40% Tier 1-2 | 60% Tier 1-2 | 70% Tier 1-2, mostly Tier 1 |
| Broken Link Tolerance | 2-3 links | 1-2 links | 0 academic links |
| Completeness | Major themes | All subtopics | Exhaustive |
| Conflict Resolution | Document major | Document all | Analyze deeply |

## Remediation Parameters

**Max Remediation Loops:** 2 (across all depths)

**Remediation Query Budget:**
- Quick: +2-3 additional queries
- Standard: +3-5 additional queries
- Deep: +5-10 additional queries

**Remediation Focus:**
- Address specific gaps identified in validation failure
- Target higher-tier sources if source quality insufficient
- Expand coverage if completeness inadequate
- Verify specific claims if factual accuracy issues

## Domain-Specific Depth Adjustments

### Technical/Software Research
- Quick: Code examples helpful but not required
- Standard: Include practical how-to guidance
- Deep: Architecture analysis, trade-off comparisons, performance benchmarks

### Medical/Health Research
- All depths: Increase source quality requirements (+10% Tier 1-2)
- Deep: Require systematic review methodology

### Business/Market Research
- Quick: Focus on key metrics and trends
- Standard: Include competitive landscape
- Deep: Detailed market analysis, financial modeling, strategic implications

### Creative/Content Research
- Quick: Examples and inspiration
- Standard: Techniques, best practices, case studies
- Deep: Historical evolution, theoretical frameworks, comparative aesthetics

## Notes

- Depth parameters are guidelines, not rigid constraints—adapt to topic complexity
- User satisfaction is the ultimate metric—adjust if feedback indicates mismatch
- Time budgets assume tool availability—add buffer if tools intermittent
- Token budgets may require compression for complex topics—prioritize quality over length
- Deep research may discover that less depth is actually needed—adjust dynamically
- Remediation loops are not failures—they're quality assurance in action
