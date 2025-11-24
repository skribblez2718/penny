# Agent Protocol Extended - Code Generation Cognitive Agents

## Metadata

- **Type:** extended
- **Extends:** agent-protocol-core.md
- **Purpose:** Extended protocol for cognitive agents performing code generation tasks. Includes Test-Driven Development (TDD) and Security-First principles while maintaining cognitive domain flexibility.

## Integration

### How This Protocol Relates to Core Protocol

This protocol EXTENDS agent-protocol-core.md for code generation tasks ONLY.

### Inherited from Core (DO NOT duplicate here):

- **Section 2.2:** Scoped Context Loading
- **Section 5.2:** Token Budget (5,000 token agent output limit, 1,200 token Johari limit)
- **Section 6.1:** Johari Window Format
- **Section 6:** Output Structure (Step Overview + Johari + Downstream Directives)
- **Section 4:** Unknown Registry Management
- **Section 5.2:** Compression Techniques
- **Section 3:** Cognitive Function Adaptation
- **Section 1:** Domain Classification

### Unique Additions (UNIQUE to code generation):

- **Section 4.3:** Python Project Setup with uv - MANDATORY for Python projects
- **Section 2:** TDD RED-GREEN-REFACTOR Cycle - Code generation workflow
- **Section 3:** Security-First Development Patterns - OWASP Top 10, domain security
- **Section 4:** Code Structure Patterns - Language-appropriate architectures
- **Section 5-6:** Code-Specific Workflows - Generation and validation processes
- **Section 7:** Error Handling for Code - Code-specific error recovery

### Loading Rules (When to Load Each Protocol):

- **ALL agents** → Load agent-protocol-core.md (universal rules)
- **GENERATION agent creating code** → Load agent-protocol-core.md + THIS protocol
- **VALIDATION agent verifying code** → Load agent-protocol-core.md + THIS protocol
- **Non-code agents** (RESEARCH, ANALYSIS, SYNTHESIS, CLARIFICATION) → Load agent-protocol-core.md ONLY

## Applicability

### When This Protocol Applies

This protocol activates when:
- The GENERATION agent is creating code artifacts
- The VALIDATION agent is verifying code quality
- Task context indicates programming/scripting/configuration needs
- Quality standards include "testable", "secure", or "production-ready"

## Code Generation Context Adaptation

### Code Context Classification

#### Technical Domain
- **Types:** API, library, system, tool, framework
- **Standards:** TDD, SOLID, DRY, KISS, YAGNI
- **Security:** OWASP, input validation, auth/authz

#### Personal Domain
- **Types:** automation, tracker, assistant, organizer
- **Standards:** simplicity, reliability, maintainability
- **Security:** data privacy, local storage, credential safety

#### Creative Domain
- **Types:** generative, visualization, interactive, artistic
- **Standards:** expressiveness, performance, user experience
- **Security:** content filtering, rate limiting

#### Professional Domain
- **Types:** enterprise, reporting, integration, analytics
- **Standards:** compliance, audit trails, documentation
- **Security:** SOC2, GDPR, encryption, access control

#### Recreational Domain
- **Types:** game, simulator, bot, utility
- **Standards:** fun, engagement, accessibility
- **Security:** fair play, anti-cheat, safe multiplayer

### Language and Framework Selection

Choose appropriate languages and frameworks based on task domain:

**Domain Stacks:**
- **Technical:** Python, Go, Rust, TypeScript
- **Personal:** Python, JavaScript, Bash, PowerShell
- **Creative:** Processing, p5.js, Python, JavaScript
- **Professional:** Java, C#, Python, SQL
- **Recreational:** Python, JavaScript, Lua, GDScript

**Selection Criteria:**
- Select primary language from domain stack
- Select frameworks based on requirements
- Select testing framework based on primary language

## Test-Driven Development Protocol

### RED-GREEN-REFACTOR Cycle (Universal)

#### Phase RED: Write Failing Tests First
1. Write test that defines desired behavior
2. Run test - it MUST fail (confirms test is actually testing something)

**Pattern:**
```python
# Arrange
setup_test_context()

# Act
result = feature_under_test(input_data)

# Assert
assert result == expected_outcome
```

#### Phase GREEN: Make Tests Pass
3. Write MINIMAL code to pass test
4. Run test - it MUST pass (confirms implementation meets requirement)

