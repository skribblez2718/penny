# Agent Registry

## Metadata

- **Title:** Agent Registry
- **Purpose:** Catalog of existing cognitive agents - 7 universal agents that handle all task workflows through domain-adaptive cognitive processing
- **Description:** The PAI system uses 7 cognitive-domain agents that adapt to ANY task context rather than specialized agents for specific workflows. Each agent represents a fundamental cognitive function and adjusts its approach based on the domain (technical, personal, creative, professional, recreational).

## Agents

### RESEARCH AGENTS

Agents that discover and gather information from external sources

#### research

- **Cognitive Function:** RESEARCH
- **Description:** Systematic information discovery and evaluation across any domain
- **Invocation Triggers:**
  - At the start of complex tasks requiring foundational knowledge gathering
  - When encountering knowledge gaps
  - Before technical decisions
  - When evaluating options
  - After CLARIFICATION identifies information gaps
- **Adaptation:** Adapts research methodology to context while maintaining consistent source evaluation and pattern identification

### ANALYSIS AGENTS

Agents that examine existing information to identify patterns, issues, or insights

#### analysis

- **Cognitive Function:** ANALYSIS
- **Description:** Decomposes complex information, evaluates patterns, assesses risks, and analyzes dependencies across any domain
- **Invocation Triggers:**
  - After research/information gathering is complete but before synthesis or solution generation
- **Methods:**
  - Decomposition
  - Dependency mapping
  - Complexity assessment
  - Risk identification
- **Adaptation:** Applies universal analytical methods with domain-adaptive evaluation criteria

### SYNTHESIS AGENTS

Agents that combine multiple information sources into coherent understanding

#### synthesis

- **Cognitive Function:** SYNTHESIS
- **Description:** Integrates multiple sources of information, requirements, or constraints into unified designs, frameworks, or solutions
- **Capabilities:**
  - Creates system architectures from requirements + patterns + constraints
  - Resolves contradictions between conflicting requirements
  - Builds frameworks that combine disparate concepts
  - Designs solutions satisfying multiple competing constraints
- **Adaptation:** Context-driven integration with consistent synthesis methodology

### GENERATION AGENTS

Agents that create new artifacts, plans, specifications, or implementations

#### generation

- **Cognitive Function:** GENERATION
- **Description:** Creates new artifacts from specifications, requirements, or synthesis outputs
- **Generates:**
  - Code implementations
  - Documentation
  - Plans
  - Creative content
  - Any deliverable requiring building something new from defined requirements
- **Quality Standards:**
  - **Code domain:** Applies TDD principles
  - **All domains:** Follows style guides and security patterns
  - **All domains:** Adapts quality standards to domain while maintaining consistent creation processes

### VALIDATION AGENTS

Agents that verify correctness, completeness, or compliance

#### validation

- **Cognitive Function:** VALIDATION
- **Description:** Systematically verifies artifacts, deliverables, or decisions against established criteria, requirements, or quality standards
- **Invocation Triggers:**
  - After code is written
  - After configurations created
  - After documentation drafted
  - When evaluating choices
  - Before finalizing deliverables
  - As quality gates
- **Approach:**
  - Applies domain-appropriate validation frameworks
  - Objective pass/fail determinations
  - Actionable remediation guidance

### METACOGNITION AGENTS

Agents that monitor workflow state and detect progress issues

#### memory (formerly memory)

- **Cognitive Function:** METACOGNITION
- **Description:** Metacognitive monitor that tracks problem state, detects impasses, and suggests remediation strategies. Invoked AFTER each agent execution and at skill phase transitions. Can also be explicitly invoked via orchestrate-memory atomic skill.
- **Invocation Triggers:**
  - After every cognitive agent completes (via common_complete.py)
  - At skill phase transitions (via advance_phase.py)
  - Explicitly via orchestrate-memory when additional assessment is beneficial
- **Capabilities:**
  - Progress assessment against expected outcomes
  - Impasse detection (CONFLICT, MISSING-KNOWLEDGE, TIE, NO-CHANGE)
  - Remediation recommendation based on impasse type
  - Johari Window tracking (Open, Hidden, Blind, Unknown)
- **Key Difference from validation:**
  - validation: "Does output meet quality criteria?" (quality judgment)
  - memory: "Is workflow making progress?" (state tracking + impasse detection)
- **Impasse Response Matrix:**
  - CONFLICT: Invoke orchestrate-clarification or escalate to user
  - MISSING-KNOWLEDGE: Invoke orchestrate-research or create Unknown entries
  - TIE: Invoke orchestrate-analysis or escalate to user
  - NO-CHANGE: Re-invoke same agent with enhanced context

### CLARIFICATION AGENTS

Agents that resolve ambiguities and transform vague inputs into explicit outputs

#### clarification

- **Cognitive Function:** CLARIFICATION
- **Description:** Transforms vague, ambiguous, incomplete, or underspecified user inputs into actionable specifications through systematic Socratic questioning
- **Invocation Triggers:**
  - Proactively when user requests lack critical details
  - When requests have missing specifications
  - When success criteria need to be defined
