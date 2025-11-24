---
name: perform-research
description: Production-grade research with adaptive depth and quality validation
tags: research, validation, synthesis, citations, quality-gates
---

# perform-research

## OVERVIEW

The perform-research skill orchestrates production-grade research workflows with adaptive depth handling (quick/standard/deep) and embedded quality validation. It transforms user research queries into comprehensive, citation-backed reports through multi-phase cognitive processing with quality gates.

**Key Capabilities:**
- Adaptive depth inference from user intent (quick/standard/deep)
- Multi-pass information gathering with source cataloging
- Cross-source validation with confidence scoring
- Contradiction resolution and citation accuracy verification
- Depth-appropriate output formatting (bullets/narrative/literature review)

**Cognitive Pattern:** CLARIFICATION → RESEARCH → VALIDATION → SYNTHESIS (with remediation loop)

## AGENT ORCHESTRATION

### AGENT 1: CLARIFICATION-SPECIALIST

**Purpose:** Transform ambiguous research queries into explicit scope definitions with depth indicators and success criteria

**Trigger:** User query lacks clarity on research scope, depth, or specific requirements

**Instructions:**
- Extract research question from user query
- Identify ambiguous aspects requiring clarification
- Determine whether depth is explicitly stated or needs inference
- Define scope boundaries (what is included/excluded)
- Establish success criteria for research completion
- Output explicit research specification for downstream agents

**Context Required:**
- task_domain: [technical|personal|creative|professional|recreational|hybrid]
- user_query: Original research request
- clarity_threshold: Minimum clarity needed before proceeding

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- research_question: Explicit question statement
- scope_boundaries: Inclusions/exclusions
- depth_indicator: [quick|standard|deep] or detection keywords
- success_criteria: Measurable completion indicators
- ambiguities_resolved: List of clarifications made

**Handoff Protocol:**
Pass research_question, scope_boundaries, depth_indicator to research-discovery

### AGENT 2: RESEARCH-DISCOVERY

**Purpose:** Gather information through multi-pass querying with source cataloging and conflict identification

**Trigger:** Research specification defined (from CLARIFICATION or direct user query)

**Instructions:**
- Decompose research question into subtopics for comprehensive coverage
- Execute information gathering across multiple sources
- Catalog source metadata for each finding
- Identify and flag conflicting claims immediately
- Track query count against depth-specific targets
- Ensure coverage across all defined subtopics
- Document information gaps discovered during research

**Context Required:**
- research_question: Explicit question from CLARIFICATION
- scope_boundaries: What to include/exclude
- research_depth: [quick|standard|deep]
- target_query_count: Depth-specific query targets (see resources/depth-parameters.md)
- quality_standards: Research-specific standards (see resources/validation-rubric.md)

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-clarification-specialist-memory.md [IMMEDIATE PREDECESSOR - OPTIONAL]

**Context Scope:** IMMEDIATE_PREDECESSORS
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- findings_by_subtopic: Organized research findings
- source_catalog: Metadata for each source (type, date, author, credibility)
- conflicting_claims: Identified contradictions with source citations
- query_count_achieved: Actual queries executed
- information_gaps: Areas with insufficient coverage

**Handoff Protocol:**
Pass findings_by_subtopic, source_catalog, conflicting_claims to quality-validator

### AGENT 3: QUALITY-VALIDATOR

**Purpose:** Verify research quality through cross-source validation, citation accuracy, and conflict detection

**Trigger:** Research findings collected from research-discovery

**Instructions:**
- Apply research validation rubric to findings
- Verify factual accuracy through source cross-checking
- Check citation accuracy and source accessibility
- Assess source quality using quality criteria
- Evaluate completeness against research scope
- Detect and document conflicting information
- Calculate quality scores per criterion
- Determine pass/fail status for quality gate

**Context Required:**
- validation_rubric: Research quality criteria (see resources/validation-rubric.md)
- source_quality_criteria: Primary vs secondary rankings (see resources/source-quality-criteria.md)
- pass_threshold: Minimum quality score (0.75)
- critical_failure_types: Errors causing immediate failure

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-research-discovery-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- quality_scores: Scores per criterion (factual accuracy, citation accuracy, source quality, completeness, conflict resolution)
- overall_score: Weighted average quality score
- gate_status: [PASS|FAIL]
- critical_failures: List of critical issues if any
- remediation_guidance: Specific improvements needed if FAIL
- validation_confidence: Confidence level in validation results

**Handoff Protocol:**
- If gate_status = PASS: Pass validated findings to synthesis-agent
- If gate_status = FAIL: Pass remediation_guidance back to research-discovery (loop)

### AGENT 4: SYNTHESIS-AGENT

