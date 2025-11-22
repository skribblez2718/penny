---
name: develop-project
version: 2.0.0
description: Comprehensive domain-agnostic development workflow from concept to deployment-ready code. Orchestrates 6 universal cognitive agents across 10 phases implementing TDD and security-first approaches. Works for technical, personal, creative, professional, and recreational projects through cognitive domain adaptation.
status: production
complexity: complex
agents_required: 6
estimated_turns: 40-60
---

DEVELOP-PROJECT SKILL

OVERVIEW

The develop-project skill transforms project ideas into deployment-ready deliverables through systematic cognitive processing. It orchestrates 6 universal cognitive agents across 10 phases with explicit quality gates ensuring excellence at every step.

This skill works across ALL domains through cognitive adaptation:
- Technical: Web apps, CLI tools, mobile apps, PWAs, AI applications, APIs
- Personal: Life decisions, goal planning, habit systems, personal projects
- Creative: Content creation, art projects, creative workflows, entertainment
- Professional: Business strategies, operational plans, market analysis
- Recreational: Event planning, game design, hobby projects

Specialization happens through domain context, not agent specialization. The same 6 cognitive agents adapt their processing to the task domain.

KEY FEATURES

- 10-PHASE WORKFLOW: Requirements through deployment with clear separation
- 6 COGNITIVE AGENTS: Research, Analysis, Synthesis, Generation, Validation, Clarification
- DOMAIN-ADAPTIVE: Same workflow adapts to technical/personal/creative/professional/recreational
- GATE-BASED VALIDATION: Quality gates prevent low-quality work from progressing
- SEQUENTIAL EXECUTION: Agents always invoked sequentially, never in parallel
- TDD-INTEGRATED: Test-driven development for technical projects
- SECURITY-FIRST: OWASP Top 10 and secure coding throughout technical implementations
- REMEDIATION LOOPS: Failed gates loop back for fixes before proceeding
- COMPREHENSIVE OUTPUT: Complete deliverables with validation and documentation

COGNITIVE AGENT ARCHITECTURE

This skill uses 6 universal cognitive agents that adapt to domain context:

For agent descriptions and capabilities:
  See .claude/references/agent-registry.md

For context structure and format:
  See .claude/references/johari.md (Johari Window format)
  See .claude/references/context-inheritance.md (examples)

For execution protocols:
  See .claude/protocols/agent-protocol-core.md (all agents)
  See .claude/protocols/agent-protocol-extended.md (technical code generation)

IMPORTANT: Agents are ALWAYS invoked sequentially, never in parallel.

---

WORKFLOW PHASES

PHASE 0: Requirements Clarification & Analysis

Cognitive Sequence: CLARIFICATION → ANALYSIS → VALIDATION

Purpose: Transform vague project idea into validated, testable requirements

TASK CONTEXT:
  task_domain: [Established from user input - technical/personal/creative/professional/recreational]
  quality_standards: ["testable", "SMART criteria", "consistent", "prioritized"]
  artifact_types: ["requirements specification", "acceptance criteria", "dependency graph"]
  success_criteria: ["all requirements explicit", "acceptance tests defined", "dependencies mapped"]

Agent Invocations:

1. clarification-specialist (CLARIFICATION)
   Purpose: Transform vague project idea into explicit requirements

   Gate Entry:
   - User has provided initial project description
   - Domain classification attempted

   Gate Exit:
   - All requirements have explicit acceptance criteria
   - Scope boundaries defined
   - Constraints documented

   Context References:
   - None (first step)

2. analysis-agent (ANALYSIS)
   Purpose: Analyze requirements for dependencies, complexity, risks

   Gate Entry:
   - Clarified requirements available

   Gate Exit:
   - Dependency graph created
   - Complexity assessed (SIMPLE/MEDIUM/COMPLEX)
   - Risk matrix with mitigation strategies
   - MoSCoW prioritization complete

   Context References:
   - .claude/memory/task-{id}-clarification-specialist-memory.md

