---
name: develop-agent
description: |
  Structured workflow for creating reusable, single-responsibility agents following cognitive function taxonomy and Penny design principles. Guides from agent concept through validation with registry checks, cognitive function assignment, template selection, and implementation.
type: project
---

PURPOSE

Guides systematic agent creation following Penny's agent design principles: Single Cognitive Responsibility Principle (SCRP), cognitive function taxonomy alignment, context-driven specialization, and reusability validation. Ensures agents are discoverable, maintainable, and workflow-agnostic.

WHEN TO USE

Use this skill when:
- Creating a new agent for Penny's agent system
- Refactoring an existing agent to align with design principles
- Uncertain which cognitive function an agent should perform
- Need to validate agent design against reusability criteria

Do NOT use when:
- Creating workflow skills (use develop-skill instead)
- Modifying agent behavior without changing core design
- Adding examples or documentation to existing agents

---

WORKFLOW ARCHITECTURE

This workflow follows an 8-phase sequential process with validation gates:

PHASE 0: Agent Concept Definition
- Define agent purpose and scope
- Document initial requirements

PHASE 1: Registry Discovery
- Search AGENT-REGISTRY.md for existing agents
- Validate need for new agent vs reusing existing

PHASE 2: Cognitive Function Classification
- Identify primary cognitive function (RESEARCHER, ANALYZER, SYNTHESIZER, GENERATOR, VALIDATOR, CLARIFIER, COORDINATOR)
- Apply Single Cognitive Responsibility Principle
- Validate reusability (3+ workflow test)

PHASE 3: Template Selection
- Choose SIMPLE (1-3 steps, no user interaction) or COMPLEX (4-8 steps, with interaction/research)
- Review relevant anti-patterns from existing agents
- Plan agent-specific steps

PHASE 4: Agent Description Generation
- Fill template with agent-specific content
- Define gate exit requirements
- Create example interactions
- Document anti-patterns

PHASE 5: Implementation Validation
- Review against AGENT-DESIGN-PRINCIPLES.md
- Check AGENT-INTERFACE-CONTRACTS.md compliance
- Validate token budgets (170-270 tokens per output)
- Verify protocol references

PHASE 6: Registry Update
- Add agent to AGENT-REGISTRY.md
- Document cognitive function classification
- Update usage guidelines if needed

PHASE 7: Integration Testing
- Test agent in target workflow context
- Verify input/output contracts
- Validate reusability claim with alternative contexts
- Document findings

---

GATE SYSTEM

Each phase has entry and exit criteria:

ENTRY GATE: Prerequisites that must be satisfied before starting phase
EXIT GATE: Deliverables and validations required before advancing to next phase

Workflow cannot advance to next phase until current phase EXIT GATE is satisfied.

---

PHASE 0: AGENT CONCEPT DEFINITION

ENTRY GATE:
- User has identified need for new agent functionality
- Basic purpose or use case described

PHASE OBJECTIVES:
- Document agent concept clearly
- Identify target workflows where agent will be used
- Define initial scope and boundaries

EXECUTION STEPS:

1. Capture Agent Concept
   - What problem does this agent solve?
   - What are the primary responsibilities?
   - What workflows will use this agent?

2. Document Initial Requirements
   - What inputs does agent receive?
   - What outputs must agent produce?
   - What constraints or non-negotiables exist?

3. Identify Scope Boundaries
   - What does agent NOT do?
   - What responsibilities belong to other agents?
   - What should be delegated to workflows?

EXIT GATE:
- Agent concept documented with problem statement
- Target workflows identified (minimum 1, ideally 3+)
- Initial scope and boundaries defined
- Requirements captured in structured format

