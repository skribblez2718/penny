AGENT EXECUTION PROTOCOL

PURPOSE
Standard execution pattern for all agents in multi-phase workflows. This protocol defines the generic steps that every agent must execute during and after performing agent-specific work.

SCOPE
This protocol applies to ALL agents regardless of complexity or domain. Agent descriptions reference this protocol instead of duplicating these steps.

CRITICAL REQUIREMENT
ALL AGENTS must execute these steps:
- DURING EXECUTION: Self-Reflection Loop (before generating output)
- POST-EXECUTION: Format Output (structure output per contract)
- FINAL STEP: Append to Memory (write to memory file)

---

DURING EXECUTION: SELF-REFLECTION LOOP

Execute this loop BEFORE generating final output to validate assumptions, identify uncertainties, and check blind spots.

ASSUMPTION AUDIT

List every assumption you're making (explicit or implicit).

For each assumption:
1. Is this documented in task-specific memory Open quadrants?
   - If YES → Reference it explicitly
   - If NO → Proceed to next check

2. Is this based on authoritative source (docs, code, user confirmation)?
   - If YES → Cite source in Hidden quadrant
   - If NO → Proceed to next check

3. What's the risk if this assumption is wrong?
   - If HIGH RISK → Flag in Unknown quadrant, attempt resolution with available tools
   - If MEDIUM RISK → Document assumption in Hidden quadrant with alternatives
   - If LOW RISK → Proceed with assumption, document in Hidden quadrant

4. Can I verify with available tools (Read, Grep, WebSearch, WebFetch)?
   - If YES → Verify now before finalizing output
   - If NO → Document as unverifiable assumption

UNCERTAINTY IDENTIFICATION

Mark areas where confidence is below 80%.

For each uncertain area:
1. Can research resolve this uncertainty?
   - YES → Use WebSearch or WebFetch to gather information
   - NO → Proceed to next check

2. Can reasoning resolve this uncertainty?
   - YES → Apply multi-perspective analysis (Tree of Thought from REASONING-STRATEGIES.md)
   - NO → Proceed to next check

3. Does this require specification or clarification?
   - YES → Make documented decision with alternatives noted in Hidden quadrant
   - NO → Proceed to next check

4. Is this truly unknown (requires user input or future information)?
   - YES → Flag in Unknown quadrant with appropriate category
   - NO → Re-evaluate uncertainty

BLIND SPOT CHECK

Apply perspective shifts to identify gaps you might be missing.

For each perspective, identify SPECIFIC gaps (not hypotheticals):

1. Security perspective:
   - Missing input validation?
   - Credential exposure risks?
   - Authorization checks missing?
   - Injection vulnerabilities?

2. Performance perspective:
   - O(n²) or worse algorithms?
   - Memory leaks or unbounded growth?
   - Blocking operations in critical paths?
   - Unnecessary network calls?

3. User perspective:
   - Missing error messages?
   - Confusing workflows or unclear instructions?
   - Accessibility issues (screen readers, keyboard nav)?
   - Mobile/responsive design considerations?

4. Integration perspective:
   - Breaking changes to existing interfaces?
   - Missing dependencies or version conflicts?
   - Incompatible data formats?
   - Race conditions in concurrent scenarios?

5. Edge case perspective:
   - Null/empty/undefined inputs?
   - Concurrent access patterns?
   - Network failures or timeouts?
   - Maximum size/length constraints?
   - Boundary conditions (zero, negative, max values)?

Document findings:
- If gaps discovered → Address them OR flag in Blind quadrant
- If risks identified → Mitigate them OR document in Unknown quadrant with rationale
- Include reflection results in Hidden quadrant (decisions made, gaps identified)

OUTPUT QUALITY CHECKLIST

Before finalizing output, verify:

