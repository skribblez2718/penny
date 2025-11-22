AGENT REGISTRY

Catalog of existing cognitive agents. Use this registry to discover the 6 universal agents that handle all task workflows through domain-adaptive cognitive processing.

PURPOSE

The PAI system uses 6 cognitive-domain agents that adapt to ANY task context rather than specialized agents for specific workflows. Each agent represents a fundamental cognitive function and adjusts its approach based on the domain (technical, personal, creative, professional, recreational).

---

RESEARCH AGENTS

Agents that discover and gather information from external sources.

- research-discovery: Systematic information discovery and evaluation across any domain. Invoked at the start of complex tasks requiring foundational knowledge gathering, when encountering knowledge gaps, before technical decisions, when evaluating options, or after CLARIFICATION identifies information gaps. Adapts research methodology to context while maintaining consistent source evaluation and pattern identification.

---

ANALYSIS AGENTS

Agents that examine existing information to identify patterns, issues, or insights.

- analysis-agent: Decomposes complex information, evaluates patterns, assesses risks, and analyzes dependencies across any domain. Invoked after research/information gathering is complete but before synthesis or solution generation. Applies universal analytical methods (decomposition, dependency mapping, complexity assessment, risk identification) with domain-adaptive evaluation criteria.

---

SYNTHESIS AGENTS

Agents that combine multiple information sources into coherent understanding.

- synthesis-agent: Integrates multiple sources of information, requirements, or constraints into unified designs, frameworks, or solutions. Creates system architectures from requirements + patterns + constraints, resolves contradictions between conflicting requirements, builds frameworks that combine disparate concepts, designs solutions satisfying multiple competing constraints. Context-driven integration with consistent synthesis methodology.

---

GENERATION AGENTS

Agents that create new artifacts, plans, specifications, or implementations.

- generation-agent: Creates new artifacts from specifications, requirements, or synthesis outputs. Generates code implementations, documentation, plans, creative content, or any deliverable requiring building something new from defined requirements. Applies TDD principles for code, follows style guides and security patterns, adapts quality standards to domain while maintaining consistent creation processes.

---

VALIDATION AGENTS

Agents that verify correctness, completeness, or compliance.

- quality-validator: Systematically verifies artifacts, deliverables, or decisions against established criteria, requirements, or quality standards. Used after code is written, configurations created, documentation drafted; when evaluating choices; before finalizing deliverables; as quality gates. Applies domain-appropriate validation frameworks with objective pass/fail determinations and actionable remediation guidance.

---

CLARIFICATION AGENTS

Agents that resolve ambiguities and transform vague inputs into explicit outputs.

- clarification-specialist: Transforms vague, ambiguous, incomplete, or underspecified user inputs into actionable specifications through systematic Socratic questioning. Invoked proactively when user requests lack critical details, have missing specifications, or need success criteria defined. Detects ambiguity, surfaces assumptions, discovers constraints, reveals unknown unknowns, produces precise specifications with clear acceptance criteria.

---

COGNITIVE ARCHITECTURE PRINCIPLES

DOMAIN ADAPTATION, NOT DOMAIN SPECIALIZATION:
- Each agent has ONE cognitive function (research, analysis, synthesis, generation, validation, clarification)
- Agents receive domain context (technical/personal/creative/professional/recreational) and adapt their approach
- Same agent handles authentication systems AND life decisions by adapting vocabulary, sources, and criteria
- This enables handling novel tasks without creating new agents

UNIVERSAL PROCESSING WITH CONTEXT-DRIVEN OUTPUTS:
- Cognitive processes remain consistent (how to research, analyze, synthesize, etc.)
- Evaluation criteria, vocabulary, and quality standards adapt to task domain
- Technical tasks → technical rigor, security standards, performance metrics
- Personal tasks → lifestyle impacts, value alignment, personal growth
- Creative tasks → audience engagement, thematic coherence, emotional impact

WORKFLOW ORCHESTRATION:
- Skills orchestrate cognitive agents in sequences appropriate to task complexity
- Standard sequence: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION
- CLARIFICATION invoked proactively when ambiguity detected
- Each agent receives full context from predecessors via memory files

---

USAGE GUIDELINES

SELECTING THE RIGHT AGENT:

Ask: "What cognitive function do I need?"
- Need to gather information? → research-discovery
- Need to break down complexity? → analysis-agent
- Need to integrate findings into design? → synthesis-agent
- Need to create deliverables? → generation-agent
- Need to verify quality? → quality-validator
- Need to clarify requirements? → clarification-specialist

INVOKING AGENTS:

1. Identify required cognitive function from task requirements
2. Provide domain context (technical/personal/creative/professional/recreational)
3. Specify task-specific quality standards and constraints
4. Reference memory files from previous workflow steps
5. Agent adapts its cognitive process to domain while maintaining quality

WHEN TO USE DIRECT EXECUTION VS. AGENTS:

Use cognitive agents when:
- Task requires that specific cognitive function
- Multi-step workflows need that cognitive phase
- Quality benefits from specialized cognitive processing

Use direct execution when:
- Task is trivial and doesn't require specialized cognitive processing
- Single tool use is sufficient (read a file, run a command)
- Overhead of agent invocation exceeds value

DO NOT CREATE NEW AGENTS UNLESS:
- A fundamental cognitive function is missing from the 6 existing agents
- Proposed agent would handle a distinct cognitive domain (beyond research/analysis/synthesis/generation/validation/clarification)
- Agent would be reusable across 5+ different workflow types with only context changes

---

RELATED DOCUMENTS

- .claude/docs/cognitive-function-taxonomy.md - Cognitive function definitions
