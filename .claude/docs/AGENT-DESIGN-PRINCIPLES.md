AGENT DESIGN PRINCIPLES FOR PENNY

PURPOSE

This document codifies agent design principles for Penny's architecture, translating research-validated best practices (144+ sources) into Penny-specific guidelines. These principles prevent common anti-patterns (agent proliferation, scope creep, tight coupling) while maintaining alignment with Penny's core philosophy.

---

PRINCIPLE 1: SINGLE COGNITIVE RESPONSIBILITY (SCRP)

DEFINITION

Each agent performs ONE cognitive function across any domain, not one task within one domain.

IMPLEMENTATION

Cognitive Function, Not Domain:
- GOOD: requirements-clarifier (clarifies requirements across all domains)
- BAD: web-requirements-clarifier (domain-specific, limits reusability)

Cognitive Function, Not Technology:
- GOOD: code-generator (generates code in any language with context)
- BAD: python-code-generator (technology-specific, creates proliferation)

Cognitive Function, Not Workflow Position:
- GOOD: architecture-analyzer (analyzes architecture at any phase)
- BAD: phase-3-architecture-agent (workflow-specific, breaks reusability)

VALIDATION TEST

Can this agent be described in ONE sentence using ONE verb?
- "This agent CLARIFIES requirements" → PASS
- "This agent clarifies requirements AND designs architecture" → FAIL (two functions)

EXAMPLES IN PENNY

VALID Single Cognitive Responsibility:
```
requirements-clarifier: Transforms vague requirements into explicit acceptance criteria
  - Cognitive function: Clarification (resolving ambiguity)
  - Reusable across: web apps, CLI tools, MCP servers, research projects
  - Does NOT: Design architecture, generate code, validate requirements
```

INVALID Multiple Responsibilities:
```
requirements-and-design-agent: Clarifies requirements and creates architecture
  - RED FLAG: Two cognitive functions (clarification + synthesis)
  - Should be: requirements-clarifier + architecture-designer (two agents)
```

---

PRINCIPLE 2: CONTEXT-DRIVEN SPECIALIZATION

DEFINITION

Specialization comes from context injection (skills, Step Context), not agent definition. Agent capabilities remain constant; context determines application.

IMPLEMENTATION

Skills Provide Specialization:
```
code-generator (general capability, workflow-agnostic)
  + web-development-skill (context: React patterns, REST APIs, responsive design)
  + cli-tool-skill (context: argument parsing, --help flags, installation)
  = Specialized behavior without separate agents
```

Step Context Provides Framing:
```
Task ID: task-feature-abc
Step: 2
Step Name: Requirements Clarification
Purpose: Convert initial feature requests into explicit acceptance criteria
Gate Entry: Phase 1 documentation gathering completed
Gate Exit: All features have explicit acceptance criteria with test cases

[Agent uses this context to specialize its general clarification capability
to the specific needs of this recipe app without being a recipe-app-specific agent]
```

Agent Remains Workflow-Agnostic:
- Agent description uses {step-name} placeholders, not hardcoded phases
- Agent reads context from memory file, doesn't assume workflow structure
- Agent coordination through Downstream Directives, not hardcoded next steps

VALIDATION TEST

Does agent description reference ANY specific:
- Workflow name? (develop-agent, develop-skill) → FAIL
- Technology? (React, PostgreSQL, Python) → FAIL
- Domain? (web development, CLI tools) → FAIL

If YES to any: Agent is over-specialized, redesign for context-driven approach.

EXAMPLES IN PENNY

CORRECT Context-Driven Design:
```
architecture-analyzer:
  Purpose: Evaluates architectural patterns and identifies optimal approaches

  Used in web-development-skill:
    - Context: MVC patterns, REST API design, database normalization
    - Analyzes: Component structure, API boundaries, data flow

  Used in cli-tool-skill:
    - Context: Command patterns, plugin architecture, configuration management
    - Analyzes: Argument parsing strategy, extensibility, installation approach

  Same agent, different context = specialized behavior
```

INCORRECT Domain-Specific Design:
```
web-architecture-analyzer:
  Purpose: Evaluates web application architectures
  Problem: Only works for web apps, creates need for cli-architecture-analyzer,
           mcp-architecture-analyzer, etc. (agent proliferation)
```

---

PRINCIPLE 3: CAPABILITY TAXONOMY ALIGNMENT

DEFINITION

Agent boundaries map to fundamental cognitive operations, not technical domains. Organize agents by WHAT thinking they do, not WHAT artifacts they produce.

RECOMMENDED TAXONOMY

