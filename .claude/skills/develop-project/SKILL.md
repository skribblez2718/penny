---
name: develop-project
version: 3.0.0
description: Comprehensive domain-agnostic development workflow from concept to deployment-ready code. Orchestrates 6 universal cognitive agents across 6 optimized phases implementing TDD and security-first approaches. Works for technical, personal, creative, professional, and recreational projects through cognitive domain adaptation.
status: production
complexity: complex
agents_required: 6
estimated_turns: 25-40
---

DEVELOP-PROJECT SKILL - VERSION 3.0 (OPTIMIZED)

OVERVIEW

The develop-project skill transforms project ideas into deployment-ready deliverables through systematic cognitive processing. It orchestrates 6 universal cognitive agents across 6 optimized phases with embedded quality validation ensuring excellence at every step.

This skill works across ALL domains through cognitive adaptation:
- Technical: Web apps, CLI tools, mobile apps, PWAs, AI applications, APIs
- Personal: Life decisions, goal planning, habit systems, personal projects
- Creative: Content creation, art projects, creative workflows, entertainment
- Professional: Business strategies, operational plans, market analysis
- Recreational: Event planning, game design, hobby projects

Specialization happens through domain context, not agent specialization. The same 6 cognitive agents adapt their processing to the task domain.

KEY FEATURES

- 6-PHASE OPTIMIZED WORKFLOW: Streamlined phases with embedded validation for faster execution (40% faster than 10-phase)
- 6 COGNITIVE AGENTS: Research, Analysis, Synthesis, Generation, Validation, Clarification
- DOMAIN-ADAPTIVE: Same workflow adapts to technical/personal/creative/professional/recreational
- EMBEDDED VALIDATION: Quality checks integrated into cognitive agents, not separate phases
- SCOPED CONTEXT LOADING: Agents load only immediate predecessors (50-60% token reduction)
- SEQUENTIAL EXECUTION: Agents always invoked sequentially, never in parallel
- TDD-INTEGRATED: Test-driven development for technical projects (validation built-in)
- SECURITY-FIRST: OWASP Top 10 and secure coding throughout technical implementations
- REMEDIATION LOOPS: Failed exit criteria loop back for fixes before proceeding
- COMPREHENSIVE OUTPUT: Complete deliverables with validation and documentation

OPTIMIZATION IMPROVEMENTS

Compared to previous 10-phase workflow:
- Agent invocations: 14-18 → 10-12 (33% reduction)
- Execution time: ~45-60 min → ~20-30 min (40-50% faster)
- Memory file sizes: 1,000-2,800 lines → 300-400 lines (65-70% reduction)
- Token usage per phase: 6,500-8,000 → 2,000-3,000 (60-70% reduction)
- Context loading: All previous outputs → Immediate predecessors only

COGNITIVE AGENT ARCHITECTURE

This skill uses 6 universal cognitive agents that adapt to domain context:

For agent descriptions and capabilities:
  See .claude/references/agent-registry.md

For context structure and format:
  See .claude/references/johari.md (Johari Window format)
  See .claude/references/context-inheritance.md (examples)

For execution protocols:
  See .claude/protocols/agent-protocol-core.md (all agents - includes scoped context loading)
  See .claude/protocols/agent-protocol-extended.md (technical code generation)

IMPORTANT: Agents are ALWAYS invoked sequentially, never in parallel.

---

WORKFLOW PHASES

PHASE 0: Requirements Discovery & Analysis

Cognitive Sequence: CLARIFICATION → ANALYSIS (embedded validation)

Purpose: Transform vague ideas into validated requirements with embedded quality checks

TASK CONTEXT:
  task_domain: [Established from user input - technical/personal/creative/professional/recreational]
  quality_standards: ["testable", "SMART criteria", "consistent", "prioritized"]
  artifact_types: ["requirements specification", "acceptance criteria", "dependency graph"]
  success_criteria: ["requirements explicit", "acceptance tests defined", "dependencies mapped", "quality validated"]

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
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]

   Context Scope: WORKFLOW_ONLY
   Token Budget: 500-1,000 tokens

