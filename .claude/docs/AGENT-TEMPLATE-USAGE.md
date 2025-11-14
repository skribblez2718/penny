AGENT TEMPLATE USAGE GUIDE

Instructions for using agent description templates to generate agent descriptions.

PURPOSE

This guide provides step-by-step instructions for the develop-agent skill or manual agent creation. Two templates are available: agent-description-simple.md for straightforward agents and agent-description-complex.md for sophisticated agents requiring user interaction or research.

CHOOSING THE RIGHT TEMPLATE

Use agent-description-simple.md when:
- Agent has 1-3 execution steps
- No user interaction required (no AskUserQuestion)
- Minimal or no research needed (no WebSearch/WebFetch)
- Straightforward input → process → output flow
- Single-purpose, focused responsibility
- Examples: data parsers, format converters, schema validators, simple analyzers

Use agent-description-complex.md when:
- Agent has 4-8 execution steps
- Requires user interaction to resolve ambiguities
- Performs research to gather external information
- Complex decision trees or multi-stage processing
- Multiple responsibilities or sophisticated analysis
- Examples: requirements clarifiers, architecture designers, research synthesizers, system analyzers

When in doubt: Start with SIMPLE template. If you find yourself needing user interaction protocols or research guidance, upgrade to COMPLEX template.

USAGE INSTRUCTIONS

STEP 0: Check Agent Registry
Before creating a new agent:
- Read .claude/docs/AGENT-REGISTRY.md to check for existing agents
- Search for agents with similar cognitive function
- Evaluate if existing agent can be reused with different workflow context
- If reusable agent exists, use it instead of creating new agent

STEP 1: Classify Cognitive Function
Read .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md and identify agent's primary cognitive function:
- RESEARCHER: Discovers and gathers information from external sources
- ANALYZER: Examines existing information to identify patterns or issues
- SYNTHESIZER: Combines multiple sources into coherent understanding
- GENERATOR: Creates new artifacts, plans, or specifications
- VALIDATOR: Verifies correctness, completeness, or compliance
- CLARIFIER: Resolves ambiguities and transforms vague inputs into explicit outputs
- COORDINATOR: Manages workflow state and orchestrates step transitions

Apply Single Cognitive Responsibility Principle: Agent should perform EXACTLY ONE cognitive function.

STEP 2: Read Workflow Specification
Read the workflow SKILL.md file to extract step specifications:
- Step number and name
- Purpose and responsibilities
- Input requirements (what to read from task-specific memory)
- Processing steps
- Output requirements (what to write to task-{task-id}-memory.md)

STEP 3: Determine Token Budgets
Calculate based on step complexity and output richness:
- Follow .claude/templates/JOHARI.md compression guidelines
- Typical ranges: 170-270 total tokens
  - Overview: 80-120 tokens
  - Johari Summary: 60-100 tokens
  - Downstream Directives: 30-50 tokens
- Adjust based on step information density

STEP 4: Identify Anti-Patterns
Review existing implementers in same workflow for common mistakes:
- Consider implementer complexity (2-3 for simple, 4-6 for complex)
- Focus on mistakes that would break workflow continuity or violate protocols
- Include concrete examples showing bad vs. good patterns

STEP 5: Create Example Interaction
Provide realistic demonstration:
- Use realistic task-id and content
- Show complete memory file state before implementer runs
- Show complete memory file state after implementer completes
- Demonstrate proper formatting, token compression, all required sections
- Include reasoning strategy application examples

STEP 6: Apply Workflow-Agnostic Design
Ensure reusability across workflows:
- Review .claude/docs/AGENT-DESIGN-PRINCIPLES.md for guidance
- Use {step-name} placeholders instead of hardcoded phase numbers
- Reference "previous step" not "Phase N" or specific step names
- Enable implementer reusability across different workflow positions

