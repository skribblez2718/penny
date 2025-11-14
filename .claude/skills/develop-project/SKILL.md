---
name: develop-project
version: 1.0.0
description: Comprehensive project-agnostic development workflow from concept to deployment-ready code. Orchestrates 20 agents across 10 phases implementing TDD and security-first approaches. Works for web apps, CLI tools, mobile apps, PWAs, AI applications through context-driven specialization.
status: production
complexity: complex
agents_required: 20
estimated_turns: 40-60
---

DEVELOP-PROJECT SKILL

OVERVIEW

The develop-project skill is a comprehensive, project-agnostic workflow that transforms vague project ideas into deployment-ready, tested, secure, documented code. It orchestrates 20 specialized agents across 10 carefully designed phases, each with explicit entry/exit gates ensuring quality at every step.

This skill works for ANY project type:
- Web Applications (frontend, backend, full-stack)
- CLI Tools (developer utilities, system tools)
- Mobile Applications (native, cross-platform)
- Progressive Web Apps (PWAs)
- AI Applications (chatbots, RAG systems, ML services)

Specialization happens through context injection, not hardcoded logic. The same agents and workflow adapt to different domains by receiving project-type-specific context at invocation.

KEY FEATURES

- 10-PHASE WORKFLOW: Clear separation of concerns from requirements through deployment
- 20 SPECIALIZED AGENTS: Each performs one cognitive function excellently
- GATE-BASED VALIDATION: Quality gates prevent bad decisions from reaching implementation
- TDD-INTEGRATED: Test-driven development protocol applied throughout
- SECURITY-FIRST: OWASP Top 10 and secure coding from architecture through code
- PROJECT-AGNOSTIC: Same workflow for web/CLI/mobile/AI through context adaptation
- REMEDIATION LOOPS: Failed validations loop back to fix issues, not proceed broken
- COMPREHENSIVE OUTPUT: Working code + tests + docs + deployment guide

ARCHITECTURE

WORKFLOW PHASES (10 Phases)

PHASE 0: Requirements Clarification & Analysis
- Agents: project-requirements-clarifier → requirements-analyzer → requirements-validator
- Input: Vague project idea from user
- Output: Validated, prioritized requirements with acceptance criteria
- Gate: Requirements complete, testable, consistent

PHASE 1: Technology Research
- Agents: technology-researcher
- Input: Requirements, project type
- Output: Technology options researched with sources
- Gate: 3+ options per category researched

PHASE 2: Technology Evaluation & Selection
- Agents: technology-evaluator → technology-decision-synthesizer
- Input: Research findings, requirements
- Output: Technology stack decision with justification
- Gate: Stack coherent, requirements addressable

PHASE 3: Architecture Research & Design
- Agents: pattern-researcher → architecture-synthesizer
- Input: Requirements, technology stack
- Output: Architectural design with components, data models, APIs
- Gate: All requirements mapped to components

PHASE 4: Architecture Validation
- Agents: architecture-analyzer → architecture-validator
- Input: Architecture design
- Output: Validated architecture or remediation plan
- Gate: No CRITICAL/HIGH issues, security validated
- Remediation: If FAIL → loop to Phase 3

PHASE 5: Implementation Planning
- Agents: implementation-plan-generator, technical-constraint-clarifier (parallel)
- Input: Validated architecture
- Output: Implementation plan with TDD milestones, technical constraints
- Gate: All tasks defined, TDD milestones scheduled

PHASE 6: Code Structure Generation
- Agents: code-structure-generator
- Input: Architecture, implementation plan
- Output: Complete project scaffold with configs, test infrastructure
- Gate: Build succeeds, test framework runs

PHASE 7: Core Implementation & Testing
- Agents: core-implementation-generator → test-generator
- Input: Project scaffold, architecture
- Output: Implemented features with comprehensive test suite
- Gate: Features implemented, tests written

PHASE 8: Quality Validation
- Agents: implementation-validator → security-validator
- Input: Implementation + tests
- Output: Validation reports (tests + security)
- Gate: All tests pass, no HIGH/CRITICAL vulnerabilities
- Remediation: If FAIL → loop to Phase 7

