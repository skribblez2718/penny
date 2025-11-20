AGENT EXECUTION PROTOCOL - CORE COMPRESSED SUMMARY

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

IMPLEMENTATION PROTOCOLS - BRIEF GUIDANCE

TEST-DRIVEN DEVELOPMENT (when generating code):

Red-Green-Refactor Cycle:
1. RED: Write failing test first (defines expected behavior)
2. GREEN: Write minimal code to make test pass
3. REFACTOR: Improve code structure while keeping tests green

When to read full protocol: .claude/protocols/TEST-DRIVEN-DEVELOPMENT.md
- Before implementing any feature requiring code generation
- When test coverage requirements unclear
- When test strategy needs definition

SECURITY-FIRST DEVELOPMENT (when generating code):

OWASP Top 10 Awareness (prevention focus):
1. Injection: Use parameterized queries, validate/sanitize input
2. Broken Authentication: Implement secure session management, MFA support
3. Sensitive Data Exposure: Encrypt data at rest and in transit
4. XML External Entities: Disable XXE processing in parsers
5. Broken Access Control: Implement proper authorization checks
6. Security Misconfiguration: Secure defaults, minimal surface area
7. XSS: Sanitize output, use Content Security Policy
8. Insecure Deserialization: Validate serialized data, use safe formats
9. Components with Known Vulnerabilities: Keep dependencies updated
10. Insufficient Logging: Log security events, protect log integrity

When to read full protocol: .claude/protocols/SECURITY-FIRST-DEVELOPMENT.md
- Before implementing authentication, authorization, or data handling
- When security requirements need validation
- When performing security code review

GENERAL PRINCIPLE:
Read compressed protocols for ALL agents. Read full TDD and Security protocols ONLY when generating or validating code implementations.

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

Implementation Protocols (code generation agents):
- .claude/protocols/TEST-DRIVEN-DEVELOPMENT.md (complete TDD workflow + examples)
- .claude/protocols/SECURITY-FIRST-DEVELOPMENT.md (complete security requirements + OWASP details)

When to reference full protocols:
- Edge cases not covered in compressed summary
- Detailed examples needed for complex scenarios
- Specialized workflow patterns (multi-entity chains, conditional flows)
- Comprehensive checklists and validation procedures
- Extended anti-pattern catalogs with remediation strategies