3. quality-validator (VALIDATION)
   Purpose: Validate requirements meet quality standards

   Gate Entry:
   - Requirements and analysis complete

   Gate Exit Decision:
   - PASS: Requirements testable, consistent, complete → Phase 1
   - FAIL: Issues found → Loop to clarification-specialist for remediation

   Validation Criteria:
   - SMART: Specific, Measurable, Achievable, Relevant, Testable
   - Consistency: No contradictions between requirements
   - Traceability: Each requirement linked to acceptance criteria

   Context References:
   - .claude/memory/task-{id}-clarification-specialist-memory.md
   - .claude/memory/task-{id}-analysis-agent-memory.md

---

PHASE 1: Research

Cognitive Sequence: RESEARCH

Purpose: Discover relevant information, patterns, options, or approaches

TASK CONTEXT:
  task_domain: [Inherited from Phase 0]
  quality_standards: ["3+ sources per topic", "authoritative sources", "recent information"]
  artifact_types: ["research findings", "source catalog", "pattern documentation"]
  success_criteria: ["sufficient options identified", "sources documented", "gaps noted"]

Domain Adaptation:
- Technical: Technology/framework/library research via WebSearch/WebFetch
- Personal: Best practices, expert advice, case studies for life decisions
- Creative: Genre patterns, audience expectations, creative techniques
- Professional: Market data, industry standards, competitive analysis
- Recreational: Activity options, venues, planning resources

Agent Invocations:

1. research-discovery (RESEARCH)
   Purpose: Discover and evaluate information across domain

   Gate Entry:
   - Validated requirements from Phase 0
   - Research scope defined

   Gate Exit:
   - Minimum 3 options per major decision point
   - Sources documented with credibility assessment
   - Knowledge gaps identified

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata)
   - .claude/memory/task-{id}-clarification-specialist-memory.md
   - .claude/memory/task-{id}-analysis-agent-memory.md
   - .claude/memory/task-{id}-quality-validator-memory.md

---

PHASE 2: Evaluation & Decision Synthesis

Cognitive Sequence: ANALYSIS → SYNTHESIS

Purpose: Evaluate options and synthesize coherent decisions

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: ["evidence-based decisions", "justified trade-offs", "documented rationale"]
  artifact_types: ["evaluation matrix", "decision document", "rationale"]
  success_criteria: ["all major decisions made", "alternatives documented", "trade-offs explicit"]

Agent Invocations:

1. analysis-agent (ANALYSIS)
   Purpose: Evaluate researched options against requirements

   Gate Entry:
   - Research findings available

   Gate Exit:
   - Evaluation matrix complete with scoring
   - Trade-offs identified for each option
   - Recommendations formed

   Context References:
   - Previous phase outputs
   - .claude/memory/task-{id}-research-discovery-memory.md

2. synthesis-agent (SYNTHESIS)
   Purpose: Synthesize evaluation into coherent decision framework

   Gate Entry:
   - Evaluation complete

   Gate Exit:
   - Primary decisions documented with rationale
   - Alternatives considered and rejected with reasoning
   - Decision conflicts resolved

   Domain Examples:
   - Technical: Technology stack selection
   - Personal: Life decision framework
   - Creative: Artistic direction and style
   - Professional: Strategic approach
   - Recreational: Activity and venue selection

   Context References:
   - All previous phase outputs
   - .claude/memory/task-{id}-analysis-agent-memory.md (evaluation)

---

PHASE 3: Architecture/Framework Design

Cognitive Sequence: RESEARCH → SYNTHESIS

Purpose: Research patterns and synthesize architectural design

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific - see below)
  artifact_types: (domain-specific - see below)
  success_criteria: (domain-specific - see below)

Domain-Specific Standards:
- Technical: ["security-first", "SOLID principles", "scalable", "testable"]
  Artifacts: ["architecture design", "component specifications", "API definitions", "data models"]

- Personal: ["value-aligned", "realistic", "measurable", "flexible"]
  Artifacts: ["life framework", "milestone plan", "support system design"]