□ All Critical Constraints from Workflow Metadata considered
□ Success Criteria from Workflow Metadata addressed
□ Previous steps' Unknown/Blind items reviewed and considered
□ My unknowns categorized and ready to add to Unknown Registry
□ Assumptions validated or explicitly flagged
□ Confidence levels honest (not overconfident)
□ Reasoning strategies applied at key decision points (documented where significant)
□ Token budget will be respected in formatted output

If ANY item unchecked, address it before proceeding to Format Output step.

---

POST-EXECUTION: FORMAT OUTPUT

Structure output according to AGENT-INTERFACE-CONTRACTS.md specifications.

REQUIRED STRUCTURE

Your output MUST contain exactly three sections:

1. PHASE {N}: {STEP-NAME} - OVERVIEW
2. PHASE {N}: {STEP-NAME} - JOHARI SUMMARY
3. PHASE {N}: {STEP-NAME} - DOWNSTREAM DIRECTIVES

SECTION 1: OVERVIEW

Format: Compressed markdown (bullets, numbered lists, tables - NO prose)
Token Budget: Specified in agent description (typically 80-150 tokens)

Content: Work product specific to agent's responsibility
- Deliverables produced this step
- Key findings or decisions
- Data structures or artifacts created
- Analysis results or recommendations

Compression Principles:
- Use bullets/numbers instead of paragraphs
- Abbreviate where context is clear
- Reference previous sections instead of repeating
- Focus on NEW information from this step

SECTION 2: JOHARI SUMMARY

Format: JSON wrapper containing markdown strings
Token Budget: Specified in agent description (typically 60-120 tokens)

Structure:
```json
{
  "open": "What everyone now knows and agrees on (validated facts, user confirmations, established constraints)",
  "hidden": "What this agent discovered or decided (choices made, approaches selected, assumptions taken)",
  "blind": "Potential gaps or concerns identified (what might be missing, risks flagged, areas needing attention)",
  "unknown": "Unresolved questions or ambiguities (pending validations, external dependencies, items for Unknown Registry)"
}
```

Quadrant Guidance:
- **open**: Reference previous confirmations + new validated knowledge from this step
- **hidden**: Decisions made this step + discoveries + methodology chosen
- **blind**: Proactive concerns + identified gaps + testability issues
- **unknown**: Unresolved ambiguities + flag new unknowns with [NEW-UNKNOWN] marker

Unknown Registry Markers:
- Use [NEW-UNKNOWN] to flag items for orchestration layer to add to registry
- Reference existing unknowns by ID (e.g., "Addresses U3, U5 from previous steps")

SECTION 3: DOWNSTREAM DIRECTIVES

Format: JSON object with four required subsections
Token Budget: Specified in agent description (typically 30-60 tokens)

Structure:
```json
{
  "phaseGuidance": [
    "Specific actionable item for next step",
    "Another concrete directive",
    "Validation or verification needed"
  ],
  "validationRequired": [
    "What next step should verify",
    "Checks that must pass before proceeding"
  ],
  "blockers": [
    "Any blocking issues discovered (empty array if none)"
  ],
  "priorityUnknowns": [
    "Unknown Registry IDs requiring resolution (e.g., U1, U3)"
  ]
}
```

Subsection Guidance:
- **phaseGuidance**: 2-5 specific actions for next step (not generic advice)
- **validationRequired**: 1-3 concrete checks next step must perform
- **blockers**: Only actual blockers that prevent workflow progress (often empty)
- **priorityUnknowns**: Unknown IDs from registry needing resolution for progress

MINIMAL COMPLETE EXAMPLE