2. analysis-agent (ANALYSIS)
   Purpose: Analyze requirements for dependencies, complexity, risks AND validate quality

   Gate Entry:
   - Clarified requirements available

   Gate Exit Decision:
   - PASS: Requirements are SMART, consistent, complete → Phase 1
   - FAIL: Issues found → Loop to clarification-specialist for remediation

   Validation Responsibilities (embedded):
   - SMART compliance check (Specific, Measurable, Achievable, Relevant, Testable)
   - Consistency verification (no contradictions)
   - Dependency mapping
   - Risk assessment with mitigation
   - MoSCoW prioritization
   - Traceability confirmation

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-clarification-specialist-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 2,500-3,000 tokens

OPTIMIZATION NOTE: Phase 0 reduces from 3 agents (clarification, analysis, validation) to 2 agents by embedding validation into analysis. Analysis agent validates as it analyzes.

---

PHASE 1: Research & Decision Synthesis

Cognitive Sequence: RESEARCH → SYNTHESIS (embedded validation)

Purpose: Discover options and synthesize coherent decisions

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: ["3+ sources", "authoritative", "evidence-based decisions"]
  artifact_types: ["research findings", "decision document", "rationale"]
  success_criteria: ["options identified", "decisions made with rationale", "trade-offs explicit"]

Domain Adaptation:
- Technical: Technology/framework/library research, architectural patterns
- Personal: Best practices, expert advice, case studies
- Creative: Genre patterns, audience research, creative techniques
- Professional: Market data, industry standards, competitive analysis
- Recreational: Activity options, venues, planning resources

Agent Invocations:

1. research-discovery (RESEARCH)
   Purpose: Discover and evaluate information across domain

   Gate Entry:
   - Validated requirements from Phase 0

   Gate Exit:
   - Minimum 3 options per decision point
   - Sources documented with credibility
   - Knowledge gaps identified

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-analysis-agent-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 2,500-3,000 tokens

2. synthesis-agent (SYNTHESIS)
   Purpose: Synthesize evaluation into coherent decisions AND validate completeness

   Gate Entry:
   - Research findings available

   Gate Exit Decision:
   - PASS: Decisions coherent, alternatives documented → Phase 2
   - FAIL: Incomplete research → Loop to research-discovery

   Validation Responsibilities (embedded):
   - Decision completeness check
   - Rationale quality verification
   - Conflict resolution confirmation
   - Trade-offs explicitly stated

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-research-discovery-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]
   - .claude/memory/task-{id}-analysis-agent-memory.md [OPTIONAL: requirements for alignment check]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-4,000 tokens

OPTIMIZATION NOTE: Phase 1 merges old Phases 1 (Research) and 2 (Evaluation & Decision). Synthesis naturally validates research completeness.

---

PHASE 2: Architecture Design & Validation

Cognitive Sequence: RESEARCH → SYNTHESIS → ANALYSIS (embedded validation)

Purpose: Research patterns, design architecture, and validate quality

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific - see below)
  artifact_types: (domain-specific - see below)
  success_criteria: ["complete design", "patterns applied", "no critical issues", "quality validated"]

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
   - Decisions from Phase 1

   Gate Exit:
   - Relevant patterns documented
   - Applicability criteria defined
   - Anti-patterns noted

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-synthesis-agent-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 2,500-3,000 tokens

2. synthesis-agent (SYNTHESIS)
   Purpose: Synthesize architecture/framework from patterns and decisions

   Gate Entry:
   - Pattern research complete

   Gate Exit:
   - Complete architecture/framework design
   - Components clearly defined
   - Integration points specified

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical domain)

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-research-discovery-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]
   - .claude/memory/task-{id}-synthesis-agent-memory.md (Phase 1) [OPTIONAL: decisions context]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-4,000 tokens