- Creative: ["audience-appropriate", "thematically coherent", "engaging"]
  Artifacts: ["creative framework", "narrative structure", "content outline"]

- Professional: ["market-aligned", "resource-constrained", "scalable", "measurable"]
  Artifacts: ["strategic framework", "operational plan", "resource allocation"]

- Recreational: ["fun-maximizing", "inclusive", "feasible", "flexible"]
  Artifacts: ["activity framework", "schedule outline", "contingency plans"]

Agent Invocations:

1. research-discovery (RESEARCH)
   Purpose: Research architectural/design patterns applicable to domain

   Gate Entry:
   - Decisions from Phase 2

   Gate Exit:
   - Relevant patterns documented
   - Applicability criteria defined
   - Anti-patterns noted

   Context References:
   - All previous phase outputs

2. synthesis-agent (SYNTHESIS)
   Purpose: Synthesize architecture/framework from requirements, patterns, and decisions

   Gate Entry:
   - Pattern research complete

   Gate Exit:
   - Complete architecture/framework design
   - Components/elements clearly defined
   - Integration points specified

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical domain with security requirements)

   Context References:
   - All previous phase outputs
   - .claude/memory/task-{id}-research-discovery-memory.md (patterns)

---

PHASE 4: Architecture/Framework Validation

Cognitive Sequence: ANALYSIS → VALIDATION

Purpose: Analyze and validate design meets quality requirements

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: ["quality analysis", "validation report", "issue list"]
  success_criteria: ["no critical issues", "quality gates met", "actionable feedback"]

Agent Invocations:

1. analysis-agent (ANALYSIS)
   Purpose: Analyze design for quality attributes

   Gate Entry:
   - Architecture/framework design complete

   Gate Exit:
   - Quality analysis complete
   - Issues categorized by severity (CRITICAL/HIGH/MEDIUM/LOW)
   - Improvement recommendations provided

   Domain-Specific Analysis:
   - Technical: SOLID principles, coupling/cohesion, security patterns, performance
   - Personal: Values alignment, feasibility, resource requirements, risk assessment
   - Creative: Narrative coherence, audience fit, engagement potential, originality
   - Professional: Market viability, resource efficiency, risk exposure, scalability
   - Recreational: Fun factor, accessibility, logistics, safety

   Context References:
   - All previous phase outputs

2. quality-validator (VALIDATION)
   Purpose: Validate design against requirements and standards

   Gate Entry:
   - Quality analysis complete

   Gate Exit Decision:
   - PASS: No CRITICAL issues, acceptable quality → Phase 5
   - FAIL: CRITICAL issues or major gaps → Loop to Phase 3 for remediation

   Validation Criteria (Domain-Specific):
   - Technical: Security audit pass (OWASP), architecture patterns appropriate
   - Personal: Values alignment confirmed, feasibility validated
   - Creative: Audience appropriateness validated, coherence confirmed
   - Professional: Market viability confirmed, resource constraints satisfied
   - Recreational: Safety validated, accessibility confirmed

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical with security checks)

   Context References:
   - All previous phase outputs
   - .claude/memory/task-{id}-analysis-agent-memory.md (quality analysis)

---

PHASE 5: Implementation Planning

Cognitive Sequence: CLARIFICATION → GENERATION

Purpose: Clarify constraints and generate implementation plan

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: ["implementation plan", "task breakdown", "timeline", "resource plan"]
  success_criteria: ["all tasks actionable", "dependencies clear", "milestones defined"]

Agent Invocations:

1. clarification-specialist (CLARIFICATION)
   Purpose: Clarify technical/operational constraints before planning

   Gate Entry:
   - Validated architecture/framework from Phase 4

   Gate Exit:
   - All constraints explicit
   - Deployment/operational requirements clarified
   - Integration points defined

   Domain Examples:
   - Technical: Deployment targets, performance requirements, integration endpoints
   - Personal: Time constraints, resource availability, support requirements
   - Creative: Publication channels, format requirements, distribution constraints
   - Professional: Budget limits, timeline constraints, regulatory requirements
   - Recreational: Venue availability, participant constraints, budget limits

   Context References:
   - All previous phase outputs

