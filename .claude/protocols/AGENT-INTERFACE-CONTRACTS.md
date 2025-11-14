AGENT INTERFACE CONTRACTS

PURPOSE
Define the contract between agents and the orchestration layer, enabling loose coupling and independent agent development. This specification ensures agents can be tested independently, reused across workflows, and evolved without breaking existing systems.

DESIGN PHILOSOPHY
Agents should focus on their domain-specific work, treating memory structures and workflow orchestration as implementation details behind a stable interface. The orchestration layer handles infrastructure concerns (memory management, registry updates, workflow state) while agents handle domain logic.

---

INPUT CONTRACT

WHAT AGENTS RECEIVE

When invoked by the orchestration layer (Penny or skill workflows), agents receive structured context in their invocation prompt:

```
Task ID: task-{descriptive-name}
Step: {step-number}
Step Name: {step-name}
Purpose: {what-this-step-accomplishes}
Gate Entry: {prerequisites-that-must-be-met}
Gate Exit: {completion-criteria}

{Agent-specific invocation instructions}
```

INPUT COMPONENTS

**Task ID** (format: task-{name})
- Unique identifier for this workflow instance
- Format specified in `.claude/protocols/TASK-ID.md`
- Used to derive memory file path: `.claude/memory/task-{task-id}-memory.md`
- Must be 5-40 characters, lowercase + dashes only

**Step Number**
- Integer indicating position in workflow (1, 2, 3, ...)
- Used in output section headers: "PHASE {N}: {STEP-NAME}"
- Helps agents understand workflow progression

**Step Name**
- Human-readable name for this step
- Examples: "Requirements Clarification", "Architecture Design", "Code Implementation"
- Used in output section headers and completion signals

**Purpose**
- Clear statement of what this step accomplishes in the workflow
- Guides agent's focus and deliverables
- Example: "Transform vague requirements into explicit, testable acceptance criteria"

**Gate Entry**
- Prerequisites that must be satisfied before this step executes
- Example: "Previous step has completed documentation gathering and flagged ambiguities"
- Agents validate these are met (documented in previous step outputs)

**Gate Exit**
- Completion criteria that define when this step is done
- Example: "All requirements have explicit acceptance criteria with test cases"
- Agents ensure these are met before signaling completion

**Agent-Specific Instructions**
- Detailed work instructions specific to this agent and workflow context
- May include domain-specific guidance, constraints, or requirements
- Provided by skill workflow or orchestrating system

AGENT RESPONSIBILITIES FOR INPUT

1. **Extract Task ID**
   - Parse Task ID from invocation prompt
   - Validate format per TASK-ID.md protocol
   - Signal error if Task ID invalid or missing

2. **Extract Step Context**
   - Parse all step metadata (Step, Step Name, Purpose, Gate Entry, Gate Exit)
   - Validate completeness (all fields present)
   - Signal error if Step Context incomplete

3. **Derive Memory File Path**
   - Calculate: `.claude/memory/task-{task-id}-memory.md`
   - Example: `task-feature-abc` → `.claude/memory/task-feature-abc-memory.md`

4. **Execute Context Inheritance**
   - Follow `.claude/protocols/CONTEXT-INHERITANCE.md` protocol
   - Load workflow context from memory file
   - Resolve flagged unknowns from previous steps
   - Build on established knowledge (Open quadrant)

INVOCATION EXAMPLE

```
Task ID: task-component-xyz
Step: 2
Step Name: Requirements Clarification
Purpose: Convert initial feature requests into explicit, testable acceptance criteria with comprehensive test cases
Gate Entry: Phase 1 documentation gathering completed, user provided initial feature list, ambiguities flagged
Gate Exit: All features have explicit acceptance criteria, test cases cover happy paths and edge cases, assumptions documented

Analyze the feature requests gathered in Phase 1. The user wants a recipe management app but hasn't specified:
- Recipe input method (manual entry, import, or both?)
- Search capabilities (by ingredient, cuisine, dietary restrictions?)
- Sharing features (public, private, social media integration?)

Clarify these ambiguities through direct user interaction. Generate acceptance criteria in Given-When-Then format for each clarified feature. Include test cases for happy paths, edge cases (empty inputs, special characters), and error scenarios.
```

---

OUTPUT CONTRACT

WHAT AGENTS RETURN

Agents produce structured output appended to the task-specific memory file. Output consists of exactly three sections:

1. **PHASE {N}: {STEP-NAME} - OVERVIEW**
2. **PHASE {N}: {STEP-NAME} - JOHARI SUMMARY**
3. **PHASE {N}: {STEP-NAME} - DOWNSTREAM DIRECTIVES**

OUTPUT SECTION 1: OVERVIEW