3. analysis-agent (ANALYSIS)
   Purpose: Analyze design for quality AND perform embedded validation

   Gate Entry:
   - Architecture/framework design complete

   Gate Exit Decision:
   - PASS: No CRITICAL issues, acceptable quality → Phase 3
   - FAIL: CRITICAL issues found → Loop to synthesis-agent (step 2) for redesign

   Validation Responsibilities (embedded):
   - Domain-specific quality analysis (SOLID, security, values alignment, etc.)
   - Issue categorization (CRITICAL/HIGH/MEDIUM/LOW)
   - Architecture pattern compliance
   - Integration point verification

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-synthesis-agent-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-3,500 tokens

OPTIMIZATION NOTE: Phase 2 merges old Phases 3 (Architecture Design) and 4 (Architecture Validation). Analysis validates while analyzing.

---

PHASE 3: Implementation Planning & Foundation

Cognitive Sequence: CLARIFICATION → GENERATION (combined plan + foundation)

Purpose: Clarify constraints and generate plan + foundation in one phase

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: ["implementation plan", "task breakdown", "project foundation/scaffold"]
  success_criteria: ["plan actionable", "foundation complete", "ready for implementation"]

Domain-Specific Artifacts:
- Technical: Project scaffold, configuration files, build setup, test infrastructure, implementation plan
- Personal: Framework templates, tracking systems, resources, implementation plan
- Creative: Content templates, style guides, tools setup, production plan
- Professional: Document templates, tracking systems, frameworks, execution plan
- Recreational: Planning documents, checklists, resources, coordination plan

Agent Invocations:

1. clarification-specialist (CLARIFICATION)
   Purpose: Clarify constraints before planning and foundation generation

   Gate Entry:
   - Validated architecture from Phase 2

   Gate Exit:
   - All constraints explicit
   - Deployment/operational requirements clarified
   - Integration points defined

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-synthesis-agent-memory.md (Phase 2) [REQUIRED - architecture]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 2,500-3,000 tokens

2. generation-agent (GENERATION)
   Purpose: Generate implementation plan AND project foundation

   Gate Entry:
   - Constraints clarified

   Gate Exit Decision:
   - PASS: Plan complete, foundation operational → Phase 4
   - FAIL: Foundation issues → Loop to generation-agent for fixes

   Generation Responsibilities (combined):
   - Implementation plan with milestones
   - Project scaffold/structure
   - Configuration and build setup
   - Test infrastructure (if technical)
   - Foundation validation (self-check)

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical - TDD setup)

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-clarification-specialist-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]
   - .claude/memory/task-{id}-synthesis-agent-memory.md (Phase 2) [OPTIONAL: architecture reference]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-4,000 tokens

OPTIMIZATION NOTE: Phase 3 merges old Phases 5 (Implementation Planning) and 6 (Foundation Generation). Generation creates both plan and foundation.

---

PHASE 4: Core Implementation (TDD Cycle)

Cognitive Sequence: GENERATION (iterative with self-validation)

Purpose: Implement core features/content/deliverables

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific)
  artifact_types: (domain-specific deliverables)
  success_criteria: (domain-specific - tests pass, milestones met, etc.)

Agent Invocations:

1. generation-agent (GENERATION) - ITERATIVE
   Purpose: Create core deliverables with built-in quality measures

   Gate Entry:
   - Foundation from Phase 3
   - Implementation plan from Phase 3

   Gate Exit Decision:
   - PASS: All core features complete, domain quality met → Phase 5
   - FAIL: Quality issues → Iterate within phase

   Self-Validation (embedded in TDD/domain process):
   - Technical: Tests pass (validation built into RED-GREEN-REFACTOR)
   - Personal: Milestones met, progress measurable
   - Creative: Quality iterations complete
   - Professional: KPIs tracked
   - Recreational: Logistics confirmed

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
   - .claude/protocols/agent-protocol-extended.md (if technical - TDD + Security)

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-generation-agent-memory.md (Phase 3) [IMMEDIATE PREDECESSOR - REQUIRED]
   - .claude/memory/task-{id}-synthesis-agent-memory.md (Phase 2) [OPTIONAL: architecture reference]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-4,000 tokens