**Purpose:** Integrate validated findings into coherent narrative with confidence ratings, contradiction resolution, and structured citations

**Trigger:** Research findings passed validation quality gate

**Instructions:**
- Organize findings by subtopic for narrative flow
- Resolve contradictory claims using source quality hierarchy
- Assign confidence ratings to major claims based on source quality
- Structure output according to research depth requirements
- Format citations according to depth-specific style
- Document remaining gaps and limitations
- Include meta-analysis of research landscape
- Ensure all claims are properly cited

**Context Required:**
- research_depth: [quick|standard|deep]
- output_format: Depth-specific format (see resources/depth-parameters.md)
- citation_style: Numbered inline with full bibliography
- artifact_types: [research_report, citation_list, executive_summary]

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-research-discovery-memory.md [REQUIRED]
- .claude/memory/task-{id}-quality-validator-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS + RESEARCH_FINDINGS
**Token Budget:** 3,000-3,500 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- synthesized_research: Structured narrative with sections
- confidence_ratings: Per-claim confidence levels
- contradictions_resolved: How conflicting claims were handled
- citation_list: Full bibliography
- research_gaps: Documented limitations
- meta_analysis: Overall landscape assessment

**Handoff Protocol:**
- If deliverable format requires specialized generation: Pass to generation-agent
- Otherwise: Return synthesized_research to user

### AGENT 5: GENERATION-AGENT (OPTIONAL)

**Purpose:** Generate formatted deliverable in specific output format if required

**Trigger:** Synthesized research needs specialized formatting (e.g., PDF report, slide deck, formal document)

**Instructions:**
- Apply format-specific templates to synthesized research
- Ensure proper document structure and styling
- Maintain citation integrity in formatted output
- Generate any required supplementary materials
- Validate output meets format requirements

**Context Required:**
- deliverable_format: [markdown_report|pdf_document|presentation|other]
- format_requirements: Specific formatting constraints
- artifact_types: Expected output types

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-synthesis-agent-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS
**Token Budget:** 2,000-2,500 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
Formatted deliverable in requested format

**Handoff Protocol:**
Return formatted deliverable to user

## STATE MANAGEMENT

### PERSISTENT STATE

```json
{
  "workflow_id": "research-{timestamp}-{uid}",
  "current_phase": "clarification|research|validation|synthesis|generation",
  "research_metadata": {
    "research_question": "",
    "scope_boundaries": {},
    "research_depth": "quick|standard|deep",
    "target_query_count": 0,
    "actual_query_count": 0
  },
  "quality_gate": {
    "validation_attempts": 0,
    "max_remediation_loops": 2,
    "current_quality_score": 0.0,
    "pass_threshold": 0.75,
    "gate_status": "pending|pass|fail"
  },
  "agents_completed": [],
  "remediation_history": []
}
```

### STATE TRANSITIONS

1. **User Query → CLARIFICATION**
   - Condition: Query ambiguity detected OR depth unclear
   - State update: current_phase = "clarification"

2. **User Query → RESEARCH** (skip CLARIFICATION)
   - Condition: Query explicit with clear depth
   - State update: current_phase = "research", infer depth from keywords

3. **RESEARCH → VALIDATION**
   - Condition: Research findings collected
   - State update: current_phase = "validation", validation_attempts++

4. **VALIDATION → RESEARCH** (remediation loop)
   - Condition: gate_status = "fail" AND validation_attempts < max_remediation_loops
   - State update: current_phase = "research", append remediation_history

5. **VALIDATION → SYNTHESIS**
   - Condition: gate_status = "pass"
   - State update: current_phase = "synthesis", quality_gate.gate_status = "pass"

6. **SYNTHESIS → GENERATION**
   - Condition: Specialized deliverable format required
   - State update: current_phase = "generation"

7. **SYNTHESIS → COMPLETE** (skip GENERATION)
   - Condition: No specialized formatting needed
   - State update: workflow complete, return results

8. **GENERATION → COMPLETE**
   - Condition: Formatted deliverable produced
   - State update: workflow complete, return formatted deliverable

## DECISION TREES

### DECISION POINT 1: DEPTH INFERENCE

**If** user query contains ["quick look", "brief", "overview", "summarize", "what is"]
  **Then** → research_depth = "quick"
**Else If** user query contains ["deep dive", "comprehensive", "doctoral", "thesis", "literature review", "exhaustive"]
  **Then** → research_depth = "deep"
**Else If** user query contains ["research", "investigate", "analyze", "explore", "understand"]
  **Then** → research_depth = "standard"
**Else**
  **Then** → Invoke clarification-specialist to determine depth

