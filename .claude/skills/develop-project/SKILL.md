---
name: develop-project
description: Comprehensive domain-agnostic development workflow from concept to deployment-ready code. Orchestrates 6 universal cognitive agents across 6 optimized phases implementing TDD and security-first approaches
tags: project-development, full-lifecycle, tdd, security, domain-agnostic
---

# develop-project

**Description:** Comprehensive domain-agnostic development workflow from concept to deployment-ready code. Orchestrates 6 universal cognitive agents across 6 optimized phases implementing TDD and security-first approaches. Works for technical, personal, creative, professional, and recreational projects through cognitive domain adaptation.

**Status:** production

**Complexity:** complex

## Overview

The develop-project skill transforms project ideas into deployment-ready deliverables through systematic cognitive processing. It orchestrates 6 universal cognitive agents across 6 optimized phases with embedded quality validation ensuring excellence at every step.

### Domain Adaptation

This skill works across ALL domains through cognitive adaptation:

**Domains:**
- **technical:** Web apps, CLI tools, mobile apps, PWAs, AI applications, APIs
- **personal:** Life decisions, goal planning, habit systems, personal projects
- **creative:** Content creation, art projects, creative workflows, entertainment
- **professional:** Business strategies, operational plans, market analysis
- **recreational:** Event planning, game design, hobby projects

**Note:** Specialization happens through domain context, not agent specialization. The same 6 cognitive agents adapt their processing to the task domain.

## Key Features

- **6-phase-optimized-workflow:** Streamlined phases with embedded validation for faster execution (40% faster than 10-phase)
- **6-cognitive-agents:** Research, Analysis, Synthesis, Generation, Validation, Clarification
- **domain-adaptive:** Same workflow adapts to technical/personal/creative/professional/recreational
- **embedded-validation:** Quality checks integrated into cognitive agents, not separate phases
- **scoped-context-loading:** Agents load only immediate predecessors (50-60% token reduction)
- **sequential-execution:** Agents always invoked sequentially, never in parallel
- **tdd-integrated:** Test-driven development for technical projects (validation built-in)
- **security-first:** OWASP Top 10 and secure coding throughout technical implementations
- **remediation-loops:** Failed exit criteria loop back for fixes before proceeding
- **comprehensive-output:** Complete deliverables with validation and documentation

## Optimization Improvements

Compared to previous 10-phase workflow:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Agent invocations | 14-18 | 10-12 | 33% reduction |
| Execution time | 45-60 min | 20-30 min | 40-50% faster |
| Memory file sizes | 1,000-2,800 lines | 300-400 lines | 65-70% reduction |
| Token usage per phase | 6,500-8,000 | 2,000-3,000 | 60-70% reduction |
| Context loading | All previous outputs | Immediate predecessors only | Scoped |

## Cognitive Agent Architecture

This skill uses 6 universal cognitive agents that adapt to domain context:

**References:**
- **Agent descriptions:** See `.claude/references/agent-registry.md`
- **Context structure:** See `.claude/references/johari.md` (Johari Window format)
- **Context inheritance:** See `.claude/references/context-inheritance.md` (examples)
- **Execution protocols (core):** See `.claude/protocols/agent-protocol-core.md` (all agents - includes scoped context loading)
- **Execution protocols (extended):** See `.claude/protocols/agent-protocol-extended.md` (technical code generation)

**Important:** Agents are ALWAYS invoked sequentially, never in parallel.

## Workflow

### Phase 0: Requirements Discovery and Analysis

**Cognitive Sequence:** CLARIFICATION → ANALYSIS (embedded validation)

**Purpose:** Transform vague ideas into validated requirements with embedded quality checks

**Task Context:**
- **Task Domain:** Established from user input - technical/personal/creative/professional/recreational
- **Quality Standards:** testable, SMART criteria, consistent, prioritized
- **Artifact Types:** requirements specification, acceptance criteria, dependency graph
- **Success Criteria:** requirements explicit, acceptance tests defined, dependencies mapped, quality validated