PHASE 9: Documentation & Deployment Readiness
- Agents: documentation-generator → deployment-readiness-validator → project-delivery-coordinator
- Input: Validated implementation
- Output: Complete project package (code + tests + docs + deployment guide)
- Gate: Deployment checklist satisfied, GO decision

STATE MANAGEMENT

WORKFLOW METADATA (JSON in task memory):
```json
{
  "workflowMetadata": {
    "taskId": "task-{project-name}",
    "workflowType": "develop-project",
    "projectType": "web_app|cli_tool|mobile_app|pwa|ai_app",
    "targetPlatform": "browser|node|desktop|mobile|edge",
    "startDate": "2025-11-14T10:30:00Z",
    "currentPhase": 0,
    "totalPhases": 10,
    "criticalConstraints": ["budget", "timeline", "technology"],
    "successCriteria": ["all tests pass", "security audit clean", "docs complete"],
    "blockingIssues": null
  },
  "unknownRegistry": {
    "unknowns": [
      {
        "id": "U1",
        "phase": 0,
        "category": "Requirements",
        "description": "User authentication method unclear",
        "resolutionPhase": 1,
        "status": "Unresolved|Resolved",
        "resolution": null
      }
    ]
  }
}
```

UNKNOWN REGISTRY

Tracks unknowns across phases with structured IDs:
- Agents flag unknowns with `[NEW-UNKNOWN]` markers
- Orchestrator assigns IDs (U1, U2, U3...)
- Agents resolve unknowns in designated phases
- Status lifecycle: Unresolved → In Progress → Resolved/Deferred

PHASE DEFINITIONS

PHASE 0: REQUIREMENTS CLARIFICATION & ANALYSIS

ENTRY GATE:
- User has provided initial project description
- Task ID generated (task-{project-name})
- Task memory file created

PHASE OBJECTIVES:
- Transform vague idea into explicit requirements
- Analyze dependencies, complexity, risks
- Validate requirements quality
- Establish clear scope boundaries

AGENT ORCHESTRATION:

AGENT 1: project-requirements-clarifier (CLARIFIER)
Purpose: Transform vague project idea into explicit requirements
Trigger: Phase 0 start
Instructions:
  1. Extract project concept from user input
  2. Identify ambiguities in description
  3. Interact with user via AskUserQuestion to clarify scope, features, users, metrics
  4. Formulate explicit requirements with Given-When-Then acceptance criteria
  5. Define scope boundaries (in/out of scope)
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass requirements to requirements-analyzer

AGENT 2: requirements-analyzer (ANALYZER)
Purpose: Analyze requirements for dependencies, complexity, risks, priorities
Trigger: requirements-clarifier completion
Instructions:
  1. Parse requirements from previous output
  2. Build dependency graph
  3. Assess complexity per requirement (SIMPLE/MEDIUM/COMPLEX)
  4. Map risks with likelihood×impact
  5. Apply MoSCoW prioritization
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass analysis to requirements-validator

AGENT 3: requirements-validator (VALIDATOR)
Purpose: Validate requirements quality (SMART criteria, testability, consistency)
Trigger: requirements-analyzer completion
Instructions:
  1. Validate completeness (all have acceptance criteria)
  2. Validate testability (can write tests from criteria)
  3. Check consistency (no contradictions)
  4. Generate validation report
  5. Make gate decision (PASS or FAIL)
Output Format: Append to task memory per JOHARI.md template
Handoff: PASS → Phase 1; FAIL → loop to project-requirements-clarifier

EXIT GATE:
- All requirements have explicit acceptance criteria
- All requirements are testable
- No contradictions identified
- Scope boundaries clear
- Dependencies mapped
- Priorities assigned (MoSCoW)
- Validation report: PASS

---

PHASE 1: TECHNOLOGY RESEARCH

ENTRY GATE:
- Phase 0 exit gate PASSED
- Requirements validated and prioritized

