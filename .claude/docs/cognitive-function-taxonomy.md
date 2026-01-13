COGNITIVE FUNCTION TAXONOMY

A classification system for agent capabilities based on COGNITIVE FUNCTION rather than domain or workflow position. Enables agent reusability across workflows and prevents agent proliferation.

PURPOSE

This taxonomy defines eight cognitive functions in the system. When creating an agent, assign it EXACTLY ONE cognitive function. This enforces the Single Cognitive Responsibility Principle (SCRP) and enables context-driven specialization where workflows provide domain context to general-purpose cognitive capabilities.

TAXONOMY OVERVIEW

**Seven agent-based functions (invoked via orchestrate-* skills):**
1. RESEARCHER - Discovers and gathers information from external sources
2. ANALYZER - Examines existing information to identify patterns, issues, or insights
3. SYNTHESIZER - Combines multiple information sources into coherent understanding
4. GENERATOR - Creates new artifacts, plans, or specifications
5. VALIDATOR - Verifies correctness, completeness, or compliance
6. CLARIFIER - Resolves ambiguities and transforms vague inputs into explicit outputs
7. METACOGNITION - Monitors progress, detects impasses (memory agent)

**Special function:**
8. COORDINATOR - Manages workflow state, tracks progress (performed by the orchestrator)

---

COGNITIVE FUNCTION 1: RESEARCHER

DEFINITION

Discovers and gathers information from external sources. Executes search queries, fetches documentation, explores codebases, and retrieves authoritative references. Does NOT analyze or synthesize findings - only collects and organizes raw information.

CHARACTERISTICS

- Information ACQUISITION not interpretation
- Broad search coverage across multiple sources
- Documentation of source provenance (URLs, timestamps, authority)
- Raw data collection with minimal filtering
- Query optimization and search strategy execution

TYPICAL TOOLS

- WebSearch: Broad information gathering
- WebFetch: Specific documentation retrieval
- Grep: Codebase keyword search
- Glob: File pattern discovery
- Read: Documentation extraction

USAGE GUIDELINES

Use RESEARCHER when:
- Task requires external information not in task memory
- Multiple sources must be consulted for comprehensive coverage
- Authoritative documentation must be retrieved
- Codebase exploration is needed before analysis

Do NOT use RESEARCHER for:
- Analyzing gathered information (use ANALYZER)
- Combining sources into synthesis (use SYNTHESIZER)
- Making decisions based on findings (use CLARIFIER or GENERATOR)

---

COGNITIVE FUNCTION 2: ANALYZER

DEFINITION

Examines existing information to identify patterns, issues, risks, or insights. Operates on information already in task memory or provided by previous steps. Does NOT gather new external information or create new artifacts - only interprets what exists.

CHARACTERISTICS

- Works with EXISTING information from task memory
- Pattern recognition and issue identification
- Risk assessment and impact evaluation
- Dependency mapping and constraint discovery
- No external information gathering (delegates to RESEARCHER if needed)

TYPICAL TOOLS

- Read: Access task memory and project files
- Grep: Search for patterns in codebase
- Glob: Identify file relationships
- AskUserQuestion: Clarify analysis scope or priorities

USAGE GUIDELINES

Use ANALYZER when:
- Information exists but needs interpretation
- Patterns or issues must be identified
- Risk assessment is required
- Dependencies or constraints must be mapped

Do NOT use ANALYZER for:
- Gathering information (use RESEARCHER)
- Creating plans or specifications (use GENERATOR)
- Validating correctness (use VALIDATOR)

---

COGNITIVE FUNCTION 3: SYNTHESIZER

DEFINITION

Combines multiple information sources into coherent understanding. Cross-references findings, resolves conflicts, identifies knowledge gaps, and produces integrated analysis. Bridges RESEARCHER output and downstream decision-making.

CHARACTERISTICS