Penny adopts these cognitive functions as GUIDANCE (not rigid enforcement):

1. RESEARCHER: Information gathering, source evaluation, knowledge retrieval
   - External information discovery
   - Source credibility assessment
   - Knowledge gap identification

2. ANALYZER: Decomposition, pattern identification, evaluation, diagnosis
   - Breaking complex structures into components
   - Identifying patterns and anti-patterns
   - Quality assessment against criteria

3. SYNTHESIZER: Integration, composition, connection-building, unification
   - Combining disparate information into coherent whole
   - Resolving contradictions between sources
   - Creating unified designs or narratives

4. GENERATOR: Creative production, artifact creation, solution formulation
   - Code generation
   - Content creation
   - Design production

5. VALIDATOR: Verification, testing, quality assurance, compliance checking
   - Correctness verification
   - Completeness checking
   - Standards compliance testing

6. CLARIFIER: Ambiguity resolution, assumption validation, requirement negotiation
   - Identifying unclear specifications
   - Resolving ambiguities through user interaction
   - Confirming implicit assumptions

7. COORDINATOR: Workflow orchestration, dependency management, gate validation
   - Multi-step process management
   - Agent coordination
   - Workflow state tracking

FLEXIBILITY

New cognitive functions may emerge. Taxonomy is DESCRIPTIVE (documents existing patterns) not PRESCRIPTIVE (forces agents into categories).

If agent doesn't fit existing categories:
1. First: Re-examine if it's truly single cognitive function
2. If yes and genuinely novel: Document as new cognitive function category
3. Update taxonomy to reflect discovered pattern

VALIDATION TEST

Can this agent's cognitive function be explained without mentioning:
- Specific outputs? (code, documents, designs) → Should focus on THINKING
- Specific inputs? (requirements, code, data) → Should focus on OPERATION
- Specific domains? (web, CLI, databases) → Should focus on FUNCTION

EXAMPLES IN PENNY

ALIGNED with Taxonomy:
```
requirements-clarifier
  Cognitive Function: CLARIFIER
  Thinking Operation: Identifies ambiguities, asks questions, confirms understanding
  Domain-Agnostic: Works for web apps, CLI tools, MCP servers, research projects
```

NEW Cognitive Function Discovery:
```
scenario: User needs agent that predicts future architectural needs
initial classification: ANALYZER? SYNTHESIZER? Neither fits perfectly
analysis: This is FORECASTING - distinct cognitive operation
action: Document as new cognitive function category
result: forecaster (new taxonomy entry)
```

---

PRINCIPLE 4: TOOL/AGENT BOUNDARY

DEFINITION

Tools execute deterministic operations; agents perform cognitive work requiring reasoning, adaptation, and decision-making with justification.

DECISION CRITERIA

| Characteristic | TOOL | AGENT |
|----------------|------|-------|
| Operation | Deterministic | Adaptive |
| Input → Output | Single fixed path | Multiple reasoning paths |
| Decision-making | None | With justification |
| State | Stateless | Contextual |
| Ambiguity | Errors on ambiguity | Resolves ambiguity |
| Complexity | Single operation | Multi-step reasoning |

EXAMPLES

TOOLS (Not Agents):
- Database query execution → Deterministic SQL operation
- File format conversion → Fixed transformation rules
- API call wrapper → Direct request/response
- Data validation → Rule-based checking
- Text search → Pattern matching

AGENTS (Not Tools):
- Query optimization strategy → Reasoning about performance trade-offs
- Architecture design → Multi-criteria decision-making with justification
- Code review → Pattern recognition + quality evaluation + recommendations
- Requirements analysis → Ambiguity detection + clarification + validation

BOUNDARY CASES

Case 1: Code Formatter
- Question: Agent or tool?
- Analysis: Deterministic transformation, no decisions, no ambiguity handling
- Answer: TOOL (not agent)

Case 2: Code Refactoring Advisor
- Question: Agent or tool?
- Analysis: Evaluates trade-offs, suggests alternatives, justifies recommendations
- Answer: AGENT

Case 3: Test Runner
- Question: Agent or tool?
- Analysis: Executes tests, reports results, no reasoning
- Answer: TOOL

Case 4: Test Strategy Designer
- Question: Agent or tool?
- Analysis: Analyzes code, identifies edge cases, recommends test approaches
- Answer: AGENT

VALIDATION TEST

If this were deterministic code, would it be:
- <100 lines with no conditionals? → Likely TOOL
- >100 lines with complex decision trees? → Likely AGENT