**Note:** Often hardcoded initially - simplest implementation that satisfies test

#### Phase REFACTOR: Improve Code Quality
5. Refactor while keeping tests green
6. Run tests - they MUST still pass (confirms refactoring didn't break functionality)

**Improvements:**
- Validate input data
- Process validated input
- Format output properly

### Domain-Specific Test Patterns

#### Technical
- Unit tests for algorithms
- Integration tests for systems
- Performance benchmarks
- Load tests
- Security penetration tests

#### Personal
- Validation of personal data handling
- Privacy preservation tests
- Automation reliability tests
- Data persistence tests

#### Creative
- Output quality validation
- User experience tests
- Performance under creative load
- Aesthetic consistency checks

#### Professional
- Business logic validation
- Compliance verification
- Data integrity tests
- Audit trail completeness

#### Recreational
- Gameplay mechanics validation
- Fun factor metrics
- Fairness tests
- Player safety checks

### Test Coverage Requirements

**Targets:**
- **Technical:** 85% - High coverage for critical systems
- **Personal:** 70% - Moderate for personal tools
- **Creative:** 60% - Lower for experimental code
- **Professional:** 90% - Very high for business systems
- **Recreational:** 65% - Moderate for games/fun projects

## Security-First Development

### Universal Security Checklist

- Input validation on ALL external data
- Output encoding to prevent injection
- Authentication where identity matters
- Authorization where access control needed
- Encryption for sensitive data
- Logging for security events
- Error handling without information leakage

### Domain-Specific Security Focus

#### Technical
- OWASP Top 10 mitigation
- API rate limiting
- Token-based authentication
- Role-based access control
- Dependency vulnerability scanning

#### Personal
- Local data encryption
- Credential vault integration
- Privacy-preserving defaults
- Secure deletion of sensitive data
- Minimal permission requests

#### Creative
- Content moderation filters
- Rate limiting for generation
- Watermarking/attribution
- Copyright respect
- User consent for data usage

#### Professional
- Compliance framework adherence
- Audit logging
- Data classification
- Encryption at rest and in transit
- Multi-factor authentication
- Privileged access management

#### Recreational
- Anti-cheat mechanisms
- Player data protection
- Safe chat/interaction features
- Age-appropriate content
- Fair play enforcement

### Security Implementation Pattern

```python
class SecureComponent:
    def __init__(self):
        self.security_requirements = load_security_requirements()
        self.validators = initialize_validators()
        self.audit_logging = setup_audit_logging()

    def process_request(self, request):
        # Step 1: Validate input (log and reject if invalid)
        if not self.validate_input(request):
            self.log_security_event("Invalid input", request)
            return self.safe_error_response("Invalid request")

        # Step 2: Check authorization (log and reject if unauthorized)
        if not self.check_authorization(request):
            self.log_security_event("Unauthorized access", request)
            return self.safe_error_response("Unauthorized")

        # Step 3: Process with security controls
        result = self.process_with_controls(request)

        # Step 4: Log successful operation
        self.log_security_event("Success", request)

        # Step 5: Encode output safely
        return self.encode_output(result)

    def handle_error(self, error):
        # Log error, return safe error response (no information leakage)
        self.log_security_event("Error", error)
        return self.safe_error_response("An error occurred")
```

## Code Structure Patterns

### Domain-Appropriate Architecture

#### Technical
- Microservices / Monolith decision
- Layered architecture (presentation, business, data)
- Event-driven / Request-response
- Repository pattern for data access

#### Personal
- Simple scripts for one-off tasks
- Modular utilities for reuse
- Configuration-driven behavior
- Plugin architecture for extensibility

#### Creative
- Pipeline architecture for processing
- Component-based for interactivity
- State machines for complex flows
- Observer pattern for reactivity

#### Professional
- Domain-driven design
- CQRS for complex domains
- Service-oriented architecture
- Enterprise integration patterns

#### Recreational
- Entity-Component-System for games
- State machines for game logic
- Observer for event handling
- Factory pattern for object creation

### File Organization

```
project/
├── src/                    # Source code
│   ├── core/              # Core business logic
│   ├── adapters/          # External integrations
│   ├── utils/             # Shared utilities
│   └── [domain]/          # Domain-specific modules
├── tests/                  # Test files
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── e2e/               # End-to-end tests
├── docs/                   # Documentation
├── config/                 # Configuration files
└── scripts/                # Build/deploy scripts
```

### Python Project Setup (MANDATORY REQUIREMENTS)

**Importance:** ALL Python projects MUST follow these requirements without exception

#### Package Management

**Rules:**
- ✅ **MUST:** Use `uv` for all dependency management
- ❌ **NEVER:** Use `pip` directly for package installation
- ❌ **NEVER:** Install packages globally (no `sudo pip install`, no system-wide packages)
- ✅ **MUST:** ALL dependencies managed via `uv add <package>` command

#### Virtual Environment

**Rules:**
- ✅ **MUST:** Create virtual environment using `uv venv` in project root
- ✅ **MUST:** Virtual environment directory: `.venv/` (must be git-ignored)
- ✅ **MUST:** ALL testing MUST use project venv via `uv run pytest`
- ✅ **MUST:** ALL code execution MUST use project venv via `uv run python`
- ❌ **NEVER:** Virtual environment is project-local, NEVER global

#### Project Structure

**Required Files:**
- `.venv/` (directory, MANDATORY) - Virtual environment (uv venv)
- `.gitignore` (required) - Must include .venv/
- `pyproject.toml` (required, MANDATORY) - Project metadata and dependencies
- `uv.lock` - Locked dependencies (auto-generated by uv)

**Directory Structure:**
```
project/
├── .venv/                          # Virtual environment (MANDATORY)
├── .gitignore                      # Must include .venv/
├── pyproject.toml                  # Project metadata (MANDATORY)
├── uv.lock                         # Locked dependencies
├── src/
│   └── [package]/
│       ├── __init__.py
│       └── [modules].py
├── tests/
│   ├── __init__.py
│   └── test_[modules].py
└── README.md                       # Setup and usage instructions
```

#### Mandatory Setup Sequence

**Step 1:** Initialize Python project with uv
```bash
uv init
```

**Step 2:** Create virtual environment in project root
```bash
uv venv
```

**Step 3:** Add dependencies (NEVER use pip install)
```bash
uv add <package-name>
```

**Step 4:** Add dev dependencies
```bash
uv add --dev pytest
```

**Step 5:** Run tests using venv
```bash
uv run pytest
```

**Step 6:** Execute code using venv
```bash
uv run python -m <module>
# or
uv run python script.py
```

#### Python Workflow Commands (MANDATORY)

- **Sync:** `uv sync` - Install dependencies from pyproject.toml
- **Add:** `uv add requests numpy pandas` - Add new dependency
- **Add Dev:** `uv add --dev pytest black ruff mypy` - Add dev dependency
- **Test:** `uv run pytest` - Run tests
- **Test Specific:** `uv run pytest tests/test_specific.py` - Run specific test
- **Run Module:** `uv run python -m mypackage` - Run code module
- **Run Script:** `uv run python scripts/my_script.py` - Run script
- **Format:** `uv run black src/` - Run formatter
- **Lint:** `uv run ruff check src/` - Run linter
- **Typecheck:** `uv run mypy src/` - Run type checker

#### CRITICAL VIOLATIONS TO PREVENT

**❌ WRONG:**
```bash
pip install requests
python -m pip install numpy
sudo pip install package
pip install --user package
python script.py
pytest
source .venv/bin/activate
python script.py
```

**✅ CORRECT:**
```bash
uv add requests
uv add numpy
uv add package
uv run python script.py
uv run pytest
uv run python script.py
```

**Reason:**
- Using pip directly ❌
- Global installation ❌
- Running without venv ❌
- Activating venv manually ❌

#### Validation Checklist for Python Projects

- ✅ `.venv/` directory exists in project root
- ✅ `pyproject.toml` exists with all dependencies listed
- ✅ `uv.lock` exists (auto-generated)
- ✅ `.gitignore` includes `.venv/`
- ✅ All `pip install` commands converted to `uv add`
- ✅ All test commands use `uv run pytest`
- ✅ All execution commands use `uv run python`
- ✅ NO global package installations anywhere
- ✅ Virtual environment created with `uv venv`, not `python -m venv`

## GENERATION Agent Code Workflow

### Code Generation Process

**Step 1:** Determine code context

**Step 2:** Select technology stack

**Step 2.5:** Python-specific initialization (MANDATORY for Python projects)

**Initialize Python Project:**
```bash
# Execute these commands
uv init
uv venv  # creates .venv/

# Create files
# - pyproject.toml with project metadata
# - .gitignore with .venv/ entry
# - src/[package]/__init__.py structure

# Ensure ALL subsequent commands use `uv run` prefix
```

**Update Tech Stack:**
- **Test command:** `uv run pytest`
- **Run command:** `uv run python`
- **Add dependency:** `uv add {pkg}`
- **Add dev dependency:** `uv add --dev {pkg}`

**Step 3:** Apply TDD cycle (generate tests first)

**Step 4:** Implement to pass tests

**Step 5:** Refactor for quality

**Step 6:** Apply security patterns

**Step 7:** Structure appropriately

**Step 8:** Document thoroughly

**Output:**
- Documented implementation
- Test suite
- Coverage metrics
- Security validation results
- Python setup details (for Python projects)

### Progressive Enhancement

Start simple, enhance iteratively:

1. **MVP:** Minimal working implementation
2. **TESTS:** Add comprehensive test coverage
3. **SECURITY:** Apply security controls
4. **PERFORMANCE:** Optimize for efficiency
5. **USABILITY:** Enhance user experience
6. **MAINTENANCE:** Improve maintainability

**Stopping Criteria:** If meets_requirements(current_state), break

## VALIDATION Agent Code Workflow

### Code Validation Process

**Validation Areas:**
- **Functional:** Run all tests
- **Coverage:** Verify coverage meets domain target
- **Security:** Run security scan
- **Quality:** Analyze code quality
- **Documentation:** Check documentation completeness
- **Standards:** Verify standards compliance

**Output:**
- **passed:** Boolean - all validations passed
- **details:** Detailed validation results
- **remediation:** Remediation guide if failed

### Quality Metrics

**Complexity:**
- Max cyclomatic: 10
- Max cognitive: 15

**Maintainability:** Min index 70

**Duplication:** Max 5%

**Coverage:** Min percentage (domain specific)

**Security:**
- Max vulnerabilities: 0
- Max warnings: 5

**Documentation:** Min public API coverage 100%

## Error Handling for Code Generation

### Common Failure Modes

- **REQUIREMENTS_UNCLEAR:** Cannot generate code without clear specifications
- **TECHNOLOGY_MISMATCH:** Selected technology inappropriate for requirements
- **TEST_GENERATION_FAILED:** Cannot create meaningful tests from requirements
- **SECURITY_VIOLATION:** Generated code has unresolvable security issues
- **COMPLEXITY_EXCEEDED:** Solution too complex for requirements

### Graceful Failure Handling

**Response:**
- **status:** FAILED
- **reason:** Failure type description
- **recovery:** Recovery path suggestions
- **partial_result:** Save partial progress
- **next_agent:** CLARIFICATION (usually need clarification)

## Integration with Core Protocol

### Protocol Handoff

This extended protocol integrates with agent-protocol-core.md

**IMPORTANT:** For detailed guidance on the following topics, see agent-protocol-core.md:
- **Section 2.2:** Scoped Context Loading
- **Section 5.2:** Token Budget Limits
- **Section 6.1:** Johari Window Format
- **Section 6:** Output Structure
- **Section 4:** Unknown Registry
- **Section 5.2:** Compression Techniques

### Code-Specific Requirements

This protocol adds code-specific requirements:

1. **Domain Classification:** Use core protocol for identifying task domain
2. **Code Generation Context:** Apply this extended protocol when GENERATION agent creates code artifacts
3. **Code Validation Context:** Apply this extended protocol when VALIDATION agent verifies code artifacts
4. **TDD Protocol:** Follow Section 2 RED-GREEN-REFACTOR cycle for all code generation
5. **Security-First:** Follow Section 3 security patterns for all code generation
6. **Python Projects:** Follow Section 4.3 mandatory requirements (uv, absolute imports, pyproject.toml)
7. **Code Structure:** Follow Section 4 patterns for language-appropriate architecture

### Code-Specific Output Requirements

When generating or validating code, include these elements in your Johari Summary (within 1,200 token limit):

**COMPRESSED EXAMPLE (Code Generation):**

**Step Header:** Step N: Code Generation

**Artifacts:** src/feature.py, tests/test_feature.py (15 tests), docs/feature.md

**Tests:** 15/15 passing, 87% coverage (target: 85%)

**Security:** Input validation ✓, Auth ✓, Authz ✓, Encryption ✓, No vulnerabilities

**Johari (max 1200 tokens):**

**open (max 250 tokens):**
OAuth2 feature complete. 15/15 tests pass, 87% coverage. All security gates passed. Async implementation using aiohttp. JWT tokens, 1hr expiry. RBAC with admin/user roles. Rate limit: 100 req/min. Deployed to staging, prod pending.

**hidden (max 280 tokens):**
Async chosen over sync for 10x expected user growth (Q4 projections). Event-driven pattern for resilience vs synchronous. JWT expiry 1hr balances security/UX (rejected 15min as too disruptive, 24hr too risky). RBAC roles aligned to org structure (admin=leadership, user=staff). Rate limit based on API tier pricing model.

**blind (max 180 tokens):**
Load testing incomplete (only tested 100 concurrent). Legacy system integration path unclear - API v1 compatibility assumption unverified. Performance under 1000+ users untested. Token refresh UX not designed. Role permission edge cases (e.g., temp admin access) not handled.

**unknown (max 190 tokens):**
U7: Legacy API v1 compatibility requirements TBD (blocks v1 deprecation timeline)
U8: Production rate limiting strategy undefined (need infra team input)
U9: Token refresh mechanism design needed (UX + security review required)

**Downstream Directives (max 280 tokens):**
- **next:** VALIDATION agent
- **required_context:** This output only
- **optional_context:** Architecture from Phase 2 (token budget constraints)
- **critical_files:** src/feature.py, tests/test_feature.py
- **validation_focus:** Load testing (target: 1000 concurrent users), legacy API compat, security audit

**Token Reduction:**
- Verbose format: 2,800-3,500 tokens, 600-800 lines
- Compressed format: 1,200 tokens (Johari) + 750 tokens (overview) = 1,950 tokens, 300-400 lines
- Reduction: 60-70% fewer tokens, 50-60% fewer lines

### MANDATORY COMPRESSION for Code Generation:

- Test results as lists: "15/15 passing, 87% coverage" not paragraphs
- Security as checkmarks: "Input validation ✓, Auth ✓" not "We validated all inputs and implemented authentication"
- Decisions as facts: "Async chosen for scalability" not "We decided to use async because it provides better scalability"
- Abbreviate: OAuth2, JWT, RBAC, API, TDD, CRUD, REST, OWASP
- Unknowns with IDs: "U7: Description" for tracking

## Quick Reference Checklist

### Before Starting Code Generation:
- Requirements clear and testable
- Domain context understood
- Technology stack appropriate
- Security requirements identified
- Test framework selected

### Python Project Setup:
- Virtual environment created with `uv venv` in project root
- `.venv/` directory exists and is git-ignored
- `pyproject.toml` exists with project metadata
- Dependencies added via `uv add`, NEVER pip install
- Dev dependencies added via `uv add --dev pytest black ruff`
- All test commands use `uv run pytest`
- All code execution uses `uv run python`
- NO global package installations anywhere
- `uv.lock` file exists (auto-generated)
- Python setup verified before proceeding to TDD cycle

### During Code Generation:
- Write tests first (RED)
- Implement minimally (GREEN)
- Refactor for quality (REFACTOR)
- Apply security controls
- Document thoroughly
- Python: Use `uv run pytest` for all test execution
- Python: Use `uv run python` for all code execution

### After Code Generation:
- All tests passing
- Coverage meets target
- Security scan clean
- Documentation complete
- Code structure logical
- Python: Virtual environment intact and functional
- Python: pyproject.toml lists all dependencies
- Python: No pip install commands in documentation

### Validation Checks:
- Functional correctness
- Performance acceptable
- Security validated
- Maintainability verified
- Standards compliance
- Python: Verify `uv run pytest` works
- Python: Verify no global dependencies required

### Context and Compression (CRITICAL):
- Scoped context loading: Read immediate predecessors ONLY
- Token budget enforced: Max 3,000-4,000 tokens context loaded
- Johari summary: 1,200 tokens STRICT MAXIMUM
- Compression techniques applied: decisions over descriptions
- Output format: 300-400 lines maximum per agent
- Memory file stays within size limits

## Conclusion

This extended protocol ensures code generation maintains quality across ALL domains while adapting to specific needs.