#### Agent Invocations

**1. clarification-specialist (CLARIFICATION)**

**Purpose:** Transform vague project idea into explicit requirements

**Gate Entry:**
- User has provided initial project description
- Domain classification attempted

**Gate Exit:**
- All requirements have explicit acceptance criteria
- Scope boundaries defined
- Constraints documented

**Context Loading:** WORKFLOW_ONLY (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** None (first agent)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-clarification-specialist-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "WORKFLOW_ONLY",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**2. analysis-agent (ANALYSIS)**

**Purpose:** Analyze requirements for dependencies, complexity, risks AND validate quality

**Gate Entry:**
- Clarified requirements available

**Gate Exit Decision:**
- **PASS:** Requirements are SMART, consistent, complete → Phase 1
- **FAIL:** Issues found → Loop to clarification-specialist for remediation

**Validation Responsibilities (Embedded):**
- SMART compliance check (Specific, Measurable, Achievable, Relevant, Testable)
- Consistency verification (no contradictions)
- Dependency mapping
- Risk assessment with mitigation
- MoSCoW prioritization
- Traceability confirmation

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** clarification-specialist

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-analysis-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Optimization Note:** Phase 0 reduces from 3 agents (clarification, analysis, validation) to 2 agents by embedding validation into analysis. Analysis agent validates as it analyzes.

### Phase 1: Research and Decision Synthesis

**Cognitive Sequence:** RESEARCH → SYNTHESIS (embedded validation)

**Purpose:** Discover options and synthesize coherent decisions

**Task Context:**
- **Task Domain:** Inherited
- **Quality Standards:** 3+ sources, authoritative, evidence-based decisions
- **Artifact Types:** research findings, decision document, rationale
- **Success Criteria:** options identified, decisions made with rationale, trade-offs explicit

**Domain Adaptation:**
- **technical:** Technology/framework/library research, architectural patterns
- **personal:** Best practices, expert advice, case studies
- **creative:** Genre patterns, audience research, creative techniques
- **professional:** Market data, industry standards, competitive analysis
- **recreational:** Activity options, venues, planning resources

#### Agent Invocations

**1. research-discovery (RESEARCH)**

**Purpose:** Discover and evaluate information across domain

**Gate Entry:**
- Validated requirements from Phase 0

**Gate Exit:**
- Minimum 3 options per decision point
- Sources documented with credibility
- Knowledge gaps identified

**Context Injection (Technical Project Dependency Validation):**

*Note: Penny injects this for technical projects*

```
Library Research Must Include Dependency Validation:

VERSION COMPATIBILITY:
- Check compatibility with other selected libraries/frameworks
- Identify known version conflicts (search: "library_name version conflict")
- Document compatible version ranges (e.g., "requires Python 3.9+, compatible with FastAPI 0.100+")
- Flag libraries with restrictive dependency constraints

INSTALLATION TESTING:
- Verify installation method (uv add, pip install, conda)
- Document exact installation command: uv add library_name==version
- Flag any installation issues or system dependencies required
- Note if library requires compilation (C extensions, Rust, etc.)

DEPENDENCY ANALYSIS:
- What dependencies does this library pull in? (transitive dependencies)
- Are there conflicts with project dependencies already selected?
- Total dependency footprint (number of packages installed)
- Any security-sensitive dependencies?

KNOWN CONFLICTS TO FLAG:
- Example: py-vapid + cryptography version conflicts
- Example: TensorFlow + NumPy version pinning
- Example: Outdated libraries with unmaintained dependencies

DOCUMENT IN JOHARI:
- open: Library selection with versions
- hidden: Installation method, compatibility checks performed
- blind: Untested version combinations, potential conflicts not validated
- unknown: Actual installation success (needs testing), production behavior
```

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** analysis-agent

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-research-discovery-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**2. synthesis-agent (SYNTHESIS)**

**Purpose:** Synthesize evaluation into coherent decisions AND validate completeness

**Gate Entry:**
- Research findings available

**Gate Exit Decision:**
- **PASS:** Decisions coherent, alternatives documented → Phase 2
- **FAIL:** Incomplete research → Loop to research-discovery

**Validation Responsibilities (Embedded):**
- Decision completeness check
- Rationale quality verification
- Conflict resolution confirmation
- Trade-offs explicitly stated

**Context Injection (Technical Project Synthesis Requirements):**

*Note: Penny injects this for technical projects*

```
For Every Library/Technology Selected, Document:

DECISION RATIONALE:
- Exact version chosen (not "latest" - specify X.Y.Z)
- Why this library over alternatives (specific reasons)
- Compatibility verified with: [list other selected libraries]
- Installation tested: [command used, e.g., "uv add fastapi==0.104.1"]

DEPENDENCY DOCUMENTATION:
- Direct dependencies: [what this library needs]
- Transitive dependencies: [what gets pulled in]
- Conflicts resolved: [document any conflicts found and how resolved]
- Version constraints: [e.g., "requires Python >=3.9, <4.0"]

FLAG UNRESOLVED ISSUES IN JOHARI:
- blind: Dependencies not yet installed (theoretical compatibility only)
- unknown: Production behavior, performance at scale, actual installation success
- unknown: Edge cases with specific version combinations

VALIDATION CRITERIA:
- All selected libraries have explicit versions
- Compatibility matrix complete (Library A version X works with Library B version Y)
- Installation commands documented for each dependency
- Known conflicts addressed or flagged as unknowns
```

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** research-discovery
**Optional References:**
- analysis-agent (requirements for alignment check)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-synthesis-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Optimization Note:** Phase 1 merges old Phases 1 (Research) and 2 (Evaluation and Decision). Synthesis naturally validates research completeness.

### Phase 2: Architecture Design and Validation

**Cognitive Sequence:** RESEARCH → SYNTHESIS → ANALYSIS (embedded validation)

**Purpose:** Research patterns, design architecture, and validate quality

**Task Context:**
- **Task Domain:** Inherited
- **Quality Standards:** Domain-specific (see domain_specific_standards)
- **Artifact Types:** Domain-specific (see domain_specific_standards)
- **Success Criteria:** complete design, patterns applied, no critical issues, quality validated

**Domain-Specific Standards:**

**Technical:**
- **Quality Standards:** security-first, SOLID principles, scalable, testable
- **Artifacts:** architecture design, component specifications, API definitions, data models

**Personal:**
- **Quality Standards:** value-aligned, realistic, measurable, flexible
- **Artifacts:** life framework, milestone plan, support system design

**Creative:**
- **Quality Standards:** audience-appropriate, thematically coherent, engaging
- **Artifacts:** creative framework, narrative structure, content outline

**Professional:**
- **Quality Standards:** market-aligned, resource-constrained, scalable, measurable
- **Artifacts:** strategic framework, operational plan, resource allocation

**Recreational:**
- **Quality Standards:** fun-maximizing, inclusive, feasible, flexible
- **Artifacts:** activity framework, schedule outline, contingency plans

#### Agent Invocations

**1. research-discovery (RESEARCH)**

**Purpose:** Research architectural/design patterns applicable to domain

**Gate Entry:**
- Decisions from Phase 1

**Gate Exit:**
- Relevant patterns documented
- Applicability criteria defined
- Anti-patterns noted

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** synthesis-agent

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-research-discovery-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**2. synthesis-agent (SYNTHESIS)**

**Purpose:** Synthesize architecture/framework from patterns and decisions

**Gate Entry:**
- Pattern research complete

**Gate Exit:**
- Complete architecture/framework design
- Components clearly defined
- Integration points specified

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md` (if technical domain)

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** research-discovery
**Optional References:**
- synthesis-agent (Phase 1 decisions context)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical domain]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-synthesis-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**3. analysis-agent (ANALYSIS)**

**Purpose:** Analyze design for quality AND perform embedded validation

**Gate Entry:**
- Architecture/framework design complete

**Gate Exit Decision:**
- **PASS:** No CRITICAL issues, acceptable quality → Phase 3
- **FAIL:** CRITICAL issues found → Loop to synthesis-agent (step 2) for redesign

**Validation Responsibilities (Embedded):**
- Domain-specific quality analysis (SOLID, security, values alignment, etc.)
- Issue categorization (CRITICAL/HIGH/MEDIUM/LOW)
- Architecture pattern compliance
- Integration point verification

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** synthesis-agent

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-analysis-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Optimization Note:** Phase 2 merges old Phases 3 (Architecture Design) and 4 (Architecture Validation). Analysis validates while analyzing.

### Phase 3: Implementation Planning and Foundation

**Cognitive Sequence:** CLARIFICATION → GENERATION (combined plan + foundation)

**Purpose:** Clarify constraints and generate plan + foundation in one phase

**Task Context:**
- **Task Domain:** Inherited
- **Quality Standards:** Domain-specific
- **Artifact Types:** implementation plan, task breakdown, project foundation/scaffold
- **Success Criteria:** plan actionable, foundation complete, ready for implementation

**Domain-Specific Artifacts:**
- **technical:** Project scaffold, configuration files, build setup, test infrastructure, implementation plan
- **personal:** Framework templates, tracking systems, resources, implementation plan
- **creative:** Content templates, style guides, tools setup, production plan
- **professional:** Document templates, tracking systems, frameworks, execution plan
- **recreational:** Planning documents, checklists, resources, coordination plan

#### Agent Invocations

**1. clarification-specialist (CLARIFICATION)**

**Purpose:** Clarify constraints before planning and foundation generation

**Gate Entry:**
- Validated architecture from Phase 2

**Gate Exit:**
- All constraints explicit
- Deployment/operational requirements clarified
- Integration points defined

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** synthesis-agent

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-clarification-specialist-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**2. generation-agent (GENERATION)**

**Purpose:** Generate implementation plan AND project foundation

**Gate Entry:**
- Constraints clarified

**Gate Exit Decision:**
- **PASS:** Plan complete, foundation operational → Phase 4
- **FAIL:** Foundation issues → Loop to generation-agent for fixes

**Generation Responsibilities (Combined):**
- Implementation plan with milestones
- Project scaffold/structure
- Configuration and build setup
- Test infrastructure (if technical)
- Foundation validation (self-check)

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md` (if technical - TDD setup)

**Context Injection (Python Project Foundation Setup):**

*Note: Penny injects this for Python technical projects*

```
Python Project Foundation Requirements (MUST complete in Phase 3):

CRITICAL: Environment setup happens NOW (Phase 3), NOT later.

STEP 1: Initialize uv Project
- Run: uv init project_name
- Creates: pyproject.toml, .python-version, README.md
- Verify: pyproject.toml exists with [project] section

STEP 2: Create Virtual Environment
- Run: uv venv
- Creates: .venv/ directory
- Verify: .venv/bin/python exists

STEP 3: Add Base Dependencies
- Add dependencies: uv add package_name==version
- Example: uv add fastapi==0.104.1 uvicorn==0.24.0
- Verify: Dependencies listed in pyproject.toml

STEP 4: Create Project Structure
- Create: src/project_name/ directory
- Create: src/project_name/__init__.py
- Create: tests/ directory
- Create: tests/__init__.py
- Verify: All imports will use absolute paths (from project_name.module import Class)

STEP 5: Test Environment
- Run: uv sync (install all dependencies)
- Run: uv run python -c "import project_name; print('OK')"
- Verify: No import errors

GATE EXIT REQUIREMENTS:
- ✅ pyproject.toml exists and valid
- ✅ .venv/ directory exists
- ✅ Dependencies install: uv sync succeeds
- ✅ Project structure created (src/project_name/)
- ✅ NO requirements.txt file (forbidden)
- ✅ Environment validated (test import works)

If any fail, loop back to fix before Phase 4.
```

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** clarification-specialist
**Optional References:**
- synthesis-agent (Phase 2 architecture reference)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical - TDD setup]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-generation-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Optimization Note:** Phase 3 merges old Phases 5 (Implementation Planning) and 6 (Foundation Generation). Generation creates both plan and foundation.

