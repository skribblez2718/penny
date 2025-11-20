AGENT DESCRIPTION TEMPLATE (COMPLEX)

Template for creating complex, multi-faceted agents with 4-8 execution steps, user interaction, research capabilities, and sophisticated decision-making.

---

TEMPLATE STRUCTURE

```markdown
---
name: {AGENT_NAME}
description: {AGENT_DESCRIPTION_WITH_INVOCATION_EXAMPLES}
cognitive_function: {COGNITIVE_FUNCTION}
dependencies: [{PREDECESSOR_AGENT_1}, {PREDECESSOR_AGENT_2}]  # Optional: specific agents to read context from
---

PURPOSE

{1-2 paragraphs describing what this agent does, its role in workflows, and core responsibility. Should be workflow-agnostic - describe the FUNCTION not the position. For complex agents, articulate the sophisticated work they perform.}

CORE MISSION

{2-4 paragraphs including:
- What the agent DOES (primary responsibilities with detail)
- What the agent does NOT do (excluded responsibilities)
- Key deliverables/outputs
- Critical constraints or non-negotiables
- When user interaction is required
- When research is required}

MANDATORY PROTOCOL

Read and execute:
1. .claude/protocols/agent-protocol-core.md (all agents - context inheritance, output formatting)
2. .claude/protocols/agent-protocol-extended.md (if code generation agent - TDD + Security)

Core protocol covers: Task-ID extraction, context inheritance, reasoning strategies, output formatting, and execution steps.

---

USER INTERACTION PROTOCOL

This agent may require user interaction to resolve ambiguities or gather requirements.

WHEN TO INTERACT:
- {CONDITION_1_REQUIRING_USER_INPUT}
- {CONDITION_2_REQUIRING_USER_INPUT}
- {CONDITION_3_REQUIRING_USER_INPUT}

HOW TO INTERACT:
Use the AskUserQuestion tool with:
- Clear, specific questions (avoid vague or leading questions)
- Limited options (2-4 choices) when applicable
- Context for why the question is being asked
- Default recommendation if appropriate

INTERACTION GUIDELINES:
- Batch related questions together (minimize round trips)
- Provide enough context for informed decisions
- Document all user responses in Open quadrant
- Flag any unresolved questions in Unknown quadrant

---

RESEARCH PROTOCOL

This agent may need to perform research using WebSearch or WebFetch.

WHEN TO RESEARCH:
- {CONDITION_1_REQUIRING_RESEARCH}
- {CONDITION_2_REQUIRING_RESEARCH}
- {CONDITION_3_REQUIRING_RESEARCH}

HOW TO RESEARCH:
- Use WebSearch for broad information gathering
- Use WebFetch for specific documentation or authoritative sources
- Prioritize official documentation over blog posts
- Cross-reference multiple sources for validation
- Document sources in Hidden quadrant

RESEARCH GUIDELINES:
- Focus research on resolving uncertainties, not browsing
- Validate information currency (check dates)
- Flag conflicting information in Blind quadrant
- Cite sources when making recommendations

---

STEP 1: {AGENT_SPECIFIC_STEP_1_NAME}

ACTION: {Brief description of what this step does}

{Detailed instructions for this step, including:
- What to analyze, process, or generate
- Which tools to use and how
- Decision points and criteria
- User interaction triggers
- Research triggers
- Error handling for this step}

DECISION LOGIC (if applicable):
IF {condition}
  THEN → {action}
ELSE IF {condition}
  THEN → {action}
ELSE
  THEN → {default_action}

---

STEP 2: {AGENT_SPECIFIC_STEP_2_NAME}

ACTION: {Brief description}

{Detailed instructions}

---

STEP 3: {AGENT_SPECIFIC_STEP_3_NAME}

ACTION: {Brief description}

{Detailed instructions}

---

STEP 4: {AGENT_SPECIFIC_STEP_4_NAME}

ACTION: {Brief description}

{Detailed instructions}

---

[STEPS 5-8: Add as needed for complex agents with multi-stage processing]

---

GATE EXIT REQUIREMENTS

DO NOT signal completion until ALL criteria met:

- {SPECIFIC_REQUIREMENT_1}
- {SPECIFIC_REQUIREMENT_2}
- {SPECIFIC_REQUIREMENT_3}
- {SPECIFIC_REQUIREMENT_4}
- User interactions completed (if required)
- Research completed (if required)
- All generic requirements from AGENT-EXECUTION-PROTOCOL.md satisfied

---

ANTI-PATTERNS TO AVOID

ANTI-PATTERN 1: {ANTI_PATTERN_1_NAME}

{Brief description of what NOT to do}

```
Bad: {Concrete example showing the anti-pattern}
```

CORRECT: {Description of right approach}

```
Good: {Concrete example showing correct pattern}
```

---

ANTI-PATTERN 2: {ANTI_PATTERN_2_NAME}

{Brief description}

```
Bad: {Example}
```

CORRECT: {Description}

```
Good: {Example}
```

---

ANTI-PATTERN 3: {ANTI_PATTERN_3_NAME}

{Brief description}

```
Bad: {Example}
```

CORRECT: {Description}

```
Good: {Example}
```

---

ANTI-PATTERN 4: {ANTI_PATTERN_4_NAME}

{Brief description}

```
Bad: {Example}
```

CORRECT: {Description}

```
Good: {Example}
```

---

[ANTI-PATTERNS 5-6: Include for very complex agents with many pitfalls]

---

EXAMPLE INTERACTION

SCENARIO 1: {PRIMARY_USE_CASE_NAME}

INPUT STATE (task-{example-task-id}-memory.md before this step):

```markdown
{Complete example showing what exists in memory file before agent runs.
Include: Workflow Metadata, previous step Overview/Johari/Directives, Unknown Registry.
Make realistic and detailed enough to show agent's complexity.}
```

AGENT PROCESS:

1. Extracted task-id: {example-task-id}
2. Executed context inheritance: loaded {N} previous steps, identified {N} unknowns to resolve
3. Applied reasoning strategies: {REASONING_SUMMARY}
4. {PROCESS_STEP_3_SUMMARY}
5. User interaction: {USER_INTERACTION_SUMMARY}
6. Research performed: {RESEARCH_SUMMARY}
7. {PROCESS_STEP_6_SUMMARY}
8. {PROCESS_STEP_7_SUMMARY}
9. Self-reflection: {REFLECTION_FINDINGS_SUMMARY}
10. Formatted output: {TOKEN_COUNT} tokens ({OVERVIEW_TOKENS} Overview + {JOHARI_TOKENS} Johari + {DIRECTIVES_TOKENS} Directives)
11. Appended to memory file

OUTPUT STATE (task-{example-task-id}-memory.md after this step):

```markdown
{Complete example showing memory file state after agent completes.
Show previous content preserved + new three sections appended.
Demonstrate realistic Overview with multiple components, all 4 Johari quadrants substantively populated, Downstream Directives with concrete guidance.}
```

---

SCENARIO 2: {EDGE_CASE_OR_ALTERNATIVE_SCENARIO}

{Optional second scenario showing how agent handles complications, user ambiguity, or research challenges. Include INPUT, PROCESS, OUTPUT like Scenario 1 but more concise.}

---

REMEMBER: {CLOSING_REMINDER_SPECIFIC_TO_AGENT}

```

---

PLACEHOLDER MAPPING GUIDE

REQUIRED PLACEHOLDERS

| Placeholder | Description | Example |
|-------------|-------------|---------|
| {AGENT_NAME} | Kebab-case agent name | requirements-clarifier, architecture-designer, research-synthesizer |
| {AGENT_DESCRIPTION_WITH_INVOCATION_EXAMPLES} | Detailed description with usage | Use this agent when you need to transform vague requirements into explicit acceptance criteria... |
| {COGNITIVE_FUNCTION} | One of 7 cognitive functions from taxonomy | RESEARCHER, ANALYZER, SYNTHESIZER, GENERATOR, VALIDATOR, CLARIFIER, COORDINATOR |
| {AGENT_SPECIFIC_STEP_N_NAME} | Name for each execution step | Analyze Previous Context, Identify Ambiguities, Interact with User, Generate Criteria, Validate Completeness |
| {CONDITION_N_REQUIRING_USER_INPUT} | When user interaction needed | Requirements contain ambiguous terms (e.g., "fast", "scalable") |
| {CONDITION_N_REQUIRING_RESEARCH} | When research needed | Technology choice requires evaluation of current best practices |
| {SPECIFIC_REQUIREMENT_N} | Completion criterion | All requirements have explicit acceptance criteria with test cases |
| {ANTI_PATTERN_N_NAME} | Anti-pattern category | Accepting Vague Requirements, Not Documenting User Decisions |
| {PRIMARY_USE_CASE_NAME} | Main scenario name | Clarifying Web Application Requirements |
| {EDGE_CASE_OR_ALTERNATIVE_SCENARIO} | Alternative scenario | Handling Conflicting User Preferences |
| {CLOSING_REMINDER_SPECIFIC_TO_AGENT} | Agent-specific reminder | Clarity enables action - ambiguous requirements guarantee failure |

AGENT-SPECIFIC STEPS

Define 4-8 detailed steps for agent's complex work:
- Early steps: Read context, analyze, identify issues
- Middle steps: Interact with user, research, process information
- Later steps: Generate deliverables, validate, synthesize
- Complex decision logic with IF/THEN/ELSE where appropriate

USER INTERACTION PROTOCOL

Specify WHEN and HOW agent interacts with users:
- Conditions requiring interaction (3-5 scenarios)
- How to use AskUserQuestion tool effectively
- Batching strategy to minimize round trips
- Documentation requirements for user responses

RESEARCH PROTOCOL

Specify WHEN and HOW agent performs research:
- Conditions requiring research (3-5 scenarios)
- When to use WebSearch vs WebFetch
- Source validation and currency checks
- Documentation requirements for research findings

ANTI-PATTERNS

Include 4-6 anti-patterns for complex agents:
- Domain-specific mistakes (e.g., accepting vague requirements)
- Interaction mistakes (e.g., asking too many questions)
- Research mistakes (e.g., relying on outdated sources)
- Process mistakes (e.g., skipping validation steps)

Provide concrete Bad vs Good examples for each.

EXAMPLE INTERACTION

Provide comprehensive scenarios:
- SCENARIO 1: Primary use case with full detail (INPUT, PROCESS, OUTPUT)
- SCENARIO 2: Edge case or complication (concise but complete)

Show agent's sophistication through:
- Multi-stage processing (8-11 process steps)
- User interaction examples
- Research integration
- Complex reasoning application
- Substantial output (realistic token counts)

---

RELATED DOCUMENTS

- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Workflow-agnostic design guidance
- .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md - Seven cognitive function definitions
- .claude/docs/AGENT-REGISTRY.md - Catalog of existing agents
- .claude/protocols/agent-protocol-core.md - Core execution protocol (all agents)
- .claude/protocols/agent-protocol-extended.md - Extended protocol (code generation)
- .claude/templates/JOHARI.md - Python types, anti-patterns, format decision guidance
- .claude/skills/develop-agent/resources/agent-description-simple.md - Template for simple agents
