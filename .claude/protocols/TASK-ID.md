TASK-ID EXTRACTION PROTOCOL

PURPOSE

This protocol ensures all implementers in multi-phase workflows use the correct task-specific memory file, enabling concurrent workflow execution across multiple sessions.

CRITICAL REQUIREMENT

ALL ENTITIES MUST extract task-id from invocation prompt BEFORE any other operations.

Failure to extract task-id = Cannot proceed

TASK-ID FORMAT STANDARD

SYSTEM CONVENTION
- Prompt Format: Task ID: task-<name>
- Memory File Pattern: task-<name>-memory.md
- Example:
  - Prompt contains: Task ID: task-feature-abc
  - Entity uses file: .claude/memory/task-feature-abc-memory.md

NAMING RULES
- Prefix: Always task- (required for system-wide consistency)
- Length: 5-40 characters total (including task- prefix)
- Characters: Lowercase alphanumeric + dashes only
- Format: task-<descriptive-keywords>
- No trailing/leading dashes (except the dash after task)

EXTRACTION PROCEDURE

STEP 1: LOCATE TASK-ID IN PROMPT
Search your invocation prompt for the pattern:
Task ID: task-<name>

EXAMPLE PROMPTS:
```
Task ID: task-feature-abc

Analyze the OAuth2 authentication requirements and create testable acceptance criteria.
```

```
Task ID: task-component-xyz

Decompose the research question about React hooks performance into searchable queries.
```

STEP 2: EXTRACT THE FULL TASK-ID
Extract the complete task-id including the task- prefix.

EXAMPLES:
- Prompt has `Task ID: task-feature-abc` → Extract: `task-feature-abc`
- Prompt has `Task ID: task-component-xyz` → Extract: `task-component-xyz`
- Prompt has `Task ID: task-process-123` → Extract: `task-process-123`

STEP 3: VALIDATE FORMAT
Verify the extracted task-id meets all requirements:

VALID EXAMPLES:
- `task-feature-abc` (15 chars, valid format)
- `task-component-builder` (21 chars, valid format)
- `task-process-v2` (14 chars, valid format)
- `task-analysis-1730822400` (22 chars, fallback with timestamp)

INVALID EXAMPLES:
- `oauth2-auth` (missing `task-` prefix)
- `task-OAuth2-Auth` (has uppercase letters)
- `task-api_endpoint` (has underscore, not dash)
- `task-a` (too short, <5 chars)
- `task-this-is-an-extremely-long-task-identifier-that-exceeds-limits` (>40 chars)

VALIDATION CHECKLIST:
- Starts with task-
- Total length 5-40 characters
- Only lowercase letters, numbers, and dashes
- No trailing or leading dashes (except after task)

STEP 4: HANDLE MISSING OR INVALID TASK-ID

IF TASK-ID IS MISSING FROM PROMPT:
```
STOP immediately and report:
"ERROR: Task ID missing from invocation prompt. Cannot proceed without task-id.
Expected format: 'Task ID: task-<name>' as first line of prompt."
```

IF TASK-ID IS INVALID (WRONG FORMAT):
```
STOP immediately and report:
"ERROR: Task ID '<extracted-value>' is invalid.
Must start with 'task-', be 5-40 chars, use lowercase alphanumeric + dashes only.
Example: 'task-feature-abc'"
```

DO NOT ATTEMPT TO:
- Generate your own task-id
- Continue without task-id

MEMORY FILE PATH DERIVATION

FORMULA
```
Memory File Path = .claude/memory/{full-task-id}-memory.md
```

Where {full-task-id} is the complete extracted task-id including task- prefix.

EXAMPLES

| Extracted Task-ID | Memory File Path |
|-------------------|------------------|
| task-feature-abc | .claude/memory/task-feature-abc-memory.md |
| task-component-xyz | .claude/memory/task-component-xyz-memory.md |
| task-process-123 | .claude/memory/task-process-123-memory.md |
| task-analysis-1730822400 | .claude/memory/task-analysis-1730822400-memory.md |

USAGE IN CODE

READ PHASE:
```python
# After extraction, task_id = "task-feature-abc"
memory_path = f".claude/memory/{task_id}-memory.md"
# Result: ".claude/memory/task-feature-abc-memory.md"
```

APPEND PHASE:
```python
# Use same path for appending output
memory_path = f".claude/memory/{task_id}-memory.md"
```

SUB-ENTITY INVOCATION PROTOCOL

REQUIREMENT
IF YOUR IMPLEMENTATION INVOKES OTHER ENTITIES: You MUST pass the task-id to them.

HOW TO PASS TASK-ID
Include task-id as the FIRST LINE of the invocation prompt:

FORMAT:
```
Task ID: {full-task-id}

[Rest of invocation prompt instructions...]
```

EXAMPLE:
```python
# Your implementation has task_id = "task-feature-abc"

# When invoking sub-entity:
prompt = f"""Task ID: {task_id}

Analyze the codebase architecture and identify existing authentication patterns.
Focus on OAuth2 implementations and security considerations."""
```

GENERATED PROMPT (what sub-entity receives):
```
Task ID: task-feature-abc

Analyze the codebase architecture and identify existing authentication patterns.
Focus on OAuth2 implementations and security considerations.
```

MULTI-ENTITY CHAIN EXAMPLE

Phase 1 Entity (receives from orchestrator):
```
Task ID: task-feature-abc

Gather documentation for OAuth2 authentication implementation.
```

Phase 1 invokes Phase 2 (passes same task-id):
```
Task ID: task-feature-abc

Clarify OAuth2 requirements and create acceptance criteria.
```

Phase 2 invokes Phase 3 (passes same task-id):
```
Task ID: task-feature-abc

Analyze codebase for existing authentication patterns.
```