### DECISION POINT 2: CLARIFICATION NECESSITY

**If** research question is ambiguous OR scope unclear OR depth undefined
  **Then** → Agent: clarification-specialist
**Else**
  **Then** → Skip to research-discovery with inferred parameters

### DECISION POINT 3: VALIDATION GATE

**If** overall_quality_score ≥ 0.75 AND no critical_failures
  **Then** → gate_status = "pass" → Agent: synthesis-agent
**Else If** validation_attempts < max_remediation_loops
  **Then** → gate_status = "fail" → Agent: research-discovery (with remediation_guidance)
**Else**
  **Then** → gate_status = "fail" → Abort with quality report, recommend manual research

### DECISION POINT 4: GENERATION NECESSITY

**If** deliverable_format is specified AND format ≠ "markdown"
  **Then** → Agent: generation-agent
**Else**
  **Then** → Return synthesized research directly

## ERROR HANDLING

### ERROR RECOVERY MATRIX

| Error Type | Detection | Recovery Strategy | Fallback |
|------------|-----------|-------------------|----------|
| Insufficient sources | query_count < target AND information_gaps present | Broaden search terms, add alternative sources | Proceed with lower confidence, document gaps |
| Conflicting sources | Multiple contradictory claims without resolution | Invoke validation early, prioritize primary sources | Document conflicts, present multiple perspectives |
| Validation failure (max loops) | validation_attempts ≥ max_remediation_loops AND gate_status = fail | Abort workflow with quality report | Recommend manual research or lower depth |
| Query tools unavailable | WebSearch/WebFetch/perplexity-search errors | Retry with available tools, adjust expectations | Use cached knowledge with explicit limitations |
| Citation broken | Source URLs inaccessible during validation | Attempt archive.org lookup, flag as unavailable | Remove or mark citation as unverifiable |
| Scope creep | Research expanding beyond defined boundaries | Re-invoke clarification-specialist to redefine scope | Proceed with original scope, note expansion areas |
| Token overflow | Agent output exceeds Johari limit | Apply progressive compression techniques | Summarize findings with reference to full data |

## USAGE EXAMPLES

### SCENARIO 1: QUICK RESEARCH REQUEST

**User:** "Quick look at what Perplexity Deep Research is"

**Penny:** Initiating perform-research skill with inferred depth: quick

**Agent Flow:**
1. Skip CLARIFICATION (query clear)
2. research-discovery: 5 queries across WebSearch + perplexity-search, finds key features, methodology, differentiation
3. quality-validator: Validates sources, checks factual accuracy, gate_status = pass (score: 0.82)
4. synthesis-agent: Produces bullet-point summary with key themes and 3-5 key sources

**Result:**
- Executive summary format (bullet points)
- 3-5 key sources cited
- Confidence ratings on major claims
- Execution time: ~3-5 minutes

### SCENARIO 2: STANDARD RESEARCH WITH VALIDATION FAILURE

**User:** "Research best practices for multi-agent research systems"

**Penny:** Initiating perform-research skill with inferred depth: standard

**Agent Flow:**
1. research-discovery: 12 queries, gathers findings from academic papers, industry blogs, documentation
2. quality-validator: Detects citation accuracy issues, missing primary sources, gate_status = fail (score: 0.68)
3. research-discovery (remediation): 5 additional queries targeting academic sources, improves source quality
4. quality-validator: Validates improvements, gate_status = pass (score: 0.79)
5. synthesis-agent: Produces structured narrative with sections, inline citations, comprehensive bibliography

**Result:**
- Structured narrative report
- 15+ sources with quality ratings
- Contradictions documented and resolved
- Research gaps acknowledged
- Execution time: ~15-25 minutes

### SCENARIO 3: DEEP RESEARCH WITH CLARIFICATION

**User:** "I need comprehensive research on AI agents"

**Penny:** Initiating perform-research skill, query requires clarification

**Agent Flow:**
1. clarification-specialist: Asks user to specify: which aspects? (architecture/applications/evaluation?), what depth?, what use case?
2. User clarifies: "AI agent evaluation frameworks, doctoral-level depth, for thesis literature review"
3. research-discovery: 25 queries, extensive academic source gathering, cross-references, citation mapping
4. quality-validator: Rigorous validation, primary source verification, gate_status = pass (score: 0.88)
5. synthesis-agent: Produces literature review format with thematic organization, comparative analysis, research gaps
6. generation-agent: Formats as formal academic document with proper citations

**Result:**
- Literature review quality output
- 30+ academic sources with citation counts
- Thematic organization with subsections
- Comparative framework analysis
- Research gaps and future directions documented
- Execution time: ~60-90 minutes

## PERFORMANCE CONSIDERATIONS