Can this handle ambiguous input gracefully?
- No (errors/fails) → TOOL
- Yes (asks questions, makes inferences) → AGENT

---

PRINCIPLE 5: PROGRESSIVE DISCLOSURE ARCHITECTURE

DEFINITION

Agents load context incrementally based on task needs, not upfront. Token budgets enforce compression and reference-over-repetition.

IMPLEMENTATION PATTERNS

Pattern 1: Compressed Output
```
JOHARI Template:
  Overview: 80-120 tokens (bullets/tables, not prose)
  Johari Summary: 60-100 tokens (JSON with markdown strings)
  Downstream Directives: 30-50 tokens (JSON with arrays)

Total: 170-270 tokens per phase (vs 400-600 uncompressed)
```

Pattern 2: Reference Not Repeat
```
BAD (Phase 3 repeating Phase 1-2):
  open: "Phase 1 established project scope: web app. Phase 2 identified tech stack: React..."

GOOD (Phase 3 referencing previous):
  open: "Building on Phase 1-2 context (web app, React/Node/Postgres): Confirmed OAuth2..."
```

Pattern 3: Unknown Registry IDs
```
BAD (full description repeated):
  unknown: "OAuth2 provider selection unclear (Google vs GitHub vs custom)"
  unknown: "Database schema for user roles undefined"
  unknown: "OAuth2 provider selection unclear (Google vs GitHub vs custom)" [repeated!]

GOOD (ID references):
  unknown: "[NEW-UNKNOWN] OAuth2 provider selection unclear"
  [Orchestrator assigns U3]
  unknown: "Resolves U3 - selected Google OAuth2"
```

Pattern 4: Conditional Context Loading
```
Agent Structure:
  core.md (always loaded): Purpose, Core Mission, Mandatory Protocols

  Conditional (loaded based on task):
    - research/academic.md (when: scholarly research)
    - research/technical.md (when: software documentation)
    - research/market.md (when: business/product research)
```

TOKEN BUDGET ENFORCEMENT

Simple Agents: 170-220 tokens total
- Overview: 80-100 tokens
- Johari: 60-90 tokens
- Directives: 30-40 tokens

Complex Agents: 220-270 tokens total
- Overview: 100-120 tokens
- Johari: 80-100 tokens
- Directives: 40-50 tokens

Calculation Method:
Before appending to memory, agents count tokens:
```
overview_tokens = count(Overview section)
johari_tokens = count(Johari Summary section)
directives_tokens = count(Downstream Directives section)
total = overview_tokens + johari_tokens + directives_tokens

if total > MAX_TOKENS:
  compress further (abbreviate, remove redundancy)
```

8-Phase Workflow Token Analysis:
```
Workflow Metadata: ~100 tokens
Unknown Registry: ~50 tokens (5 unknowns with IDs)
Phase outputs: 8 × 220 tokens = 1760 tokens
Total: ~1910 tokens (well within context limits)
```

VALIDATION TEST

Does agent output:
- Use bullets/tables instead of prose? → PASS
- Reference previous context instead of repeating? → PASS
- Stay within token budget? → PASS
- Focus on NEW information only? → PASS

---

PRINCIPLE 6: FAILURE BOUNDARY ISOLATION

DEFINITION

Agent failures are contained and recoverable without system-wide impact. Agents don't manipulate orchestration layer directly.

ISOLATION MECHANISMS

Mechanism 1: Gate System
```
Gate Entry: Prerequisites that must be met before agent executes
  - If not met: Workflow blocks, agent doesn't run with bad input

Gate Exit: Completion criteria that must be satisfied
  - If not met: Agent signals incomplete, workflow doesn't proceed
```

Mechanism 2: Interface Abstraction
```
Agents DO:
  - Flag unknowns with [NEW-UNKNOWN] marker
  - Append to memory file (never overwrite)
  - Signal blockers in Downstream Directives

Agents DON'T:
  - Manipulate Unknown Registry JSON directly
  - Update Workflow Metadata
  - Modify other agents' outputs
  - Delete memory file content
```

Mechanism 3: Blocker Signaling
```
Downstream Directives:
  blockers: [
    "User approval pending for $10k infrastructure cost",
    "OAuth2 credentials not provided by user"
  ]

Orchestrator: Sees blockers, halts workflow, escalates to user
Agent: Isolated from workflow management decisions
```

Mechanism 4: Append-Only Memory
```
CORRECT:
  Read existing memory → Append new output → Write combined content

INCORRECT (isolation violation):
  Overwrite memory file → Destroys previous agent outputs
```