PHASE OBJECTIVES:
- Discover available technology options
- Gather official documentation
- Collect community insights
- Build knowledge base for evaluation

AGENT ORCHESTRATION:

AGENT 4: technology-researcher (RESEARCHER)
Purpose: Discover and gather technology options via WebSearch/WebFetch
Trigger: Phase 1 start
Instructions:
  1. Identify research categories from requirements and project type
  2. WebSearch for technology options (frameworks, databases, tools)
  3. WebFetch official documentation
  4. Collect community insights (adoption, maturity, activity)
  5. Document all sources with URLs and timestamps
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass research findings to Phase 2

EXIT GATE:
- All technology categories researched
- 3-5 options per category identified
- Official documentation URLs captured
- Community insights collected
- Source provenance documented

---

PHASE 2: TECHNOLOGY EVALUATION & SELECTION

ENTRY GATE:
- Phase 1 exit gate PASSED
- Technology research complete with sources

PHASE OBJECTIVES:
- Evaluate technology options against requirements
- Compare options with structured criteria
- Make informed technology stack decision
- Document decision rationale

AGENT ORCHESTRATION:

AGENT 5: technology-evaluator (ANALYZER)
Purpose: Evaluate technologies against requirements with structured criteria
Trigger: Phase 2 start
Instructions:
  1. Define evaluation criteria (requirement fit, maturity, community, performance, learning curve)
  2. Score each technology (1-5 scale) against criteria
  3. Calculate weighted totals
  4. Identify trade-offs (power vs simplicity, performance vs DX)
  5. Assess risks and deal-breakers per technology
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass evaluation to technology-decision-synthesizer

AGENT 6: technology-decision-synthesizer (SYNTHESIZER)
Purpose: Synthesize evaluation into final technology stack decision
Trigger: technology-evaluator completion
Instructions:
  1. Aggregate evaluation results and requirements
  2. Resolve conflicts between criteria
  3. Construct coherent technology stack
  4. Document decision rationale per technology
  5. Acknowledge trade-offs and risks
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass technology stack to Phase 3

EXIT GATE:
- Technology stack specified for all categories
- Each selection has evaluation-based justification
- Stack is coherent (technologies integrate well)
- Trade-offs explicitly acknowledged
- Requirements addressable by chosen stack

---

PHASE 3: ARCHITECTURE RESEARCH & DESIGN

ENTRY GATE:
- Phase 2 exit gate PASSED
- Technology stack finalized

PHASE OBJECTIVES:
- Research applicable architectural patterns
- Design system architecture
- Define components, data models, APIs
- Apply security-first principles

AGENT ORCHESTRATION:

AGENT 7: pattern-researcher (RESEARCHER)
Purpose: Research architectural and design patterns
Trigger: Phase 3 start
Instructions:
  1. Identify pattern categories from project type
  2. WebSearch for architectural patterns (MVC, layered, microservices)
  3. Research design patterns (Gang of Four, domain-specific)
  4. Collect anti-patterns (what to avoid)
  5. Document patterns with applicability criteria
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass pattern catalog to architecture-synthesizer

AGENT 8: architecture-synthesizer (SYNTHESIZER)
Purpose: Synthesize requirements, patterns, technology into architecture
Trigger: pattern-researcher completion
Instructions:
  1. Select architectural style (layered, MVC, microservices)
  2. Define components with responsibilities and interfaces
  3. Design data model (entities, relationships)
  4. Define integration points (APIs, external services)
  5. Apply security architecture (auth, authorization, data protection)
  6. Reference SECURITY-FIRST-DEVELOPMENT.md protocol
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass architecture to Phase 4

EXIT GATE:
- Architectural style selected and justified
- All requirements mapped to components
- Component interfaces defined
- Data model designed
- APIs specified
- Security architecture integrated

---

PHASE 4: ARCHITECTURE VALIDATION

ENTRY GATE:
- Phase 3 exit gate PASSED
- Architecture design complete

PHASE OBJECTIVES:
- Analyze architecture quality
- Validate against requirements and security standards
- Identify issues before implementation
- Make gate decision (proceed or remediate)