2. generation-agent (GENERATION)
   Purpose: Generate comprehensive implementation plan

   Gate Entry:
   - Constraints clarified

   Gate Exit:
   - Implementation plan complete with task breakdown
   - Milestones defined with acceptance criteria
   - Resource allocation specified
   - Risk mitigation strategies included

   Domain-Specific Planning:
   - Technical: TDD milestones, security checkpoints, integration phases
   - Personal: Habit formation stages, progress markers, review points
   - Creative: Content production schedule, review cycles, publication timeline
   - Professional: Strategic phases, KPI checkpoints, pivot criteria
   - Recreational: Activity phases, setup timeline, contingency activation

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical with TDD requirements)

   Context References:
   - All previous phase outputs
   - .claude/memory/task-{id}-clarification-specialist-memory.md (constraints)

---

PHASE 6: Foundation Generation

Cognitive Sequence: GENERATION

Purpose: Generate project foundation/structure

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: (domain-specific - see below)
  success_criteria: ["foundation complete", "structure validated", "ready for implementation"]

Domain-Specific Artifacts:
- Technical: Project scaffold, configuration files, directory structure, build setup, test infrastructure
- Personal: Framework templates, tracking systems, initial resources, support network setup
- Creative: Content templates, style guides, initial drafts, production tools setup
- Professional: Document templates, tracking systems, communication frameworks, reporting structures
- Recreational: Planning documents, checklists, resource lists, communication channels

Agent Invocations:

1. generation-agent (GENERATION)
   Purpose: Generate project foundation appropriate to domain

   Gate Entry:
   - Implementation plan from Phase 5

   Gate Exit:
   - Foundation/structure complete
   - All templates and tools in place
   - Ready for core implementation

   Domain Standards:
   - Technical: Secure defaults, build passes, tests configured, linting enabled
   - Personal: Tracking operational, templates usable, resources accessible
   - Creative: Templates ready, tools configured, style guide applied
   - Professional: Documents structured, tracking operational, templates validated
   - Recreational: Checklists complete, communications ready, logistics confirmed

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical - TDD + Security)

   Context References:
   - All previous phase outputs

---

PHASE 7: Core Implementation

Cognitive Sequence: GENERATION (iterative)

Purpose: Implement core features/content/deliverables

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: (domain-specific)
  success_criteria: (domain-specific)

Agent Invocations:

1. generation-agent (GENERATION) - ITERATIVE
   Purpose: Create core deliverables using domain-appropriate methods

   Gate Entry:
   - Foundation from Phase 6
   - Implementation plan from Phase 5

   Gate Exit:
   - All core features/content/elements implemented
   - Domain-appropriate quality measures met
   - Ready for validation

   Domain-Specific Implementation:
   - Technical: TDD cycle (RED-GREEN-REFACTOR), secure coding, input validation
     Quality: 80%+ test coverage, no HIGH/CRITICAL security issues

   - Personal: Action implementation, habit establishment, milestone achievement
     Quality: Measurable progress, documented outcomes, review completed

   - Creative: Content creation, refinement cycles, quality iterations
     Quality: Audience-appropriate, thematically coherent, engaging

   - Professional: Strategy execution, operational implementation, deliverable creation
     Quality: KPI tracking, stakeholder alignment, milestone achievement

   - Recreational: Activity preparation, resource acquisition, participant coordination
     Quality: Logistics confirmed, safety validated, fun maximized

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical - TDD + Security protocols)

   Context References:
   - All previous phase outputs

   Note: Agent handles both primary artifacts and quality measures appropriate to domain
   (e.g., in technical domain: both code and tests; in creative domain: both content and refinements)

---

PHASE 8: Quality Validation

Cognitive Sequence: VALIDATION (sequential: implementation → domain-specific)

Purpose: Comprehensive quality validation appropriate to domain

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: ["validation report", "test results", "quality assessment"]
  success_criteria: (domain-specific)

Agent Invocations:

