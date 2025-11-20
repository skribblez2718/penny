AGENT EXECUTION PROTOCOL - EXTENDED COMPRESSED SUMMARY

This extended protocol contains all core operational requirements PLUS detailed Test-Driven Development and Security-First Development guidance for code generation and validation agents.

TASK ID EXTRACTION - MANDATORY FIRST STEP

EVERY agent MUST execute this 4-step extraction procedure before any other work:

Step 1 - Locate Task ID in Prompt
- Search for pattern: "Task ID: task-{name}"
- Pattern appears in first 50 lines of invocation prompt
- Format: task-{descriptive-keywords}
- Validation: 5-40 chars, lowercase + dashes only, starts with "task-"
- Examples: task-oauth2-auth, task-recipe-app, task-react-components

Step 2 - Extract Task ID Value
- Capture exact string after "Task ID: " prefix
- Store as variable for all subsequent file operations
- NEVER modify or transform the Task ID value

Step 3 - Validate Format
- Confirm starts with "task-" prefix
- Confirm length 5-40 characters
- Confirm lowercase letters, numbers, dashes only
- If invalid: HALT execution, report format error to orchestrator

Step 4 - Set Working Task ID
- Use extracted Task ID for ALL memory file operations
- All file reads/writes MUST use this Task ID in paths
- NEVER hardcode or assume Task ID values

ERROR HANDLING:
- Task ID missing from prompt: Report "TASK-ID-MISSING" error, halt execution
- Task ID invalid format: Report "TASK-ID-INVALID" error with details, halt execution
- Multiple Task IDs found: Use first occurrence, log warning

CONTEXT INHERITANCE - 5-STEP MANDATORY PROCESS

Execute BEFORE beginning agent-specific work:

STEP 1: EXTRACT STEP CONTEXT FROM PROMPT

Required fields (always present in invocation prompt):
- Task ID: task-{name}
- Step: {step-number}
- Step Name: {descriptive-name}
- Purpose: {what-this-step-accomplishes}
- Gate Entry: {prerequisites-required}
- Gate Exit: {completion-criteria}

Store all fields for reference throughout execution.

STEP 2: LOAD WORKFLOW CONTEXT

Dual File Pattern - Two types of memory files:

TYPE 1: Workflow Metadata File (centralized)
- Path: .claude/memory/task-{task-id}-memory.md
- Contains: Workflow Metadata JSON + Unknown Registry JSON
- Read: ALWAYS (every agent reads this file)
- Purpose: Shared context, unknown tracking, workflow state

TYPE 2: Agent Output Files (per-agent)
- Path: .claude/memory/task-{task-id}-{agent-name}-memory.md
- Contains: Agent-specific outputs (three-section structure)
- Read: Based on dependencies or last 2 predecessors
- Purpose: Previous agent outputs, discoveries, directives

Reading Strategy:
1. ALWAYS read workflow metadata file first
2. Check prompt for "Read context from:" explicit file list
3. If explicit list provided: read those specific files
4. If no explicit list: read last 2 predecessor agent output files
5. If first agent in workflow: only workflow metadata file exists

STEP 3: RESOLVE PREVIOUS UNKNOWNS

Unknown Registry Structure:
{
  "unknownRegistry": [
    {
      "id": "unknown-001",
      "description": "What deployment platform will be used?",
      "identifiedBy": "requirements-clarifier",
      "identifiedInPhase": "phase-0",
      "status": "unresolved",
      "resolutionPhase": "phase-1",
      "impact": "Cannot finalize technology stack without platform choice"
    }
  ]
}

Resolution Procedure:
1. Load Unknown Registry from workflow metadata file
2. Filter unknowns where resolutionPhase matches current phase
3. For each filtered unknown:
   - Determine if you have information to resolve it
   - If resolvable: document resolution in your output
   - If not resolvable: maintain status "unresolved"
4. Propose Unknown Registry updates in Downstream Directives

NEVER modify Unknown Registry directly - propose updates via Downstream Directives.

STEP 4: ADDRESS BLIND SPOTS

Blind Spot Analysis:
- Review predecessor agent outputs (from Step 2)
- Identify unstated assumptions in their analysis
- Identify missing considerations or edge cases
- Identify implicit dependencies not explicitly documented
- Identify conflicting information between sources

