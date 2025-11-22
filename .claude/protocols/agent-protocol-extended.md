AGENT PROTOCOL EXTENDED - CODE GENERATION COGNITIVE AGENTS

OVERVIEW
This extended protocol applies to cognitive agents when performing code generation tasks. It includes Test-Driven Development (TDD) and Security-First principles while maintaining cognitive domain flexibility.

WHEN THIS PROTOCOL APPLIES

This protocol activates when:
1. The GENERATION agent is creating code artifacts
2. The VALIDATION agent is verifying code quality
3. Task context indicates programming/scripting/configuration needs
4. Quality standards include "testable", "secure", or "production-ready"

SECTION 1: CODE GENERATION CONTEXT ADAPTATION 🤖

1.1 Code Context Classification
```python
CodeContext = {
    "technical": {
        "types": ["API", "library", "system", "tool", "framework"],
        "standards": ["TDD", "SOLID", "DRY", "KISS", "YAGNI"],
        "security": ["OWASP", "input validation", "auth/authz"]
    },
    "personal": {
        "types": ["automation", "tracker", "assistant", "organizer"],
        "standards": ["simplicity", "reliability", "maintainability"],
        "security": ["data privacy", "local storage", "credential safety"]
    },
    "creative": {
        "types": ["generative", "visualization", "interactive", "artistic"],
        "standards": ["expressiveness", "performance", "user experience"],
        "security": ["content filtering", "rate limiting"]
    },
    "professional": {
        "types": ["enterprise", "reporting", "integration", "analytics"],
        "standards": ["compliance", "audit trails", "documentation"],
        "security": ["SOC2", "GDPR", "encryption", "access control"]
    },
    "recreational": {
        "types": ["game", "simulator", "bot", "utility"],
        "standards": ["fun", "engagement", "accessibility"],
        "security": ["fair play", "anti-cheat", "safe multiplayer"]
    }
}
```

1.2 Language and Framework Selection
```python
def select_technology_stack(task_context: dict) -> dict:
    """
    Choose appropriate languages and frameworks based on task domain
    """
    domain_stacks = {
        "technical": ["Python", "Go", "Rust", "TypeScript"],
        "personal": ["Python", "JavaScript", "Bash", "PowerShell"],
        "creative": ["Processing", "p5.js", "Python", "JavaScript"],
        "professional": ["Java", "C#", "Python", "SQL"],
        "recreational": ["Python", "JavaScript", "Lua", "GDScript"]
    }
    
    return {
        "primary_language": select_best_fit(domain_stacks[task_context["domain"]]),
        "frameworks": select_frameworks(task_context["requirements"]),
        "testing_framework": select_test_framework(primary_language)
    }
```

SECTION 2: TEST-DRIVEN DEVELOPMENT PROTOCOL

2.1 RED-GREEN-REFACTOR Cycle (Universal)

RED Phase (Write Failing Tests First)
```python
# Step 1: Write test that defines desired behavior
def test_feature_behavior():
    # Arrange
    setup_test_context()
    
    # Act
    result = feature_under_test(input_data)
    
    # Assert
    assert result == expected_outcome
    
# Step 2: Run test - it MUST fail
# This confirms test is actually testing something
```

GREEN Phase (Make Tests Pass)
```python
# Step 3: Write MINIMAL code to pass test
def feature_under_test(input_data):
    # Simplest implementation that satisfies test
    return expected_outcome  # Often hardcoded initially
    
# Step 4: Run test - it MUST pass
# This confirms implementation meets requirement
```

REFACTOR Phase (Improve Code Quality)
```python
# Step 5: Refactor while keeping tests green
def feature_under_test(input_data):
    # Improved implementation
    validated_input = validate(input_data)
    processed = process(validated_input)
    return format_output(processed)
    
# Step 6: Run tests - they MUST still pass
# This confirms refactoring didn't break functionality
```

2.2 Domain-Specific Test Patterns

Technical Domain Tests
```python
# Unit tests for algorithms
# Integration tests for systems
# Performance benchmarks
# Load tests
# Security penetration tests
```