FAILURE MODES

Recoverable Failures (agent handles):
- Insufficient context → Request additional context in Unknown quadrant
- Ambiguous input → Use AskUserQuestion, document in Blind quadrant
- Tool unavailable → Flag in blockers, suggest alternatives

Blocking Failures (escalate to orchestrator):
- Gate Entry not met → Workflow stops, doesn't invoke agent
- Critical resource missing → Agent signals blocker, workflow halts
- Unresolvable ambiguity → Agent flags in Unknown, requests user decision

VALIDATION TEST

If this agent fails, does it:
- Corrupt memory file? → FAIL (isolation violated)
- Break other agents? → FAIL (isolation violated)
- Signal failure cleanly? → PASS
- Provide recovery path? → PASS

---

PRINCIPLE 7: MEASURABLE VALUE

DEFINITION

Every agent has clear success criteria, measurable outcomes, and defined value metrics.

IMPLEMENTATION

Success Criteria (Gate Exit requirements):
```
requirements-clarifier Gate Exit:
  - All requirements have explicit acceptance criteria
  - Acceptance criteria are testable (Given-When-Then or equivalent)
  - Edge cases and error scenarios identified
  - User has confirmed all clarifications
  - No [NEW-UNKNOWN] markers remain unresolved
```

Measurable Outcomes:
```
requirements-clarifier Metrics:
  - Ambiguity resolution rate: (Ambiguities resolved / Total ambiguities identified)
  - User interaction efficiency: (Clarifications / User questions asked)
  - Downstream success: (% of downstream agents that complete without asking questions)
  - Token efficiency: (Output tokens / Target token budget)
```

Value Tracking (Future enhancement):
```
Agent performance scorecard (per invocation):
  - Success: Gate Exit criteria met? (Yes/No)
  - Efficiency: Token budget respected? (Yes/No)
  - Quality: Downstream agents succeed without re-clarification? (Yes/No)
  - Time: Execution duration
```

VALIDATION TEST

Can you answer:
- What does success look like for this agent? → Must be explicit
- How do you measure if agent performed well? → Must be quantifiable
- What value does this agent provide? → Must be articulable

---

ANTI-PATTERNS TO AVOID

ANTI-PATTERN 1: Agent Proliferation

Description: Creating many specialized agents instead of reusable capability-based agents.

Examples:
```
BAD:
  - oauth-requirements-clarifier
  - api-requirements-clarifier
  - ui-requirements-clarifier
  (Should be ONE requirements-clarifier with context-driven specialization)

BAD:
  - react-code-generator
  - vue-code-generator
  - angular-code-generator
  (Should be ONE frontend-code-generator with framework context)
```

Detection:
- Agent name contains technology, framework, or domain
- Multiple agents with similar purposes but different domains
- Agent only used in 1-2 workflows

Prevention:
- Reusability test: Must work in 3+ workflows without modification
- Existing agent check: Search registry before creating
- Cognitive function mapping: Ensure genuinely new function

ANTI-PATTERN 2: Scope Creep

Description: Agent doing multiple cognitive functions instead of one.

Examples:
```
BAD:
  research-and-implement-agent:
    - Researches best practices
    - Designs architecture
    - Generates code
    - Validates implementation
  (Four cognitive functions: research, synthesis, generation, validation)

GOOD:
  researcher → architect-designer → code-generator → validator
  (Four agents, each with single cognitive function)
```

Detection:
- Agent description uses "and" more than 3 times
- Agent has >8 execution steps
- "What does NOT do" section is empty or vague

Prevention:
- Single cognitive function test
- Core Mission requires explicit exclusions
- Step count monitoring

ANTI-PATTERN 3: Workflow Coupling

Description: Agent references specific workflows, phases, or positions.

Examples:
```
BAD:
  phase-2-clarifier: "Executes in Phase 2 of develop-agent workflow"

GOOD:
  requirements-clarifier: "Transforms vague requirements into explicit criteria"
  (Workflow-agnostic, usable anywhere)
```

Detection:
- Agent name contains "phase", "step", or workflow name
- Agent description references specific workflow structure
- Agent assumes specific previous/next agents

Prevention:
- Use {step-name} placeholders
- Define agent by cognitive function, not position
- Coordinate through Downstream Directives, not hardcoded assumptions

ANTI-PATTERN 4: Context Bloat

Description: Agent loading excessive context upfront instead of progressive disclosure.

Examples:
```
BAD:
  Agent loads entire knowledge base on every invocation (10,000+ tokens)

GOOD:
  Agent loads core (200 tokens) + conditional context based on task (300 tokens)
```

