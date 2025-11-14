CONTEXT INHERITANCE PROTOCOL EXAMPLES

This file provides complete, detailed examples of context inheritance protocol execution. Reference specific line numbers from CONTEXT-INHERITANCE.md to avoid duplication.

NOTE: Examples use generic data processing scenarios for illustration. The same structure applies to any workflow domain by replacing scenario-specific details with your domain content.

EXAMPLE 1: UNKNOWN RESOLUTION (Step 3)

SCENARIO
Agent: requirements-clarifier
Phase: 2 (Requirements Clarification)
Task ID: task-feature-abc
Context: Previous data gathering flagged unknown about processing thresholds

UNKNOWN REGISTRY ENTRY (Before Resolution)
```json
{
  "unknowns": [
    {
      "id": "U3",
      "phase": 1,
      "category": "Scope",
      "description": "Performance target undefined - <500ms or <1s response time?",
      "resolutionPhase": 2,
      "status": "Unresolved",
      "resolution": null
    }
  ]
}
```

AGENT EXECUTION
1. Parse JSON from memory file Workflow Metadata block
2. Filter unknowns: resolutionPhase == 2 AND category in ["Scope", "Business", "Technical"]
3. Identify U3 as relevant (resolutionPhase: 2, category: "Scope")
4. Apply reasoning strategies:
   [CoT] Break down what "performance target" means in OAuth2 context
   [ToT] Generate options: <500ms aggressive, <1s standard, <2s permissive
   [SC] Cross-check against industry standards (OAuth2 typically <500ms for token endpoints)
   [Socratic] Question: "What evidence do we have? What are implications of each target?"
5. Use AskUserQuestion tool to clarify with user
6. User confirms: "<500ms for token endpoint, <1s for authorization endpoint, 95th percentile"
7. Document resolution in Step Overview section
8. Update Unknown Registry JSON

UPDATED REGISTRY (After Resolution)
```json
{
  "unknowns": [
    {
      "id": "U3",
      "phase": 1,
      "category": "Scope",
      "description": "Performance target undefined - <500ms or <1s response time?",
      "resolutionPhase": 2,
      "status": "Resolved",
      "resolution": "User clarified: <500ms for token endpoint, <1s for authorization endpoint, measured at 95th percentile. Added to acceptance criteria AC-NF-2"
    }
  ]
}
```

STEP OVERVIEW DOCUMENTATION
Added to memory file Step 2 section:
"Resolved U3: Performance targets clarified via user confirmation. Token endpoint requires <500ms, authorization endpoint <1s, both at 95th percentile. Codified in AC-NF-2."

EXAMPLE 2: BLIND SPOT ANALYSIS (Step 4)

SCENARIO
Agent: clarify-requirements
Phase: 2 (Requirements Clarification)
Task ID: task-feature-abc
Context: Previous documentation gathering flagged missing specification

PREVIOUS STEP JOHARI SUMMARY (From Step 1 - Documentation Gathering)
```json
{
  "open": "Development request confirmed: Add OAuth2 authentication with Google provider. Existing auth utilities found in src/auth/session.py.",
  "hidden": "Located OAuth2 examples in archived codebase (2023 implementation for deprecated API). Token refresh pattern available for reference.",
  "blind": "No rate limiting mentioned in documentation - should clarify need for API rate limiting to prevent abuse. No error handling strategy specified - need explicit requirements for network failures, invalid tokens, expired sessions.",
  "unknown": "Performance targets not specified (response time SLAs). Refresh token strategy unclear (optional or required?)."
}
```

AGENT EXECUTION
1. Parse JSON from all previous step Johari Summaries in memory file
2. Extract "blind" field from Step 1
3. Identify blinds relevant to requirements clarification:
   - "No rate limiting mentioned" - RELEVANT (scope clarification needed)
   - "No error handling strategy" - RELEVANT (functional requirements needed)
4. Apply reasoning strategies:
   [CoT] Rate limiting: Industry standard for OAuth2 endpoints, prevents credential stuffing
   [ToT] Options: No rate limiting, basic (IP-based), advanced (user+IP+endpoint)
   [Socratic] Question: "Is this a public or internal API? What's the risk profile?"