Document blind spots discovered in JOHARI SUMMARY section (Blind Spots quadrant).

STEP 5: CONSOLIDATE OPEN AREA

Open Area = Information you and orchestrator both know and agree on

Consolidation Principles:
- Reference previous content, NEVER repeat verbatim
- Cite sources: "As identified by requirements-clarifier in phase-0..."
- Build on established facts without re-explaining
- Use compressed summaries: "Given the three security requirements (auth, encryption, audit logging)..."

Token Budget Compliance:
- Avoid redundant explanations of information already in workflow context
- Summarize multi-agent discussions: "The technology evaluation consensus..."
- Reference file contents instead of copying: "Per the requirements in task-{id}-memory.md..."

PRE-EXECUTION VALIDATION:
Before proceeding to agent-specific work, verify:
- [ ] Task ID extracted and validated
- [ ] Workflow metadata file read successfully
- [ ] Predecessor agent outputs read (if applicable)
- [ ] Unknown Registry filtered for current phase
- [ ] Blind spots from predecessors identified
- [ ] Open Area context consolidated

REASONING STRATEGIES - APPLY THROUGHOUT EXECUTION

Six strategies for systematic reasoning (apply as needed):

STRATEGY 1: SEMANTIC UNDERSTANDING
- Interpret intent behind instructions, not just literal words
- Distinguish between what is explicitly stated vs implied
- Identify true goal vs surface request
- Apply: At start when interpreting Step Purpose and Gate Exit criteria

STRATEGY 2: CHAIN-OF-THOUGHT (CoT)
- Break problem into explicit logical steps
- Show internal work at each stage
- Connect steps logically to conclusion
- Make reasoning transparent
- Apply: For complex analysis, multi-step procedures, validation logic

STRATEGY 3: TREE-OF-THOUGHTS (ToT)
- Generate 2-3 alternative solution approaches
- Evaluate viability of each path
- Compare trade-offs explicitly
- Select optimal path with justification
- Apply: When multiple valid approaches exist, architecture decisions, trade-off analysis

STRATEGY 4: SELF-CONSISTENCY (SC)
- Generate multiple reasoning chains for same problem
- Identify most consistent conclusion across chains
- Flag divergent paths for explicit consideration
- Apply: Validation of critical decisions, verification of complex logic

STRATEGY 5: SOCRATIC QUESTIONING
- Are all terms and requirements clearly defined?
- What assumptions underlie my conclusions?
- What evidence supports this approach?
- What alternatives exist and why are they suboptimal?
- What perspectives or edge cases am I missing?
- Apply: When facing ambiguity, validating assumptions, challenging conclusions

STRATEGY 6: CONSTITUTIONAL SELF-CRITIQUE
- Review initial analysis against principles
- Critique for accuracy, completeness, clarity, efficiency
- Revise if critique reveals issues
- Re-verify before finalizing output
- Apply: Before completing output, after major decisions, when uncertain

CONFIDENCE SCORING:
Label all conclusions with confidence level:
- CERTAIN: Verified against documentation or explicit requirements
- PROBABLE: Based on best practices and established patterns
- POSSIBLE: Reasonable approach but requires validation
- UNCERTAIN: Requires clarification from orchestrator or user

SELF-REFLECTION LOOP - EXECUTE BEFORE OUTPUT

MANDATORY pre-output quality check (execute in order):

COMPONENT 1: ASSUMPTION AUDIT
Questions to ask yourself:
- What am I assuming about requirements that wasn't explicitly stated?
- What am I assuming about the system/architecture/technology?
- What am I assuming about user needs or preferences?
- Are any assumptions unvalidated or risky?

Document assumptions in output if they affect decisions.

COMPONENT 2: UNCERTAINTY IDENTIFICATION
Questions to ask yourself:
- What information is missing that I need?
- What decisions am I uncertain about?
- What alternatives exist that I couldn't fully evaluate?
- What could go wrong with my recommendations?

Mark unknowns with [NEW-UNKNOWN] in output for registry tracking.

COMPONENT 3: BLIND SPOT CHECK
Questions to ask yourself:
- What perspectives am I not considering?
- What edge cases might I be missing?
- What could users/stakeholders see that I don't?
- What implicit biases are affecting my analysis?