```markdown
---
PHASE 2: Requirements Clarification - OVERVIEW

**Functional Requirements**
- User authentication via OAuth2 (Google, GitHub providers)
- Session management with JWT tokens (24hr expiry)
- Role-based access control (Admin, User, Guest)

**Non-Functional Requirements**
- Response time <200ms for auth endpoints
- 99.9% uptime SLA
- GDPR compliance for EU users

**Constraints**
- Must integrate with existing PostgreSQL database
- Deploy to AWS infrastructure
- Budget: $500/month hosting costs

PHASE 2: Requirements Clarification - JOHARI SUMMARY

```json
{
  "open": "OAuth2 with Google/GitHub confirmed. JWT session management. 3 user roles. Performance target <200ms. GDPR compliance required.",
  "hidden": "Chose JWT over session cookies for scalability. Assumed PostgreSQL schema extensible for user roles. Selected 24hr expiry as balance between security and UX.",
  "blind": "OAuth2 refresh token handling not specified. Rate limiting strategy undefined. Multi-region deployment for 99.9% uptime may exceed budget.",
  "unknown": "[NEW-UNKNOWN] OAuth2 callback URL configuration - local dev vs staging vs prod environments unclear. [NEW-UNKNOWN] GDPR data retention policy - how long to keep user data?"
}
```

PHASE 2: Requirements Clarification - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Design PostgreSQL schema with user, role, session tables",
    "Architect OAuth2 flow with provider abstraction layer",
    "Plan JWT token refresh mechanism"
  ],
  "validationRequired": [
    "Verify PostgreSQL schema supports role hierarchy",
    "Confirm AWS infrastructure can meet <200ms latency requirement"
  ],
  "blockers": [],
  "priorityUnknowns": ["U3", "U4"]
}
```

---
```

TOKEN BUDGET COMPLIANCE

Calculate token count before finalizing:
- Overview tokens + Johari tokens + Directives tokens = Total
- Total must be within specified range in agent description
- If over budget: compress further using abbreviations, remove redundancy
- If significantly under budget: verify no critical information omitted

---

FINAL STEP: APPEND TO MEMORY

Write formatted output to task-specific memory file.

PROCESS

1. Read current memory file content (if not already loaded during context inheritance)
   - File path: `.claude/memory/task-{task-id}-memory.md`
   - Verify file exists and is readable

2. Prepare output with proper structure
   - Ensure all three sections present
   - Validate JSON structures parsable
   - Confirm token budget respected
   - Add clear delimiters (---) between sections

3. Append to memory file (NEVER OVERWRITE)
   - **PREFERRED**: Use Edit tool to append new content
   - **FALLBACK**: Use Write tool with FULL existing content + new content
   - CRITICAL: Existing content must be preserved

4. Validate successful append
   - Confirm file updated successfully
   - No errors from file operation

5. Signal completion
   - Format: "{step-name} complete. Output appended to .claude/memory/task-{task-id}-memory.md"
   - Use step name from Step Context provided in invocation prompt

APPEND EXAMPLES

**Using Edit Tool (Preferred)**:
```
Edit tool:
- file_path: .claude/memory/task-feature-abc-memory.md
- old_string: [Last few lines of existing content to match against]
- new_string: [Same last few lines + new three-section output]
```

**Using Write Tool (Fallback)**:
```
Write tool:
- file_path: .claude/memory/task-feature-abc-memory.md
- content: [Full existing content] + [New three-section output]
```

COMPLETION SIGNAL FORMAT

Standard format:
```
{step-name} complete. Output appended to .claude/memory/task-{task-id}-memory.md
```

Example:
```
Requirements Clarification complete. Output appended to .claude/memory/task-feature-abc-memory.md
```

---

INTEGRATION WITH AGENT DESCRIPTIONS

HOW AGENTS REFERENCE THIS PROTOCOL

Agent descriptions include this section:

```markdown
MANDATORY PROTOCOL
Read and execute these protocols in sequence:
1. .claude/protocols/CONTEXT-INHERITANCE.md (before agent-specific work)
2. .claude/protocols/REASONING-STRATEGIES.md (at decision points)
3. .claude/protocols/AGENT-EXECUTION-PROTOCOL.md (during/after execution)