1. quality-validator (VALIDATION) - Implementation Quality
   Purpose: Validate core implementation meets standards

   Gate Entry:
   - Core implementation from Phase 7

   Gate Exit Decision:
   - PASS: Quality standards met → Step 2 (domain-specific validation)
   - FAIL: Issues found → Loop to Phase 7 for remediation

   Domain-Specific Validation:
   - Technical: Execute tests, verify coverage, check code quality, validate architecture compliance
     Criteria: All tests pass, 80%+ coverage, no code smells, patterns followed

   - Personal: Review progress, validate milestone achievement, assess goal alignment
     Criteria: Milestones met, values aligned, sustainable progress

   - Creative: Review content quality, validate audience appropriateness, assess engagement
     Criteria: Quality standards met, audience fit confirmed, coherent

   - Professional: Review deliverables, validate KPIs, assess stakeholder alignment
     Criteria: KPIs met, stakeholders satisfied, strategy on track

   - Recreational: Review preparations, validate logistics, assess readiness
     Criteria: Logistics complete, safety confirmed, participants ready

   Context References:
   - All previous phase outputs

2. quality-validator (VALIDATION) - Domain-Specific Deep Validation
   Purpose: Perform domain-specific deep quality checks

   Gate Entry:
   - Implementation validation passed

   Gate Exit Decision:
   - PASS: Domain-specific quality confirmed → Phase 9
   - FAIL: Critical domain issues → Loop to Phase 7 for fixes

   Domain-Specific Deep Validation:
   - Technical: Security audit (OWASP Top 10), dependency scan, performance validation
     Criteria: No HIGH/CRITICAL vulnerabilities, acceptable performance

   - Personal: Long-term sustainability check, support system validation, risk assessment
     Criteria: Sustainable approach, support adequate, risks acceptable

   - Creative: Audience testing, feedback incorporation, polish validation
     Criteria: Audience response positive, feedback addressed, polished

   - Professional: Market validation, financial review, compliance check
     Criteria: Market viable, financially sound, compliant

   - Recreational: Safety audit, accessibility review, participant readiness
     Criteria: Safe, accessible, participants prepared

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical - security checklist)

   Context References:
   - All previous phase outputs
   - .claude/memory/task-{id}-quality-validator-memory.md (implementation validation)

---

PHASE 9: Documentation & Deployment Readiness

Cognitive Sequence: GENERATION → VALIDATION

Purpose: Create comprehensive documentation and validate deployment readiness

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: ["complete", "accurate", "accessible", "actionable"]
  artifact_types: (domain-specific documentation)
  success_criteria: ["documentation complete", "deployment ready", "handoff prepared"]

Agent Invocations:

1. generation-agent (GENERATION)
   Purpose: Generate comprehensive documentation

   Gate Entry:
   - Validated implementation from Phase 8

   Gate Exit:
   - Complete documentation suite
   - All required documents created
   - Deployment/handoff guide ready

   Domain-Specific Documentation:
   - Technical: README, API docs, architecture docs, deployment guide, runbook
   - Personal: Progress documentation, resource guide, sustainability plan, review schedule
   - Creative: Style guide, production notes, distribution plan, future iteration guide
   - Professional: Strategy document, operational guide, KPI dashboard, stakeholder brief
   - Recreational: Event guide, participant instructions, logistics document, contingency plans

   Context References:
   - All previous phase outputs

2. quality-validator (VALIDATION)
   Purpose: Validate deployment/launch/handoff readiness

   Gate Entry:
   - Documentation complete

   Gate Exit Decision:
   - GO: Deployment checklist satisfied → Phase 10 (finalization)
   - NO-GO: Critical gaps → Remediate (loop to appropriate phase)

   Domain-Specific Readiness Checklist:
   - Technical: Tests pass, docs complete, configs ready, security clean, deployment tested
   - Personal: Goals clear, resources ready, support active, sustainability confirmed
   - Creative: Content polished, distribution ready, audience prepared, launch plan set
   - Professional: Strategy documented, team aligned, resources allocated, launch ready
   - Recreational: Logistics complete, participants briefed, safety confirmed, contingencies ready

   Context References:
   - All previous phase outputs
   - .claude/memory/task-{id}-generation-agent-memory.md (documentation)