OPTIMIZATION NOTE: Phase 4 is UNCHANGED from old Phase 7. TDD already includes validation (tests passing = validated).

---

PHASE 5: Security Audit & Documentation

Cognitive Sequence: VALIDATION → GENERATION

Purpose: Comprehensive validation and documentation in final phase

TASK CONTEXT:
  task_domain: [Inherited]
  quality_standards: (domain-specific security + documentation standards)
  artifact_types: ["validation report", "comprehensive documentation", "deployment guide"]
  success_criteria: ["security validated", "documentation complete", "deployment ready"]

Agent Invocations:

1. quality-validator (VALIDATION)
   Purpose: Comprehensive quality and security validation

   Gate Entry:
   - Core implementation from Phase 4

   Gate Exit Decision:
   - PASS: All quality gates met → Step 2 (documentation)
   - FAIL: Critical issues → Loop to Phase 4 for remediation

   Validation Scope (combined):
   - Implementation quality (tests, coverage, architecture compliance)
   - Domain-specific deep validation (security audit, sustainability, compliance, etc.)
   - Deployment readiness check

   Domain-Specific Validation:
   - Technical: Execute tests, verify coverage, security audit (OWASP Top 10), dependency scan, performance validation
     Criteria: All tests pass, 80%+ coverage, no HIGH/CRITICAL vulnerabilities

   - Personal: Progress review, milestone validation, sustainability check, support system validation
     Criteria: Milestones met, values aligned, sustainable approach, support adequate

   - Creative: Content quality review, audience testing, feedback incorporation, polish validation
     Criteria: Quality standards met, audience fit confirmed, feedback addressed

   - Professional: Deliverables review, KPI validation, market validation, financial review, compliance check
     Criteria: KPIs met, stakeholders satisfied, market viable, financially sound

   - Recreational: Preparations review, logistics validation, safety audit, accessibility review
     Criteria: Logistics complete, safety confirmed, accessible, participants ready

   Protocol References:
   - .claude/protocols/agent-protocol-extended.md (if technical - security checklist)

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-generation-agent-memory.md (Phase 4) [IMMEDIATE PREDECESSOR - REQUIRED]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-3,500 tokens

2. generation-agent (GENERATION)
   Purpose: Generate comprehensive documentation

   Gate Entry:
   - Validation passed

   Gate Exit Decision:
   - GO: Documentation complete, all checklists satisfied → Phase 6 (completion)
   - NO-GO: Critical gaps → Remediate (loop to appropriate phase)

   Documentation Scope:
   - Domain-specific documentation suite
   - Deployment/handoff guide
   - Sustainability/maintenance plan

   Domain-Specific Documentation:
   - Technical: README, API docs, architecture docs, deployment guide, runbook
   - Personal: Progress documentation, resource guide, sustainability plan, review schedule
   - Creative: Style guide, production notes, distribution plan, future iteration guide
   - Professional: Strategy document, operational guide, KPI dashboard, stakeholder brief
   - Recreational: Event guide, participant instructions, logistics document, contingency plans

   Context References:
   - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
   - .claude/memory/task-{id}-generation-agent-memory.md (Phase 4) [REQUIRED - implementation]
   - .claude/memory/task-{id}-quality-validator-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

   Context Scope: IMMEDIATE_PREDECESSORS
   Token Budget: 3,000-3,500 tokens

OPTIMIZATION NOTE: Phase 5 merges old Phases 8 (Quality Validation) and 9 (Documentation). Single comprehensive validation before docs.

