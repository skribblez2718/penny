# Agent Protocol Core

## Metadata

- **Type:** core
- **Purpose:** Defines how ALL cognitive domain agents execute within the Penny system. Agents apply consistent cognitive processes while adapting to task-specific contexts.

## Task-ID Extraction and Domain Classification

### Task-ID Extraction

Every agent invocation MUST include task-id in the prompt

**Format:**
```
Task ID: task-{descriptive-keywords}
Step: {step-number}
Step Name: {step-name}
Purpose: {purpose}
```

**Extraction:**
- Extract task-id from invocation prompt using regex: `task-[a-z0-9-]{1,36}`

### Task Domain Classification

**Domains:**
- **technical** - Software, systems, engineering tasks
- **personal** - Life decisions, personal growth, health
- **creative** - Art, writing, design, content creation
- **professional** - Business, career, workplace tasks
- **recreational** - Fun, games, entertainment, hobbies
- **hybrid** - Multi-domain tasks requiring mixed approach

**Indicators:**
- **Technical:** code, API, architecture, deployment, debug
- **Personal:** life, health, goal, habit, decision
- **Creative:** write, design, story, content, artistic
- **Professional:** business, market, strategy, report, meeting
- **Recreational:** game, fun, party, hobby, entertainment

## Context Inheritance Protocol

### Load Workflow Context (Enhanced)

**Workflow Metadata:**
- **Location:** `.claude/memory/task-{task-id}-memory.md`
- **Extract:**
  - **taskDomain** - Domain classification (defaults to "technical")
  - **qualityStandards** - Quality criteria to apply
  - **artifactTypes** - Types of artifacts to generate
  - **successCriteria** - Success evaluation criteria
  - **constraints** - Limitations and requirements
- **Domain Criteria:** Load domain-specific evaluation criteria based on task domain

### Previous Agent Context Loading (SCOPED)

Agents receive explicit predecessor list in invocation with scope annotation

**Context References:**
- **[ALWAYS] Scope:** `.claude/memory/task-{task-id}-memory.md` - Workflow metadata (every agent reads this)
- **[REQUIRED] Scope:** `.claude/memory/task-{task-id}-{predecessor-1}-memory.md` - Immediate predecessors whose outputs are critical
- **[OPTIONAL] Scope:** `.claude/memory/task-{task-id}-{predecessor-2}-memory.md` - Referenced for specific information (e.g., constraints, standards)

**Token Budget:**
- **Max total:** 3000-4000 tokens of context
- **Workflow metadata:** ~500 tokens
- **Required predecessors:** ~2500-3000 tokens
- **Optional references:** ~500 tokens (specific sections only)

**Scoping Strategy:**

#### CLARIFICATION Agent
- **First invocation:** workflow_metadata
- **Subsequent:** workflow_metadata, previous_agent_output

#### RESEARCH Agent
- **Always:** workflow_metadata
- **Required:** most_recent_CLARIFICATION_or_ANALYSIS

#### ANALYSIS Agent
- **Always:** workflow_metadata
- **Required:** most_recent_RESEARCH_or_SYNTHESIS_or_GENERATION
- **Optional:** previous_ANALYSIS_for_comparison

#### SYNTHESIS Agent
- **Always:** workflow_metadata
- **Required:** most_recent_RESEARCH
- **Optional:** most_recent_ANALYSIS_if_evaluation_phase

#### GENERATION Agent
- **Always:** workflow_metadata
- **Required:** most_recent_SYNTHESIS_architecture_design
- **Optional:** most_recent_CLARIFICATION_constraints, previous_GENERATION_for_iteration

#### VALIDATION Agent
- **Always:** workflow_metadata
- **Required:** target_agent_output_being_validated
- **Optional:** quality_standards_from_phase_0

**Context Request Mechanism:**

If agent needs additional context not in scope:
- Add to unknown registry with:
  - **id:** U{N}
  - **type:** CONTEXT_REQUEST
  - **description:** Need {specific_file} to complete {task}
  - **priority:** HIGH
  - **resolution:** Add {file} to context scope and re-invoke

## Learning Injection Protocol

### Purpose

Enable cognitive agents to leverage accumulated learnings from previous tasks without manual context loading. This implements the develop-learnings skill's Part 2 requirement for dynamic learning retrieval.

### Loading Strategy

**Always Load (Step 0 of every agent execution):**
- `learnings/{cognitive_function}/heuristics.md` (INDEX section only, ~100-150 tokens)
- `learnings/{cognitive_function}/anti-patterns.md` (INDEX section only, ~50-100 tokens)
- `learnings/{cognitive_function}/checklists.md` (INDEX section only, ~50-100 tokens)