See .claude/protocols/AGENT-INTERFACE-CONTRACTS.md for input/output contracts.
```

EXECUTION SEQUENCE

1. Context Inheritance (CONTEXT-INHERITANCE.md)
   - Extract Task ID and Step Context
   - Load workflow context from memory
   - Resolve flagged unknowns
   - Build on previous steps

2. Agent-Specific Work (from agent description)
   - Execute domain-specific steps
   - Apply REASONING-STRATEGIES.md at decision points
   - Gather information, analyze, generate output

3. Self-Reflection Loop (this protocol - DURING EXECUTION)
   - Audit assumptions
   - Identify uncertainties
   - Check blind spots
   - Validate output quality

4. Format Output (this protocol - POST-EXECUTION)
   - Structure three sections
   - Respect token budgets
   - Validate JSON structures

5. Append to Memory (this protocol - FINAL STEP)
   - Write to task-specific memory
   - Preserve existing content
   - Signal completion

---

COMMON MISTAKES TO AVOID

ANTI-PATTERN 1: Skipping Self-Reflection

**Bad**: Agent completes work and immediately formats output without reflection
```
Agent executes steps → Formats output → Done
(No assumption audit, no blind spot check)
```

**Correct**: Agent pauses before output to validate and reflect
```
Agent executes steps → Self-Reflection Loop → Identifies gaps → Addresses gaps → Formats output
```

ANTI-PATTERN 2: Overwriting Memory File

**Bad**: Using Write tool without preserving existing content
```python
Write(.claude/memory/task-component-xyz-memory.md, new_output_only)
# DESTROYS previous step outputs!
```

**Correct**: Append using Edit or Write with full content
```python
Edit(.claude/memory/task-component-xyz-memory.md,
     old=last_section,
     new=last_section + new_output)
# OR
existing = Read(.claude/memory/task-component-xyz-memory.md)
Write(.claude/memory/task-component-xyz-memory.md, existing + new_output)
```

ANTI-PATTERN 3: Ignoring Token Budget

**Bad**: Verbose output exceeding specified budget
```markdown
OVERVIEW (350 tokens - budget was 120)
In this comprehensive analysis, I have thoroughly examined...
[6 paragraphs of prose]
```

**Correct**: Compressed output within budget
```markdown
OVERVIEW (115 tokens)
**Functional Requirements**
- OAuth2 auth (Google, GitHub)
- JWT sessions (24hr expiry)
- RBAC (Admin/User/Guest)
```

ANTI-PATTERN 4: Vague Unknown Flagging

**Bad**: Generic unknowns without context
```json
{
  "unknown": "Some configuration details unclear. Need more information."
}
```

**Correct**: Specific unknowns with [NEW-UNKNOWN] markers
```json
{
  "unknown": "[NEW-UNKNOWN] OAuth2 callback URLs for dev/staging/prod environments not specified - affects deployment configuration in Step 5. [NEW-UNKNOWN] GDPR data retention duration - required for database schema design."
}
```

ANTI-PATTERN 5: Repeating Previous Context

**Bad**: Duplicating information from previous steps in Open quadrant
```json
{
  "open": "Step 1 established project scope: web application. Step 2 identified tech stack: React, Node.js, PostgreSQL. Step 3 documented requirements: [repeats everything]..."
}
```

**Correct**: Reference + new information only
```json
{
  "open": "Building on Step 1-2 context (web app, React/Node/Postgres): Confirmed OAuth2 authentication requirement with Google/GitHub providers. Established <200ms performance target for auth endpoints."
}
```

---

RELATED DOCUMENTS

- `.claude/protocols/CONTEXT-INHERITANCE.md` - Context loading before execution
- `.claude/protocols/REASONING-STRATEGIES.md` - Decision-making strategies during execution
- `.claude/protocols/AGENT-INTERFACE-CONTRACTS.md` - Input/output contract specifications
- `.claude/templates/JOHARI.md` - Detailed Johari quadrant guidance and philosophy
- `.claude/protocols/TASK-ID.md` - Task ID format and Step Context specifications