5. Address proactively in acceptance criteria:
   - Added AC-NF-3: "Rate limiting required - 100 requests/minute per user, 429 status on exceed"
   - Added AC-F-8: "Error handling for network failures, invalid tokens, expired sessions with user-friendly messages"
6. Document in current step's Johari Summary "hidden" field

CURRENT STEP JOHARI SUMMARY (Step 2 - Requirements Clarification)
```json
{
  "open": "Development request and Google provider confirmed per Step 1. User clarified: JWT tokens with 1hr expiry, refresh tokens optional. Performance: <500ms token endpoint, <1s auth endpoint at 95th percentile.",
  "hidden": "Addressed previous blind spots: Added explicit rate limiting requirement (AC-NF-3: 100 req/min, 429 response). Specified error handling strategy (AC-F-8: network failures, invalid tokens, expired sessions with UX messaging). Total acceptance criteria: 12 functional, 4 non-functional.",
  "blind": "Token storage security not addressed - need clarification on encryption at rest vs in-transit only. Logout behavior unclear - should tokens be actively revoked or rely on expiry?",
  "unknown": "CORS configuration requirements if this will be cross-origin API. Monitoring/logging requirements for security audit trail."
}
```

EXAMPLE 3: OPEN AREA CONSOLIDATION (Step 5)

SCENARIO
Agent: clarify-requirements
Phase: 2 (Requirements Clarification)
Task ID: task-feature-abc
Context: Building on confirmed knowledge from previous step

PREVIOUS STEP JOHARI SUMMARY (From Step 1 - Documentation Gathering)
```json
{
  "open": "Development request confirmed: Add OAuth2 authentication with Google provider. Existing auth utilities found in src/auth/session.py. Project uses Flask framework with SQLAlchemy ORM. Python 3.11 runtime.",
  "hidden": "...",
  "blind": "...",
  "unknown": "..."
}
```

AGENT EXECUTION
1. Parse JSON from all previous step Johari Summaries
2. Extract "open" field from Step 1
3. Reference (not repeat) previous confirmations
4. Add NEW confirmed knowledge from current step's work
5. Apply reasoning strategies:
   [SC] Cross-verify new confirmations against previous open knowledge - ensure no contradictions
   [Socratic] Question: "Is this truly confirmed or am I assuming?"
6. Format: "[Reference to previous] (per Step N). [New confirmed facts]"

CURRENT STEP JOHARI SUMMARY (Step 2 - Requirements Clarification)
```json
{
  "open": "Development request, Google provider, Flask/SQLAlchemy stack, Python 3.11 confirmed per Step 1. User clarifications added: JWT tokens (1hr expiry), refresh tokens optional, performance targets (<500ms token, <1s auth at p95), rate limiting (100 req/min per user). Acceptance criteria finalized: 12 functional (AC-F-1 through AC-F-12), 4 non-functional (AC-NF-1 through AC-NF-4). All criteria validated with user - ready for technical analysis.",
  "hidden": "Addressed previous blind spots: Added explicit rate limiting requirement (AC-NF-3: 100 req/min, 429 response). Specified error handling strategy (AC-F-8: network failures, invalid tokens, expired sessions with UX messaging). Total acceptance criteria: 12 functional, 4 non-functional.",
  "blind": "Token storage security not addressed - need clarification on encryption at rest vs in-transit only. Logout behavior unclear - should tokens be actively revoked or rely on expiry?",
  "unknown": "CORS configuration requirements if this will be cross-origin API. Monitoring/logging requirements for security audit trail."
}
```

KEY OBSERVATIONS
- "open" field references Step 1 confirmations without repeating verbatim
- New confirmed knowledge added (user clarifications, acceptance criteria count, validation status)
- No assumptions included - only verified facts
- Prepares downstream steps with clear confirmed baseline

EXAMPLE 4: COMPLETE WORKFLOW CONTEXT LOADING (Step 2)

SCENARIO
Agent: impact-analyzer
Phase: 4 (Risk Identification)
Task ID: task-feature-abc
Context: Loading complete workflow history before beginning analysis