**Triggered Deep Lookup (conditional):**
When INDEX contains pattern matching task characteristics:
- **Domain match:** "technical + API" → grep "API" in learnings/{function}/domain-snippets/
- **Pattern match:** "multi-source research" → grep "cross-checking" in learnings/research/heuristics.md
- Load only matched section (~100-200 tokens)

### Token Budget

- **INDEX loading:** 200-400 tokens (always, before main task execution)
- **Deep lookup:** 0-200 tokens (conditional, only when pattern matches)
- **Total maximum:** 600 tokens for learning injection

### Integration with Existing Context Loading

Learning injection happens BEFORE main context loading in agent execution:

**Execution Order:**
1. **Step 0 - Learning Injection:** 200-600 tokens
2. **Context Loading (existing):** 2,500-3,000 tokens (workflow metadata + predecessors)
3. **Total available:** ~3,200-3,600 tokens for pre-work context

This maintains token efficiency while enabling agents to apply accumulated knowledge.

### Per-Agent Implementation

Each agent file includes Phase/Step 0 (Learning Injection) in its execution protocol with:
- **Purpose:** Load accumulated learnings before performing task
- **Instructions:** Specific steps for loading INDEX + conditional deep lookup
- **Token Budget:** Explicit limits for INDEX and deep lookup
- **Matching Triggers:** Domain/pattern-specific triggers for deep lookup
- **Efficiency Note:** Reminder that INDEX provides pattern awareness without full file load

**Example Triggers by Agent:**

**Clarification:**
- Technical domain + security → search "security" in clarification/heuristics.md
- Requirements gathering → load clarification/checklists.md relevant sections
- Domain-specific context → search domain tag in clarification/domain-snippets/

**Research:**
- Security research → search "security" in research/heuristics.md and research/domain-snippets/
- Technical + API → search "API" in research/domain-snippets/
- Multi-source research → load research/heuristics.md "cross-checking" related sections

**Analysis:**
- Complexity assessment → load analysis/heuristics.md decomposition patterns
- Risk analysis → search "risk" in analysis/heuristics.md
- Pattern recognition → load analysis/heuristics.md pattern-related sections

**Synthesis:**
- Integration task → load synthesis/heuristics.md integration patterns
- Contradiction resolution → search "contradiction" or "conflict" in synthesis/heuristics.md
- Framework design → load synthesis/heuristics.md framework-related sections

**Generation:**
- Code generation → load generation/heuristics.md code-related patterns
- Security-sensitive code → search "security" in generation/heuristics.md and generation/anti-patterns.md
- Specific tech stack → search technology name in generation/domain-snippets/
- TDD approach → load generation/checklists.md test-related sections

**Validation:**
- Code validation → load validation/checklists.md code quality sections
- Security validation → search "security" in validation/heuristics.md
- Documentation validation → load validation/checklists.md documentation sections

### Progressive Disclosure Pattern

**Philosophy:** Don't load what you don't need, but know what's available.

**Mechanism:**
- **INDEX** acts as a "table of contents" - always loaded, minimal tokens
- **Deep lookup** fetches specific sections only when relevant pattern detected
- Agents scan INDEX first, then decide whether to fetch full entries

This pattern ensures agents benefit from learnings without token overhead for irrelevant patterns.

## Cognitive Function Adaptation

### Cognitive Adaptation Framework

**Principles:**
- **universal_process** - Consistent method (HOW)
- **domain_adaptation** - Context-specific application (WHAT)
- **quality_standards** - Domain-appropriate criteria (STANDARDS)

**Adaptation Process:**
1. Universal process remains constant
2. Adapt evaluation criteria to domain
3. Select domain-appropriate methods

### Domain-Specific Adaptations

#### Technical Domain
- **Apply:** TDD, security patterns, SOLID principles
- **Vocabulary:** Technical vocabulary and specifications
- **Artifacts:** Code, configs, documentation

#### Personal Domain
- **Apply:** Decision frameworks, goal-setting methods
- **Vocabulary:** Empathetic, supportive language
- **Artifacts:** Plans, trackers, reflection documents

#### Creative Domain
- **Apply:** Narrative structure, artistic principles
- **Vocabulary:** Expressive, engaging language
- **Artifacts:** Content, designs, creative works

#### Professional Domain
- **Apply:** Business frameworks, strategic thinking
- **Vocabulary:** Formal, precise language
- **Artifacts:** Reports, analyses, proposals

#### Recreational Domain
- **Apply:** Fun/engagement principles
- **Vocabulary:** Casual, enthusiastic language
- **Artifacts:** Activities, games, entertainment plans

## Unknown Registry Management (Enhanced)

### Unknown Categories Expanded