Document discovered blind spots in Blind Spots quadrant.

OUTPUT QUALITY CHECKLIST:
Before finalizing output, verify:
- [ ] Gate Entry criteria validated (were prerequisites met?)
- [ ] Gate Exit criteria addressed (did I accomplish the purpose?)
- [ ] All unknowns from current phase resolved or explained
- [ ] New unknowns documented with [NEW-UNKNOWN] markers
- [ ] Assumptions explicitly stated when they affect decisions
- [ ] Blind spots identified and documented
- [ ] Token budget respected (compressed, no redundant content)
- [ ] Three-section output structure followed

OUTPUT FORMATTING - THREE-SECTION STRUCTURE

ALL agent outputs MUST use this exact structure:

SECTION 1: OVERVIEW AND EXECUTIVE SUMMARY

Purpose: Concise summary of work performed and key findings
Token Budget: 200-400 tokens (10-20% of total output)

Required subsections:
- Work Completed: What you accomplished in this step
- Key Findings: Most important discoveries or conclusions
- Gate Status: Entry criteria validation + Exit criteria completion status

Compression Principles:
- Bullet points, not prose paragraphs
- Reference existing context, don't repeat: "Building on the three requirements identified in phase-0..."
- Highlight only NEW information or decisions
- Avoid redundant summaries of well-established facts

SECTION 2: JOHARI SUMMARY

Purpose: Organize discoveries by knowledge quadrant
Token Budget: 40-60% of total output
Format: JSON structure + brief prose explanation

Required JSON Structure:
{
  "openArea": {
    "summary": "What we both know and agree on (consolidated from context)",
    "newInformation": ["New facts established in this step"]
  },
  "hiddenArea": {
    "summary": "Information you may not be aware of",
    "revelations": ["Insights discovered during analysis", "Constraints identified", "Technical details uncovered"]
  },
  "blindSpots": {
    "summary": "Potential gaps in our collective understanding",
    "identified": ["Assumptions in predecessor analysis", "Missing considerations", "Edge cases not addressed", "Conflicting information"]
  },
  "unknownUnknowns": {
    "summary": "Questions we didn't know to ask",
    "discovered": ["Unexpected dependencies", "Emergent complexity", "New risks identified"]
  }
}

Prose Explanation:
- Brief context for each quadrant (2-4 sentences)
- Explain significance of discoveries
- Connect findings to workflow goals

SECTION 3: DOWNSTREAM DIRECTIVES

Purpose: Actionable guidance for orchestrator and future agents
Token Budget: 20-30% of total output
Format: JSON structure

Required JSON Structure:
{
  "completionStatus": "complete" | "blocked" | "partial",
  "blockingIssues": ["Description of any blockers preventing completion"],
  "nextSteps": ["Recommended actions for next agent or phase"],
  "unknownRegistryUpdates": [
    {
      "action": "add" | "update" | "resolve",
      "unknownId": "unknown-003",
      "description": "What deployment platform will be used?",
      "resolutionPhase": "phase-1",
      "impact": "Cannot finalize architecture without platform choice",
      "resolution": "If action=resolve, provide resolution details"
    }
  ],
  "workflowMetadataUpdates": {
    "field": "value"
  }
}

Critical Requirements:
- completionStatus MUST be accurate ("complete" only if Gate Exit fully met)
- unknownRegistryUpdates MUST use [NEW-UNKNOWN] marker in prose text
- nextSteps MUST be specific and actionable (not vague suggestions)

Example [NEW-UNKNOWN] marker usage in prose:
"The authentication approach remains unclear [NEW-UNKNOWN: What auth method (OAuth2, JWT, session-based) should be used? Resolution needed in phase-2 for security architecture design.]"

MEMORY FILE OPERATIONS

WRITING YOUR OUTPUT:

File Path Derivation:
- Pattern: .claude/memory/task-{task-id}-{your-agent-name}-memory.md
- Extract Task ID from prompt (Step 1)
- Use your agent name from invocation (e.g., "requirements-clarifier", "architecture-synthesizer")
- Example: .claude/memory/task-recipe-app-requirements-clarifier-memory.md