### Phase 4: Core Implementation (TDD Cycle)

**Cognitive Sequence:** GENERATION (iterative with self-validation)

**Purpose:** Implement core features/content/deliverables

**Task Context:**
- **Task Domain:** Inherited
- **Quality Standards:** Domain-specific
- **Artifact Types:** Domain-specific deliverables
- **Success Criteria:** Domain-specific - tests pass, milestones met, etc.

#### Agent Invocations

**1. generation-agent (GENERATION) - ITERATIVE MODE**

**Purpose:** Create core deliverables with built-in quality measures

**Gate Entry:**
- Foundation from Phase 3
- Implementation plan from Phase 3

**Gate Exit Decision:**
- **PASS:** System works end-to-end (see criteria below) → Phase 5
- **FAIL:** Quality issues or system not functional → Iterate within phase

**End-to-End Validation Criteria (Python Projects):**
- ✅ Dependencies install: uv sync succeeds without errors
- ✅ Imports resolve: No ModuleNotFoundError when running code
- ✅ Tests pass: uv run pytest executes successfully
- ✅ Application starts: uv run python -m project_name runs without errors
- ✅ No relative imports: Code uses absolute imports only

**Generic Criteria (All Domains):**
- Core features implemented and functional
- Domain-specific quality standards met
- Self-validation passed (TDD for technical, milestones for personal, etc.)

