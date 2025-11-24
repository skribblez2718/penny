---
name: develop-mcp-server
description: Generate production-ready MCP servers with modular architecture, factory patterns, comprehensive tests, and complete deployment configuration
tags: mcp, server, generation, testing, deployment, security, python
---

# develop-mcp-server

## OVERVIEW

The develop-mcp-server skill orchestrates production-grade MCP (Model Context Protocol) server generation through systematic cognitive processing. It enforces rigorous requirements validation, architectural planning with factory method patterns, comprehensive security hardening, >80% test coverage, and complete deployment configuration.

**Key Capabilities:**
- Validates 6 required inputs with blocking enforcement
- Generates modular architecture following single responsibility principle
- Implements factory method pattern for tool creation
- Produces >80% test coverage with realistic fixtures
- Creates security-hardened systemd deployment
- Generates comprehensive documentation for all major MCP clients

**Cognitive Pattern:** CLARIFICATION → ANALYSIS → SYNTHESIS → GENERATION (4 phases) → VALIDATION

**Domain:** Technical (Python code generation, MCP protocol implementation)

## AGENT ORCHESTRATION

### AGENT 1: CLARIFICATION-SPECIALIST

**Purpose:** Validate and extract 6 required inputs with blocking enforcement for missing or ambiguous requirements

**Trigger:** User request to develop MCP server

**Instructions:**
- Extract and validate all 6 required inputs from user request
- Enforce blocking requirement: If external API is used, API documentation MUST be provided
- Validate service name is valid Python module name
- Confirm authentication details are sufficient for implementation
- Ensure feature descriptions are concrete and implementable
- Determine MCP client target for documentation examples
- Document any non-blocking clarifications needed (max 3, ask in single message)
- BLOCK generation if any required input missing or API documentation absent when needed

**Context Required:**
- task_domain: technical (Python MCP server generation)
- blocking_requirements: 6 required inputs (see resources/required-inputs-checklist.md)
- quality_standards: Production-ready, immediately deployable
- artifact_types: Requirements specification with validated inputs

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- validated_inputs: All 6 required inputs with validation status
- blocking_issues: Any critical missing inputs (triggers BLOCK)
- clarifications_needed: Non-blocking clarifications (if any)
- api_documentation_status: [present|not_needed|MISSING_CRITICAL]
- ready_to_proceed: boolean

**Handoff Protocol:**
- If blocking_issues exist: BLOCK with error message listing missing inputs
- If clarifications_needed: Ask user in single message, wait for response
- If ready_to_proceed: Pass validated_inputs to analysis-agent

### AGENT 2: ANALYSIS-AGENT

**Purpose:** Decompose features into modular architecture with factory pattern, identify shared utilities, and analyze security requirements

**Trigger:** Requirements validated and all 6 inputs present

**Instructions:**
- Decompose features into individual tool modules following single responsibility principle
- Identify shared utilities needed (validation, logging, rate limiting, auth)
- Design service layer boundaries for business logic separation
- Plan factory method structure for tool creation with dependency injection
- Map data model hierarchy using pydantic
- Identify all external input points for security analysis
- Determine authentication flow design
- Assess rate limiting requirements
- Plan module boundaries ensuring no file exceeds 200 lines
- Evaluate test coverage strategy mapping to module structure

**Context Required:**
- validated_inputs: From clarification-specialist
- architecture_principles: Factory method, SRP, modularity (see resources/architecture-principles.md)
- quality_standards: Modular, testable, secure
- artifact_types: Architecture analysis with module boundaries

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-clarification-specialist-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- module_structure: Directory structure with module purposes
- factory_design: Factory method pattern for tool creation
- shared_utilities: Common functionality (validation, logging, rate limiting, auth)
- service_boundaries: Business logic layer design
- data_model_hierarchy: Pydantic model organization
- security_analysis: Input validation points, auth flow, rate limiting
- test_strategy: Coverage mapping to modules

**Handoff Protocol:**
Pass module_structure, factory_design, service_boundaries, security_analysis to synthesis-agent

### AGENT 3: SYNTHESIS-AGENT

**Purpose:** Integrate architectural analysis into coherent design with data flow, resolve design decisions, and create implementation roadmap

**Trigger:** Architectural analysis complete from analysis-agent