Personal Domain Tests
```python
# Validation of personal data handling
# Privacy preservation tests
# Automation reliability tests
# Data persistence tests
```

Creative Domain Tests
```python
# Output quality validation
# User experience tests
# Performance under creative load
# Aesthetic consistency checks
```

Professional Domain Tests
```python
# Business logic validation
# Compliance verification
# Data integrity tests
# Audit trail completeness
```

Recreational Domain Tests
```python
# Gameplay mechanics validation
# Fun factor metrics
# Fairness tests
# Player safety checks
```

2.3 Test Coverage Requirements 🤖
```python
COVERAGE_TARGETS = {
    "technical": 85,      # High coverage for critical systems
    "personal": 70,       # Moderate for personal tools
    "creative": 60,       # Lower for experimental code
    "professional": 90,   # Very high for business systems
    "recreational": 65    # Moderate for games/fun projects
}
```

SECTION 3: SECURITY-FIRST DEVELOPMENT

3.1 Security Principles by Domain 🤖

Universal Security Checklist
- [ ] Input validation on ALL external data
- [ ] Output encoding to prevent injection
- [ ] Authentication where identity matters
- [ ] Authorization where access control needed
- [ ] Encryption for sensitive data
- [ ] Logging for security events
- [ ] Error handling without information leakage

Domain-Specific Security Focus 🤖

Technical Security:
```python
# OWASP Top 10 mitigation
# API rate limiting
# Token-based authentication
# Role-based access control
# Dependency vulnerability scanning
```

Personal Security:
```python
# Local data encryption
# Credential vault integration
# Privacy-preserving defaults
# Secure deletion of sensitive data
# Minimal permission requests
```

Creative Security:
```python
# Content moderation filters
# Rate limiting for generation
# Watermarking/attribution
# Copyright respect
# User consent for data usage
```

Professional Security:
```python
# Compliance framework adherence
# Audit logging
# Data classification
# Encryption at rest and in transit
# Multi-factor authentication
# Privileged access management
```

Recreational Security:
```python
# Anti-cheat mechanisms
# Player data protection
# Safe chat/interaction features
# Age-appropriate content
# Fair play enforcement
```

3.2 Security Implementation Pattern
```python
class SecureComponent:
    def __init__(self):
        self.security_context = load_security_requirements()
        self.validators = initialize_validators()
        self.audit_logger = setup_audit_logging()
    
    def process_request(self, request):
        # 1. Validate input
        if not self.validate_input(request):
            self.audit_logger.log_invalid_request(request)
            raise ValidationError("Invalid input")
        
        # 2. Check authorization
        if not self.check_authorization(request.user):
            self.audit_logger.log_unauthorized_attempt(request)
            raise AuthorizationError("Unauthorized")
        
        # 3. Process with security controls
        try:
            result = self.secure_process(request)
            self.audit_logger.log_successful_operation(request, result)
            return self.encode_output(result)
        except Exception as e:
            self.audit_logger.log_error(request, e)
            return self.safe_error_response(e)
```

SECTION 4: CODE STRUCTURE PATTERNS

4.1 Domain-Appropriate Architecture

Technical Domain Patterns:
- Microservices / Monolith decision
- Layered architecture (presentation, business, data)
- Event-driven / Request-response
- Repository pattern for data access

Personal Domain Patterns:
- Simple scripts for one-off tasks
- Modular utilities for reuse
- Configuration-driven behavior
- Plugin architecture for extensibility

Creative Domain Patterns:
- Pipeline architecture for processing
- Component-based for interactivity
- State machines for complex flows
- Observer pattern for reactivity

Professional Domain Patterns:
- Domain-driven design
- CQRS for complex domains
- Service-oriented architecture
- Enterprise integration patterns

Recreational Domain Patterns:
- Entity-Component-System for games
- State machines for game logic
- Observer for event handling
- Factory pattern for object creation