OUTPUT FORMAT:
Create task-{agent-name}-memory.md with:
```markdown
---
WORKFLOW METADATA

Workflow: develop-agent
Task ID: {agent-name}
Status: Phase 0 Complete
---

PHASE 0: AGENT CONCEPT DEFINITION - OVERVIEW

Agent Name: {agent-name}
Problem Statement: {What problem this agent solves}

Target Workflows:
1. {workflow-1}: {how agent would be used}
2. {workflow-2}: {how agent would be used}
3. {workflow-3}: {how agent would be used}

Primary Responsibilities:
- {responsibility-1}
- {responsibility-2}
- {responsibility-3}

Excluded Responsibilities:
- {exclusion-1}: {delegate to X}
- {exclusion-2}: {delegate to Y}

Initial Requirements:
- Input: {expected inputs}
- Output: {expected outputs}
- Constraints: {constraints}

PHASE 0: AGENT CONCEPT DEFINITION - JOHARI SUMMARY

```json
{
  "open": "Agent concept defined with target workflows and scope boundaries",
  "hidden": "Initial requirements captured, delegation boundaries identified",
  "blind": "Cognitive function not yet classified, existing agent overlap unknown",
  "unknown": "U1: Is similar agent already in registry? U2: Which cognitive function aligns best?"
}
```

PHASE 0: AGENT CONCEPT DEFINITION - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Phase 1: Search AGENT-REGISTRY.md for overlapping functionality",
    "Check if existing agent with similar cognitive function can be reused",
    "If overlap found, evaluate reuse vs create-new decision"
  ],
  "validationRequired": ["Verify target workflows actually need this functionality"],
  "blockers": [],
  "priorityUnknowns": ["U1", "U2"]
}
```
---
```

---

PHASE 1: REGISTRY DISCOVERY

ENTRY GATE:
- Phase 0 complete with agent concept documented
- Target workflows identified

PHASE OBJECTIVES:
- Search AGENT-REGISTRY.md for existing agents that might satisfy need
- Evaluate reuse vs create-new decision
- Document decision rationale

EXECUTION STEPS:

1. Read AGENT-REGISTRY.md
   - Review all cognitive function categories
   - Identify agents with similar responsibilities
   - Note cognitive functions of similar agents

2. Evaluate Overlap
   - Does existing agent perform same COGNITIVE FUNCTION?
   - Can existing agent be reused with different workflow context?
   - What would need to change to reuse existing agent?

3. Make Reuse vs Create Decision

   REUSE if:
   - Existing agent has same cognitive function
   - Only workflow context differs
   - Modifications would be minimal (<20% of agent description)

   CREATE NEW if:
   - No existing agent with required cognitive function
   - Existing agent has different cognitive function (even if similar domain)
   - Reusability test fails (agent wouldn't work in 3+ workflows)

4. Document Decision
   - If REUSE: Document which agent and what context changes needed
   - If CREATE: Document why existing agents insufficient

EXIT GATE:
- AGENT-REGISTRY.md reviewed completely
- Overlapping agents identified (if any)
- Reuse vs create decision made with rationale
- Decision documented in task memory

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 1: REGISTRY DISCOVERY - OVERVIEW

Registry Search Results:
- Agents reviewed: {count} across {N} cognitive functions
- Similar agents identified: {list or "None"}

Decision: {REUSE existing-agent-name | CREATE NEW}

Rationale: {detailed explanation}

If REUSE:
- Agent to reuse: {agent-name}
- Cognitive function: {function}
- Context changes needed: {changes}

If CREATE:
- Gaps in existing agents: {what's missing}
- Cognitive function needed: {preliminary identification}

PHASE 1: REGISTRY DISCOVERY - JOHARI SUMMARY

```json
{
  "open": "Registry search complete, decision made: {REUSE|CREATE}",
  "hidden": "Evaluated {N} agents, identified cognitive function gaps",
  "blind": "May have missed subtle reuse opportunities, cognitive function not yet validated",
  "unknown": "U3: Is cognitive function classification correct? U4: Will reusability test pass?"
}
```

PHASE 1: REGISTRY DISCOVERY - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Phase 2: Classify cognitive function definitively",
    "Apply Single Cognitive Responsibility Principle",
    "Validate with 3+ workflow reusability test"
  ],
  "validationRequired": ["Confirm no existing agent was overlooked"],
  "blockers": [],
  "priorityUnknowns": ["U3", "U4"]
}
```
---
```

WORKFLOW BRANCH:
- If REUSE decision → Exit workflow, document reuse plan
- If CREATE decision → Continue to Phase 2

---

PHASE 2: COGNITIVE FUNCTION CLASSIFICATION

ENTRY GATE:
- Phase 1 complete with CREATE NEW decision
- Agent concept and requirements documented

PHASE OBJECTIVES:
- Classify agent's primary cognitive function
- Apply Single Cognitive Responsibility Principle (SCRP)
- Validate reusability across 3+ workflows

EXECUTION STEPS:

1. Read COGNITIVE-FUNCTION-TAXONOMY.md
   - Review all 7 cognitive function definitions
   - Study characteristics and examples for each

2. Identify Primary Activity
   - What does agent PRIMARILY do?
   - Map to cognitive function decision tree:
     - Gathers information → RESEARCHER
     - Examines existing information → ANALYZER
     - Combines multiple sources → SYNTHESIZER
     - Creates new artifacts → GENERATOR
     - Verifies correctness → VALIDATOR
     - Resolves ambiguities → CLARIFIER
     - Manages workflow state → COORDINATOR

3. Apply Single Cognitive Responsibility Principle
   - Does agent perform ONLY ONE cognitive function?
   - If multiple functions detected:
     - Can responsibilities be split into separate agents?
     - Which function is PRIMARY vs delegated?
   - Document SCRP validation

4. Validate Tool Alignment
   - Do expected tools match cognitive function's typical tools?
   - Tool mismatches indicate wrong cognitive function classification
   - Example: RESEARCHER shouldn't primarily use Write tool

5. Execute Reusability Test
   - Can this agent work in 3+ different workflows with only context changes?
   - List specific workflows where agent could be reused
   - If test fails → Scope too domain-specific or multi-function

EXIT GATE:
- Cognitive function definitively classified
- SCRP validation passed (single function confirmed)
- Tool alignment validated
- Reusability test passed with 3+ workflow examples
- Classification rationale documented

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 2: COGNITIVE FUNCTION CLASSIFICATION - OVERVIEW

Cognitive Function: {RESEARCHER|ANALYZER|SYNTHESIZER|GENERATOR|VALIDATOR|CLARIFIER|COORDINATOR}

Classification Rationale:
- Primary activity: {what agent does}
- Maps to {function} because: {reasoning}

SCRP Validation:
- Single cognitive function: {YES|NO}
- If multi-function detected: {split plan or primary/delegated breakdown}

Tool Alignment:
- Expected tools: {tool-list}
- Typical {function} tools: {standard-tool-list}
- Alignment: {MATCH|explain mismatches}

Reusability Test (3+ workflows):
1. {workflow-1}: {how agent would be used}
2. {workflow-2}: {how agent would be used}
3. {workflow-3}: {how agent would be used}
4. {workflow-4}: {optional}

Test Result: {PASS|FAIL}

PHASE 2: COGNITIVE FUNCTION CLASSIFICATION - JOHARI SUMMARY

```json
{
  "open": "Cognitive function classified as {FUNCTION}, SCRP validated, reusability test passed",
  "hidden": "Tool alignment verified, multiple workflow contexts identified",
  "blind": "Template selection not yet determined, anti-patterns not yet identified",
  "unknown": "U5: Should template be SIMPLE or COMPLEX? U6: What anti-patterns apply?"
}
```

PHASE 2: COGNITIVE FUNCTION CLASSIFICATION - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Phase 3: Select SIMPLE or COMPLEX template based on step count and interaction needs",
    "Review existing agents with same cognitive function for anti-pattern examples",
    "Plan agent-specific execution steps"
  ],
  "validationRequired": ["Confirm reusability examples are realistic, not forced"],
  "blockers": [],
  "priorityUnknowns": ["U5", "U6"]
}
```
---
```

---

PHASE 3: TEMPLATE SELECTION

ENTRY GATE:
- Phase 2 complete with cognitive function classified
- SCRP and reusability validated

PHASE OBJECTIVES:
- Choose SIMPLE or COMPLEX template
- Review anti-patterns from similar agents
- Plan agent-specific execution steps

EXECUTION STEPS:

1. Read AGENT-TEMPLATE-USAGE.md
   - Review SIMPLE vs COMPLEX decision criteria
   - Evaluate agent against decision tree

2. Template Decision Criteria

   SIMPLE template if:
   - 1-3 execution steps
   - No user interaction required (no AskUserQuestion)
   - Minimal or no research (no WebSearch/WebFetch)
   - Straightforward input → process → output flow
   - Single-purpose, focused responsibility

   COMPLEX template if:
   - 4-8 execution steps
   - Requires user interaction to resolve ambiguities
   - Performs research to gather external information
   - Complex decision trees or multi-stage processing
   - Multiple responsibilities or sophisticated analysis

3. Review Similar Agents for Anti-Patterns
   - Search AGENT-REGISTRY.md for agents with same cognitive function
   - Read 2-3 similar agent descriptions
   - Extract anti-patterns section from each
   - Identify patterns relevant to new agent

4. Plan Agent-Specific Steps
   - Define 1-3 steps (SIMPLE) or 4-8 steps (COMPLEX)
   - Map each step to specific actions
   - Identify decision points and criteria
   - Plan user interaction triggers (COMPLEX only)
   - Plan research triggers (COMPLEX only)

EXIT GATE:
- Template selected (SIMPLE or COMPLEX) with rationale
- 2-3 similar agents reviewed for anti-patterns
- Agent-specific steps planned (count matches template)
- User interaction scenarios defined (if COMPLEX)
- Research scenarios defined (if COMPLEX)

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 3: TEMPLATE SELECTION - OVERVIEW

Template: {SIMPLE|COMPLEX}

Selection Rationale:
- Step count: {N} steps planned
- User interaction: {REQUIRED|NOT REQUIRED}
- Research needs: {EXTENSIVE|MINIMAL|NONE}
- Processing complexity: {STRAIGHTFORWARD|COMPLEX}
- Decision: {template} based on {primary factors}

Similar Agents Reviewed:
1. {agent-name-1} ({cognitive-function})
   - Anti-patterns noted: {list}
2. {agent-name-2} ({cognitive-function})
   - Anti-patterns noted: {list}

Agent-Specific Steps:

STEP 1: {step-name}
- Action: {brief description}
- Tools: {expected tools}
- Decision points: {if any}

STEP 2: {step-name}
- Action: {brief description}
- Tools: {expected tools}

[Continue for all planned steps...]

If COMPLEX template:

User Interaction Scenarios:
- {scenario-1}: {when and why to interact}
- {scenario-2}: {when and why to interact}

Research Scenarios:
- {scenario-1}: {what to research and when}
- {scenario-2}: {what to research and when}

PHASE 3: TEMPLATE SELECTION - JOHARI SUMMARY

```json
{
  "open": "{SIMPLE|COMPLEX} template selected, {N} steps planned, anti-patterns identified from similar agents",
  "hidden": "Step-by-step breakdown defined, interaction/research triggers specified",
  "blind": "Agent description not yet written, gate requirements not yet defined",
  "unknown": "U7: Are step definitions detailed enough? U8: Have all anti-patterns been considered?"
}
```

PHASE 3: TEMPLATE SELECTION - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Phase 4: Fill selected template with agent-specific content",
    "Define gate exit requirements beyond generic protocol",
    "Create realistic example interaction showing full workflow",
    "Document 2-6 anti-patterns based on template complexity"
  ],
  "validationRequired": ["Verify step count aligns with template choice"],
  "blockers": [],
  "priorityUnknowns": ["U7", "U8"]
}
```
---
```

---

PHASE 4: AGENT DESCRIPTION GENERATION

ENTRY GATE:
- Phase 3 complete with template selected
- Agent-specific steps planned
- Anti-patterns identified from similar agents

PHASE OBJECTIVES:
- Fill selected template with complete agent description
- Define comprehensive gate exit requirements
- Create realistic example interaction
- Document relevant anti-patterns

EXECUTION STEPS:

1. Read Selected Template
   - Read .claude/skills/develop-agent/resources/agent-description-simple.md (if SIMPLE)
   - Read .claude/skills/develop-agent/resources/agent-description-complex.md (if COMPLEX)
   - Note all placeholders requiring values

2. Fill Template Sections

   A. PURPOSE Section (1-2 paragraphs):
      - What agent does (workflow-agnostic description)
      - Core responsibility
      - Role in workflow ecosystem

   B. CORE MISSION Section (1-2 paragraphs for SIMPLE, 2-4 for COMPLEX):
      - What agent DOES (primary responsibilities)
      - What agent does NOT do (exclusions with delegation)
      - Key deliverables/outputs
      - Critical constraints
      - [COMPLEX only] When user interaction required
      - [COMPLEX only] When research required

   C. MANDATORY PROTOCOL Section:
      - Keep as-is (references external protocols)
      - No customization needed

   D. [COMPLEX only] USER INTERACTION PROTOCOL:
      - When to interact (3-5 conditions)
      - How to interact (AskUserQuestion guidelines)
      - Interaction guidelines (batching, context, documentation)

   E. [COMPLEX only] RESEARCH PROTOCOL:
      - When to research (3-5 conditions)
      - How to research (WebSearch vs WebFetch guidance)
      - Research guidelines (validation, sources, conflicts)

   F. Agent-Specific Steps (from Phase 3 planning):
      - Transfer planned steps to template structure
      - Expand with detailed instructions
      - Add decision logic where applicable
      - Specify tools and error handling

   G. GATE EXIT REQUIREMENTS:
      - List agent-specific completion criteria (3-4 items)
      - Add "All generic requirements from AGENT-EXECUTION-PROTOCOL.md satisfied"

   H. ANTI-PATTERNS Section:
      - Document 2-3 anti-patterns (SIMPLE) or 4-6 (COMPLEX)
      - For each: Name, Description, Bad example, Correct approach, Good example
      - Use insights from Phase 3 similar agent review

   I. EXAMPLE INTERACTION:
      - Show complete before/after task memory states
      - Document agent process steps (5-7 for SIMPLE, 8-11 for COMPLEX)
      - Demonstrate all sections appended correctly
      - Include realistic token counts
      - [COMPLEX only] Show user interaction example
      - [COMPLEX only] Show research integration example

   J. REMEMBER Section:
      - Single-line closing reminder specific to agent

3. Validate Placeholder Replacement
   - Search for all {PLACEHOLDER} patterns
   - Verify every placeholder filled with agent-specific content
   - No generic or template language remaining

4. Calculate Token Budgets
   - Based on step output richness
   - Typical range: 170-270 total tokens
   - Overview: 80-120 tokens
   - Johari Summary: 60-100 tokens
   - Downstream Directives: 30-50 tokens

5. Create Agent Description File
   - Write to .claude/skills/develop-agent/agent-tmp/{agent-name}_TEMP.md
   - Include frontmatter with name, description, cognitive_function
   - Plain text formatting (no markdown headers/bold)
   - Verify protocol references accurate

EXIT GATE:
- All template placeholders filled with agent-specific content
- Gate exit requirements defined (agent-specific + generic protocol)
- Anti-patterns documented (2-3 for SIMPLE, 4-6 for COMPLEX)
- Example interaction complete with realistic before/after states
- Token budgets specified appropriately
- Agent description file created at .claude/skills/develop-agent/agent-tmp/{agent-name}_TEMP.md
- No workflow-specific references (workflow-agnostic design)

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 4: AGENT DESCRIPTION GENERATION - OVERVIEW

Agent Description File: .claude/skills/develop-agent/agent-tmp/{agent-name}_TEMP.md

Template Used: {SIMPLE|COMPLEX}
Total Lines: {line-count}

Sections Completed:
- PURPOSE: {line-count} lines
- CORE MISSION: {line-count} lines
- MANDATORY PROTOCOL: Referenced (not duplicated)
- [If COMPLEX] USER INTERACTION PROTOCOL: {line-count} lines
- [If COMPLEX] RESEARCH PROTOCOL: {line-count} lines
- Agent-Specific Steps: {N} steps, {line-count} lines total
- GATE EXIT REQUIREMENTS: {N} agent-specific + generic protocol reference
- ANTI-PATTERNS: {N} patterns documented with examples
- EXAMPLE INTERACTION: {line-count} lines with complete workflow demonstration
- REMEMBER: Agent-specific closing reminder

Token Budget Specified:
- Total: {min}-{max} tokens
- Overview: {min}-{max} tokens
- Johari: {min}-{max} tokens
- Directives: {min}-{max} tokens

Cognitive Function Documented: {FUNCTION}

PHASE 4: AGENT DESCRIPTION GENERATION - JOHARI SUMMARY

```json
{
  "open": "Agent description complete at _TEMP.md, {N} sections filled, {N} anti-patterns documented",
  "hidden": "Token budgets calculated, example interaction shows full workflow, protocols referenced correctly",
  "blind": "Design principles compliance not yet validated, interface contracts not yet verified",
  "unknown": "U9: Does agent description satisfy all design principles? U10: Are token budgets realistic?"
}
```

PHASE 4: AGENT DESCRIPTION GENERATION - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Phase 5: Validate against AGENT-DESIGN-PRINCIPLES.md (all 7 principles)",
    "Check AGENT-INTERFACE-CONTRACTS.md compliance",
    "Verify protocol references point to existing files",
    "Review token budgets for realism based on step complexity"
  ],
  "validationRequired": ["Confirm example interaction token counts match specified budgets"],
  "blockers": [],
  "priorityUnknowns": ["U9", "U10"]
}
```
---
```

---

PHASE 5: IMPLEMENTATION VALIDATION

ENTRY GATE:
- Phase 4 complete with agent description generated
- Agent description file exists at _TEMP.md

PHASE OBJECTIVES:
- Validate against all 7 AGENT-DESIGN-PRINCIPLES.md
- Verify AGENT-INTERFACE-CONTRACTS.md compliance
- Check protocol references and token budgets
- Identify any design issues requiring remediation

EXECUTION STEPS:

1. Read Validation References
   - Read .claude/docs/AGENT-DESIGN-PRINCIPLES.md
   - Read .claude/protocols/AGENT-INTERFACE-CONTRACTS.md
   - Read created agent description file

2. Validate Design Principles (all 7)

   PRINCIPLE 1: Single Cognitive Responsibility
   - Agent performs exactly ONE cognitive function: {YES|NO}
   - If NO: {split plan or remediation}

   PRINCIPLE 2: Context-Driven Specialization
   - No hardcoded workflow references: {YES|NO}
   - Reusable across 3+ workflows with context only: {YES|NO}

   PRINCIPLE 3: Capability Taxonomy Alignment
   - Cognitive function in frontmatter: {YES|NO}
   - Function matches actual agent work: {YES|NO}

   PRINCIPLE 4: Tool/Agent Boundary
   - No deterministic work (appropriate tool usage): {YES|NO}
   - Adaptive work requiring reasoning: {YES|NO}

   PRINCIPLE 5: Progressive Disclosure Architecture
   - Token budgets specified: {YES|NO}
   - Budgets realistic (170-270 range): {YES|NO}
   - Johari compression guidelines referenced: {YES|NO}

   PRINCIPLE 6: Failure Boundary Isolation
   - Agent doesn't manipulate orchestration layer: {YES|NO}
   - Errors reported via Unknown quadrant: {YES|NO}

   PRINCIPLE 7: Measurable Value
   - Clear deliverables defined: {YES|NO}
   - Success criteria in gate exit requirements: {YES|NO}

3. Validate Interface Contracts

   INPUT CONTRACT:
   - Extracts task-id from invocation prompt: {YES|NO}
   - Reads from task-{task-id}-memory.md: {YES|NO}
   - Inherits context via CONTEXT-INHERITANCE.md: {YES|NO}

   OUTPUT CONTRACT:
   - Three-section structure (Overview, Johari, Directives): {YES|NO}
   - Appends to task-{task-id}-memory.md: {YES|NO}
   - Uses [NEW-UNKNOWN] markers (not direct Unknown Registry manipulation): {YES|NO}

4. Verify Protocol References
   - .claude/protocols/agent-protocol-core.md: {EXISTS|MISSING}
   - .claude/protocols/agent-protocol-extended.md (if code generation): {EXISTS|MISSING|N/A}
   - .claude/templates/JOHARI.md: {EXISTS|MISSING}

5. Review Token Budgets
   - Total budget 170-270 tokens: {YES|NO - actual: X}
   - Budget split realistic for step complexity: {YES|NO}
   - Example interaction demonstrates budget: {YES|NO}

6. Document Validation Results
   - All checks passed: {YES|NO}
   - Issues identified: {list}
   - Remediation required: {YES|NO}

EXIT GATE:
- All 7 design principles validated (pass/remediate documented)
- Interface contracts compliance verified
- Protocol references confirmed to exist
- Token budgets reviewed for realism
- Validation results documented with any required remediation
- If remediation needed: issues documented for Phase 4 loop-back
- If validation passed: Ready for Phase 6

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 5: IMPLEMENTATION VALIDATION - OVERVIEW

Validation Status: {PASSED|REMEDIATION REQUIRED}

Design Principles Compliance:
1. Single Cognitive Responsibility: {PASS|FAIL - reason}
2. Context-Driven Specialization: {PASS|FAIL - reason}
3. Capability Taxonomy Alignment: {PASS|FAIL - reason}
4. Tool/Agent Boundary: {PASS|FAIL - reason}
5. Progressive Disclosure Architecture: {PASS|FAIL - reason}
6. Failure Boundary Isolation: {PASS|FAIL - reason}
7. Measurable Value: {PASS|FAIL - reason}

Interface Contracts Compliance:
- Input contract: {PASS|FAIL - reason}
- Output contract: {PASS|FAIL - reason}

Protocol References: {ALL EXIST|missing: list}

Token Budget Review:
- Total: {actual} (target: 170-270)
- Assessment: {REALISTIC|TOO LOW|TOO HIGH - reasoning}

Issues Identified:
{list issues if any, or "None"}

Remediation Plan:
{if needed, detail required changes}

PHASE 5: IMPLEMENTATION VALIDATION - JOHARI SUMMARY

```json
{
  "open": "Validation complete: {PASSED|N issues identified requiring remediation}",
  "hidden": "Checked all 7 design principles, interface contracts, protocol references, token budgets",
  "blind": "Registry not yet updated, integration testing not performed",
  "unknown": "U11: Will agent work correctly in target workflows? U12: Are there edge cases not covered?"
}
```

PHASE 5: IMPLEMENTATION VALIDATION - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "If REMEDIATION REQUIRED: Loop back to Phase 4, apply fixes, re-validate",
    "If PASSED: Phase 6 - Update AGENT-REGISTRY.md with new agent entry",
    "Move agent description from _TEMP.md to permanent location",
    "Prepare for integration testing"
  ],
  "validationRequired": ["Confirm all protocol files referenced actually exist"],
  "blockers": [],
  "priorityUnknowns": ["U11", "U12"]
}
```
---
```

WORKFLOW BRANCH:
- If REMEDIATION REQUIRED → Loop back to Phase 4, apply fixes, return to Phase 5
- If PASSED → Continue to Phase 6

---

PHASE 6: REGISTRY UPDATE

ENTRY GATE:
- Phase 5 validation passed
- Agent description validated against all design principles
- No blocking issues identified

PHASE OBJECTIVES:
- Add agent to AGENT-REGISTRY.md
- Move agent description to permanent location
- Update usage guidelines if needed

EXECUTION STEPS:

1. Read AGENT-REGISTRY.md
   - Locate section for agent's cognitive function
   - Review existing entries in that section

2. Prepare Registry Entry
   - Agent name: {agent-name}
   - Cognitive function: {FUNCTION}
   - One-line description: {what agent does}

3. Update AGENT-REGISTRY.md
   - Add entry to appropriate cognitive function section
   - Maintain alphabetical order within section
   - Format: "- {agent-name}: {one-line description}"

4. Move Agent Description File
   - Rename .claude/skills/develop-agent/agent-tmp/{agent-name}_TEMP.md
   - To: .claude/skills/develop-agent/agent-tmp/{agent-name}.md
   - Verify file contents unchanged

5. Review AGENT-REGISTRY.md Usage Guidelines
   - Assess if new agent requires guideline updates
   - If cognitive function section was empty, add usage notes
   - Update if new patterns emerge

EXIT GATE:
- Agent added to AGENT-REGISTRY.md in correct cognitive function section
- Agent description moved from _TEMP.md to permanent .md file
- Usage guidelines updated if needed
- All file operations successful

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 6: REGISTRY UPDATE - OVERVIEW

Registry Updated: YES
- Cognitive function section: {FUNCTION}
- Entry added: "{agent-name}: {one-line description}"
- Position: {alphabetical position in section}

Agent Description File:
- Moved from: .claude/skills/develop-agent/agent-tmp/{agent-name}_TEMP.md
- To: .claude/skills/develop-agent/agent-tmp/{agent-name}.md
- Status: {SUCCESS|FAILED}

Usage Guidelines:
- Updates needed: {YES|NO}
- If YES: {what was updated}

PHASE 6: REGISTRY UPDATE - JOHARI SUMMARY

```json
{
  "open": "Agent registered in {FUNCTION} section, description file finalized at permanent location",
  "hidden": "Registry entry formatted correctly, alphabetical order maintained",
  "blind": "Agent not yet tested in real workflow contexts, reusability claim not yet validated",
  "unknown": "U13: Does agent work correctly in all target workflows? U14: Are there integration issues?"
}
```

PHASE 6: REGISTRY UPDATE - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "Phase 7: Test agent in target workflow context",
    "Verify input/output contracts work as expected",
    "Validate reusability with alternative workflow contexts",
    "Document any integration issues discovered"
  ],
  "validationRequired": ["Confirm registry entry visible and agent file accessible"],
  "blockers": [],
  "priorityUnknowns": ["U13", "U14"]
}
```
---
```

---

PHASE 7: INTEGRATION TESTING

ENTRY GATE:
- Phase 6 complete with registry updated
- Agent description file at permanent location
- Target workflows identified for testing

PHASE OBJECTIVES:
- Test agent in target workflow context
- Verify input/output contracts work correctly
- Validate reusability claim with alternative contexts
- Document findings and integration issues

EXECUTION STEPS:

1. Prepare Test Environment
   - Identify primary target workflow for testing
   - Create test task-id: task-{test-name}
   - Prepare test task memory with appropriate context

2. Execute Agent in Primary Workflow Context
   - Invoke agent with test task-id and step context
   - Monitor agent execution and tool usage
   - Observe agent output (3 sections: Overview, Johari, Directives)

3. Validate Input Contract Compliance
   - Agent extracted task-id correctly: {YES|NO}
   - Agent read from task-{task-id}-memory.md: {YES|NO}
   - Agent executed context inheritance protocol: {YES|NO}
   - Agent loaded previous step context: {YES|NO}

4. Validate Output Contract Compliance
   - Three sections present (Overview, Johari, Directives): {YES|NO}
   - Output appended to task memory (not overwritten): {YES|NO}
   - Token budget respected: {actual tokens vs target}
   - Unknown markers used correctly ([NEW-UNKNOWN]): {YES|NO}

5. Test Reusability with Alternative Context
   - Select second target workflow from Phase 0
   - Create alternative test context
   - Re-invoke agent with different workflow context
   - Assess: Does agent work with only context changes?

6. Document Integration Findings
   - Successes: What worked as expected
   - Issues: What failed or underperformed
   - Edge cases: Unexpected scenarios encountered
   - Recommendations: Suggested improvements or documentation updates

EXIT GATE:
- Agent tested in primary workflow context
- Input/output contracts validated
- Reusability tested with alternative context
- Integration findings documented (successes and issues)
- If blocking issues found: Remediation plan created
- If testing passed: Ready for workflow completion

OUTPUT FORMAT:
Append to task-{agent-name}-memory.md:
```markdown
---
PHASE 7: INTEGRATION TESTING - OVERVIEW