Write Procedure:
1. Format complete output in three-section structure
2. APPEND to file (do NOT overwrite if file exists)
3. If file doesn't exist, create with complete output
4. Include metadata header:
   ```
   # {Agent Name} Output - {Timestamp}
   Task ID: {task-id}
   Step: {step-number}
   ```
5. Write complete three-section formatted output below metadata

NEVER modify workflow metadata file directly - propose updates via Downstream Directives.

COMPLETION SIGNAL:

After writing memory file, output completion signal:
```
AGENT-COMPLETE: {agent-name} | Step {step-number} | Status: {complete|blocked|partial}
```

Example:
```
AGENT-COMPLETE: requirements-clarifier | Step 1 | Status: complete
```

This signals orchestrator that execution finished and memory file written.

TEST-DRIVEN DEVELOPMENT - MANDATORY FOR CODE GENERATION

TDD CORE PRINCIPLES:

1. Test First, Code Second
   - Write test BEFORE implementation
   - Test defines expected behavior and interface
   - Implementation satisfies test requirements

2. Red-Green-Refactor Cycle (MANDATORY)
   - RED: Write failing test first
   - GREEN: Write minimal code to make test pass
   - REFACTOR: Improve code structure while keeping tests green
   - NEVER skip RED phase (no tests for existing code)

3. Minimal Implementation
   - Write ONLY enough code to pass current test
   - No speculative features or premature optimization
   - Each test adds ONE behavior increment

4. Test Quality Standards
   - Tests must be deterministic (same input = same output always)
   - Tests must be isolated (no dependencies between tests)
   - Tests must be readable (clear intent and assertions)
   - Tests must be fast (unit tests < 100ms each)

5. Comprehensive Coverage
   - Unit tests: 80%+ code coverage minimum
   - Integration tests: All component interactions
   - E2E tests: Critical user workflows

TDD WORKFLOW:

PHASE 1: RED - Write Failing Test
1. Identify ONE behavior to implement
2. Write test that exercises this behavior
3. Run test - MUST fail (if passes, test is invalid)
4. Verify failure message is meaningful

Example test structure:
```
test('user authentication with valid credentials succeeds', async () => {
  // Arrange: Set up test data
  const user = { username: 'test@example.com', password: 'secure123' }

  // Act: Execute behavior
  const result = await authenticate(user)

  // Assert: Verify expected outcome
  expect(result.success).toBe(true)
  expect(result.token).toBeDefined()
})
```

PHASE 2: GREEN - Make Test Pass
1. Write minimal implementation code
2. Run test - MUST pass
3. If test fails, fix implementation (not test)
4. ALL previous tests must still pass (regression check)

PHASE 3: REFACTOR - Improve Code Quality
1. Review implementation for improvements:
   - Remove duplication
   - Improve naming clarity
   - Simplify complex logic
   - Extract reusable functions
2. Run ALL tests after each refactor
3. Tests must remain green throughout refactoring
4. Stop when code is clean and tests pass

TEST TYPES AND COVERAGE:

UNIT TESTS (foundational layer):
- Test individual functions/methods in isolation
- Mock external dependencies (database, APIs, file system)
- Coverage target: 80%+ of code paths
- Speed: < 100ms per test
- Quantity: Majority of test suite (70-80% of total tests)

INTEGRATION TESTS (component interaction):
- Test multiple components working together
- Use test databases, mock external services only
- Coverage: All public APIs and service boundaries
- Speed: < 1 second per test
- Quantity: 15-25% of test suite

END-TO-END TESTS (user workflows):
- Test complete user journeys through system
- Use real infrastructure (database, services)
- Coverage: Critical user paths and workflows
- Speed: < 10 seconds per test
- Quantity: 5-10% of test suite, high-value scenarios only

TDD ANTI-PATTERNS TO AVOID:

| Anti-Pattern | Problem | Correct Approach |
|--------------|---------|------------------|
| Writing code before tests | No test to verify behavior | Always write test first (RED phase) |
| Testing implementation details | Brittle tests that break on refactoring | Test public interfaces and behaviors |
| Large test cases | Hard to debug, unclear failures | One behavior per test, clear assertions |
| Skipping refactor phase | Technical debt accumulates | Always refactor after GREEN phase |
| Mocking everything | Tests don't verify real behavior | Mock external dependencies only |
| Ignoring test failures | Broken tests erode trust | Fix immediately or delete broken tests |
| No test for bugs | Bugs can reoccur | Add regression test before fixing bug |