MEMORY FILE STRUCTURE
```
# Workflow Metadata (JSON block at top)
{
  "task-id": "task-feature-abc",
  "workflow": "develop-agent",
  "startDate": "2025-11-10",
  "criticalConstraints": ["SCRP compliance", "VALIDATOR cognitive function", "Workflow-agnostic design"],
  "successCriteria": ["All design principles validated", "Reusability test passed"],
  "unknownRegistry": {
    "unknowns": [
      {"id": "U1", "status": "Resolved", ...},
      {"id": "U2", "status": "Resolved", ...},
      {"id": "U3", "status": "Resolved", ...},
      {"id": "U4", "phase": 3, "category": "Integration", "resolutionPhase": 4, "status": "Unresolved", ...}
    ]
  }
}

# Phase 1: Documentation Gathering (Markdown)
[Step overview content with findings...]

# Phase 1 Johari Summary (JSON)
{"open": "...", "hidden": "...", "blind": "...", "unknown": "..."}

# Phase 1 Downstream Directives (JSON)
{"requirements": [...], "constraints": [...], "risks": [...], ...}

# Phase 2: Requirements Clarification (Markdown)
[Step overview content with acceptance criteria...]

# Phase 2 Johari Summary (JSON)
{"open": "...", "hidden": "...", "blind": "...", "unknown": "..."}

# Phase 2 Downstream Directives (JSON)
{"technical": [...], "integration": [...], ...}

# Phase 3: Technical Context Analysis (Markdown)
[Step overview content with architecture analysis...]

# Phase 3 Johari Summary (JSON)
{"open": "...", "hidden": "...", "blind": "...", "unknown": "..."}

# Phase 3 Downstream Directives (JSON)
{"risks": [...], "dependencies": [...], ...}
```

AGENT EXECUTION (impact-analyzer in Phase 4)
1. Extract task-id from invocation prompt: "task-feature-abc"
2. Derive memory file path: ".claude/memory/task-feature-abc-memory.md"
3. Read ENTIRE file (all previous phases)
4. Parse JSON Workflow Metadata:
   - task-id: task-feature-abc
   - workflow: develop-agent
   - criticalConstraints: 3 items loaded
   - successCriteria: 2 items loaded
   - unknownRegistry: 4 unknowns total (3 resolved, 1 unresolved)
5. Filter unknownRegistry for Phase 4, relevant categories ["Performance", "Security", "Integration"]:
   - U4 matches: phase=3, resolutionPhase=4, category="Integration", status="Unresolved"
   - Agent must resolve U4 during risk analysis
6. Parse all previous Johari Summaries (Phases 1-3):
   - Phase 1 blind spots reviewed
   - Phase 2 blind spots reviewed
   - Phase 3 blind spots reviewed
   - Identify gaps relevant to risk analysis
7. Parse all previous Open knowledge (Phases 1-3):
   - Confirmed requirements loaded
   - Confirmed architecture decisions loaded
   - Ready to reference without repeating
8. Validate Gate Entry: "Technical context analysis complete"
   - Check Phase 3 section exists in memory file
   - Check Phase 3 Johari Summary present
   - Confirm no "INCOMPLETE" markers
   - Gate Entry: PASSED
9. Proceed to Phase 4 risk identification work

REASONING STRATEGY APPLICATION
[SC] Cross-verified gate entry from multiple angles: file presence, content completeness, gate markers
[Socratic] Questioned: "Is technical analysis truly complete or are there gaps?" - Confirmed via explicit completion statement in Phase 3
[Constitutional] Reviewed against protocol requirements: All 5 context inheritance steps completed before proceeding

RESULT
Agent begins Phase 4 work with complete context from Phases 1-3, ready to:
- Resolve unknown U4 (flagged for this phase)
- Address blind spots from previous phases
- Build on confirmed open knowledge
- Produce Phase 4 output that maintains continuity

USAGE NOTES

REFERENCING FROM PROTOCOL
Instead of duplicating these examples in CONTEXT-INHERITANCE.md, reference by line number:
"See CONTEXT-INHERITANCE-EXAMPLES.md lines 15-85 for complete unknown resolution example"

ADAPTING EXAMPLES
These examples use OAuth2 authentication scenario. Apply same structure to any domain:
- Replace task-id, scenario details, unknowns, blind spots with your context
- Keep JSON structures identical
- Maintain reasoning strategy applications
- Follow same execution flow

TEMPLATE EXTRACTION
Use these examples as templates:
- Lines 15-85: Unknown resolution template
- Lines 87-143: Blind spot analysis template
- Lines 145-191: Open area consolidation template
- Lines 193-284: Complete context loading template