---

PHASE 10: Workflow Completion

Purpose: Finalize deliverables and complete workflow

TASK CONTEXT:
  No agents invoked - workflow orchestration handles completion

Actions:
1. Aggregate all phase outputs into final project package
2. Review Unknown Registry for critical unresolved items
3. Generate project completion summary
4. Present complete deliverables to user
5. Signal workflow completion

Final Deliverable Structure (Domain-Specific):
- Technical: Working code + comprehensive tests + documentation + deployment guide
- Personal: Implemented framework + progress documentation + sustainability plan + review system
- Creative: Finished content + style guide + production notes + distribution plan
- Professional: Executed strategy + operational docs + KPI tracking + stakeholder reports
- Recreational: Event ready + participant materials + logistics confirmed + contingency plans

Completion Criteria:
- All phases completed successfully
- All gate validations passed
- Critical unknowns resolved
- Deliverables complete per domain requirements
- User acceptance obtained

---

DEPENDENCIES & REQUIREMENTS

REQUIRED SKILLS: None (standalone skill)

REQUIRED PROTOCOLS:
- .claude/protocols/agent-protocol-core.md (all agents - context inheritance, Johari format)
- .claude/protocols/agent-protocol-extended.md (technical domain code generation - TDD + Security)

REQUIRED REFERENCES:
- .claude/references/agent-registry.md (agent descriptions and capabilities)
- .claude/references/johari.md (context structure, type definitions, format)
- .claude/references/context-inheritance.md (context-passing examples)

REQUIRED AGENTS (6):
- clarification-specialist (CLARIFICATION function)
- research-discovery (RESEARCH function)
- analysis-agent (ANALYSIS function)
- synthesis-agent (SYNTHESIS function)
- generation-agent (GENERATION function)
- quality-validator (VALIDATION function)

---

STATE MANAGEMENT

WORKFLOW METADATA:
Location: .claude/memory/task-{id}-memory.md
Format: See .claude/references/johari.md for WorkflowMetadata schema

Required Fields:
- task_id: Unique identifier (task-{project-name})
- workflow_type: "develop-project"
- task_domain: technical|personal|creative|professional|recreational|hybrid
- target_platform: (if technical) browser|node|desktop|mobile|edge
- current_phase: 0-10
- total_phases: 10
- quality_standards: Domain-specific standards list
- artifact_types: Expected output types
- cognitive_sequence: List of cognitive functions in order
- critical_constraints: Project-specific limitations
- success_criteria: Measurable success indicators

UNKNOWN REGISTRY:
Location: Within workflow metadata file
Format: See .claude/references/johari.md for Unknown schema

Required Fields per Unknown:
- id: U{number}
- phase: Phase where unknown identified
- category: Unknown category from taxonomy
- description: What is unknown
- resolution_phase: Phase where resolved
- cognitive_agent: Which cognitive function resolves it
- status: Unresolved|In Progress|Resolved|Deferred
- resolution: How it was resolved (when resolved)

AGENT OUTPUTS:
Location: .claude/memory/task-{id}-{agent-name}-memory.md
Format: Johari Window (see .claude/references/johari.md)

Structure:
- open: Confirmed knowledge shared by all
- hidden: Non-obvious insights discovered
- blind: Limitations and gaps
- unknown: Areas requiring other cognitive functions
- domain_insights: Domain-specific discoveries

---

PERFORMANCE CONSIDERATIONS

TOKEN BUDGET:
- Workflow metadata: ~500 tokens
- Agent outputs (Johari format): ~300-500 tokens each
- Total estimated: 8,000-12,000 tokens for complete workflow
- Significant reduction from 20-agent system (~15,000-20,000 tokens)

CONTEXT COMPRESSION:
- Johari Window format compresses agent outputs
- Reference previous findings without repetition
- Domain insights extracted separately
- Unknown Registry tracks gaps systematically