**Self-Validation (Embedded):**
- **technical:** Tests pass (validation built into RED-GREEN-REFACTOR)
- **personal:** Milestones met, progress measurable
- **creative:** Quality iterations complete
- **professional:** KPIs tracked
- **recreational:** Logistics confirmed

**Domain-Specific Implementation:**

**Technical:**
- **Process:** TDD cycle (RED-GREEN-REFACTOR), secure coding, input validation
- **Quality:** 80%+ test coverage, no HIGH/CRITICAL security issues

**Personal:**
- **Process:** Action implementation, habit establishment, milestone achievement
- **Quality:** Measurable progress, documented outcomes, review completed

**Creative:**
- **Process:** Content creation, refinement cycles, quality iterations
- **Quality:** Audience-appropriate, thematically coherent, engaging

**Professional:**
- **Process:** Strategy execution, operational implementation, deliverable creation
- **Quality:** KPI tracking, stakeholder alignment, milestone achievement

**Recreational:**
- **Process:** Activity preparation, resource acquisition, participant coordination
- **Quality:** Logistics confirmed, safety validated, fun maximized

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md` (if technical - TDD + Security)

**Context Injection (Python Project Implementation):**

*Note: Penny injects this for Python technical projects*

```
Python Project Mandatory Requirements (from agent-protocol-extended.md Section 4.3):