4.2 File Organization
```
project/
├── src/                 # Source code
│   ├── core/           # Core business logic
│   ├── adapters/       # External integrations
│   ├── utils/          # Shared utilities
│   └── [domain]/       # Domain-specific modules
├── tests/              # Test files
│   ├── unit/          # Unit tests
│   ├── integration/   # Integration tests
│   └── e2e/           # End-to-end tests
├── docs/               # Documentation
├── config/             # Configuration files
└── scripts/            # Build/deploy scripts
```

4.3 Python Project Setup (MANDATORY REQUIREMENTS)

ALL Python projects MUST follow these requirements without exception:

Package Management:
- MUST use `uv` for all dependency management
- NEVER use `pip` directly for package installation
- NEVER install packages globally (no `sudo pip install`, no system-wide packages)
- ALL dependencies managed via `uv add <package>` command

Virtual Environment:
- MUST create virtual environment using `uv venv` in project root
- Virtual environment directory: `.venv/` (must be git-ignored)
- ALL testing MUST use project venv via `uv run pytest`
- ALL code execution MUST use project venv via `uv run python`
- Virtual environment is project-local, NEVER global

Python Project Structure (REQUIRED):
```
project/
├── .venv/              # Virtual environment (uv venv) - MANDATORY
├── .gitignore          # Must include .venv/
├── pyproject.toml      # Project metadata and dependencies - MANDATORY
├── uv.lock             # Locked dependencies (auto-generated by uv)
├── src/                # Source code
│   └── [package]/      # Python package directory
│       ├── __init__.py
│       └── [modules].py
├── tests/              # Test files
│   ├── __init__.py
│   └── test_[modules].py
└── README.md           # Setup and usage instructions
```

Mandatory Setup Sequence:
```bash
# 1. Initialize Python project with uv
uv init

# 2. Create virtual environment in project root
uv venv

# 3. Add dependencies (NEVER use pip install)
uv add <package-name>
uv add --dev pytest  # Development dependencies

# 4. Run tests using venv
uv run pytest

# 5. Execute code using venv
uv run python -m <module>
uv run python script.py
```

Python Workflow Commands (MANDATORY):
```bash
# Install dependencies from pyproject.toml
uv sync

# Add new dependency
uv add requests numpy pandas

# Add dev dependency
uv add --dev pytest black ruff mypy

# Run tests
uv run pytest
uv run pytest tests/test_specific.py

# Run code
uv run python -m mypackage
uv run python scripts/my_script.py

# Run formatters/linters
uv run black src/
uv run ruff check src/
uv run mypy src/
```

CRITICAL VIOLATIONS TO PREVENT:
```bash
# ❌ WRONG - Using pip directly
pip install requests
python -m pip install numpy

# ✅ CORRECT - Using uv
uv add requests
uv add numpy

# ❌ WRONG - Global installation
sudo pip install package
pip install --user package

# ✅ CORRECT - Project-local with uv
uv add package

# ❌ WRONG - Running without venv
python script.py
pytest

# ✅ CORRECT - Using venv via uv run
uv run python script.py
uv run pytest

# ❌ WRONG - Activating venv manually
source .venv/bin/activate
python script.py

# ✅ CORRECT - Using uv run (handles activation)
uv run python script.py
```

Validation Checklist for Python Projects:
- [ ] `.venv/` directory exists in project root
- [ ] `pyproject.toml` exists with all dependencies listed
- [ ] `uv.lock` exists (auto-generated)
- [ ] `.gitignore` includes `.venv/`
- [ ] All `pip install` commands converted to `uv add`
- [ ] All test commands use `uv run pytest`
- [ ] All execution commands use `uv run python`
- [ ] NO global package installations anywhere
- [ ] Virtual environment created with `uv venv`, not `python -m venv`

SECTION 5: GENERATION AGENT CODE WORKFLOW 🤖

