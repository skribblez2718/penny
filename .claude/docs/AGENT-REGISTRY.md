AGENT REGISTRY

Catalog of existing agents organized by COGNITIVE FUNCTION. Use this registry to discover reusable agents and prevent agent proliferation.

PURPOSE

Before creating a new agent, consult this registry to check if an agent with the required cognitive function already exists. Agents are designed for reusability across workflows - the same agent can perform its cognitive function in different domain contexts.

---

RESEARCHER AGENTS

Agents that discover and gather information from external sources.

- technology-researcher: Discovers technologies, frameworks, libraries relevant to requirements via WebSearch/WebFetch. Gathers documentation, community insights, maturity indicators. Project-agnostic.

- pattern-researcher: Gathers architectural/design patterns via WebSearch. Researches patterns for ANY context (MVC, MVVM, Command, RAG), collects anti-patterns, documents applicability criteria.

---

ANALYZER AGENTS

Agents that examine existing information to identify patterns, issues, or insights.

- requirements-analyzer: Examines requirements to identify dependencies, complexity, risks, prioritization. Creates dependency graphs, complexity scores, risk matrices, MoSCoW prioritization.

- technology-evaluator: Evaluates researched technologies against requirements using structured criteria. Creates comparison matrices, identifies trade-offs, assesses team fit, flags deal-breakers.

- architecture-analyzer: Evaluates architecture for scalability, maintainability, testability. Applies SOLID principles, assesses quality attributes, identifies risks and technical debt.

---

SYNTHESIZER AGENTS

Agents that combine multiple information sources into coherent understanding.

- technology-decision-synthesizer: Combines research and evaluation into technology stack decision. Cross-references requirements, resolves conflicts, documents rationale and alternatives.

- architecture-synthesizer: Combines requirements, patterns, and technology into architectural design. Defines components, data models, APIs. References SECURITY-FIRST-DEVELOPMENT.md.

---

GENERATOR AGENTS

Agents that create new artifacts, plans, specifications, or implementations.

- implementation-plan-generator: Creates implementation plan with TDD milestones, task breakdown (WBS), testing strategy, deployment pipeline. References TEST-DRIVEN-DEVELOPMENT.md.

- code-structure-generator: Creates project scaffold, directory structure, config files, boilerplate code, test infrastructure. References SECURITY-FIRST-DEVELOPMENT.md and TEST-DRIVEN-DEVELOPMENT.md.

- core-implementation-generator: Implements core features using TDD RED-GREEN-REFACTOR cycle. Secure coding, input validation, architecture patterns. References SECURITY-FIRST-DEVELOPMENT.md and TEST-DRIVEN-DEVELOPMENT.md.

- test-generator: Creates comprehensive test suite (unit/integration/E2E). Achieves 80%+ coverage. References TEST-DRIVEN-DEVELOPMENT.md.

- documentation-generator: Creates README, API docs, architecture diagrams, usage guides, deployment procedures. Complete documentation suite.

---

VALIDATOR AGENTS

Agents that verify correctness, completeness, or compliance.

- requirements-validator: Verifies requirements meet SMART criteria (Specific, Measurable, Achievable, Relevant, Testable), checks consistency, ensures traceability. Gate agent.

- architecture-validator: Validates architecture satisfies requirements and security standards. References SECURITY-FIRST-DEVELOPMENT.md. Checks patterns, interfaces, testability. Gate agent.

- implementation-validator: Verifies code quality, executes tests via Bash, validates architecture compliance, checks security basics. References SECURITY-FIRST-DEVELOPMENT.md and TEST-DRIVEN-DEVELOPMENT.md. Gate agent.

- security-validator: Deep security audit against OWASP Top 10. Validates auth/authz, checks injection vulnerabilities, crypto, input validation, dependency vulnerabilities. References SECURITY-FIRST-DEVELOPMENT.md. Gate agent.

- deployment-readiness-validator: Verifies deployment readiness via checklist (tests pass, docs complete, configs present, security addressed). Final gate agent.

---

CLARIFIER AGENTS

Agents that resolve ambiguities and transform vague inputs into explicit outputs.

- project-requirements-clarifier: Transforms vague project ideas into explicit, testable requirements with acceptance criteria. User interaction via AskUserQuestion. Works across all project types.

- technical-constraint-clarifier: Resolves ambiguities around deployment targets, performance requirements, integrations. Clarifies technical feasibility via user interaction.

---

COORDINATOR AGENTS

Agents that manage workflow state and orchestrate deliverable finalization.

- project-delivery-coordinator: Manages workflow across all phases, aggregates deliverables, resolves Unknown Registry, produces final project package.

---

SPECIALIZED AGENTS

Agents with specific domain knowledge but still aligned to cognitive functions.

No agents currently registered in this category.

---

USAGE GUIDELINES

BEFORE CREATING A NEW AGENT:

1. Identify required cognitive function (see COGNITIVE-FUNCTION-TAXONOMY.md)
2. Search this registry for agents with that function
3. If match exists → Reuse existing agent with workflow-specific context
4. If no match → Create new agent following AGENT-DESIGN-PRINCIPLES.md

WHEN TO CREATE NEW AGENT:

- Required cognitive function has no existing implementation
- Existing agent performs different cognitive function despite similar domain
- Reusability test shows agent can be used in 3+ workflows with only context changes

WHEN NOT TO CREATE NEW AGENT:

- Domain differs but cognitive function matches existing agent
- Agent would only be used in 1-2 workflows (consider inline orchestration)
- Agent would perform multiple cognitive functions (violates SCRP - split into multiple)

---

RELATED DOCUMENTS

- .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md - Cognitive function definitions
- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Agent design principles
- .claude/skills/develop-agent/resources/agent-description-simple.md - Simple agent template
- .claude/skills/develop-agent/resources/agent-description-complex.md - Complex agent template
- .claude/skills/develop-agent/SKILL.md - Agent creation workflow