IMPORT PATHS:
- ✅ ALWAYS use absolute imports: from project_name.module import Class
- ❌ NEVER use relative imports: from module import Class
- ❌ NEVER use relative imports: from .module import Class

Example:
# ❌ WRONG:
from database import Base
from models import User

# ✅ CORRECT:
from backend.database import Base
from backend.models import User

PACKAGE MANAGEMENT:
- ✅ ALWAYS use uv package manager: uv add, uv run, uv sync
- ❌ NEVER use pip directly: pip install
- ✅ Create pyproject.toml (NOT requirements.txt)
- ✅ Use uv venv for virtual environment

PROJECT STRUCTURE:
- Root must contain: pyproject.toml, .venv/, src/project_name/
- All code in src/project_name/ directory
- All imports reference project name: from project_name.module import Class

COMMANDS:
- Install deps: uv sync
- Add dependency: uv add package_name
- Run tests: uv run pytest
- Run app: uv run python -m project_name

See agent-protocol-extended.md Lines 308-430 for complete requirements.
```

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** generation-agent
**Optional References:**
- synthesis-agent (Phase 2 architecture reference)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical - TDD + Security]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-generation-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Optimization Note:** Phase 4 is UNCHANGED from old Phase 7. TDD already includes validation (tests passing = validated).

### Phase 5: Security Audit and Documentation

**Cognitive Sequence:** VALIDATION → GENERATION

**Purpose:** Comprehensive validation and documentation in final phase

**Task Context:**
- **Task Domain:** Inherited
- **Quality Standards:** Domain-specific security + documentation standards
- **Artifact Types:** validation report, comprehensive documentation, deployment guide
- **Success Criteria:** security validated, documentation complete, deployment ready

#### Agent Invocations

**1. quality-validator (VALIDATION)**

**Purpose:** Comprehensive quality and security validation

**Gate Entry:**
- Core implementation from Phase 4

**Gate Exit Decision:**
- **PASS:** All quality gates met → Step 2 (documentation)
- **FAIL:** Critical issues → Loop to Phase 4 for remediation

**Validation Scope (Combined):**
- Implementation quality (tests, coverage, architecture compliance)
- Domain-specific deep validation (security audit, sustainability, compliance, etc.)
- Deployment readiness check

**Domain-Specific Validation:**

**Technical:**
- **Validation:** Execute tests, verify coverage, security audit (OWASP Top 10), dependency scan, performance validation
- **Criteria:** All tests pass, 80%+ coverage, no HIGH/CRITICAL vulnerabilities

**Personal:**
- **Validation:** Progress review, milestone validation, sustainability check, support system validation
- **Criteria:** Milestones met, values aligned, sustainable approach, support adequate

**Creative:**
- **Validation:** Content quality review, audience testing, feedback incorporation, polish validation
- **Criteria:** Quality standards met, audience fit confirmed, feedback addressed

**Professional:**
- **Validation:** Deliverables review, KPI validation, market validation, financial review, compliance check
- **Criteria:** KPIs met, stakeholders satisfied, market viable, financially sound

**Recreational:**
- **Validation:** Preparations review, logistics validation, safety audit, accessibility review
- **Criteria:** Logistics complete, safety confirmed, accessible, participants ready

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md` (if technical - security checklist)