REMEDIATION EFFICIENCY:
- Gate-based validation prevents cascading errors
- Targeted loops to specific phases reduce rework
- Sequential agent execution maintains clarity

---

USAGE EXAMPLES

EXAMPLE 1: Technical Project - OAuth2 Authentication System

Domain: technical
Target: Node.js API with JWT tokens

Cognitive Flow:
- Phase 0: Clarify OAuth2 provider, security requirements, performance targets
- Phase 1: Research OAuth2 libraries, security best practices, JWT handling
- Phase 2: Evaluate libraries, synthesize technology stack decision
- Phase 3: Research security patterns, synthesize secure architecture
- Phase 4: Analyze architecture for OWASP compliance, validate security
- Phase 5: Clarify deployment constraints, generate TDD implementation plan
- Phase 6: Generate project scaffold with secure configs and test infrastructure
- Phase 7: Implement OAuth2 flow using TDD (tests first, then code)
- Phase 8: Validate tests pass and security audit clean
- Phase 9: Generate API docs and deployment guide, validate readiness
- Phase 10: Deliver working OAuth2 system with tests and docs

EXAMPLE 2: Personal Project - Career Transition Planning

Domain: personal

Cognitive Flow:
- Phase 0: Clarify career goals, constraints, values; analyze current situation
- Phase 1: Research target roles, industries, skill requirements, market trends
- Phase 2: Evaluate career paths against values/goals, synthesize optimal path
- Phase 3: Research transition frameworks, synthesize personalized strategy
- Phase 4: Analyze strategy for feasibility and risks, validate approach
- Phase 5: Clarify timeline and resource constraints, generate action plan
- Phase 6: Create tracking templates, resource lists, support network framework
- Phase 7: Implement initial actions (skill building, networking, applications)
- Phase 8: Validate progress against milestones, assess sustainability
- Phase 9: Document progress, generate sustainability guide, validate readiness
- Phase 10: Deliver complete career transition plan with tracking system

EXAMPLE 3: Creative Project - Blog Series on AI Ethics

Domain: creative
Audience: Tech professionals

Cognitive Flow:
- Phase 0: Clarify audience, topics, tone; analyze existing content landscape
- Phase 1: Research AI ethics topics, competing content, audience preferences
- Phase 2: Evaluate topics and angles, synthesize content strategy
- Phase 3: Research narrative structures, synthesize series framework
- Phase 4: Analyze framework for coherence and engagement, validate approach
- Phase 5: Clarify publishing constraints, generate content production plan
- Phase 6: Create content templates, style guide, production tools
- Phase 7: Write blog posts following creative framework
- Phase 8: Validate content quality and audience fit, assess engagement potential
- Phase 9: Generate publication guide and promotion plan, validate launch readiness
- Phase 10: Deliver complete blog series with publication materials

---

MAINTENANCE NOTES

MODIFYING PHASES:
1. Update phase definition in this file
2. Update cognitive sequence if needed
3. Update gate criteria if needed
4. Re-test workflow end-to-end

TROUBLESHOOTING:
- Gate failures: Check previous phase outputs for completeness
- Context inheritance issues: Verify workflow metadata format matches johari.md
- Agent errors: Check agent receives required context (domain, standards, artifacts)
- Unknown resolution: Ensure Unknown Registry properly updated with cognitive_agent field

ADDING DOMAIN SUPPORT:
1. Add domain-specific quality standards per phase
2. Add domain-specific artifact types per phase
3. Add domain-specific success criteria per phase
4. Add example workflow for new domain
5. Test end-to-end with real project in new domain

---

REMEMBER

This skill transforms ideas into reality through systematic cognitive processing. Every phase builds on the last, every gate ensures quality, every agent performs its cognitive function excellently across ANY domain.

The workflow is systematic, the validation is rigorous, the output is comprehensive.

Trust the process, follow the gates, respect the sequential execution, and watch ideas become deployment-ready deliverables.

6 cognitive agents. 10 phases. Infinite domains. One proven workflow.