Detection:
- Agent regularly exceeds token budget
- Agent context includes rarely-used information
- Long agent initialization time

Prevention:
- Progressive disclosure architecture
- Conditional context loading
- Token budget enforcement

ANTI-PATTERN 5: Tool/Agent Confusion

Description: Creating agents for deterministic operations that should be tools.

Examples:
```
BAD (should be tool):
  json-formatter-agent: Formats JSON with standard indentation

BAD (should be tool):
  api-caller-agent: Makes HTTP requests to specified endpoints

GOOD (actual agent):
  api-design-agent: Designs RESTful API architecture with trade-off analysis
```

Detection:
- No decision-making or reasoning
- Single deterministic input → output
- Could be written as <100 line script

Prevention:
- Apply Tool/Agent Decision Criteria
- Ask: "Does this require adaptation and justification?"

---

COORDINATION PATTERNS

PATTERN 1: Sequential Coordination

When: Clear dependencies between agents, linear workflow.

Structure:
```
Skill orchestrates:
  Phase 1: researcher → Gathers information
  Phase 2: analyzer → Evaluates information
  Phase 3: synthesizer → Creates design
  Phase 4: generator → Implements design
  Phase 5: validator → Tests implementation
```

Coordination Mechanism:
- Agents communicate through memory file
- Each agent inherits context from previous via CONTEXT-INHERITANCE
- Downstream Directives provide explicit handoff guidance

PATTERN 2: Parallel Coordination

When: Independent sub-tasks, no dependencies.

Structure:
```
Skill orchestrates (simultaneously):
  researcher A: Technical documentation
  researcher B: User requirements
  researcher C: Competitive analysis

Then: synthesizer integrates findings
```

Coordination Mechanism:
- Agents write to separate sections
- Synthesizer reads all sections
- No inter-agent communication needed

PATTERN 3: Iterative Refinement

When: Progressive improvement until quality threshold met.

Structure:
```
Loop until Gate Exit criteria satisfied:
  1. generator: Proposes solution
  2. validator: Tests solution
  3. analyzer: Evaluates quality
  4. Decision: Accept, refine, or revert
```

Coordination Mechanism:
- Agents track iteration count
- Validator signals when threshold met
- Analyzer provides refinement guidance

---

VALIDATION CHECKLIST

Before finalizing agent, verify ALL criteria:

Single Cognitive Responsibility:
- [ ] Can be described in ONE sentence with ONE verb
- [ ] Performs ONE cognitive function across domains
- [ ] Core Mission explicitly lists what agent does NOT do

Context-Driven Specialization:
- [ ] No workflow-specific references in description
- [ ] No technology-specific naming
- [ ] No domain-specific limitations
- [ ] Uses {step-name} placeholders, not hardcoded phases

Capability Taxonomy Alignment:
- [ ] Maps to cognitive function (or documents new function)
- [ ] Cognitive function explained without mentioning outputs/inputs/domains

Tool/Agent Boundary:
- [ ] Requires reasoning and decision-making
- [ ] Handles ambiguity gracefully
- [ ] Integrates 6 reasoning strategies

Progressive Disclosure:
- [ ] Token budget specified and enforced
- [ ] References previous context instead of repeating
- [ ] Uses compressed markdown (bullets/tables)

Failure Boundary Isolation:
- [ ] Gate Entry/Exit criteria defined
- [ ] Doesn't manipulate orchestration layer directly
- [ ] Signals failures through standard mechanisms

Measurable Value:
- [ ] Success criteria are explicit and measurable
- [ ] Gate Exit requirements are clear
- [ ] Value proposition is articulable

Reusability:
- [ ] Works in 3+ workflows without modification
- [ ] Existing agent check completed (not duplicate)
- [ ] Example interactions demonstrate cross-domain use

---

RELATED DOCUMENTS

- .claude/docs/PHILOSOPHY.md - Penny's core architectural principles
- .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md - Detailed cognitive function guide
- .claude/docs/AGENT-REGISTRY.md - Agent discovery catalog
- .claude/docs/AGENT-TEMPLATE-USAGE.md - Template usage guidance
- .claude/skills/develop-agent/resources/agent-description-simple.md - Simple agent template
- .claude/skills/develop-agent/resources/agent-description-complex.md - Complex agent template
- .claude/protocols/CONTEXT-INHERITANCE.md - Context loading protocol
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md - Generic execution steps
- .claude/protocols/AGENT-INTERFACE-CONTRACTS.md - Input/output specifications