**Instructions:**
- Integrate module boundaries into unified architecture
- Resolve design decisions for error handling (fail-fast vs graceful degradation)
- Design data flow between layers (server → tools → services → API client)
- Create dependency graph showing component relationships
- Resolve authentication implementation approach
- Design configuration management strategy
- Plan deployment architecture (systemd service, logging, monitoring)
- Synthesize test fixture strategy (minimal vs comprehensive mocks)
- Create generation sequence (dependency-ordered: models → utils → services → tools → server)
- Document architectural rationale for key decisions

**Context Required:**
- validated_inputs: Service requirements
- module_structure: From analysis-agent
- factory_design: Tool creation pattern
- security_analysis: Security requirements
- quality_standards: Complete, production-ready, secure

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-clarification-specialist-memory.md [REQUIRED for inputs]
- .claude/memory/task-{id}-analysis-agent-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS + REQUIREMENTS
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- integrated_architecture: Complete architecture with all components
- data_flow_design: Request flow through layers
- dependency_graph: Component relationships and dependencies
- implementation_sequence: Dependency-ordered generation plan
- design_rationale: Key architectural decisions explained
- configuration_strategy: Environment variables, validation, secret management

**Handoff Protocol:**
Pass integrated_architecture, implementation_sequence, data_flow_design to generation-agent (Phase 4)

### AGENT 4: GENERATION-AGENT (PHASE 4: CORE IMPLEMENTATION)

**Purpose:** Generate complete source code following modular architecture with factory pattern, type hints, validation, and security hardening

**Trigger:** Integrated architecture designed from synthesis-agent

**Instructions:**
- Generate all source files in dependency order (models → utils → services → tools → server)
- Implement factory method pattern for tool creation with dependency injection
- Apply single responsibility principle to all modules (max 200 lines per file)
- Include 100% type hints on all functions/methods
- Write Google-style docstrings on all public interfaces
- Implement comprehensive error handling without exposing internals
- Apply pydantic validation to all external inputs
- Implement rate limiting with configurable parameters
- Create configuration management with validation
- Generate custom exception hierarchy
- Ensure no hardcoded secrets in any file
- Follow implementation sequence from synthesis-agent

**Context Required:**
- integrated_architecture: Complete design from synthesis-agent
- implementation_sequence: Dependency-ordered generation plan
- code_quality_standards: Type hints, docstrings, validation (see resources/code-quality-standards.md)
- security_requirements: Input validation, rate limiting, secret management (see resources/security-hardening-checklist.md)
- artifact_types: Python source files (models, utils, services, tools, server, config, exceptions)

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md`: Technical code generation protocol

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-synthesis-agent-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS
**Token Budget:** 3,000-3,500 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- source_files_generated: List of all generated source files with paths
- factory_implementation: ToolFactory class with dependency injection
- module_summary: Purpose of each module
- security_measures_applied: Input validation, rate limiting, secret management
- code_quality_metrics: Type hint coverage, docstring coverage

**Handoff Protocol:**
Pass source_files_generated, module_summary to generation-agent (Phase 5)

### AGENT 5: GENERATION-AGENT (PHASE 5: TEST SUITE)

**Purpose:** Generate comprehensive test suite with >80% coverage, realistic fixtures based on API documentation, and edge case testing

**Trigger:** Core implementation generated from Phase 4

**Instructions:**
- Generate complete test structure (conftest.py, fixtures/, unit/, integration/)
- Create realistic mock fixtures based on API documentation provided in requirements
- Generate unit tests for all tools with success, validation error, API error, and edge cases
- Generate unit tests for all services with mocking
- Generate unit tests for all utilities
- Generate integration tests for complete MCP server flow
- Ensure >80% code coverage requirement met
- Configure pytest with coverage reporting and failure threshold
- Include tests for rate limiting, timeout handling, error conditions
- Test factory method pattern instantiation
- Verify all test assertions are meaningful and test intended behavior

**Context Required:**
- source_files_generated: From Phase 4
- api_documentation: From validated requirements (for realistic mocks)
- test_coverage_requirements: >80% coverage, realistic fixtures (see resources/test-coverage-requirements.md)
- artifact_types: Test files (conftest, fixtures, unit tests, integration tests, pytest config)

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md`: Technical code generation protocol

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-generation-agent-phase4-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]
- .claude/memory/task-{id}-clarification-specialist-memory.md [REQUIRED for API docs]