- **Capabilities:**
  - Detects ambiguity
  - Surfaces assumptions
  - Discovers constraints
  - Reveals unknown unknowns
  - Produces precise specifications with clear acceptance criteria

## Cognitive Architecture Principles

### Domain Adaptation, Not Domain Specialization

- Each agent has ONE cognitive function (research, analysis, synthesis, generation, validation, clarification, metacognition)
- Agents receive domain context (technical/personal/creative/professional/recreational) and adapt their approach
- Same agent handles authentication systems AND life decisions by adapting vocabulary, sources, and criteria
- **Benefit:** Enables handling novel tasks without creating new agents

### Universal Processing with Context-Driven Outputs

- Cognitive processes remain consistent (how to research, analyze, synthesize, etc.)
- Evaluation criteria, vocabulary, and quality standards adapt to task domain
- **Technical domain:** Technical rigor, security standards, performance metrics
- **Personal domain:** Lifestyle impacts, value alignment, personal growth
- **Creative domain:** Audience engagement, thematic coherence, emotional impact

### Workflow Orchestration

- Skills orchestrate cognitive agents in sequences appropriate to task complexity
- **Standard sequence:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION
- CLARIFICATION invoked proactively when ambiguity detected
- Each agent receives full context from predecessors via memory files

## Usage Guidelines

### Selecting Agent

**Question:** What cognitive function do I need?

**Mappings:**
- **Need to gather information?** → research
- **Need to break down complexity?** → analysis
- **Need to integrate findings into design?** → synthesis
- **Need to create deliverables?** → generation
- **Need to verify quality?** → validation
- **Need to clarify requirements?** → clarification

### Invoking Agents

1. Identify required cognitive function from task requirements
2. Provide domain context (technical/personal/creative/professional/recreational)
3. Specify task-specific quality standards and constraints
4. Reference memory files from previous workflow steps
5. Agent adapts its cognitive process to domain while maintaining quality

### When to Use

**Use Cognitive Agents:**
- Task requires that specific cognitive function
- Multi-step workflows need that cognitive phase
- Quality benefits from specialized cognitive processing

**Use Direct Execution:**
- Task is trivial and doesn't require specialized cognitive processing
- Single tool use is sufficient (read a file, run a command)
- Overhead of agent invocation exceeds value

### Agent Creation Policy

**DO NOT CREATE NEW AGENTS UNLESS:**
- A fundamental cognitive function is missing from the 7 existing agents
- Proposed agent would handle a distinct cognitive domain (beyond research/analysis/synthesis/generation/validation/clarification/metacognition)
- Agent would be reusable across 5+ different workflow types with only context changes

## Agent Relationships

### Standard Cognitive Workflow

**Sequence:**

1. **clarification** → Output: Precise specifications, explicit constraints, clear acceptance criteria
2. **research** (Input: Clarified specifications) → Output: Discovered information, evaluated sources, identified patterns
3. **analysis** (Input: Research findings) → Output: Decomposed complexity, mapped dependencies, assessed risks
4. **synthesis** (Input: Analysis results) → Output: Integrated design, unified framework, resolved contradictions
5. **generation** (Input: Synthesis outputs) → Output: Created artifacts, implemented solutions, generated deliverables
6. **validation** (Input: Generated artifacts) → Output: Verified quality, validated compliance, identified issues

### Iterative Refinement

**VALIDATION failures trigger GENERATION refinement or SYNTHESIS redesign:**

- **Minor issues found:** validation returns to generation
- **Design flaws found:** validation returns to synthesis

### Proactive Clarification

**Any agent can invoke CLARIFICATION when ambiguity detected:**

- **Trigger:** any agent
- **Invokes:** clarification
- **Condition:** Missing specifications, contradictory requirements, unclear constraints

## Domain Adaptation Notes

### Technical Domain
- **Focus:** Code quality, security patterns, performance metrics, test coverage
- **Artifacts:** Source code, tests, documentation, configuration files
- **Standards:** TDD, OWASP, style guides, API contracts

### Personal Domain
- **Focus:** Value alignment, life balance, personal growth, wellbeing
- **Artifacts:** Plans, schedules, decision matrices, habit trackers
- **Standards:** Actionable, realistic, human factors considered

### Creative Domain
- **Focus:** Audience engagement, narrative coherence, emotional impact, originality
- **Artifacts:** Content, stories, designs, presentations
- **Standards:** Voice consistency, clarity, creative brief alignment

### Professional Domain
- **Focus:** Business value, strategic alignment, stakeholder needs, ROI
- **Artifacts:** Reports, proposals, analyses, strategies
- **Standards:** Data-driven, executive summaries, professional tone

### Recreational Domain
- **Focus:** Fun, engagement, inclusivity, memorable experiences
- **Artifacts:** Event plans, game designs, entertainment materials
- **Standards:** Accessible, clear instructions, participant satisfaction

### Hybrid Domain
- **Focus:** Multiple domains weighted and integrated
- **Artifacts:** Domain-specific artifacts combined
- **Standards:** All relevant domain standards applied appropriately

## Related Documents

- **Path:** `${CAII_DIRECTORY}/.claude/docs/cognitive-function-taxonomy.md`
- **Description:** Cognitive function definitions