---

PHASE 6: Workflow Completion

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

OPTIMIZATION NOTE: Phase 6 is UNCHANGED from old Phase 10. No agent invocations.

---

DEPENDENCIES & REQUIREMENTS

REQUIRED SKILLS: None (standalone skill)

REQUIRED PROTOCOLS:
- .claude/protocols/agent-protocol-core.md (all agents - scoped context loading, token limits)
- .claude/protocols/agent-protocol-extended.md (technical domain code generation - TDD + Security)

REQUIRED REFERENCES:
- .claude/references/agent-registry.md (agent descriptions and capabilities)
- .claude/references/johari.md (context structure, type definitions, format, compression)
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
- current_phase: 0-6
- total_phases: 6
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

TOKEN BUDGET (per agent output):
- Johari Summary: 1,200 tokens maximum (strictly enforced)
- Step Overview: 500 words maximum (~750 tokens)
- Downstream Directives: 300 tokens maximum
- TOTAL per agent: 2,500-3,000 tokens target, 300-400 lines

---

PERFORMANCE CONSIDERATIONS

TOKEN BUDGET:
- Workflow metadata: ~500 tokens
- Agent outputs (Johari format, compressed): ~300-400 lines each (1,200 token Johari max)
- Total estimated: 3,000-5,000 tokens for complete workflow

CONTEXT COMPRESSION:
- Scoped context loading: Agents read immediate predecessors only (not all previous outputs)
- Johari Window format with strict token limits
- Reference previous findings without repetition
- Domain insights extracted separately
- Unknown Registry tracks gaps systematically

REMEDIATION EFFICIENCY:
- Embedded validation prevents cascading errors
- Targeted loops to specific agents reduce rework
- Sequential agent execution maintains clarity
- Exit criteria clearly defined

---

USAGE EXAMPLES

EXAMPLE 1: Technical Project - OAuth2 Authentication System

Domain: technical
Target: Node.js API with JWT tokens

Cognitive Flow:
- Phase 0: Clarify OAuth2 provider, security requirements → Analyze dependencies, validate SMART requirements (2 agents)
- Phase 1: Research OAuth2 libraries → Synthesize technology stack decision (2 agents)
- Phase 2: Research security patterns → Synthesize secure architecture → Analyze quality (3 agents)
- Phase 3: Clarify deployment constraints → Generate TDD plan + project scaffold (2 agents)
- Phase 4: Implement OAuth2 flow using TDD (tests first, then code) (1 agent, iterative)
- Phase 5: Validate tests pass + security audit → Generate API docs and deployment guide (2 agents)
- Phase 6: Deliver working OAuth2 system with tests and docs

EXAMPLE 2: Personal Project - Career Transition Planning

Domain: personal

Cognitive Flow:
- Phase 0: Clarify career goals, values, constraints → Analyze current situation, validate completeness (2 agents)
- Phase 1: Research target roles, market trends → Synthesize optimal career path (2 agents)
- Phase 2: Research transition frameworks → Synthesize personalized strategy → Analyze feasibility (3 agents)
- Phase 3: Clarify timeline/resources → Generate action plan + tracking templates (2 agents)
- Phase 4: Implement initial actions (skill building, networking, applications) (1 agent)
- Phase 5: Validate progress against milestones → Generate sustainability guide (2 agents)
- Phase 6: Deliver complete career transition plan with tracking system

---

REMEMBER

This skill transforms ideas into reality through systematic cognitive processing. Every phase builds on the last, embedded validation ensures quality, every agent performs its cognitive function excellently across ANY domain.

The workflow is systematic, the validation is rigorous, the output is comprehensive.

Trust the process, follow the embedded validation, respect the sequential execution, and watch ideas become deployment-ready deliverables.

6 cognitive agents. 6 optimized phases. Infinite domains. One proven workflow. 40% faster execution.
