CONTEXT INHERITANCE PROTOCOL

PURPOSE
This protocol ensures context inheritance from previous workflow steps through the Johari Window framework, preventing information loss across phase boundaries and transforming unknown unknowns into known knowns.

CRITICAL REQUIREMENT
ALL ENTITIES MUST execute all 5 steps of this protocol BEFORE beginning their step-specific work.

Failure to execute context inheritance = Information loss across workflow boundaries

STEP 1: TASK-ID EXTRACTION

Read .claude/protocols/TASK-ID.md and follow the task-id extraction procedure:

1. Locate Task ID: task-<name> in invocation prompt
2. Extract the complete task-id (including task- prefix)
3. Validate format (5-40 chars, lowercase + dashes, starts with task-)
4. Derive memory file path: .claude/memory/{task-id}-memory.md
5. STOP if task-id is missing or invalid (report error to orchestrator)

EXAMPLE
Prompt contains "Task ID: task-feature-abc"
Extract: task-feature-abc
Use file: .claude/memory/task-feature-abc-memory.md

STEP 2: LOAD WORKFLOW CONTEXT

Read the complete .claude/memory/task-{task-id}-memory.md file:

1. Read entire memory file before beginning step work
2. Parse JSON Workflow Metadata block (task-id, workflow type, critical constraints, success criteria)
3. Load all previous step sections (Step Overview in markdown, Johari Summary in JSON, Downstream Directives in JSON)
4. Parse JSON Unknown Registry from Workflow Metadata block (filter for unresolved unknowns from previous steps)
5. Validate Gate Entry requirements from Step Context in invocation prompt

FORMAT EXPECTATIONS
Workflow Metadata & Unknown Registry: JSON block at top of memory file (see .claude/templates/JOHARI.md lines 118-131)
Phase Overviews: Markdown format (human-readable work products)
Johari Summaries: JSON wrapper with markdown string content (see .claude/templates/JOHARI.md lines 326-367)
Downstream Directives: JSON object with typed arrays (see .claude/templates/JOHARI.md lines 213-315)

GATE ENTRY VALIDATION
Confirm previous step completion before proceeding.

If Gate Entry requirements NOT met:
STOP immediately and report:
"ERROR: Gate Entry requirements not met. {step-name} requires {gate-entry-condition}.
Previous step appears incomplete or missing from memory file."

STEP 3: PREVIOUS UNKNOWN RESOLUTION

Before beginning step work, resolve unknowns explicitly flagged for your attention:

PROCESS
1. Parse JSON Unknown Registry from Workflow Metadata block in task-{task-id}-memory.md
2. Filter unknowns array for items where resolutionPhase matches your phase number (from Step Context)
3. Filter for items in categories declared in your description's "Relevant Unknown Categories" field
4. For each relevant unknown:
   - Apply reasoning strategies from .claude/protocols/REASONING-STRATEGIES.md:
     [Semantic] Understand the intent and context of the unknown
     [CoT] Break down the unknown into explicit reasoning steps
     [ToT] Generate 2-3 resolution approaches, evaluate trade-offs
     [SC] Cross-verify resolution from multiple perspectives
     [Socratic] Question assumptions underlying the unknown
     [Constitutional] Critique resolution against accuracy, completeness, clarity
   - Explicitly investigate/resolve through your step's analysis methods
   - Document resolution in your Step Overview section
   - Update Unknown Registry: Set status: "Resolved" and add resolution text
   - Write updated JSON back to memory file

JSON PARSING EXAMPLE (Python)
```python
import json

# Extract JSON block from memory file
json_block = extract_json_block(memory_content)
metadata = json.loads(json_block)

# Filter Unknown Registry
unknowns = metadata["unknownRegistry"]["unknowns"]
relevant = [u for u in unknowns
           if u["resolutionPhase"] == current_phase
           and u["category"] in relevant_categories
           and u["status"] != "Resolved"]
```

COMPLETE EXAMPLE
See .claude/templates/CONTEXT-INHERITANCE-EXAMPLES.md lines 15-85 for detailed unknown resolution example with reasoning strategy application.

STEP 4: BLIND SPOT ANALYSIS

Proactively address gaps flagged by previous steps:

PROCESS
1. Parse JSON Johari Summaries from all previous steps in task-{task-id}-memory.md
2. Extract "blind" field from each previous step's Johari Summary JSON
3. Identify blind spots relevant to your step's responsibility domain
4. Apply reasoning strategies from .claude/protocols/REASONING-STRATEGIES.md:
   [Semantic] Understand the intent behind the flagged blind spot
   [CoT] Explain step-by-step how you'll address the blind spot
   [ToT] Consider multiple approaches to resolve the gap
   [Socratic] Question: "Why is this blind spot relevant to my domain?"
   [Constitutional] Verify your resolution addresses the gap completely
5. Address proactively through your analysis/clarification work
6. Document how you addressed them in your "hidden" field (JSON format)

COMPLETE EXAMPLE
See .claude/templates/CONTEXT-INHERITANCE-EXAMPLES.md lines 87-143 for detailed blind spot analysis with reasoning strategy application.

STEP 5: OPEN AREA CONSOLIDATION

Build on confirmed knowledge without repetition:

PROCESS
1. Parse JSON Johari Summaries from all previous steps
2. Extract "open" field from each previous step's JSON
3. Reference (not repeat) previous Open knowledge from earlier steps
4. Add new confirmed knowledge from your step's work to your "open" field
5. Apply reasoning strategies:
   [SC] Cross-verify new confirmations against previous open knowledge - ensure no contradictions
   [Socratic] Question: "Is this truly confirmed or am I assuming?"
6. Format: "[Previous step confirmation referenced] + [New knowledge you've confirmed]"

FORMAT TEMPLATE
"open": "{Reference-to-previous-confirmation} (per Step N). {New-confirmed-knowledge-from-your-work}. {New-validated-decision-you-made}"

COMPLETE EXAMPLE
See .claude/templates/CONTEXT-INHERITANCE-EXAMPLES.md lines 145-191 for detailed open area consolidation with reasoning strategy application.

PRE-EXECUTION VALIDATION CHECKLIST

Before beginning step-specific work, verify completion of all 5 steps:

- Step 1: Task-ID extracted and validated from invocation prompt
- Step 2: Memory file read completely, Gate Entry requirements validated
- Step 3: Unknown Registry filtered and relevant unknowns identified for resolution
- Step 4: Previous Blind quadrants reviewed and relevant gaps identified
- Step 5: Previous Open knowledge reviewed and ready to reference (not repeat)

Only after ALL checks pass: Proceed to your step's execution sequence.

INTEGRATION WITH EXECUTION

DESCRIPTION REFERENCE FORMAT
All implementers should include this section immediately after Core Mission:

MANDATORY PROTOCOL
Context Inheritance Protocol (Pre-Execution)
MANDATORY: Read .claude/protocols/CONTEXT-INHERITANCE.md and execute all steps before proceeding.

Reasoning Strategies (Throughout Execution)
MANDATORY: Apply .claude/protocols/REASONING-STRATEGIES.md at all decision points and before finalizing outputs.

EXECUTION FLOW
1. Entity invoked by orchestrator with Task ID and Step Context
2. Entity reads CONTEXT-INHERITANCE.md (this file)
3. Steps 1-5 executed (task-id extraction → memory load → unknown resolution → blind spot analysis → open area consolidation)
4. Step-specific work begins (Execution Sequence section)
5. Output formatted with Johari Summary referencing inherited context
6. Memory file updated with contributions

COMMON MISTAKES TO AVOID

• Never skip Unknown Registry filtering - unknowns may have been escalated to your step
• Never repeat previous Open knowledge verbatim - reference with "(per Step N)" and add only NEW knowledge
• Never ignore Blind quadrants - review ALL previous blind spots for gaps you can address
• Never proceed without Gate Entry validation - always verify previous step completion

PROTOCOL COMPLIANCE

This protocol is MANDATORY for all implementers. Non-compliance results in:
- Information loss across workflow boundaries
- Unresolved unknowns persisting indefinitely
- Blind spots becoming unknown unknowns
- Workflow quality degradation

Orchestrators: When creating new workflows, ensure this protocol is referenced in descriptions immediately after Core Mission.

Developers: Include context inheritance validation in your pre-execution checklist.