TDD CHECKLIST FOR CODE GENERATION:

Before generating ANY production code:
- [ ] Test file created with appropriate framework imports
- [ ] Test case written describing expected behavior
- [ ] Test executed and confirmed failing (RED phase)
- [ ] Minimal implementation code written
- [ ] Test executed and confirmed passing (GREEN phase)
- [ ] Code refactored for quality while maintaining green tests
- [ ] All existing tests still pass (regression verification)
- [ ] Code coverage measured and meets minimum threshold
- [ ] Integration tests added for component interactions
- [ ] E2E tests added for critical workflows

SECURITY-FIRST DEVELOPMENT - MANDATORY FOR CODE GENERATION

SECURITY CORE PRINCIPLES:

1. Secure by Default
   - Enable security features by default (disable requires explicit action)
   - Fail closed (deny access on error, not grant access)
   - Minimal attack surface (only expose necessary functionality)

2. Defense in Depth
   - Multiple layers of security controls
   - No single point of security failure
   - Validate at every trust boundary

3. Least Privilege
   - Grant minimum permissions necessary for function
   - Separate concerns (authentication vs authorization vs data access)
   - Principle applies to users, services, and components

4. Input Validation and Output Encoding
   - Validate ALL input from untrusted sources (users, APIs, files)
   - Whitelist validation (allow known-good) preferred over blacklist
   - Encode output based on context (HTML, JavaScript, SQL, URL)

5. Cryptography Best Practices
   - Use industry-standard algorithms (AES-256, RSA-2048+, SHA-256+)
   - Never implement custom cryptography
   - Proper key management (secure generation, storage, rotation)

6. Security Testing Integration
   - SAST (Static Application Security Testing) in CI/CD
   - Dependency vulnerability scanning (automated)
   - Regular security code reviews

OWASP TOP 10 - PREVENTION PATTERNS:

1. INJECTION (SQL, Command, LDAP, etc.)
   THREAT: Attacker sends malicious data to interpreter
   PREVENTION:
   - Use parameterized queries (prepared statements) for databases
   - Use ORM frameworks with built-in escaping
   - Validate input against strict whitelist
   - Escape special characters for context (SQL, shell, LDAP)
   EXAMPLE SECURE PATTERN:
   ```
   // SECURE: Parameterized query
   const result = await db.query('SELECT * FROM users WHERE email = ?', [userEmail])

   // INSECURE: String concatenation
   const result = await db.query(`SELECT * FROM users WHERE email = '${userEmail}'`)
   ```

2. BROKEN AUTHENTICATION
   THREAT: Attacker gains access through compromised authentication
   PREVENTION:
   - Implement multi-factor authentication (MFA)
   - Enforce strong password requirements (length > complexity)
   - Use secure session management (HttpOnly, Secure, SameSite cookies)
   - Implement account lockout after failed attempts
   - Hash passwords with strong algorithms (bcrypt, Argon2, PBKDF2)
   CRITICAL: NEVER store passwords in plaintext or weak hashes (MD5, SHA-1)