Primary Workflow Test:
- Workflow: {workflow-name}
- Test task-id: task-{test-name}
- Execution status: {SUCCESS|FAILED|PARTIAL}

Input Contract Validation:
- Task-id extraction: {PASS|FAIL}
- Memory file reading: {PASS|FAIL}
- Context inheritance: {PASS|FAIL}
- Previous step loading: {PASS|FAIL}

Output Contract Validation:
- Three-section structure: {PASS|FAIL}
- Append operation: {PASS|FAIL}
- Token budget: {actual}/{target} - {PASS|FAIL}
- Unknown markers: {PASS|FAIL}

Alternative Context Test:
- Workflow: {alternative-workflow-name}
- Context changes only: {YES|NO}
- Execution status: {SUCCESS|FAILED|PARTIAL}
- Reusability validated: {YES|NO}

Integration Findings:

Successes:
- {success-1}
- {success-2}

Issues Identified:
- {issue-1}: {severity} - {description}
- {issue-2}: {severity} - {description}

Edge Cases Encountered:
- {edge-case-1}: {how handled}

Recommendations:
- {recommendation-1}
- {recommendation-2}

Overall Assessment: {PRODUCTION READY|NEEDS REMEDIATION|NEEDS DOCUMENTATION UPDATES}

PHASE 7: INTEGRATION TESTING - JOHARI SUMMARY