5.1 Code Generation Process
```python
def generate_code_artifact(task_context, requirements):
    """
    GENERATION agent's code creation workflow
    """
    # 1. Determine code context
    code_context = classify_code_context(task_context)

    # 2. Select technology stack
    tech_stack = select_technology_stack(code_context)

    # 2.5 Python-specific initialization (MANDATORY for Python projects)
    if tech_stack["primary_language"] == "Python":
        python_setup = initialize_python_project_with_uv(
            project_root=task_context.get("project_path", "."),
            project_name=task_context.get("project_name")
        )
        # This function MUST:
        # - Execute: uv init
        # - Execute: uv venv (creates .venv/)
        # - Create: pyproject.toml with project metadata
        # - Create: .gitignore with .venv/ entry
        # - Create: src/[package]/__init__.py structure
        # - Ensure ALL subsequent commands use `uv run` prefix

        # Update tech_stack with Python-specific commands
        tech_stack["test_command"] = "uv run pytest"
        tech_stack["run_command"] = "uv run python"
        tech_stack["add_dependency"] = lambda pkg: f"uv add {pkg}"
        tech_stack["add_dev_dependency"] = lambda pkg: f"uv add --dev {pkg}"

    # 3. Apply TDD cycle
    tests = generate_tests_first(requirements, tech_stack)
    implementation = implement_to_pass_tests(tests, requirements)
    refactored = refactor_for_quality(implementation)

    # 4. Apply security patterns
    secured = apply_security_patterns(refactored, code_context)

    # 5. Structure appropriately
    structured = organize_code_structure(secured, code_context)

    # 6. Document thoroughly
    documented = add_documentation(structured)

    return {
        "code": documented,
        "tests": tests,
        "coverage": calculate_coverage(tests, documented),
        "security_checklist": validate_security(documented),
        "python_setup": python_setup if tech_stack["primary_language"] == "Python" else None
    }
```

5.2 Progressive Enhancement 🤖
```python
# Start simple, enhance iteratively
iterations = [
    "MVP: Minimal working implementation",
    "TESTS: Add comprehensive test coverage",
    "SECURITY: Apply security controls",
    "PERFORMANCE: Optimize for efficiency",
    "USABILITY: Enhance user experience",
    "MAINTENANCE: Improve maintainability"
]

for iteration in iterations:
    if meets_requirements(current_state):
        break
    current_state = enhance(current_state, iteration)
```

SECTION 6: VALIDATION AGENT CODE WORKFLOW 🤖

6.1 Code Validation Process
```python
def validate_code_artifact(code_artifact, requirements, task_context):
    """
    VALIDATION agent's code verification workflow
    """
    validation_results = {
        "functional": run_all_tests(code_artifact["tests"]),
        "coverage": verify_coverage_meets_target(
            code_artifact["coverage"],
            COVERAGE_TARGETS[task_context["domain"]]
        ),
        "security": run_security_scan(code_artifact["code"]),
        "quality": analyze_code_quality(code_artifact["code"]),
        "documentation": check_documentation_completeness(code_artifact),
        "standards": verify_standards_compliance(code_artifact, task_context)
    }
    
    return {
        "passed": all(validation_results.values()),
        "details": validation_results,
        "remediation": generate_remediation_guide(validation_results)
    }
```

6.2 Quality Metrics 🤖
```python
QUALITY_METRICS = {
    "complexity": {"max_cyclomatic": 10, "max_cognitive": 15},
    "maintainability": {"min_index": 70},
    "duplication": {"max_percentage": 5},
    "coverage": {"min_percentage": domain_specific},
    "security": {"max_vulnerabilities": 0, "max_warnings": 5},
    "documentation": {"min_public_api_coverage": 100}
}
```

SECTION 7: ERROR HANDLING FOR CODE GENERATION 🤖

7.1 Common Failure Modes
```python
CODE_GENERATION_FAILURES = {
    "REQUIREMENTS_UNCLEAR": "Cannot generate code without clear specifications",
    "TECHNOLOGY_MISMATCH": "Selected technology inappropriate for requirements",
    "TEST_GENERATION_FAILED": "Cannot create meaningful tests from requirements",
    "SECURITY_VIOLATION": "Generated code has unresolvable security issues",
    "COMPLEXITY_EXCEEDED": "Solution too complex for requirements"
}

def handle_generation_failure(failure_type, context):
    """
    Graceful failure handling with recovery suggestions
    """
    return {
        "status": "FAILED",
        "reason": CODE_GENERATION_FAILURES[failure_type],
        "recovery": suggest_recovery_path(failure_type, context),
        "partial_result": save_partial_progress(),
        "next_agent": "CLARIFICATION"  # Usually need clarification
    }
```