**Format**: Compressed markdown (bullets, numbered lists, tables)
**Token Budget**: Specified in agent description (typically 80-150 tokens)
**Compression**: HIGH (no prose, abbreviate where clear)

**Content**:
- Work product produced this step
- Key findings or decisions
- Deliverables specific to agent's domain
- Analysis results or recommendations

**Principles**:
- NEW information only (don't repeat previous steps)
- Structured format (bullets/numbers/tables, not paragraphs)
- Reference previous sections instead of duplicating
- Focus on actionable deliverables

OUTPUT SECTION 2: JOHARI SUMMARY

**Format**: JSON object with four keys, markdown string values
**Token Budget**: Specified in agent description (typically 60-120 tokens)
**Compression**: MEDIUM (concise but complete)

**Structure**:
```json
{
  "open": "What everyone now knows and agrees on",
  "hidden": "What this agent discovered, decided, or chose",
  "blind": "Potential gaps, risks, or concerns identified",
  "unknown": "Unresolved questions, ambiguities, or dependencies"
}
```

**Quadrant Semantics**:

- **open** (Shared Knowledge)
  - Validated facts confirmed this step
  - User confirmations and agreements
  - Established constraints and requirements
  - Reference previous Open + add new validated knowledge
  - Example: "OAuth2 with Google/GitHub confirmed. Performance target <200ms. GDPR compliance required."

- **hidden** (Agent Decisions)
  - Decisions made during execution
  - Approaches or methodologies selected
  - Assumptions taken with rationale
  - Discoveries or insights gained
  - Example: "Chose JWT over session cookies for stateless scaling. Assumed PostgreSQL schema extensible. Selected 24hr token expiry balancing security/UX."

- **blind** (Identified Gaps)
  - Potential issues or risks flagged proactively
  - Areas needing attention from next step
  - Edge cases requiring consideration
  - Testability or implementation concerns
  - Example: "OAuth refresh token handling not specified. Rate limiting undefined. Multi-region deployment may exceed budget."

- **unknown** (Unresolved Items)
  - Questions requiring user input
  - External dependencies or unknowns
  - Items for Unknown Registry (marked with [NEW-UNKNOWN])
  - References to existing unknowns by ID (U1, U2, etc.)
  - Example: "[NEW-UNKNOWN] OAuth callback URLs for dev/staging/prod unclear. [NEW-UNKNOWN] GDPR retention duration unspecified."

**Unknown Registry Markers**:
- Use `[NEW-UNKNOWN]` prefix to flag new items for orchestration layer
- Orchestration layer parses these and adds to Unknown Registry
- Agents don't manipulate Unknown Registry JSON directly
- Agents reference existing unknowns by ID: "Addresses U3, resolves U5"

OUTPUT SECTION 3: DOWNSTREAM DIRECTIVES

**Format**: JSON object with four required keys
**Token Budget**: Specified in agent description (typically 30-60 tokens)
**Compression**: HIGH (terse, actionable)

**Structure**:
```json
{
  "phaseGuidance": [
    "Specific action for next step",
    "Another concrete directive"
  ],
  "validationRequired": [
    "What next step must verify"
  ],
  "blockers": [],
  "priorityUnknowns": ["U1", "U3"]
}
```

**Subsection Semantics**:

- **phaseGuidance** (2-5 items)
  - Specific, actionable items for next step
  - Concrete directives, not generic advice
  - Example: "Design PostgreSQL schema with user, role, session tables"
  - NOT: "Consider database design carefully"

- **validationRequired** (1-3 items)
  - Checks next step must perform
  - Verification criteria for deliverables
  - Example: "Verify PostgreSQL schema supports role hierarchy"
  - NOT: "Make sure everything works"

- **blockers** (0-N items)
  - **ONLY actual blockers** that prevent workflow progress
  - Often empty array (no blockers is good!)
  - Example: "User approval pending for $10k cloud infrastructure cost"
  - NOT non-blocking concerns (those go in Blind quadrant)

- **priorityUnknowns** (Unknown Registry IDs)
  - List of Unknown IDs requiring resolution for progress
  - Format: ["U1", "U3", "U7"]
  - References items in Unknown Registry that block next steps
  - Empty array if no priority unknowns

OUTPUT VALIDATION

Before appending to memory, verify:
- All three sections present with correct headers
- JSON structures are valid and parsable
- Token budgets respected (count before writing)
- Unknown markers formatted correctly ([NEW-UNKNOWN] prefix)
- Unknown IDs match registry format (U1, U2, etc.)
- No existing memory content will be overwritten

---

ORCHESTRATION LAYER RESPONSIBILITIES

WHAT THE ORCHESTRATOR DOES

The orchestration layer (Penny or skill workflows) handles infrastructure concerns that agents should not manage directly:

**Memory Management**
- Creates task-specific memory files on workflow initialization
- Initializes Workflow Metadata section
- Ensures memory files are properly formatted
- Handles file creation errors

**Unknown Registry Management**
- Parses agent outputs for [NEW-UNKNOWN] markers
- Generates unique Unknown IDs (U1, U2, U3, ...)
- Updates Unknown Registry JSON structure in Workflow Metadata
- Tracks unknown status (Unresolved, Resolved, Obsolete)
- Updates resolution information when unknowns are resolved

**Workflow State Management**
- Updates currentPhase in Workflow Metadata after each step
- Tracks phasesCompleted array
- Monitors blockingIssues from agent Directives
- Manages workflow progression and gate validation

**Context Passing**
- Constructs Step Context for each agent invocation
- Includes Task ID, Step metadata, and agent-specific instructions
- Provides priorityUnknowns from previous steps to current agent
- Ensures agents have necessary context without redundant searching

**Output Mapping**
- Reads agent output sections (Overview, Johari, Directives)
- Extracts information for workflow decisions
- Maps Johari quadrants to workflow context for next step
- Parses blockers to determine if workflow can proceed
- Updates Unknown Registry based on unknown quadrant content

ORCHESTRATION LAYER PARSING EXAMPLE

Agent produces output with unknown quadrant:
```json
{
  "unknown": "[NEW-UNKNOWN] OAuth2 provider credentials (client ID/secret) not provided - blocks implementation in Step 4. Category: Configuration. [NEW-UNKNOWN] Production database connection string undefined - needed for deployment planning in Step 6."
}
```

Orchestration layer parses and updates Unknown Registry:
```json
"unknowns": [
  {
    "id": "U5",
    "phase": 2,
    "category": "Configuration",
    "description": "OAuth2 provider credentials (client ID/secret) not provided",
    "impact": "Blocks implementation in Step 4",
    "resolutionPhase": 4,
    "status": "Unresolved",
    "resolution": null
  },
  {
    "id": "U6",
    "phase": 2,
    "category": "Configuration",
    "description": "Production database connection string undefined",
    "impact": "Needed for deployment planning in Step 6",
    "resolutionPhase": 6,
    "status": "Unresolved",
    "resolution": null
  }
]
```

Next agent receives in priorityUnknowns: ["U5", "U6"]

---

AGENT RESPONSIBILITIES

WHAT AGENTS DO

Agents focus on domain-specific work and treat infrastructure as an interface:

**Context Inheritance**
- Execute CONTEXT-INHERITANCE.md protocol before agent-specific work
- Load workflow context from memory file
- Understand previous step outputs (Overview, Johari, Directives)
- Identify unknowns flagged by previous steps

**Domain-Specific Work**
- Execute agent-specific steps per agent description
- Apply reasoning strategies at decision points
- Gather information, analyze, generate deliverables
- Interact with users when clarification needed (AskUserQuestion)
- Perform research when information needed (WebSearch, WebFetch)

**Output Generation**
- Structure output per OUTPUT CONTRACT specification
- Respect token budgets defined in agent description
- Flag new unknowns with [NEW-UNKNOWN] marker
- Reference existing unknowns by ID when addressing them

**Memory File Operations**
- Read memory file for context inheritance
- Append formatted output (three sections) to memory file
- NEVER overwrite existing memory content
- Validate successful append operation

**Completion Signaling**
- Signal completion in standard format
- Format: "{step-name} complete. Output appended to .claude/memory/task-{task-id}-memory.md"
- Use step name from Step Context in invocation prompt

ABSTRACTION BENEFITS

**For Agents**:
- Focus on domain logic, not infrastructure
- Don't need to understand Unknown Registry structure
- Don't need to know Johari Window philosophy
- Can be tested independently of workflow
- Reusable across different workflows

**For System**:
- Memory format can evolve without changing agents
- Unknown Registry structure can be enhanced without agent updates
- Workflow orchestration can be refactored independently
- Agent interface remains stable across system changes

---

EXAMPLE: BEFORE/AFTER COMPARISON

BEFORE REFACTORING (Tightly Coupled)

Agent directly manipulates Unknown Registry JSON:

```python
# Agent reads memory file
memory = Read(".claude/memory/task-feature-abc-memory.md")

# Agent parses JSON structure
metadata = parse_json(memory["WorkflowMetadata"])
registry = metadata["unknownRegistry"]

# Agent directly manipulates registry
registry["unknowns"].append({
    "id": "U5",  # Agent generates ID
    "phase": 2,
    "category": "Configuration",
    "description": "OAuth2 provider credentials missing",
    "resolutionPhase": 4,
    "status": "Unresolved",
    "resolution": null
})

# Agent updates JSON
metadata["unknownRegistry"] = registry
memory["WorkflowMetadata"] = json.dumps(metadata)

# Agent writes entire memory file
Write(".claude/memory/task-feature-abc-memory.md", memory)
```

**Problems**:
- Agent needs JSON manipulation skills
- Agent must know Unknown Registry structure
- Agent generates Unknown IDs (risk of conflicts)
- Agent updates workflow metadata (orchestration concern)
- Tightly coupled to memory format
- Cannot test agent independently

AFTER REFACTORING (Loosely Coupled)

Agent flags unknowns as text, orchestrator handles registry:

```python
# Agent performs domain work
requirements = analyze_requirements()
ambiguities = identify_ambiguities()

# Agent flags unknowns in output (simple text)
output = {
    "unknown": "[NEW-UNKNOWN] OAuth2 provider credentials (client ID/secret) not provided - blocks implementation in Step 4. Category: Configuration."
}

# Agent appends structured output to memory
append_to_memory(output)

# Orchestration layer parses output
orchestrator.parse_unknown_quadrant(output["unknown"])
# → Generates U5, updates Unknown Registry JSON
# → Passes ["U5"] to next agent's priorityUnknowns
```

**Benefits**:
- Agent focuses on domain work (identifying ambiguities)
- Agent doesn't manipulate JSON structures
- Orchestrator generates IDs (no conflicts)
- Memory format can change without agent updates
- Agent testable with simple input/output validation
- Clear separation of concerns

---

INTERFACE EVOLUTION STRATEGY

HOW THIS INTERFACE ENABLES CHANGE

**Stable Interface Elements** (shouldn't change):
- Three-section output structure (Overview, Johari, Directives)
- Task ID format and extraction protocol
- Step Context metadata fields
- [NEW-UNKNOWN] marker convention for flagging unknowns
- Unknown ID reference format (U1, U2, etc.)

**Evolvable Implementation Details** (can change without breaking agents):
- Unknown Registry JSON structure (orchestrator manages)
- Workflow Metadata schema (orchestrator manages)
- Memory file organization (as long as append interface stable)
- Johari quadrant interpretation (agents follow semantic guidance, not implementation)
- Token budget allocations (specified in agent descriptions, can be tuned)

**Version Compatibility**:
- Agents specify interface version in description frontmatter (future)
- Orchestrator validates compatibility before invocation
- Deprecation warnings for interface changes
- Migration path documented for breaking changes

**Example Evolution**: Unknown Registry Enhancement

Current structure:
```json
{
  "id": "U5",
  "phase": 2,
  "description": "..."
}
```

Future enhanced structure:
```json
{
  "id": "U5",
  "phase": 2,
  "description": "...",
  "priority": "HIGH",          // NEW FIELD
  "assignedTo": "Step 4",      // NEW FIELD
  "relatedUnknowns": ["U3"]    // NEW FIELD
}
```

**Agent Impact**: NONE
- Agents still flag with [NEW-UNKNOWN] marker
- Orchestrator parses and populates new fields
- Agents still reference by ID (U5)
- Interface contract unchanged

---

TESTING AGENTS INDEPENDENTLY

CONTRACT ENABLES UNIT TESTING

**Test Input (Mock Step Context)**:
```
Task ID: task-process-123
Step: 2
Step Name: Test Step
Purpose: Test agent behavior
Gate Entry: Test prerequisites met
Gate Exit: Test outputs produced

Perform test work with these inputs: [test data]
```

**Test Execution**:
1. Agent extracts Task ID and Step Context
2. Agent performs domain work with test inputs
3. Agent generates three-section output

**Test Validation**:
1. Verify three sections present
2. Validate JSON structures parsable
3. Check token budgets respected
4. Confirm [NEW-UNKNOWN] markers formatted correctly
5. Verify domain-specific output correct

**No Infrastructure Needed**:
- No real memory file required (mock or in-memory)
- No Unknown Registry needed (just validate markers)
- No workflow orchestration needed (just validate output)
- Focus on agent's domain logic

---

RELATED DOCUMENTS

- `.claude/protocols/CONTEXT-INHERITANCE.md` - How agents load workflow context
- `.claude/protocols/AGENT-EXECUTION-PROTOCOL.md` - Generic execution steps all agents follow
- `.claude/protocols/REASONING-STRATEGIES.md` - Decision-making strategies for agents
- `.claude/protocols/TASK-ID.md` - Task ID format and Step Context specifications
- `.claude/templates/JOHARI.md` - Detailed Johari quadrant philosophy and guidance