**Expected Execution Time:**
- Quick depth: 3-7 minutes
- Standard depth: 15-30 minutes
- Deep depth: 60-120 minutes

**Context Window Usage:**
- CLARIFICATION: ~15% (1-2 turns)
- RESEARCH: ~30-40% (3-8 turns depending on depth)
- VALIDATION: ~20% (2-3 turns)
- SYNTHESIS: ~20-25% (2-3 turns)
- GENERATION: ~10-15% (1-2 turns if needed)

**Optimal Agent Sequencing:**
All agents invoked sequentially (never parallel) to maintain context coherence and enable quality gates

**Token Efficiency Strategies:**
- Progressive context compression (see `.claude/protocols/context-pruning-protocol.md`)
- Johari output limits strictly enforced (1,200 tokens max)
- Immediate predecessor context loading only
- Embedded validation reduces separate validation phase overhead

## DEPENDENCIES

### REQUIRED SKILLS
None (standalone skill)

### REQUIRED RESOURCES
- `resources/validation-rubric.md`: Research quality criteria
- `resources/source-quality-criteria.md`: Primary vs secondary source rankings
- `resources/depth-parameters.md`: Query counts and output formats per depth

### REQUIRED TOOLS
- WebSearch: Broad web search capability
- WebFetch: Specific document retrieval
- perplexity-search: Academic and deep research queries (via slash command)

### PROTOCOL REFERENCES
- `.claude/protocols/agent-protocol-core.md`: Core agent execution protocol
- `.claude/protocols/context-pruning-protocol.md`: Progressive context compression
- `.claude/references/agent-registry.md`: Agent capabilities and descriptions
- `.claude/references/johari.md`: Context structure and output format
- `.claude/references/context-inheritance.md`: Context-passing patterns

## TESTING PROTOCOL

### Test Case 1: Quick Depth with Clear Query
**Input:** "Quick overview of Docker containers"
**Expected:**
- Skip CLARIFICATION
- research-discovery: 3-7 queries
- validation: Pass on first attempt
- synthesis: Bullet points with key themes
- Total turns: 6-8
- Execution time: < 7 minutes

### Test Case 2: Standard Depth with Conflicting Sources
**Input:** "Research effectiveness of intermittent fasting"
**Expected:**
- Optional CLARIFICATION if scope unclear
- research-discovery: Finds contradictory studies
- validation: Identifies conflicts, validates resolution strategy
- synthesis: Presents multiple perspectives with confidence ratings
- Contradictions explicitly documented

### Test Case 3: Deep Depth with Validation Failure
**Input:** "Comprehensive research on quantum computing algorithms for thesis"
**Expected:**
- CLARIFICATION: Confirms scope and specific algorithm focus
- research-discovery: 20+ academic queries
- validation: FAIL on first attempt (insufficient primary sources)
- research-discovery (remediation): Additional academic source gathering
- validation: PASS on second attempt
- synthesis: Literature review format
- generation: Formal document formatting
- Total turns: 12-18
- Execution time: 60-120 minutes

### Edge Case Test 1: Max Remediation Loops Reached
**Input:** Research request in domain with very limited sources
**Expected:**
- validation: FAIL on attempts 1 and 2
- After 2 remediation loops: Abort with quality report
- Recommend manual research or lowering depth
- Document specific quality issues encountered

### Edge Case Test 2: Tool Unavailability
**Input:** Research request when WebSearch is unavailable
**Expected:**
- research-discovery: Detects tool failure
- Attempts alternative tools (perplexity-search, cached knowledge)
- Documents limitations in findings
- Proceeds with explicit confidence reduction

## MAINTENANCE NOTES

### Update Guidelines
- When modifying validation rubric: Update `resources/validation-rubric.md`, increment patch version
- When changing agent sequence: Update workflow diagram and state transitions, increment minor version
- When adding new depth levels: Update `resources/depth-parameters.md` and decision trees
- Maintain orchestration-only principle: Never add implementation details to agent instructions

### Monitoring Points
- Track validation failure rate per depth level
- Monitor remediation loop frequency
- Measure execution time variance per depth
- Track user satisfaction with output quality

### Known Limitations
- Validation rubric requires periodic calibration based on user feedback
- Deep depth research may exceed token budgets for extremely complex topics
- Remediation loops cap at 2 to prevent infinite loops, may result in lower quality outputs for difficult topics
- Source quality criteria assume standard academic hierarchies, may need domain-specific adjustments

### Future Enhancements
- Add comparative research mode (compare multiple topics)
- Implement research caching for frequently requested topics
- Add collaborative research mode (multi-user research projects)
- Integrate with citation management tools