- Multi-source integration and cross-referencing
- Conflict resolution between contradictory sources
- Gap identification (what's missing from gathered information)
- Coherent narrative construction from disparate inputs
- Authority weighting (prioritizing official docs over blog posts)

TYPICAL TOOLS

- Read: Access multiple research outputs from task memory
- Edit: Update task memory with synthesized analysis
- AskUserQuestion: Resolve conflicts when sources disagree

USAGE GUIDELINES

Use SYNTHESIZER when:
- Multiple information sources need integration
- Research phase is complete but findings are scattered
- Conflicts between sources must be resolved
- Coherent understanding must be constructed before decision-making

Do NOT use SYNTHESIZER for:
- Initial information gathering (use RESEARCHER)
- Creating plans from synthesis (use GENERATOR)
- Final validation (use VALIDATOR)

---

COGNITIVE FUNCTION 4: GENERATOR

DEFINITION

Creates new artifacts, plans, specifications, or implementations. Produces concrete deliverables based on requirements, analysis, or synthesis from previous steps. Does NOT validate its own output - delegates to VALIDATOR.

CHARACTERISTICS

- Artifact creation (code, plans, specifications, designs)
- Template application and customization
- Design decision implementation
- Concrete deliverable production
- Self-reflection during generation but formal validation delegated

TYPICAL TOOLS

- Write: Create new files (code, specs, documentation)
- Edit: Modify existing files during implementation
- Read: Reference requirements and context
- Bash: Execute build commands, run generators

USAGE GUIDELINES

Use GENERATOR when:
- New artifacts must be created (code, plans, specs)
- Requirements exist and design decisions must be implemented
- References must be instantiated with project-specific content
- Architecture or implementation must be specified

Do NOT use GENERATOR for:
- Gathering information first (use RESEARCHER)
- Analyzing requirements (use ANALYZER)
- Validating created artifacts (use VALIDATOR)

---

COGNITIVE FUNCTION 5: VALIDATOR

DEFINITION

Verifies correctness, completeness, compliance, or quality of artifacts produced by previous steps. Checks against specifications, standards, or requirements. Categorizes issues by severity and determines workflow continuation or remediation loops.

CHARACTERISTICS

- Verification against explicit criteria (specs, standards, requirements)
- Issue categorization by severity (CRITICAL/HIGH/MEDIUM/LOW)
- Compliance checking (WCAG, security standards, coding standards)
- Completeness assessment (all requirements addressed)
- Workflow gating decisions (proceed vs remediate)

TYPICAL TOOLS

- Read: Access artifacts to validate and requirements to verify against
- Bash: Execute tests, linters, security scanners
- Playwright MCP: Browser-based validation for UI/UX
- AskUserQuestion: Escalate blocking issues or ambiguous failures

EXAMPLES

- accessibility-auditor: Verifies WCAG 2.2 Level AA compliance
- security-review: Validates implementation security before deployment
- design-validator: Tests UI designs against strategy and accessibility standards

USAGE GUIDELINES

Use VALIDATOR when:
- Artifacts exist and need verification
- Compliance with standards must be checked
- Test execution and result interpretation required
- Workflow gating decision needed (proceed vs fix)

Do NOT use VALIDATOR for:
- Creating the artifacts being validated (use GENERATOR)
- Fixing identified issues (return to appropriate generator)
- Initial requirements analysis (use ANALYZER or CLARIFIER)

---

COGNITIVE FUNCTION 6: CLARIFIER

DEFINITION

Resolves ambiguities and transforms vague inputs into explicit, testable outputs. Identifies unclear requirements, interacts with users to gather specifications, and produces concrete acceptance criteria. Bridges vague user intent and actionable downstream work.

CHARACTERISTICS

- Ambiguity detection in requirements or specifications
- User interaction to resolve uncertainties
- Transformation of vague language into explicit criteria
- Test case generation from clarified requirements
- Assumption documentation and validation

TYPICAL TOOLS

- AskUserQuestion: Resolve ambiguities via user interaction
- Read: Extract requirements from task memory
- Edit: Update task memory with clarified specifications

USAGE GUIDELINES

Use CLARIFIER when:
- Requirements are vague or ambiguous
- User intent needs specification before implementation
- Acceptance criteria must be defined
- Assumptions need explicit validation

Do NOT use CLARIFIER for:
- Gathering external information (use RESEARCHER)
- Creating plans from clear requirements (use GENERATOR)
- Validating implemented artifacts (use VALIDATOR)

---

COGNITIVE FUNCTION 7: COORDINATOR

DEFINITION

Manages workflow state, tracks progress, orchestrates step transitions, and handles deliverable finalization. Does NOT perform domain work - delegates to specialized cognitive functions. Ensures workflow integrity and completion.

NOTE: This function is performed by the master orchestrator, not a separate agent.

CHARACTERISTICS

- Workflow state management and progress tracking
- Step transition orchestration
- Deliverable aggregation and presentation
- Completion signal generation
- No domain-specific work (pure orchestration)

TYPICAL TOOLS

- Read: Access task memory to assess workflow state
- Edit: Update workflow metadata and state markers
- TodoWrite: Track multi-step progress
- AskUserQuestion: Confirm workflow completion or handle user decisions

USAGE GUIDELINES

The orchestrator performs COORDINATOR functions implicitly:
- Determining which cognitive functions are needed
- Sequencing agent invocations with proper context handoffs
- Managing workflow state across phases
- Ensuring quality gates are respected
- Surfacing and resolving unknown unknowns

---

COGNITIVE FUNCTION 8: METACOGNITION

DEFINITION

Monitors problem-solving state, detects impasses, and suggests remediation strategies. Operates as a metacognitive layer that observes workflow progress without performing task work. Automatically invoked by the orchestration layer.

NOTE: This function is performed by memory agent, which is AUTOMATICALLY invoked after each agent completion and at phase transitions. It is NOT directly invoked by the orchestrator.

CHARACTERISTICS

- Progress assessment against expected outcomes
- Impasse detection using four types (CONFLICT, MISSING-KNOWLEDGE, TIE, NO-CHANGE)
- Remediation recommendations (re-invoke, escalate, continue)
- Johari Window tracking (what became known, what emerged as unknown)
- Pure observation - never executes task work

IMPASSE TYPES

- CONFLICT: Contradictory requirements or constraints → Invoke clarification or escalate
- MISSING-KNOWLEDGE: Required information is absent → Invoke research
- TIE: Multiple valid options, no criteria to choose → Invoke analysis or escalate
- NO-CHANGE: Agent output shows no meaningful progress → Re-invoke with enhanced context

INVOCATION PATTERN

Memory agent is invoked via Python orchestration:
- After each agent completes: common_complete.py
- At phase transitions: advance_phase.py

Do NOT directly invoke memory agent - it is automatically triggered by the orchestration layer.

---

ASSIGNMENT GUIDELINES

When creating an agent, follow this decision process:

STEP 1: Identify Primary Activity

What does the agent PRIMARILY do?
- Gathers information → RESEARCHER candidate
- Examines existing information → ANALYZER candidate
- Combines multiple sources → SYNTHESIZER candidate
- Creates new artifacts → GENERATOR candidate
- Verifies correctness → VALIDATOR candidate
- Resolves ambiguities → CLARIFIER candidate
- Manages workflow state → COORDINATOR (orchestrator's role, not a separate agent)
- Monitors progress/detects impasses → METACOGNITION (memory agent, automatic)

STEP 2: Apply Single Cognitive Responsibility Principle (SCRP)

If agent performs multiple cognitive functions:
- Split into separate agents (e.g., research-gatherer + research-synthesizer)
- Or identify the PRIMARY function and delegate others

Example:
- Agent that "gathers info AND analyzes it" → Split into RESEARCHER + ANALYZER
- Agent that "creates plan AND validates it" → Split into GENERATOR + VALIDATOR

STEP 3: Validate with Reusability Test

Can this agent be reused in 3+ different workflows with only context changes?

If NO → Scope is too domain-specific or contains multiple cognitive functions
If YES → Cognitive function correctly identified

STEP 4: Check Tool Alignment

Does agent's tool list match typical tools for cognitive function?

RESEARCHER tools mismatch example:
- Uses Write to create specs → Should be GENERATOR, not RESEARCHER

ANALYZER tools mismatch example:
- Uses WebSearch extensively → Should be RESEARCHER, not ANALYZER

---

ANTI-PATTERNS

ANTI-PATTERN 1: Multi-Function Agent

```
Bad: research-and-analyze agent
- Gathers sources via WebSearch (RESEARCHER)
- Analyzes patterns in findings (ANALYZER)
- Creates recommendations (GENERATOR)
```

CORRECT: Separate agents with single cognitive functions

```
Good:
- information-gatherer (RESEARCHER)
- data-analyzer (ANALYZER)
- plan-generator (GENERATOR)
```

ANTI-PATTERN 2: Domain-Specific Function Names

```
Bad: "oauth-implementer" cognitive function
```

CORRECT: Map to general cognitive function

```
Good: GENERATOR (creates OAuth implementation)
```

The cognitive function is GENERATOR - domain (OAuth) comes from workflow context, not agent definition.

ANTI-PATTERN 3: Validation in Generator

```
Bad: code-generator that writes code AND runs tests to validate
```

CORRECT: Separate generation from validation

```
Good:
- code-generator (GENERATOR) - creates implementation
- test-runner-validator (VALIDATOR) - verifies correctness
```

---

COGNITIVE FUNCTION COMBINATIONS IN WORKFLOWS

Workflows orchestrate multiple cognitive functions in sequence:

TYPICAL WORKFLOW PATTERN 1: Research → Synthesis → Generation

1. RESEARCHER: Gathers external information
2. SYNTHESIZER: Integrates findings into coherent understanding
3. GENERATOR: Creates plan/design/implementation
4. VALIDATOR: Verifies output quality

TYPICAL WORKFLOW PATTERN 2: Clarification → Analysis → Planning

1. CLARIFIER: Resolves requirement ambiguities
2. ANALYZER: Examines codebase context and dependencies
3. GENERATOR: Creates implementation plan
4. VALIDATOR: Reviews plan completeness

TYPICAL WORKFLOW PATTERN 3: Generation → Validation Loop

1. GENERATOR: Creates artifact
2. VALIDATOR: Checks correctness
3. IF issues found → Return to GENERATOR (remediation loop)
4. IF validation passes → COORDINATOR (finalize deliverables)

---

RELATED DOCUMENTS

- ${CAII_DIRECTORY}/.claude/docs/agent-registry.md - Catalog of existing agents by cognitive function
- ${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/ - Input/output contracts