AGENT ORCHESTRATION:

AGENT 9: architecture-analyzer (ANALYZER)
Purpose: Analyze architecture for quality attributes
Trigger: Phase 4 start
Instructions:
  1. Analyze component structure (SOLID, coupling/cohesion)
  2. Evaluate quality attributes (scalability, maintainability, testability, performance)
  3. Validate requirement alignment
  4. Identify architectural risks and technical debt
  5. Provide recommendations
Output Format: Append to task memory per JOHARI.md template
Handoff: Pass analysis to architecture-validator

AGENT 10: architecture-validator (VALIDATOR)
Purpose: Validate architecture meets all quality gates
Trigger: architecture-analyzer completion
Instructions:
  1. Validate requirements coverage
  2. Validate security architecture (SECURITY-FIRST-DEVELOPMENT.md checklist)
  3. Validate patterns and principles
  4. Generate validation report with issues by severity
  5. Make gate decision (PASS or FAIL)
  6. Reference SECURITY-FIRST-DEVELOPMENT.md protocol
Output Format: Append to task memory per JOHARI.md template
Handoff: PASS → Phase 5; FAIL → loop to Phase 3

EXIT GATE:
- All requirements mapped to components
- No CRITICAL or 3+ HIGH security issues
- Security architecture validated
- Patterns applied correctly
- Component interfaces clear
- Validation report: PASS

---

PHASE 5: IMPLEMENTATION PLANNING

ENTRY GATE:
- Phase 4 exit gate PASSED
- Architecture validated

PHASE OBJECTIVES:
- Create detailed implementation plan
- Define TDD milestones
- Clarify technical constraints
- Establish testing strategy

AGENT ORCHESTRATION:

AGENT 11: implementation-plan-generator (GENERATOR)
Purpose: Create implementation plan with TDD milestones
Trigger: Phase 5 start
Instructions:
  1. Break architecture into implementation phases
  2. Create task breakdown structure (WBS)
  3. Define TDD milestones (RED-GREEN-REFACTOR per feature)
  4. Specify testing strategy (unit/integration/E2E)
  5. Document build/deployment pipeline
  6. Reference TEST-DRIVEN-DEVELOPMENT.md protocol
Output Format: Append to task memory per JOHARI.md template
Handoff: Plan available for Phase 6

AGENT 12: technical-constraint-clarifier (CLARIFIER)
Purpose: Clarify deployment, performance, integration constraints
Trigger: Phase 5 start (parallel with implementation-plan-generator)
Instructions:
  1. Identify technical ambiguities
  2. Interact with user via AskUserQuestion (deployment env, performance SLAs, integrations)
  3. Formulate explicit constraints
  4. Validate feasibility with selected stack
Output Format: Append to task memory per JOHARI.md template
Handoff: Constraints available for Phase 6

EXIT GATE:
- Implementation plan complete with phases and tasks
- TDD milestones defined per feature
- Testing strategy specified
- Technical constraints clarified
- Deployment environment specified
- Performance targets defined

---

PHASE 6: CODE STRUCTURE GENERATION

ENTRY GATE:
- Phase 5 exit gate PASSED
- Implementation plan and constraints defined

PHASE OBJECTIVES:
- Generate project scaffold
- Create secure configuration files
- Establish test infrastructure
- Prepare for implementation

AGENT ORCHESTRATION:

AGENT 13: code-structure-generator (GENERATOR)
Purpose: Create project scaffold with secure configs and test infrastructure
Trigger: Phase 6 start
Instructions:
  1. Create directory structure per architecture
  2. Generate configuration files with secure defaults
  3. Create boilerplate code following patterns
  4. Generate test directory structure
  5. Document setup instructions
  6. Reference SECURITY-FIRST-DEVELOPMENT.md and TEST-DRIVEN-DEVELOPMENT.md protocols
Output Format: Append to task memory per JOHARI.md template
Handoff: Scaffold ready for Phase 7