**Technical Group:**
- Research, Implementation, Architecture, Requirements, Risk, Scope, Source, Interpretation, Validation, Depth, Technical, Security, Integration, Performance, Environment

**Domain-Specific:**
- **Personal:** Personal preference, values, constraints
- **Creative:** Artistic direction, style, audience
- **Professional:** Business context, stakeholders, objectives
- **Recreational:** Fun factors, participant preferences
- **Ethical:** Moral considerations, impact assessment
- **Resource:** Time, budget, availability constraints
- **Quality:** Standards, expectations, success metrics

### Resolution Strategy by Cognitive Agent

- **CLARIFICATION:** Scope, Requirements, Personal, Creative, Quality
- **RESEARCH:** Source, Research, Professional, Environment
- **ANALYSIS:** Technical, Risk, Integration, Performance, Resource
- **SYNTHESIS:** Architecture, Interpretation, Ethical
- **GENERATION:** Implementation, Creative
- **VALIDATION:** Validation, Depth, Security, Quality

## Johari Window Compression (Domain-Aware)

### Compression Guidelines

**Domain Emphasis:**
- **Technical:** Focus on architectural decisions, technical trade-offs
- **Personal:** Focus on values alignment, emotional considerations
- **Creative:** Focus on artistic choices, audience impact
- **Professional:** Focus on strategic implications, stakeholder needs
- **Recreational:** Focus on enjoyment factors, participant experience

### Token Optimization and Progressive Summarization

**Strict Limits:**
- **open:** 200-300 tokens max - core findings only
- **hidden:** 200-300 tokens max - key insights only
- **blind:** 150-200 tokens max - limitations only
- **unknown:** 150-200 tokens max - unknowns for registry
- **domain_insights:** 150-200 tokens (optional)
- **TOTAL:** 1200 tokens STRICT LIMIT

**Compression Techniques:**
- **Technical:** Focus on decisions and architecture, not narrative
- **Personal:** Focus on values and milestones
- **Creative:** Focus on creative choices and impact
- **Professional:** Focus on strategy and metrics
- **Recreational:** Focus on experience and logistics

### Progressive Summarization Protocol

**Requirement:**