SECTION 8: INTEGRATION WITH CORE PROTOCOL

8.1 Protocol Handoff
This extended protocol integrates with agent-protocol-core.md:

1. **Scoped Context Loading** (CRITICAL - See agent-protocol-core.md Section 2.2):
   - GENERATION agents MUST load ONLY:
     * Workflow metadata (.claude/memory/task-{id}-memory.md) [ALWAYS]
     * SYNTHESIS agent output (architecture design) [REQUIRED]
     * CLARIFICATION agent output (constraints) [OPTIONAL: if constraints phase exists]
   - VALIDATION agents MUST load ONLY:
     * Workflow metadata (.claude/memory/task-{id}-memory.md) [ALWAYS]
     * GENERATION agent output (code being validated) [REQUIRED]
   - DO NOT load all previous agent outputs
   - Token Budget per Agent: Maximum 3,000-4,000 tokens total context
     * Workflow metadata: ~500 tokens
     * Required predecessor outputs: ~2,500-3,000 tokens (compressed Johari summaries)
     * Optional references: ~500 tokens (specific sections only)

2. **Domain Classification**: Use core protocol for identifying task domain

3. **Code Generation**: Apply this extended protocol for code artifacts

4. **Output Format**: Use core protocol's three-section structure
   - Step Overview: 500 words max (~750 tokens)
   - Johari Summary: 1,200 tokens STRICT MAXIMUM (see Section 8.2)
   - Downstream Directives: 300 tokens maximum

5. **Token Limits** (STRICT ENFORCEMENT):
   - Johari Summary: 1,200 tokens total (200-300 per quadrant)
   - Total agent output: 2,500-3,000 tokens target
   - Memory file size: 300-400 lines maximum

6. **Unknown Registry**: Update with code-specific unknowns

7. **Downstream Directives**: Include code validation needs (max 300 tokens)

8.2 Memory File Integration (COMPRESSED FORMAT - MANDATORY)

Per agent-protocol-core.md Section 5.2, ALL agent outputs MUST use compressed Johari format:

STRICT TOKEN LIMITS (agent-protocol-core.md):
```python
JOHARI_TOKEN_LIMITS = {
    "open": 300,      # 200-300 tokens max - core findings only
    "hidden": 300,    # 200-300 tokens max - key insights only
    "blind": 200,     # 150-200 tokens max - limitations only
    "unknown": 200,   # 150-200 tokens max - unknowns for registry
}
TOTAL_MAX = 1,200 tokens (STRICT - do not exceed)
```

COMPRESSION TECHNIQUES (agent-protocol-core.md Section 5.2):
- Decision-focused writing: WHAT decided, not HOW
- Abbreviations: API, CRUD, TDD, JWT, OAuth2, REST, etc.
- Lists over prose
- Reference previous findings, don't repeat
- Quantify, don't elaborate (e.g., "15/15 tests passing" not "all fifteen tests are passing")