EXIT GATE:
- All directories created
- Configuration files generated with secure defaults
- Boilerplate code follows architecture
- Test infrastructure ready
- Setup documentation complete
- Build succeeds

---

PHASE 7: CORE IMPLEMENTATION & TESTING

ENTRY GATE:
- Phase 6 exit gate PASSED
- Project scaffold complete

PHASE OBJECTIVES:
- Implement core features using TDD
- Generate comprehensive test suite
- Achieve coverage targets
- Follow secure coding practices

AGENT ORCHESTRATION:

AGENT 14: core-implementation-generator (GENERATOR)
Purpose: Implement features using TDD RED-GREEN-REFACTOR cycle
Trigger: Phase 7 start
Instructions:
  1. For each feature: RED (write test) → GREEN (implement) → REFACTOR (improve)
  2. Apply security controls (input validation, auth checks)
  3. Create integration points per architecture
  4. Implement error handling and logging
  5. Follow coding standards
  6. Reference SECURITY-FIRST-DEVELOPMENT.md and TEST-DRIVEN-DEVELOPMENT.md protocols
Output Format: Append to task memory per JOHARI.md template
Handoff: Implementation to test-generator

AGENT 15: test-generator (GENERATOR)
Purpose: Generate comprehensive test suite
Trigger: core-implementation-generator completion
Instructions:
  1. Review implementation for coverage gaps
  2. Add unit tests (functions, edge cases, errors)
  3. Add integration tests (APIs, database, services)
  4. Add E2E tests (user workflows)
  5. Achieve 80%+ coverage target
  6. Reference TEST-DRIVEN-DEVELOPMENT.md protocol
Output Format: Append to task memory per JOHARI.md template
Handoff: Tests to Phase 8

EXIT GATE:
- All planned features implemented
- Tests written for all features
- Test suite comprehensive (unit/integration/E2E)
- Coverage approaching 80%+

---

PHASE 8: QUALITY VALIDATION

ENTRY GATE:
- Phase 7 exit gate PASSED
- Implementation and tests complete

PHASE OBJECTIVES:
- Execute tests and verify pass
- Validate code quality
- Conduct security audit
- Make gate decision (deploy-ready or fix)

AGENT ORCHESTRATION:

AGENT 16: implementation-validator (VALIDATOR)
Purpose: Validate implementation quality and test execution
Trigger: Phase 8 start
Instructions:
  1. Execute test suite via Bash
  2. Validate architecture compliance
  3. Check coding standards
  4. Verify security basics (no hardcoded secrets, input validation)
  5. Confirm error handling
  6. Make gate decision (PASS or FAIL)
  7. Reference SECURITY-FIRST-DEVELOPMENT.md and TEST-DRIVEN-DEVELOPMENT.md protocols
Output Format: Append to task memory per JOHARI.md template
Handoff: PASS → security-validator; FAIL → loop to Phase 7

AGENT 17: security-validator (VALIDATOR)
Purpose: Conduct comprehensive security audit
Trigger: implementation-validator PASS
Instructions:
  1. Audit against OWASP Top 10
  2. Scan code for vulnerabilities (injection, XSS, etc.)
  3. Run dependency vulnerability scan (npm audit, pip-audit)
  4. Review authentication/authorization implementation
  5. Check configuration security
  6. Make gate decision (PASS or FAIL)
  7. Reference SECURITY-FIRST-DEVELOPMENT.md protocol
Output Format: Append to task memory per JOHARI.md template
Handoff: PASS → Phase 9; FAIL → loop to Phase 7

EXIT GATE:
- All tests pass (zero failures)
- Test coverage meets target (80%+)
- No CRITICAL or HIGH security vulnerabilities
- Code follows architecture
- Coding standards met
- Validation reports: PASS

---

PHASE 9: DOCUMENTATION & DEPLOYMENT READINESS

ENTRY GATE:
- Phase 8 exit gate PASSED
- Implementation validated, secure

PHASE OBJECTIVES:
- Generate complete documentation
- Verify deployment readiness
- Aggregate all deliverables
- Produce final project package

AGENT ORCHESTRATION:

AGENT 18: documentation-generator (GENERATOR)
Purpose: Generate comprehensive documentation suite
Trigger: Phase 9 start
Instructions:
  1. Generate README (setup, quickstart, features)
  2. Create API documentation
  3. Produce architecture diagrams and decisions
  4. Write usage guides and examples
  5. Document deployment procedures
Output Format: Append to task memory per JOHARI.md template
Handoff: Docs to deployment-readiness-validator

AGENT 19: deployment-readiness-validator (VALIDATOR)
Purpose: Validate deployment readiness via checklist
Trigger: documentation-generator completion
Instructions:
  1. Validate deployment readiness checklist
  2. Confirm tests passing, docs complete, configs present
  3. Verify security addressed, logging implemented
  4. Make GO/NO-GO decision
Output Format: Append to task memory per JOHARI.md template
Handoff: GO → project-delivery-coordinator; NO-GO → remediate

AGENT 20: project-delivery-coordinator (COORDINATOR)
Purpose: Aggregate deliverables and produce final package
Trigger: deployment-readiness-validator GO
Instructions:
  1. Track all phase completions
  2. Aggregate deliverables (code, tests, docs, configs, reports)
  3. Review Unknown Registry (confirm critical unknowns resolved)
  4. Assemble final project package
  5. Signal workflow completion
Output Format: Append to task memory per JOHARI.md template
Handoff: Final package to user

EXIT GATE:
- Documentation complete (README, API, architecture, deployment)
- Deployment checklist satisfied
- GO decision confirmed
- All deliverables aggregated
- Final project package assembled

---

CONTEXT INJECTION STRATEGY

Each agent receives project-type context via Step Context at invocation:

```
Task ID: task-recipe-app
Step: 7
Step Name: Core Implementation Generation
Purpose: Implement features using TDD RED-GREEN-REFACTOR
Gate Entry: Project scaffold complete, tests pass
Gate Exit: Features implemented with tests, coverage 80%+

PROJECT CONTEXT:
  project_type: web_app
  target_platform: browser
  technology_stack:
    frontend: Next.js
    database: PostgreSQL
    authentication: NextAuth.js
    deployment: Vercel
  requirements_summary: Recipe CRUD, search, favorites, user auth
  constraints:
    deployment: Cloud (Vercel free tier)
    performance: Search results < 500ms
    security: OWASP Top 10 compliance required

[Agent-specific instructions from SKILL.md]
```

Agents adapt behavior based on context:
- Web app → Generate React components, API routes
- CLI tool → Generate Click commands, argument parsing
- Mobile app → Generate Flutter widgets, state management
- AI app → Generate model integration, vector DB operations

Same agents, different specialization through context.

---

ERROR HANDLING & REMEDIATION

REMEDIATION LOOPS:

Phase 4 Architecture Validation FAIL:
- Loop back to Phase 3 (Architecture Research & Design)
- architecture-synthesizer revises design
- Re-run Phase 4 validation

Phase 8 Quality Validation FAIL:
- Loop back to Phase 7 (Core Implementation & Testing)
- core-implementation-generator fixes issues
- test-generator adds missing tests
- Re-run Phase 8 validation

CRITICAL BLOCKERS:

If showstopper issue detected:
- Halt workflow
- Document blocker in Unknown Registry
- Flag in Downstream Directives
- Require user intervention before proceeding

---

USAGE EXAMPLES

SCENARIO 1: Simple Web Application

User input: "Build a recipe management app"

Phase 0: Clarify → 4 requirements (auth, CRUD, search, favorites)
Phase 1: Research → Next.js, PostgreSQL, NextAuth.js
Phase 2: Evaluate → Next.js selected (integrated, Vercel-ready)
Phase 3: Design → 3-tier architecture, 4 components, PostgreSQL schema
Phase 4: Validate → PASS (security architecture sound)
Phase 5: Plan → 3 implementation phases, TDD milestones
Phase 6: Scaffold → Next.js project created, tests configured
Phase 7: Implement → Recipe CRUD, auth, search implemented with tests
Phase 8: Validate → All tests pass, security audit clean
Phase 9: Document → README, API docs, deployment guide created
Final: Working Next.js app with PostgreSQL, 95% test coverage, deployment-ready