3. SENSITIVE DATA EXPOSURE
   THREAT: Attacker accesses sensitive data through inadequate protection
   PREVENTION:
   - Encrypt data at rest (database encryption, file system encryption)
   - Encrypt data in transit (TLS 1.2+, HTTPS everywhere)
   - Minimize sensitive data collection (only collect what's needed)
   - Implement proper key management
   - Use secure random number generation (crypto.randomBytes, not Math.random)

4. XML EXTERNAL ENTITIES (XXE)
   THREAT: Attacker exploits XML parser to access files or internal systems
   PREVENTION:
   - Disable XML external entity processing in parsers
   - Use less complex data formats (JSON instead of XML when possible)
   - Validate XML input against strict schema

5. BROKEN ACCESS CONTROL
   THREAT: Attacker bypasses authorization to access unauthorized resources
   PREVENTION:
   - Implement authorization checks on EVERY protected resource
   - Use centralized authorization logic (not scattered checks)
   - Default deny (require explicit permission grant)
   - Validate user permissions on server side (never trust client)
   - Implement proper session management and timeout

6. SECURITY MISCONFIGURATION
   THREAT: Attacker exploits default or insecure configurations
   PREVENTION:
   - Remove default accounts and credentials
   - Disable unnecessary features, services, and ports
   - Keep frameworks and dependencies updated
   - Implement proper error handling (no stack traces to users)
   - Use security headers (CSP, HSTS, X-Frame-Options, etc.)

7. CROSS-SITE SCRIPTING (XSS)
   THREAT: Attacker injects malicious scripts into web pages
   PREVENTION:
   - Sanitize all user input before output
   - Use context-aware output encoding (HTML, JavaScript, URL)
   - Implement Content Security Policy (CSP) headers
   - Use frameworks with automatic escaping (React, Vue, Angular)
   EXAMPLE SECURE PATTERN:
   ```
   // SECURE: Framework handles escaping
   <div>{userInput}</div>  // React automatically escapes

   // INSECURE: Direct HTML injection
   <div dangerouslySetInnerHTML={{__html: userInput}}></div>
   ```

8. INSECURE DESERIALIZATION
   THREAT: Attacker manipulates serialized data to execute code or tamper with logic
   PREVENTION:
   - Avoid deserializing untrusted data when possible
   - Implement integrity checks (HMAC) on serialized data
   - Use safe serialization formats (JSON over pickle/marshal)
   - Validate deserialized data against strict schema

9. USING COMPONENTS WITH KNOWN VULNERABILITIES
   THREAT: Attacker exploits vulnerabilities in dependencies
   PREVENTION:
   - Maintain inventory of all dependencies and versions
   - Automate dependency vulnerability scanning (npm audit, Snyk, Dependabot)
   - Update dependencies regularly (prioritize security patches)
   - Remove unused dependencies
   - Use Software Composition Analysis (SCA) tools in CI/CD

10. INSUFFICIENT LOGGING AND MONITORING
    THREAT: Attacker actions go undetected, breach discovery delayed
    PREVENTION:
    - Log all authentication events (success and failure)
    - Log all authorization failures
    - Log all input validation failures
    - Protect log integrity (append-only, tamper detection)
    - Implement real-time alerting for suspicious patterns
    - CRITICAL: NEVER log sensitive data (passwords, tokens, PII)

SECURITY CODE REVIEW CHECKLIST:

Authentication and Authorization:
- [ ] All protected routes require authentication
- [ ] Authorization checked before accessing resources
- [ ] Session management uses secure, HttpOnly cookies
- [ ] Password hashing uses strong algorithm (bcrypt/Argon2)
- [ ] MFA implemented for sensitive operations

Input Validation:
- [ ] All user input validated against whitelist
- [ ] SQL queries use parameterized statements
- [ ] File uploads validate type, size, and content
- [ ] Input length limits enforced
- [ ] Special characters escaped for context

Data Protection:
- [ ] Sensitive data encrypted at rest
- [ ] TLS 1.2+ enforced for all connections
- [ ] Secrets stored in environment variables (not code)
- [ ] Secure random number generation used
- [ ] PII handling complies with privacy regulations

Output Encoding:
- [ ] User-generated content escaped before display
- [ ] Context-aware encoding (HTML, JavaScript, URL, SQL)
- [ ] Content Security Policy implemented
- [ ] Security headers configured (HSTS, X-Frame-Options)

Error Handling and Logging:
- [ ] Error messages don't reveal sensitive information
- [ ] Stack traces not exposed to users
- [ ] Security events logged (auth failures, access denials)
- [ ] Logs don't contain sensitive data
- [ ] Log integrity protection implemented

Dependencies and Configuration:
- [ ] Dependencies updated and vulnerability-free
- [ ] Unnecessary features and services disabled
- [ ] Default credentials changed or removed
- [ ] Security scanning integrated in CI/CD
- [ ] Code reviewed by security-aware developer

SEVERITY CLASSIFICATION:

When reporting security issues, use this severity classification:

CRITICAL:
- Remote code execution
- Authentication bypass allowing full system access
- Direct access to sensitive data (passwords, financial data, PII)
- Requires IMMEDIATE fix before any deployment

HIGH:
- Authorization bypass allowing access to other users' data
- SQL injection or command injection vulnerabilities
- XSS allowing session hijacking
- Sensitive data exposure through logs or errors
- Requires fix before next release

MEDIUM:
- Missing security headers
- Insecure session management
- Information disclosure (non-sensitive)
- Requires fix in current sprint

LOW:
- Security misconfiguration with low impact
- Missing rate limiting
- Non-exploitable edge cases
- Can be scheduled for future sprint

SECURITY TESTING REQUIREMENTS:

STATIC ANALYSIS (SAST):
- Run security linter on all code (ESLint security plugins, Bandit, etc.)
- Scan for hardcoded secrets (TruffleHog, git-secrets)
- Check dependencies for known vulnerabilities (npm audit, safety)

DYNAMIC ANALYSIS (DAST):
- Test authentication and authorization boundaries
- Verify input validation effectiveness
- Check for XSS, SQL injection, command injection
- Validate HTTPS enforcement and security headers

MANUAL SECURITY REVIEW:
- Review authentication and authorization logic
- Examine cryptography usage
- Validate input handling and output encoding
- Check error handling and logging

CRITICAL ANTI-PATTERNS - NEVER DO THESE

| Anti-Pattern | Problem | Correct Approach |
|--------------|---------|------------------|
| Skipping Task ID extraction | Cannot read/write memory files correctly | ALWAYS execute 4-step extraction first |
| Assuming Task ID value | Hardcoded paths break workflow | Extract from prompt, never assume |
| Repeating context verbatim | Token waste, verbose output | Reference and build on existing context |
| Ignoring Unknown Registry | Unresolved questions propagate | Filter and resolve unknowns for current phase |
| Missing Gate validation | Incomplete work, workflow breaks | Validate Entry, confirm Exit in output |
| Vague Downstream Directives | Next agents lack guidance | Specific, actionable recommendations |
| Wrong completion status | Orchestrator routing errors | "complete" ONLY if Gate Exit fully met |
| Forgetting [NEW-UNKNOWN] | Unknowns not tracked | Mark all new unknowns with marker in text |
| Skipping Self-Reflection | Poor quality output, missed issues | Execute full loop before finalizing output |
| Modifying metadata file | Violates interface contract | Propose updates via Downstream Directives |
| Code before tests (TDD) | No verification of behavior | ALWAYS write failing test first (RED) |
| Weak password hashing | Credential compromise | Use bcrypt, Argon2, or PBKDF2 only |
| SQL string concatenation | SQL injection vulnerability | Use parameterized queries exclusively |
| Unescaped user output | XSS vulnerability | Context-aware output encoding always |
| Hardcoded secrets | Credential exposure in code | Use environment variables, secret managers |
| Ignoring dependency vulnerabilities | Known exploits available | Automated scanning, regular updates |

REFERENCE MATERIALS - FULL PROTOCOL DOCUMENTATION

For detailed guidance, read these full protocols:

Core Protocols:
- .claude/protocols/CONTEXT-INHERITANCE.md (complete inheritance process + examples)
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md (detailed output formatting + token budgets)
- .claude/protocols/REASONING-STRATEGIES.md (extended strategy guidance + examples)
- .claude/protocols/AGENT-INTERFACE-CONTRACTS.md (complete interface specification)
- .claude/protocols/TASK-ID.md (detailed Task ID specification + multi-entity chains)

Template Protocols:
- .claude/templates/JOHARI.md (complete Johari framework + JSON type definitions)
- .claude/templates/CONTEXT-INHERITANCE-EXAMPLES.md (practical examples)

Implementation Protocols:
- .claude/protocols/TEST-DRIVEN-DEVELOPMENT.md (complete TDD workflow, examples, advanced patterns)
- .claude/protocols/SECURITY-FIRST-DEVELOPMENT.md (complete security requirements, threat models, compliance)

When to reference full protocols:
- Edge cases not covered in compressed summary
- Detailed examples needed for complex scenarios
- Specialized workflow patterns (multi-entity chains, conditional flows)
- Comprehensive checklists and validation procedures
- Extended anti-pattern catalogs with remediation strategies
- Advanced TDD patterns (mocking strategies, test organization)
- Detailed threat modeling and security architecture