**Context Scope:** IMMEDIATE_PREDECESSORS + REQUIREMENTS
**Token Budget:** 3,000-3,500 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- test_files_generated: All test files with paths
- test_coverage_estimate: Expected coverage percentage
- fixture_strategy: Mock data approach based on API docs
- test_categories: Unit, integration, edge case breakdown

**Handoff Protocol:**
Pass test_files_generated, test_coverage_estimate to generation-agent (Phase 6)

### AGENT 6: GENERATION-AGENT (PHASE 6: DEPLOYMENT ARTIFACTS)

**Purpose:** Generate production deployment configuration including security-hardened systemd service, installation scripts, and dependency management

**Trigger:** Test suite generated from Phase 5

**Instructions:**
- Generate systemd service file with security hardening (NoNewPrivileges, ProtectSystem, resource limits)
- Create installation script for production deployment (user creation, directory setup, permissions)
- Generate setup script for development environment (venv, dependencies, configuration)
- Create .env.example with all required environment variables
- Generate pyproject.toml with uv compatibility
- Create requirements.txt and setup.py as traditional fallbacks
- Generate .gitignore appropriate for Python MCP server project
- Configure logging with appropriate levels and file paths
- Ensure all scripts have proper error handling and verification steps

**Context Required:**
- service_name: From validated requirements
- deployment_environment: Systemd on Ubuntu/Debian
- security_standards: Service hardening, low-privilege user (see resources/security-hardening-checklist.md)
- artifact_types: Systemd service, install scripts, config files, dependency files

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md`: Technical code generation protocol

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-generation-agent-phase5-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- deployment_files_generated: Systemd service, install/setup scripts, config files
- security_hardening_applied: Service restrictions, resource limits
- dependency_management: pyproject.toml, requirements.txt, setup.py

**Handoff Protocol:**
Pass deployment_files_generated to generation-agent (Phase 7)

### AGENT 7: GENERATION-AGENT (PHASE 7: DOCUMENTATION)

**Purpose:** Generate comprehensive documentation including README with MCP client setup for all specified clients, CONTRIBUTING guide, and troubleshooting

**Trigger:** Deployment artifacts generated from Phase 6

**Instructions:**
- Generate complete README.md with architecture overview, features, prerequisites
- Include installation instructions for both development and production
- Create MCP client setup sections for specified client (Claude Desktop/Cursor/Windsurf/fast-agent)
- Document all environment variables with descriptions and defaults
- Generate usage examples for all tools with parameters and responses
- Create troubleshooting section covering common issues
- Document security considerations
- Generate CONTRIBUTING.md with development guidelines, code standards, testing requirements
- Include development workflow (setup, tests, code quality tools)
- Create project structure documentation
- Include final checklist and running instructions

**Context Required:**
- mcp_client_target: From validated requirements
- service_features: Tool descriptions
- deployment_configuration: From Phase 6
- documentation_standards: Complete, client-specific (see resources/documentation-template-references.md)
- artifact_types: README.md, CONTRIBUTING.md

**Protocol References:**
- `.claude/protocols/agent-protocol-extended.md`: Technical code generation protocol

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-clarification-specialist-memory.md [REQUIRED for client target]
- .claude/memory/task-{id}-generation-agent-phase6-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS + REQUIREMENTS
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- documentation_files_generated: README.md, CONTRIBUTING.md
- mcp_client_instructions: Setup for specified client
- troubleshooting_coverage: Common issues documented

**Handoff Protocol:**
Pass documentation_files_generated, all generated artifacts to quality-validator

### AGENT 8: QUALITY-VALIDATOR

**Purpose:** Verify generated MCP server meets all production requirements including code quality, test coverage, security, and documentation completeness

**Trigger:** All generation phases complete from Phase 7

**Instructions:**
- Verify all source files have 100% type hints on functions/methods
- Confirm all public interfaces have Google-style docstrings
- Validate no hardcoded secrets in any generated file
- Check all external inputs have pydantic validation
- Verify error handling doesn't expose internal details
- Confirm test coverage meets >80% threshold
- Validate systemd service includes security hardening measures
- Check documentation includes setup for specified MCP client
- Verify factory method pattern correctly implemented
- Confirm single responsibility principle applied (no file >200 lines)
- Validate all 6 required inputs incorporated into generation
- Check troubleshooting section is comprehensive

**Context Required:**
- validation_checklist: Production requirements (see resources/code-quality-standards.md, security-hardening-checklist.md, test-coverage-requirements.md)
- quality_standards: Type hints, docstrings, tests, security, docs
- artifact_types: Validation report with pass/fail status

**Context References:**
- .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
- .claude/memory/task-{id}-generation-agent-phase7-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]
- .claude/memory/task-{id}-generation-agent-phase4-memory.md [REQUIRED for code validation]
- .claude/memory/task-{id}-generation-agent-phase5-memory.md [REQUIRED for test validation]

**Context Scope:** IMMEDIATE_PREDECESSORS + GENERATION_PHASES
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
See `.claude/references/johari.md` for Johari Window format
Key outputs:
- validation_status: [PASS|FAIL]
- quality_metrics: Type hint coverage, docstring coverage, test coverage, security measures
- issues_found: Any quality violations detected
- recommendations: Improvements for production deployment

**Handoff Protocol:**
- If validation_status = PASS: Deliver complete MCP server package to user
- If validation_status = FAIL: Report issues with specific remediation guidance

## STATE MANAGEMENT

### PERSISTENT STATE

```json
{
  "workflow_id": "mcp-server-{timestamp}-{uid}",
  "current_phase": "clarification|analysis|synthesis|generation_core|generation_tests|generation_deployment|generation_docs|validation",
  "requirements": {
    "service_name": "",
    "api_documentation": "",
    "required_features": [],
    "authentication": {},
    "data_sources": [],
    "mcp_client": ""
  },
  "validation_gate": {
    "inputs_validated": false,
    "blocking_issues": [],
    "api_doc_status": "unknown",
    "ready_to_proceed": false
  },
  "architecture": {
    "module_structure": {},
    "factory_design": {},
    "security_analysis": {},
    "implementation_sequence": []
  },
  "generation_artifacts": {
    "source_files": [],
    "test_files": [],
    "deployment_files": [],
    "documentation_files": []
  },
  "quality_metrics": {
    "type_hint_coverage": 0,
    "docstring_coverage": 0,
    "test_coverage": 0,
    "security_measures": []
  },
  "agents_completed": []
}
```

### STATE TRANSITIONS

1. **User Request → CLARIFICATION**
   - State update: current_phase = "clarification"
   - Validation: Extract and validate 6 required inputs

2. **CLARIFICATION → VALIDATION GATE**
   - Condition: All 6 inputs extracted
   - State update: validation_gate.inputs_validated = true/false

3. **VALIDATION GATE → ANALYSIS** (pass)
   - Condition: inputs_validated = true AND (api_doc_status = "present" OR api_doc_status = "not_needed")
   - State update: current_phase = "analysis", validation_gate.ready_to_proceed = true

4. **VALIDATION GATE → BLOCK** (fail)
   - Condition: inputs_validated = false OR (api_doc_status = "MISSING_CRITICAL")
   - State update: validation_gate.blocking_issues = [list], workflow BLOCKED

5. **ANALYSIS → SYNTHESIS**
   - Condition: Architecture analysis complete
   - State update: current_phase = "synthesis", architecture.module_structure populated

6. **SYNTHESIS → GENERATION (Phase 4)**
   - Condition: Integrated design complete
   - State update: current_phase = "generation_core"

7. **GENERATION Phase 4 → GENERATION Phase 5**
   - Condition: Core source files generated
   - State update: current_phase = "generation_tests", generation_artifacts.source_files populated

8. **GENERATION Phase 5 → GENERATION Phase 6**
   - Condition: Test suite generated
   - State update: current_phase = "generation_deployment", generation_artifacts.test_files populated

9. **GENERATION Phase 6 → GENERATION Phase 7**
   - Condition: Deployment artifacts generated
   - State update: current_phase = "generation_docs", generation_artifacts.deployment_files populated

10. **GENERATION Phase 7 → VALIDATION**
    - Condition: Documentation generated
    - State update: current_phase = "validation", generation_artifacts.documentation_files populated

11. **VALIDATION → COMPLETE** (pass)
    - Condition: All quality checks pass
    - State update: workflow complete, deliver MCP server package

12. **VALIDATION → REPORT ISSUES** (fail)
    - Condition: Quality checks fail
    - State update: Report validation failures with remediation guidance

## DECISION TREES

### DECISION POINT 1: INPUT VALIDATION GATE (CRITICAL)

**If** All 6 required inputs present AND (API documentation provided OR no external API needed)
  **Then** → validation_gate.ready_to_proceed = true → Agent: analysis-agent
**Else If** Any required input missing
  **Then** → BLOCK with error: "Missing required inputs: [list]"
**Else If** External API needed AND API documentation missing
  **Then** → BLOCK with error: "CRITICAL: API documentation required for external API integration"

**Critical Enforcement:** This gate is non-negotiable. Generation CANNOT proceed without all inputs.

### DECISION POINT 2: CLARIFICATION NECESSITY

**If** All 6 required inputs clear and unambiguous
  **Then** → Skip additional clarifications, proceed to validation gate
**Else If** 1-3 non-blocking details need clarification
  **Then** → Ask all clarifying questions in ONE message, wait for response
**Else If** >3 details unclear
  **Then** → Request user provide clearer requirements before proceeding

### DECISION POINT 3: GENERATION SEQUENCING

**Phase 4 (Core):** Generate in dependency order
  - First: models/ (data models with pydantic)
  - Second: utils/ (shared utilities)
  - Third: services/ (business logic)
  - Fourth: tools/ (MCP tool wrappers)
  - Fifth: server.py, config.py, exceptions.py

**Phase 5 (Tests):** Generate tests matching implementation
  - First: fixtures/ (mock data based on API docs)
  - Second: conftest.py (shared test fixtures)
  - Third: unit tests (tools, services, utils)
  - Fourth: integration tests (complete server flow)

**Phase 6 (Deployment):** Generate deployment artifacts
  - First: .env.example (configuration template)
  - Second: pyproject.toml, requirements.txt, setup.py
  - Third: systemd service file
  - Fourth: scripts (install.sh, setup.sh)

**Phase 7 (Docs):** Generate documentation
  - First: README.md (complete with MCP client setup)
  - Second: CONTRIBUTING.md (development guidelines)

### DECISION POINT 4: VALIDATION OUTCOME

**If** All quality checks pass (type hints 100%, docstrings present, tests >80%, security hardened, docs complete)
  **Then** → validation_status = PASS → Deliver complete MCP server
**Else**
  **Then** → validation_status = FAIL → Report specific issues with remediation steps

## ERROR HANDLING

### ERROR RECOVERY MATRIX

| Error Type | Detection | Recovery Strategy | Fallback |
|------------|-----------|-------------------|----------|
| Missing required input | Clarification phase | Request missing input explicitly | Block generation until provided |
| API documentation missing (API needed) | Clarification phase | BLOCK with critical error message | Cannot proceed without API docs |
| Invalid service name | Clarification phase | Request valid Python module name | Suggest corrections |
| Authentication details insufficient | Clarification phase | Request complete auth flow details | Block until sufficient |
| Module exceeds 200 lines | Generation phase 4 | Decompose into smaller modules | Apply SRP more strictly |
| Test coverage <80% | Validation phase | Generate additional tests for uncovered paths | Report gap, recommend manual tests |
| Hardcoded secrets detected | Validation phase | Remove secrets, flag for .env configuration | Fail validation, require fix |
| Type hints missing | Validation phase | Add missing type hints | Fail validation until complete |
| Systemd security not hardened | Validation phase | Apply security restrictions | Fail validation, apply hardening |
| MCP client instructions missing | Validation phase | Generate client-specific setup | Fail validation until present |

## USAGE EXAMPLES

### SCENARIO 1: SIMPLE MCP SERVER (FILE-BASED, NO AUTH)

**User:** "Create an MCP server called 'file_search' that searches text files in a directory. No external API. It should have tools to search by keyword and list recent files. Target client is Claude Desktop."

**Penny:** Initiating develop-mcp-server skill

**Agent Flow:**
1. clarification-specialist:
   - Service name: "file_search" ✓
   - API documentation: N/A (no external API) ✓
   - Features: search_by_keyword, list_recent_files ✓
   - Authentication: None ✓
   - Data sources: Local text files ✓
   - MCP client: Claude Desktop ✓
   - All inputs validated, proceed

2. analysis-agent: Modules: tools/ (2 tools), services/ (file_service), utils/ (file_utils, validation), no API client needed

3. synthesis-agent: Simple architecture, factory for 2 tools, file service reads local files, no auth flow

4. generation-agent (Phase 4): Generates src/ with tools, services, utils, server, config

5. generation-agent (Phase 5): Generates tests with file system mocks, >80% coverage

6. generation-agent (Phase 6): Generates systemd service, install scripts, .env.example

7. generation-agent (Phase 7): Generates README with Claude Desktop setup, CONTRIBUTING

8. quality-validator: Validates all quality checks pass

**Result:**
- Complete MCP server package
- Tools: search_by_keyword, list_recent_files
- No external dependencies beyond MCP
- Claude Desktop configuration example
- Ready to deploy

### SCENARIO 2: API-INTEGRATED MCP SERVER WITH OAUTH

**User:** "Create an MCP server for GitHub called 'github_mcp'. Features: search_repositories, get_repository_details, list_user_repos. Use GitHub REST API v3 at https://docs.github.com/en/rest. Authentication is OAuth 2.0 with repo scope. Target is Cursor."

**Penny:** Initiating develop-mcp-server skill

**Agent Flow:**
1. clarification-specialist:
   - Service name: "github_mcp" ✓
   - API documentation: https://docs.github.com/en/rest ✓
   - Features: 3 tools specified ✓
   - Authentication: OAuth 2.0, repo scope ✓
   - Data sources: GitHub REST API ✓
   - MCP client: Cursor ✓
   - All inputs validated, API docs present, proceed

2. analysis-agent: Modules: tools/ (3 tools), services/ (github_service, api_client), utils/ (oauth_handler, rate_limiter, validation), models/ (repo request/response)

3. synthesis-agent: Modular architecture with OAuth flow, rate limiting (GitHub limits), error handling for 404/403/429

4. generation-agent (Phase 4): Generates complete source with OAuth client, GitHub API integration, pydantic models

5. generation-agent (Phase 5): Generates tests with realistic GitHub API mocks from docs, edge cases (rate limit, not found)

6. generation-agent (Phase 6): Generates deployment with OAuth token in .env, systemd service

7. generation-agent (Phase 7): Generates README with Cursor-specific setup, OAuth token acquisition instructions

8. quality-validator: Validates factory pattern, OAuth security, test coverage >80%

**Result:**
- Production GitHub MCP server
- 3 tools with OAuth authentication
- Rate limiting built-in
- Cursor configuration example
- Comprehensive tests with realistic API mocks

### SCENARIO 3: BLOCKED GENERATION (MISSING API DOCS)

**User:** "Create MCP server for Slack messaging. Features: send_message, list_channels. Use Slack API. Auth is Bearer token. For Windsurf."

**Penny:** Initiating develop-mcp-server skill

**Agent Flow:**
1. clarification-specialist:
   - Service name: "slack_mcp" ✓
   - API documentation: NOT PROVIDED ✗ (CRITICAL)
   - Features: send_message, list_channels ✓
   - Authentication: Bearer token ✓
   - Data sources: Slack API ✓
   - MCP client: Windsurf ✓
   - **BLOCKING ISSUE DETECTED**

**Penny Response:**
```
I cannot generate the MCP server because the following required information is missing:

❌ **API Documentation (CRITICAL REQUIREMENT)**
   - You mentioned using "Slack API" but did not provide API documentation URL
   - Required for generating realistic test fixtures and correct API integration
   - Needed: Slack API documentation URL (e.g., https://api.slack.com/docs)

Please provide the Slack API documentation URL so I can generate a complete, production-ready server with realistic tests based on actual API responses.

Without API documentation, I cannot:
- Generate accurate request/response models
- Create realistic test fixtures
- Implement correct error handling for API-specific errors
- Ensure proper API endpoint usage
```

**User:** "Use https://api.slack.com/docs"

**Penny:** Resuming with API documentation provided, proceeding through full workflow...

## PERFORMANCE CONSIDERATIONS

**Expected Execution Time:**
- Clarification: 1-2 turns
- Analysis: 2-3 turns
- Synthesis: 2-3 turns
- Generation (Core): 4-6 turns
- Generation (Tests): 3-5 turns
- Generation (Deployment): 2-3 turns
- Generation (Docs): 2-3 turns
- Validation: 1-2 turns
- **Total:** 15-25 turns

**Context Window Usage:**
- CLARIFICATION: ~10% (1-2 turns)
- ANALYSIS: ~15% (2-3 turns)
- SYNTHESIS: ~15% (2-3 turns)
- GENERATION (4 phases): ~40% (12-18 turns)
- VALIDATION: ~10% (1-2 turns)

**Optimal Agent Sequencing:**
All agents invoked sequentially (never parallel) to maintain architectural coherence and dependency order

**Token Efficiency Strategies:**
- Progressive context compression per agent-protocol-core.md
- Johari output limits strictly enforced (1,200 tokens max)
- Immediate predecessor context loading only (except validation needs generation phases)
- Generation phases independent to reduce context overhead

## DEPENDENCIES

### REQUIRED SKILLS
None (standalone skill)

### REQUIRED RESOURCES
- `resources/required-inputs-checklist.md`: 6 blocking requirements with validation criteria
- `resources/architecture-principles.md`: Factory method pattern, SRP, modularity
- `resources/code-quality-standards.md`: Type hints, docstrings, pydantic validation
- `resources/security-hardening-checklist.md`: Systemd hardening, rate limiting, secret management
- `resources/test-coverage-requirements.md`: >80% coverage, realistic fixtures, edge cases
- `resources/documentation-template-references.md`: README structure, CONTRIBUTING, troubleshooting

### PROTOCOL REFERENCES
- `.claude/protocols/agent-protocol-core.md`: Core agent execution protocol
- `.claude/protocols/agent-protocol-extended.md`: Technical code generation protocol (CRITICAL for generation phases)
- `.claude/protocols/context-pruning-protocol.md`: Progressive context compression
- `.claude/references/agent-registry.md`: Agent capabilities and descriptions
- `.claude/references/johari.md`: Context structure and output format
- `.claude/references/context-inheritance.md`: Context-passing patterns

## TESTING PROTOCOL

### Test Case 1: Simple File-Based MCP Server
**Input:** Request for file search server, no external API, 2 features, Claude Desktop target
**Expected:**
- All 6 inputs validated
- Simple architecture (no API client, no auth)
- 2 tools generated
- Tests with file system mocks
- Claude Desktop setup in README
- Validation passes
- Total turns: 15-18

### Test Case 2: API-Integrated with OAuth
**Input:** GitHub MCP server, 3 features, OAuth auth, API docs provided, Cursor target
**Expected:**
- All 6 inputs validated with API docs
- Modular architecture with OAuth handler
- Factory pattern with 3 tools
- Realistic GitHub API mocks in tests
- Rate limiting implemented
- Cursor-specific setup instructions
- Validation passes
- Total turns: 20-25

### Test Case 3: Blocking Validation (Missing API Docs)
**Input:** Slack MCP server, API mentioned but no docs URL provided
**Expected:**
- Clarification phase detects missing API documentation
- BLOCK generation with clear error message
- Lists specific missing requirement (API docs URL)
- Explains why API docs are critical
- Does NOT proceed to analysis phase

### Test Case 4: Clarification Needed
**Input:** Request with 2-3 ambiguous details (e.g., auth type unclear, MCP client not specified)
**Expected:**
- Clarification phase identifies non-blocking unclear items
- Asks ALL clarifying questions in ONE message
- Waits for user response
- Proceeds after clarifications received

## MAINTENANCE NOTES

### Update Guidelines
- When modifying validation requirements: Update `resources/required-inputs-checklist.md`
- When changing architecture patterns: Update `resources/architecture-principles.md`
- When adjusting quality standards: Update `resources/code-quality-standards.md` and `resources/test-coverage-requirements.md`
- Maintain orchestration-only principle: Never add Python implementation details to agent instructions

### Monitoring Points
- Track blocking rate at validation gate (indicates unclear user requirements)
- Monitor generation phase token usage (indicates need for compression optimization)
- Track validation failure rate (indicates quality standard issues)
- Measure user satisfaction with generated MCP servers

### Known Limitations
- Validation gate is strict: Will block for any missing input (intentional, ensures quality)
- API documentation requirement is non-negotiable when external API used
- Generation assumes Python 3.9+ environment
- Systemd deployment targets Ubuntu/Debian (other platforms need manual adaptation)
- Test fixtures quality depends on API documentation comprehensiveness

### Future Enhancements
- Add support for additional deployment targets (Docker, supervisord)
- Implement automated quality validation using static analysis tools
- Add MCP server template library for common patterns
- Support multi-service MCP server architectures