STEP 7: Fill All Placeholders
Replace all {PLACEHOLDER} values from template:
- {AGENT_NAME}: Kebab-case name (e.g., clarify-requirements)
- {AGENT_DESCRIPTION_WITH_INVOCATION_EXAMPLES}: YAML description with examples
- {COGNITIVE_FUNCTION}: One of 7 cognitive functions (from Step 1)
- {AGENT_SPECIFIC_STEP_N_NAME}: Names for each execution step
- Token budget placeholders: {MIN_TOKENS}, {MAX_TOKENS}, etc.
- Content guidance placeholders: {OPEN_CONTENT_GUIDANCE}, etc.
- Anti-pattern placeholders: {ANTI_PATTERN_N_NAME}, etc.

Note: Tools and model selection are determined by Claude Code during agent generation, not in the agent description.

STEP 8: Validate Completeness
Verify all requirements met:
- All required sections present (Purpose, Core Mission, Mandatory Protocol, etc.)
- Token budgets realistic for step complexity
- Anti-patterns relevant and clear with concrete examples
- Example interaction demonstrates full workflow
- No hardcoded step positions or phase numbers
- Reasoning strategies explicitly referenced
- Both Context Inheritance and Reasoning Strategies protocols included

STEP 9: Generate Agent Description File
Create the implementer description:
- Remove instructional header from template (lines 1-10)
- Fill all placeholders with step-specific content
- Ensure plain text formatting (no markdown headers/bold)
- Verify protocol references are accurate

STEP 10: Save File and Update Registry
Save to appropriate location:
- Development: .claude/skills/develop-agent/agent-tmp/{AGENT_NAME}_TEMP.md
- Production: .claude/skills/develop-agent/agent-tmp/{AGENT_NAME}.md

After creating agent description:
- Update .claude/docs/AGENT-REGISTRY.md with new agent entry
- Add to appropriate cognitive function section
- Include one-line description of what agent does
- Maintain alphabetical order within section

QUALITY CHECKLIST

Before finalizing agent description:
- Cognitive function classified and documented in frontmatter
- Agent checked against AGENT-REGISTRY.md for duplicates
- Workflow-agnostic design (no hardcoded phases)
- Protocols referenced (CONTEXT-INHERITANCE, REASONING-STRATEGIES, AGENT-EXECUTION-PROTOCOL)
- AGENT-INTERFACE-CONTRACTS.md referenced for input/output contracts
- Token budgets appropriate for complexity
- Anti-patterns specific and actionable (2-3 for simple, 4-6 for complex)
- Example interaction realistic and complete
- All placeholders filled including {COGNITIVE_FUNCTION}
- User interaction protocol included (complex agents only)
- Research protocol included (complex agents only)
- Plain text formatting throughout
- Related documents referenced correctly
- Agent will be added to AGENT-REGISTRY.md after creation

COMMON MISTAKES TO AVOID

1. Hardcoding Phase Numbers
   Bad: "You are Phase 2 of the develop-agent workflow"
   Good: "Your role and position are defined by Step Context at invocation"

2. Missing Reasoning Strategy References
   Bad: Only implicit reasoning in self-reflection
   Good: Explicit REASONING-STRATEGIES.md reference in Mandatory Protocol

3. Vague Token Budgets
   Bad: "Keep output concise"
   Good: "170-270 tokens total (80-120 Overview, 60-100 Johari, 30-50 Directives)"

4. Generic Anti-Patterns
   Bad: "Don't make mistakes"
   Good: Concrete examples showing specific anti-pattern vs. correct pattern

5. Incomplete Example Interaction
   Bad: Only showing final output
   Good: Complete before/after memory states with implementer process steps

RELATED DOCUMENTS
- .claude/skills/develop-agent/resources/agent-description-simple.md - Template for simple agents
- .claude/skills/develop-agent/resources/agent-description-complex.md - Template for complex agents
- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Workflow-agnostic design guidance
- .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md - Seven cognitive function definitions
- .claude/docs/AGENT-REGISTRY.md - Catalog of existing agents
- .claude/protocols/CONTEXT-INHERITANCE.md - Context inheritance protocol
- .claude/protocols/REASONING-STRATEGIES.md - Systematic reasoning strategies
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md - Generic execution steps
- .claude/protocols/AGENT-INTERFACE-CONTRACTS.md - Input/output contracts
- .claude/templates/JOHARI.md - Output formatting and token budgets
- .claude/skills/develop-agent/SKILL.md - Structured agent creation workflow