After each phase completes, Penny (workflow orchestrator) MUST:
1. Compress all agent outputs from that phase into phaseHistory[N]
2. Token limit per phase summary: 500 tokens maximum
3. Agents in Phase N+1 read: compressed phaseHistory[0...N-1] + full output from immediate predecessor
4. This prevents context bloat (agents don't read all previous agent outputs)

**Phase Compression:**

#### Phase 0: Requirements
- **phaseSummary:** Requirements phase: [1-2 sentence outcome]
- **criticalDecisions:** Key decisions made (max 5)
- **keyConstraints:** Important constraints identified (max 5)
- **unresolvedUnknowns:** From Unknown Registry
- **essentialContext:**
  - **requirements:** Core requirements summary (max 100 tokens)
  - **complexity:** SIMPLE|MEDIUM|COMPLEX with justification
  - **risks:** Top 3 risks only

#### Phase 1: Research and Decisions
- **phaseSummary:** Research and decision phase: [1-2 sentence outcome]
- **criticalDecisions:** Library X selected, Pattern Y chosen
- **researchFindings:** Key findings summary (max 150 tokens)
- **unresolvedUnknowns:** Outstanding questions

**Workflow Metadata Structure:**
```xml
<task_id>task-xxx</task_id>
<currentPhase>Current phase number</currentPhase>
<phaseHistory>
  <phase>
    <phase_number>Phase number</phase_number>
    <phaseSummary>Summary of phase outcome</phaseSummary>
    <criticalDecisions>List of key decisions</criticalDecisions>
    <keyConstraints>List of constraints</keyConstraints>
    <unresolvedUnknowns>Outstanding unknowns</unresolvedUnknowns>
    <essentialContext>Context needed for future phases</essentialContext>
  </phase>
</phaseHistory>
<currentContext>
  <phase>Current phase number</phase>
  <focus>Current phase focus</focus>
  <needsFromPrevious>What is needed from previous phases</needsFromPrevious>
</currentContext>
```

**Output Compression Rules:**

#### Step Overview (max 500 words, ~750 tokens)
- **Focus:** WHAT was accomplished, not HOW
- **Reference:** Reference previous findings, don't repeat them
- **Format:** Use bullet points over paragraphs where possible

#### Johari Summary (JSON format)
- **Strict token limits:** Per quadrant limits enforced
- **No repetition:** No repetition of information in workflow metadata
- **Focus:** Focus on NEW discoveries and insights
- **Abbreviations:** Use abbreviations where clear (CRUD, API, TDD, etc.)

#### Downstream Directives (max 300 tokens)
- **Format:** List format, not prose
- **Content:** Specific actionable items only

## Output Formatting

### Three-Section Output Structure (Universal)

All agents produce:

#### Section 1: STEP OVERVIEW
- **Title:** STEP {N}: {Cognitive Function} Execution
- **Content:** Domain-adapted narrative of work performed

#### Section 2: JOHARI SUMMARY (JSON format)
- **open:** Confirmed knowledge adapted to domain
- **hidden:** Discoveries relevant to domain
- **blind:** Domain-specific gaps identified
- **unknown:** Domain-appropriate unknowns

#### Section 3: DOWNSTREAM DIRECTIVES (JSON format)
- **primaryFindings:** Key findings from this step
- **recommendedActions:** Actions for next steps
- **criticalConstraints:** Constraints to observe
- **unknownRegistryUpdates:** Updates to unknown registry

### Domain-Specific Output Adaptations

- **Technical:** Include code snippets, architecture diagrams, API specs
- **Personal:** Include decision matrices, goal alignments, reflection prompts
- **Creative:** Include creative samples, mood boards, audience profiles
- **Professional:** Include metrics, KPIs, strategic alignments
- **Recreational:** Include fun factors, engagement metrics, participant feedback

## Quality Gates (Domain-Aware)

### Universal Gate Logic

**Verification:**
- Task requirements addressed
- Unknowns resolved for this phase
- Output quality meets standards
- Context preserved for downstream

### Domain-Specific Gate Criteria

- **Technical:** Tests pass, Security validated, Performance acceptable
- **Personal:** Values aligned, Constraints respected, Wellbeing considered
- **Creative:** Audience appropriate, Creative vision clear, Quality acceptable
- **Professional:** Business case valid, Stakeholders considered, ROI positive
- **Recreational:** Fun factor high, Participants accommodated, Safety ensured

## Error Handling and Recovery

### Cognitive Function Failures

When agent cannot complete cognitive function:
1. Document specific failure in Johari "blind" section
2. Add to Unknown Registry with resolution_phase
3. Suggest alternative cognitive path
4. Request orchestrator intervention if critical

### Domain Adaptation Failures

When domain unclear or hybrid:
1. Default to most conservative domain
2. Document ambiguity in output
3. Request CLARIFICATION agent intervention
4. Apply multiple domain criteria if needed

## Inter-Agent Communication

### Context Handoff Protocol

Agents explicitly pass (JSON format):
- **taskDomain:** Identified domain
- **domainConfidence:** CERTAIN|PROBABLE|POSSIBLE
- **keyFindings:** Domain-specific discoveries
- **nextAgentContext:**
  - **focusAreas:** What next agent should prioritize
  - **constraints:** Domain-specific limitations
  - **standards:** Quality criteria to apply

### Cognitive Function Chaining

**Typical sequences by domain:**
- **Technical:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION
- **Personal:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION
- **Creative:** CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION → VALIDATION
- **Professional:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → VALIDATION
- **Recreational:** CLARIFICATION → RESEARCH → GENERATION → VALIDATION

## Protocol Validation Checklist

Before completing work, EVERY agent verifies:

- Task-ID extracted successfully
- Task domain identified (confidence level documented)
- Workflow context fully loaded
- Previous agent outputs integrated
- Unknown Registry checked and updates proposed
- Cognitive function adapted to domain
- Quality standards applied appropriately
- Johari Summary compressed effectively
- Downstream Directives complete
- Output formatted correctly
- Gate criteria satisfied
- Context preserved for next agent

## Critical Success Factors

- **domain_identification:** Correctly identify task domain early
- **cognitive_consistency:** Apply universal process regardless of domain
- **context_adaptation:** Adjust WHAT not HOW based on domain
- **quality_maintenance:** Apply domain-appropriate standards
- **token_efficiency:** Compress intelligently while preserving critical context
- **handoff_clarity:** Next agent receives sufficient context to adapt

## Quick Reference

### Agent Invocation Always Includes:
- Task-ID
- Step number and name
- Purpose statement
- Gate entry/exit criteria
- Context files to read
- Previous agent dependencies

### Agent Always Produces:
- Step Overview (narrative)
- Johari Summary (JSON)
- Downstream Directives (JSON)
- Unknown Registry updates
- Task domain classification
- Quality validation results

### Memory File Locations:
- **Workflow metadata:** `task-{id}-memory.md`
- **Agent outputs:** `task-{id}-{agent}-memory.md`
- **Directory:** `.claude/memory/`

## Conclusion

This protocol ensures cognitive domain agents can handle ANY task while maintaining quality and consistency.