SCENARIO 2: CLI Tool

User input: "Create a developer utility for managing git workflows"

Phase 0: Clarify → Commands (init, branch, merge, release)
Phase 1: Research → Python Click, GitPython library
Phase 2: Evaluate → Click selected (CLI-first, plugin architecture)
Phase 3: Design → Command pattern, plugin system
Phase 4: Validate → PASS
Phase 5: Plan → 4 commands, TDD per command
Phase 6: Scaffold → Python package, Click setup, tests
Phase 7: Implement → Commands with GitPython integration, tests
Phase 8: Validate → Tests pass, no vulnerabilities
Phase 9: Document → README, command help, distribution guide
Final: Python CLI tool, pip installable, 90% coverage

---

PERFORMANCE CONSIDERATIONS

Token Budget Estimates:
- 10 phases × ~500 tokens per phase = ~5000 tokens
- Well within context limits (200k+ tokens available)
- Progressive disclosure maintains efficiency

Execution Time:
- Sequential phases: ~40-60 agent invocations
- User interaction pauses: Phases 0, 5 (clarification)
- Total time: 2-4 hours for small project, 4-8 hours for complex

Parallel Opportunities:
- Phase 5: implementation-plan-generator + technical-constraint-clarifier run concurrently

---

DEPENDENCIES

REQUIRED SKILLS: None (standalone skill)

REQUIRED PROTOCOLS:
- .claude/protocols/CONTEXT-INHERITANCE.md (all agents use 5-step protocol)
- .claude/protocols/TEST-DRIVEN-DEVELOPMENT.md (TDD implementation)
- .claude/protocols/SECURITY-FIRST-DEVELOPMENT.md (security validation)
- .claude/protocols/REASONING-STRATEGIES.md (systematic reasoning)
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md (output quality)

REQUIRED AGENTS (20):
- All agents listed in AGENT-REGISTRY.md under develop-project

REQUIRED TEMPLATES:
- .claude/templates/JOHARI.md (memory format)

---

TESTING PROTOCOL

VALIDATION STRATEGY:

Unit Test (Per Phase):
- Verify agent produces expected output format
- Validate JOHARI sections present
- Confirm token budgets respected

Integration Test (Multi-Phase):
- Run Phases 0-2 (requirements through technology selection)
- Verify information flows correctly between agents
- Confirm context inheritance working

End-to-End Test (Full Workflow):
- Execute complete workflow with real project request
- Verify final deliverable completeness
- Validate tests pass, security audit clean
- Confirm documentation complete

Test Cases:
1. Simple web app (recipe manager)
2. CLI tool (developer utility)
3. AI application (RAG chatbot)

Success Criteria:
- All phases complete without errors
- Gate validations pass
- Final deliverable includes: code, tests (80%+ coverage), docs, deployment guide
- Security audit clean (no HIGH/CRITICAL)

---

MAINTENANCE NOTES

ADDING NEW AGENTS:
1. Create agent following AGENT-DESIGN-PRINCIPLES.md
2. Update AGENT-REGISTRY.md
3. Add agent to appropriate phase in SKILL.md
4. Update agent count in frontmatter
5. Test integration with workflow

MODIFYING PHASES:
1. Update phase definition in this file
2. Update affected agent invocations
3. Update gate criteria if needed
4. Re-test workflow end-to-end

TROUBLESHOOTING:
- Gate failures: Check previous phase outputs for completeness
- Context inheritance issues: Verify task memory format matches JOHARI.md
- Agent errors: Check agent receives required context from Step Context
- Unknown resolution: Ensure Unknown Registry properly updated

---

REMEMBER

This skill transforms chaos into deployable reality. Every phase builds on the last, every gate ensures quality, every agent performs its cognitive function excellently. The workflow is systematic, the validation is rigorous, the output is comprehensive. Trust the process, follow the gates, and watch ideas become production-ready code.