```json
{
  "open": "Agent tested in {N} workflow contexts, input/output contracts validated, reusability {confirmed|needs work}",
  "hidden": "Identified {N} integration issues, {N} edge cases, documented recommendations",
  "blind": "May not have tested all possible workflow contexts, long-term maintainability unknown",
  "unknown": "U15: Are there untested edge cases? U16: Will agent scale to high-complexity workflows?"
}
```

PHASE 7: INTEGRATION TESTING - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": [
    "If PRODUCTION READY: Workflow complete, agent ready for use",
    "If NEEDS REMEDIATION: Loop back to Phase 4, fix issues, re-validate",
    "If NEEDS DOCUMENTATION: Update agent description with discovered edge cases",
    "Document lessons learned for future agent development"
  ],
  "validationRequired": ["Verify test results reproducible"],
  "blockers": [],
  "priorityUnknowns": ["U15", "U16"]
}
```
---
```

WORKFLOW BRANCH:
- If PRODUCTION READY → Workflow complete
- If NEEDS REMEDIATION → Loop to Phase 4/5
- If NEEDS DOCUMENTATION → Update agent description, then complete

---

SUCCESS CRITERIA

Workflow successful when:
- Agent description created following design principles
- Cognitive function correctly classified
- Single Cognitive Responsibility Principle satisfied
- Reusability validated across 3+ workflows
- Registry updated with new agent
- Integration testing passed in target workflow contexts
- Agent ready for production use