**Context Injection (Python Project Validation):**

*Note: Penny injects this for Python technical projects*

```
Python Project Validation Checklist:

IMPORT VALIDATION:
- [ ] All imports are absolute (grep for: ^from [a-z_]+ import)
- [ ] No relative imports exist (grep for: ^from \. import or from \.module)
- [ ] Project name used in all imports (from project_name.* pattern)

PACKAGE MANAGEMENT VALIDATION:
- [ ] pyproject.toml exists with [project] section
- [ ] .venv/ directory exists (virtual environment setup)
- [ ] NO requirements.txt file exists (pip-based - forbidden)
- [ ] Dependencies install cleanly: run `uv sync --dry-run`
- [ ] No dependency version conflicts in uv output

INSTALLATION VALIDATION:
- [ ] Virtual environment activates: .venv/bin/python exists
- [ ] Tests run successfully: `uv run pytest` command works
- [ ] Application starts: `uv run python -m project_name` works
- [ ] All imports resolve (no ModuleNotFoundError)

RUNTIME VALIDATION:
- [ ] Tests execute: uv run pytest (all tests pass)
- [ ] Coverage adequate: 80%+ test coverage
- [ ] Security scan: no HIGH/CRITICAL vulnerabilities
- [ ] Application functional end-to-end

FAILURE CRITERIA (must loop back to Phase 4 if any found):
- Relative imports detected
- requirements.txt exists
- uv sync fails
- Imports don't resolve
- Tests fail or cannot run
- Application doesn't start

CRITICAL: Validation must execute commands in actual working environment.
- Run actual: uv sync (not theoretical check)
- Run actual: uv run pytest (not just verify tests exist)
- Run actual: uv run python -m project_name (test application starts)
- Validation is NOT hypothetical - it must prove system works.
```

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** generation-agent

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical - security checklist]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-quality-validator-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**2. generation-agent (GENERATION)**