COMPRESSED EXAMPLE (Code Generation):
```markdown
## Step N: Code Generation

Artifacts: src/feature.py, tests/test_feature.py (15 tests), docs/feature.md
Tests: 15/15 passing, 87% coverage (target: 85%)
Security: Input validation ✓, Auth ✓, Authz ✓, Encryption ✓, No vulnerabilities

JOHARI SUMMARY (1,200 tokens max)

open (250 tokens):
OAuth2 feature complete. 15/15 tests pass, 87% coverage. All security gates passed. Async implementation using aiohttp. JWT tokens, 1hr expiry. RBAC with admin/user roles. Rate limit: 100 req/min. Deployed to staging, prod pending.

hidden (280 tokens):
Async chosen over sync for 10x expected user growth (Q4 projections). Event-driven pattern for resilience vs synchronous. JWT expiry 1hr balances security/UX (rejected 15min as too disruptive, 24hr too risky). RBAC roles aligned to org structure (admin=leadership, user=staff). Rate limit based on API tier pricing model.

blind (180 tokens):
Load testing incomplete (only tested 100 concurrent). Legacy system integration path unclear - API v1 compatibility assumption unverified. Performance under 1000+ users untested. Token refresh UX not designed. Role permission edge cases (e.g., temp admin access) not handled.

unknown (190 tokens):
U7: Legacy API v1 compatibility requirements TBD (blocks v1 deprecation timeline)
U8: Production rate limiting strategy undefined (need infra team input)
U9: Token refresh mechanism design needed (UX + security review required)

DOWNSTREAM DIRECTIVES (280 tokens)
Next: VALIDATION agent
Required context: This output only
Optional context: Architecture from Phase 2 (token budget constraints)
Critical files: src/feature.py, tests/test_feature.py
Validation focus: Load testing (target: 1000 concurrent users), legacy API compat, security audit
```

TOKEN REDUCTION COMPARISON:
- Verbose format: 2,800-3,500 tokens, 600-800 lines
- Compressed format: 1,200 tokens (Johari) + 750 tokens (overview) = 1,950 tokens, 300-400 lines
- Reduction: 60-70% fewer tokens, 50-60% fewer lines

MANDATORY COMPRESSION for Code Generation:
- Test results as lists: "15/15 passing, 87% coverage" not paragraphs
- Security as checkmarks: "Input validation ✓, Auth ✓" not "We validated all inputs and implemented authentication"
- Decisions as facts: "Async chosen for scalability" not "We decided to use async because it provides better scalability"
- Abbreviate: OAuth2, JWT, RBAC, API, TDD, CRUD, REST, OWASP
- Unknowns with IDs: "U7: Description" for tracking

SECTION 9: QUICK REFERENCE CHECKLIST

Before Starting Code Generation:
- [ ] Requirements clear and testable
- [ ] Domain context understood
- [ ] Technology stack appropriate
- [ ] Security requirements identified
- [ ] Test framework selected

Python Project Setup (if Python project):
- [ ] Virtual environment created with `uv venv` in project root
- [ ] `.venv/` directory exists and is git-ignored
- [ ] `pyproject.toml` exists with project metadata
- [ ] Dependencies added via `uv add`, NEVER pip install
- [ ] Dev dependencies added via `uv add --dev pytest black ruff`
- [ ] All test commands use `uv run pytest`
- [ ] All code execution uses `uv run python`
- [ ] NO global package installations anywhere
- [ ] `uv.lock` file exists (auto-generated)
- [ ] Python setup verified before proceeding to TDD cycle

During Code Generation:
- [ ] Write tests first (RED)
- [ ] Implement minimally (GREEN)
- [ ] Refactor for quality (REFACTOR)
- [ ] Apply security controls
- [ ] Document thoroughly
- [ ] Python: Use `uv run pytest` for all test execution
- [ ] Python: Use `uv run python` for all code execution

After Code Generation:
- [ ] All tests passing
- [ ] Coverage meets target
- [ ] Security scan clean
- [ ] Documentation complete
- [ ] Code structure logical
- [ ] Python: Virtual environment intact and functional
- [ ] Python: pyproject.toml lists all dependencies
- [ ] Python: No pip install commands in documentation

Validation Checks:
- [ ] Functional correctness
- [ ] Performance acceptable
- [ ] Security validated
- [ ] Maintainability verified
- [ ] Standards compliance
- [ ] Python: Verify `uv run pytest` works
- [ ] Python: Verify no global dependencies required

Context and Compression (CRITICAL):
- [ ] Scoped context loading: Read immediate predecessors ONLY
- [ ] Token budget enforced: Max 3,000-4,000 tokens context loaded
- [ ] Johari summary: 1,200 tokens STRICT MAXIMUM
- [ ] Compression techniques applied: decisions over descriptions
- [ ] Output format: 300-400 lines maximum per agent
- [ ] Memory file stays within size limits

This extended protocol ensures code generation maintains quality across ALL domains while adapting to specific needs.