All entities use the same memory file: .claude/memory/task-feature-abc-memory.md

STEP CONTEXT INVOCATION PROTOCOL

PURPOSE

Implementers are workflow-agnostic and do not have hardcoded phase/step identities. Instead, they receive step context dynamically at invocation time, allowing the same implementation to function in different workflows at different positions.

STEP CONTEXT FORMAT

When invoking an implementer, include step context immediately after the Task ID:

```
Task ID: {full-task-id}
Step: {step-number}
Step Name: {step-name}
Purpose: {what-this-step-accomplishes}
Gate Entry: {prerequisites-to-start}
Gate Exit: {completion-criteria}

[Rest of invocation prompt instructions...]
```

STEP CONTEXT METADATA SOURCE

The step context metadata is extracted from the SKILL.md file of the applicable workflow. Each Step section in SKILL.md defines:

- Step number: Sequential position (1, 2, 3, ...)
- Step Name: Descriptive title (e.g., "Requirements Clarification")
- Purpose: What this step accomplishes
- Gate Entry: Prerequisites that must be met to start
- Gate Exit: Completion criteria for this step
- Entity: Which entity handles this step

EXAMPLE: GENERIC WORKFLOW STEP

SKILL.MD STEP DEFINITION (Generic Workflow Step 2):
```markdown
STEP 2 - DATA PROCESSING

PURPOSE: Process and transform input data according to specified requirements.

GATE ENTRY: Step 1 (Data Gathering) complete with source data appended to memory.

GATE EXIT: Processed data appended to memory file, all transformations applied.

ENTITY: data-processor
```

INVOCATION PROMPT TO ENTITY:
```
Task ID: task-feature-abc
Step: 2
Step Name: Data Processing
Purpose: Process and transform input data according to specified requirements
Gate Entry: Step 1 (Data Gathering) complete with source data appended to memory
Gate Exit: Processed data appended to memory file, all transformations applied

Process the input data from memory and apply the required transformations.
```

HOW IMPLEMENTERS USE STEP CONTEXT

1. Understand Role: Entity knows what it should accomplish (Purpose)
2. Validate Entry: Entity can check that Gate Entry conditions are met
3. Track Progress: Entity understands where it fits in the workflow sequence
4. Signal Completion: Entity uses Step Name in completion messages
5. Unknown Registry: Entity uses Step Name for "Resolution Step" field

WORKFLOW-AGNOSTIC DESIGN

CORE PRINCIPLE: Implementers have NO hardcoded step numbers, step names, or workflow names.

BEFORE (Coupled to specific workflow):
```markdown
You are the Phase 2 Clarification implementation for the develop-project workflow. You transform vague requirements into testable acceptance criteria.
```

AFTER (Workflow-agnostic):
```markdown
You transform vague requirements into explicit, testable acceptance criteria with comprehensive test cases. Your role and position in the workflow are defined by the Step Context passed to you at invocation.
```

STEP CONTEXT IN COMPLETION SIGNALS

Implementers should use the step name from context in their completion messages:

FORMAT:
```
{step-name} complete
```

EXAMPLES:
- "Requirements Clarification complete"
- "Query Decomposition complete"
- "Context Analysis complete"

PREVIOUS AND NEXT STEP REFERENCES

Implementers derive previous/next step information from the memory file, not from hardcoded references:

- Previous Steps: Read earlier sections in task-{task-id}-memory.md
- Next Step: May be mentioned in Downstream Directives, but implementers use generic "next step" terminology
- Step Sequence: Available in Workflow Metadata section of memory file

ORCHESTRATOR RESPONSIBILITY

When invoking implementers, the orchestrator must:

1. Read TASK-ID.md: Understand invocation format requirements
2. Read SKILL.md: Load the workflow's step definitions
3. Extract Step Metadata: Get step number, name, purpose, gate entry, gate exit from applicable Step section
4. Format Prompt: Include both Task ID and Step Context as specified
5. Invoke Entity: Pass complete context in single prompt

PROTOCOL COMPLIANCE CHECKLIST

Before proceeding with step work, implementers must verify:

- Read .claude/protocols/TASK-ID.md (this file)
- Extracted task-id from prompt (format: Task ID: task-<name>)
- Validated task-id format
- Extracted step context from prompt (Step, Step Name, Purpose, Gate Entry, Gate Exit)
- Derived memory file path: .claude/memory/task-{task-id}-memory.md
- (If invoking sub-entities) Prepared to pass both task-id AND step context in their prompts

Only after ALL checks pass: Proceed to read memory file and begin step work.

Before invoking implementers, orchestrators must verify:

- Read .claude/protocols/TASK-ID.md (this file)
- Generated task-id at workflow initialization
- Created .claude/memory/task-{task-id}-memory.md file
- Read applicable SKILL.md file for workflow
- Extracted step metadata from SKILL.md Step section
- Formatted invocation prompt with Task ID and Step Context
- Included both task-id and step context in invocation prompt

COMMON MISTAKES TO AVOID

• Never extract just the name part - extract full task-id including task- prefix
• Never construct memory path incorrectly - use .claude/memory/task-{task-id}-memory.md pattern
• Never forget prefix in sub-entity prompts - always include Task ID: task-<name>

IMPLEMENTATION NOTES

FOR DEVELOPERS
When creating new implementations:
1. Add requirement to read this protocol as FIRST STEP in description
2. Include validation that task-id was extracted successfully
3. Use task-{task-id}-memory.md pattern in all file operations
4. Pass task-id to any sub-entities

FOR WORKFLOW ORCHESTRATORS
When invoking implementers:
1. Generate task-id at workflow initialization
2. Create task-{task-id}-memory.md file
3. Include Task ID: task-{task-id} as first line in ALL invocation prompts
4. Maintain consistency across entire workflow