**Purpose:** Generate comprehensive documentation

**Gate Entry:**
- Validation passed

**Gate Exit Decision:**
- **GO:** Documentation complete, all checklists satisfied → Phase 6 (completion)
- **NO GO:** Critical gaps → Remediate (loop to appropriate phase)

**Documentation Scope:**
- Domain-specific documentation suite
- Deployment/handoff guide
- Sustainability/maintenance plan

**Domain-Specific Documentation:**
- **technical:** README, API docs, architecture docs, deployment guide, runbook
- **personal:** Progress documentation, resource guide, sustainability plan, review schedule
- **creative:** Style guide, production notes, distribution plan, future iteration guide
- **professional:** Strategy document, operational guide, KPI dashboard, stakeholder brief
- **recreational:** Event guide, participant instructions, logistics document, contingency plans

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** quality-validator
**Optional References:**
- generation-agent (Phase 4 implementation)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-generation-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Optimization Note:** Phase 5 merges old Phases 8 (Quality Validation) and 9 (Documentation). Single comprehensive validation before docs.

### Phase 6: Workflow Completion

**Purpose:** Finalize deliverables and complete workflow

**Task Context:** No agents invoked - workflow orchestration handles completion

**Actions:**
- Aggregate all phase outputs into final project package
- Review Unknown Registry for critical unresolved items
- Generate project completion summary
- Present complete deliverables to user
- **ALWAYS prompt for develop-learnings invocation** (see below)
- Signal workflow completion

**Final Deliverable Structure:**
- **technical:** Working code + comprehensive tests + documentation + deployment guide
- **personal:** Implemented framework + progress documentation + sustainability plan + review system
- **creative:** Finished content + style guide + production notes + distribution plan
- **professional:** Executed strategy + operational docs + KPI tracking + stakeholder reports
- **recreational:** Event ready + participant materials + logistics confirmed + contingency plans

**Completion Criteria:**
- All phases completed successfully
- All gate validations passed
- Critical unknowns resolved
- Deliverables complete per domain requirements
- User acceptance obtained

**MANDATORY Learning Capture Prompt:**

After presenting deliverables, ALWAYS use this prompt:

```
Would you like to capture learnings from this workflow using the develop-learnings skill?

This will extract insights and patterns from the develop-project workflow to improve future project development.
Task ID: task-{task-id}
```

- If user accepts: Invoke develop-learnings skill with task-id
- If user declines: Log decision and complete workflow

**FAILURE CONDITION:** Skipping the learning prompt breaks the continuous improvement loop and is a SYSTEM-LEVEL FAILURE.

**Optimization Note:** Phase 6 is UPDATED to include mandatory learning capture prompt. No agent invocations.

## Dependencies

### Required Skills

None (standalone skill)

### Required Protocols

- `.claude/protocols/agent-protocol-core.md` (all agents - scoped context loading, token limits)
- `.claude/protocols/agent-protocol-extended.md` (technical domain code generation - TDD + Security)

### Required References

- `.claude/references/agent-registry.md` (agent descriptions and capabilities)
- `.claude/references/johari.md` (context structure, type definitions, format, compression)
- `.claude/references/context-inheritance.md` (context-passing examples)

### Required Agents (Count: 6)

- clarification-specialist (CLARIFICATION function)
- research-discovery (RESEARCH function)
- analysis-agent (ANALYSIS function)
- synthesis-agent (SYNTHESIS function)
- generation-agent (GENERATION function)
- quality-validator (VALIDATION function)

## State Management

### Workflow Metadata

**Location:** `.claude/memory/task-{id}-memory.md`

**Format:** See `.claude/references/johari.md` for WorkflowMetadata schema