---

ERROR HANDLING

SCENARIO: Existing agent already satisfies need (discovered in Phase 1)
- RESPONSE: Exit workflow with REUSE recommendation
- ACTION: Document context changes needed to reuse existing agent

SCENARIO: Agent performs multiple cognitive functions (detected in Phase 2)
- RESPONSE: Apply SCRP → split into multiple agents
- ACTION: Return to Phase 0 with split agent concepts

SCENARIO: Reusability test fails (Phase 2)
- RESPONSE: Scope too domain-specific
- ACTION: Re-evaluate agent concept, broaden cognitive function, or accept limited use (not all agents must be highly reusable)

SCENARIO: Validation failures in Phase 5
- RESPONSE: Loop back to Phase 4 with remediation plan
- ACTION: Apply fixes, re-run Phase 5 validation

SCENARIO: Integration testing reveals blocking issues (Phase 7)
- RESPONSE: Determine root cause (design vs implementation)
- ACTION: If design issue → Phase 2 re-classification; If implementation → Phase 4 fix

---

RELATED DOCUMENTS

- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Seven design principles for agents
- .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md - Seven cognitive function definitions
- .claude/docs/AGENT-REGISTRY.md - Catalog of existing agents
- .claude/skills/develop-agent/resources/agent-description-simple.md - Template for simple agents
- .claude/skills/develop-agent/resources/agent-description-complex.md - Template for complex agents
- .claude/docs/AGENT-TEMPLATE-USAGE.md - Template selection guidance
- .claude/protocols/agent-protocol-core.md - Core execution protocol (all agents)
- .claude/protocols/agent-protocol-extended.md - Extended protocol (code generation)
- .claude/templates/JOHARI.md - Python types, anti-patterns, format guidance