**Required Fields:**
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

### Unknown Registry

**Location:** Within workflow metadata file

**Format:** See `.claude/references/johari.md` for Unknown schema

**Required Fields Per Unknown:**
- id: U{number}
- phase: Phase where unknown identified
- category: Unknown category from taxonomy
- description: What is unknown
- resolution_phase: Phase where resolved
- cognitive_agent: Which cognitive function resolves it
- status: Unresolved|In Progress|Resolved|Deferred
- resolution: How it was resolved (when resolved)

### Agent Outputs

**Location:** `.claude/memory/task-{id}-{agent-name}-memory.md`

**Format:** Johari Window (see `.claude/references/johari.md`)

**Structure:**
- open: Confirmed knowledge shared by all
- hidden: Non-obvious insights discovered
- blind: Limitations and gaps
- unknown: Areas requiring other cognitive functions
- domain_insights: Domain-specific discoveries

### Token Budget

- **Johari summary:** 1,200 tokens maximum (strictly enforced)
- **Step overview:** 500 words maximum (~750 tokens)
- **Downstream directives:** 300 tokens maximum
- **Total per agent:** 2,500-3,000 tokens target, 300-400 lines

## Performance Considerations

### Token Budget

- **Workflow metadata:** ~500 tokens
- **Agent outputs:** ~300-400 lines each (1,200 token Johari max)
- **Total estimated:** 3,000-5,000 tokens for complete workflow

### Context Compression

- Scoped context loading: Agents read immediate predecessors only (not all previous outputs)
- Johari Window format with strict token limits
- Reference previous findings without repetition
- Domain insights extracted separately
- Unknown Registry tracks gaps systematically

### Remediation Efficiency

- Embedded validation prevents cascading errors
- Targeted loops to specific agents reduce rework
- Sequential agent execution maintains clarity
- Exit criteria clearly defined

## Usage Examples

### Example 1: Technical Project - OAuth2 Authentication System

**Domain:** technical

**Target:** Node.js API with JWT tokens

**Cognitive Flow:**
- **Phase 0:** Clarify OAuth2 provider, security requirements → Analyze dependencies, validate SMART requirements (2 agents)
- **Phase 1:** Research OAuth2 libraries → Synthesize technology stack decision (2 agents)
- **Phase 2:** Research security patterns → Synthesize secure architecture → Analyze quality (3 agents)
- **Phase 3:** Clarify deployment constraints → Generate TDD plan + project scaffold (2 agents)
- **Phase 4:** Implement OAuth2 flow using TDD (tests first, then code) (1 agent, iterative)
- **Phase 5:** Validate tests pass + security audit → Generate API docs and deployment guide (2 agents)
- **Phase 6:** Deliver working OAuth2 system with tests and docs

### Example 2: Personal Project - Career Transition Planning

**Domain:** personal

**Cognitive Flow:**
- **Phase 0:** Clarify career goals, values, constraints → Analyze current situation, validate completeness (2 agents)
- **Phase 1:** Research target roles, market trends → Synthesize optimal career path (2 agents)
- **Phase 2:** Research transition frameworks → Synthesize personalized strategy → Analyze feasibility (3 agents)
- **Phase 3:** Clarify timeline/resources → Generate action plan + tracking templates (2 agents)
- **Phase 4:** Implement initial actions (skill building, networking, applications) (1 agent)
- **Phase 5:** Validate progress against milestones → Generate sustainability guide (2 agents)
- **Phase 6:** Deliver complete career transition plan with tracking system

## Remember

This skill transforms ideas into reality through systematic cognitive processing. Every phase builds on the last, embedded validation ensures quality, every agent performs its cognitive function excellently across ANY domain.

The workflow is systematic, the validation is rigorous, the output is comprehensive.

Trust the process, follow the embedded validation, respect the sequential execution, and watch ideas become deployment-ready deliverables.

6 cognitive agents. 6 optimized phases. Infinite domains. One proven workflow. 40% faster execution.
