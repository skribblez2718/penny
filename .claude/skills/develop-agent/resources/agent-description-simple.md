AGENT DESCRIPTION TEMPLATE (SIMPLE)

Template for creating simple, single-purpose agents with 1-3 execution steps and no user interaction or research requirements.

---

TEMPLATE STRUCTURE

```markdown
---
name: {AGENT_NAME}
description: {AGENT_DESCRIPTION_WITH_INVOCATION_EXAMPLES}
cognitive_function: {COGNITIVE_FUNCTION}
---

PURPOSE

{1 paragraph describing what this agent does, its role in workflows, and core responsibility. Should be workflow-agnostic - describe the FUNCTION not the position.}

CORE MISSION

{1-2 paragraphs including:
- What the agent DOES (primary responsibilities)
- What the agent does NOT do (excluded responsibilities)
- Key deliverables/outputs
- Critical constraints or non-negotiables}

MANDATORY PROTOCOL

Read and execute these protocols in sequence:
1. .claude/protocols/CONTEXT-INHERITANCE.md (before agent-specific work)
2. .claude/protocols/REASONING-STRATEGIES.md (at decision points)
3. .claude/protocols/AGENT-EXECUTION-PROTOCOL.md (during/after execution)

See .claude/protocols/AGENT-INTERFACE-CONTRACTS.md for input/output contracts.

---

STEP 1: {AGENT_SPECIFIC_STEP_1_NAME}

ACTION: {Brief description of what this step does}

{Detailed instructions for this step, including:
- What to analyze, process, or generate
- Which tools to use and how
- What data structures or formats to produce
- Error handling for this step}

---

STEP 2: {AGENT_SPECIFIC_STEP_2_NAME}

ACTION: {Brief description}

{Detailed instructions for this step}

---

[OPTIONAL STEP 3 for simple agents - include only if truly needed]

---

GATE EXIT REQUIREMENTS

DO NOT signal completion until ALL criteria met:

- {SPECIFIC_REQUIREMENT_1}
- {SPECIFIC_REQUIREMENT_2}
- {SPECIFIC_REQUIREMENT_3}
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

[OPTIONAL ANTI-PATTERN 3 for simple agents]

---

EXAMPLE INTERACTION

INPUT STATE (task-{example-task-id}-memory.md before this step):

```markdown
{Complete example showing what exists in memory file before agent runs.
Include: Workflow Metadata, previous step Overview/Johari/Directives, Unknown Registry if relevant.
Keep realistic and concise.}
```

AGENT PROCESS:

1. Extracted task-id: {example-task-id}
2. Executed context inheritance: loaded previous step context
3. {PROCESS_STEP_1_SUMMARY}
4. {PROCESS_STEP_2_SUMMARY}
5. Self-reflection: {BRIEF_REFLECTION_SUMMARY}
6. Formatted output: {TOTAL_TOKENS} tokens
7. Appended to memory file

OUTPUT STATE (task-{example-task-id}-memory.md after this step):

```markdown
{Complete example showing memory file state after agent completes.
Show previous content preserved + new three sections appended.
Demonstrate realistic Overview content, all 4 Johari quadrants populated, Downstream Directives complete.}
```

---

REMEMBER: {CLOSING_REMINDER_SPECIFIC_TO_AGENT}

```

---

PLACEHOLDER MAPPING GUIDE

REQUIRED PLACEHOLDERS

| Placeholder | Description | Example |
|-------------|-------------|---------|
| {AGENT_NAME} | Kebab-case agent name | data-parser, format-converter, schema-validator |
| {AGENT_DESCRIPTION_WITH_INVOCATION_EXAMPLES} | Description with usage examples (see existing agents) | Use this agent when you need to parse CSV data... |
| {COGNITIVE_FUNCTION} | One of 7 cognitive functions from taxonomy | RESEARCHER, ANALYZER, SYNTHESIZER, GENERATOR, VALIDATOR, CLARIFIER, COORDINATOR |
| {AGENT_SPECIFIC_STEP_N_NAME} | Name for each execution step | Parse Input Data, Transform Format, Validate Output |
| {SPECIFIC_REQUIREMENT_N} | Completion criterion beyond generic protocol | Output file contains valid JSON with no syntax errors |
| {ANTI_PATTERN_N_NAME} | Anti-pattern category | Skipping Validation, Assuming Format Without Checking |
| {CLOSING_REMINDER_SPECIFIC_TO_AGENT} | Agent-specific reminder | Always validate input format before processing |

AGENT-SPECIFIC STEPS

Define 1-3 detailed steps for agent's core work:
- Step 1: Usually reads/extracts data
- Step 2: Usually processes/transforms/analyzes
- Step 3: Usually validates/generates output (optional)

Keep focused on agent's specific responsibility.

ANTI-PATTERNS

Include 2-3 anti-patterns based on agent's domain:
- What mistakes are easy to make with this agent's work?
- What shortcuts would produce incorrect results?
- What assumptions would be dangerous?

Provide concrete Bad vs Good examples for each.

EXAMPLE INTERACTION

Provide realistic before/after memory states:
- INPUT STATE: Show what agent inherits from previous step
- AGENT PROCESS: Bullet list of actions taken (5-7 items)
- OUTPUT STATE: Show all three sections appended to memory

Keep example concise but complete enough to understand agent's role.

---

RELATED DOCUMENTS

- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Workflow-agnostic design guidance
- .claude/docs/COGNITIVE-FUNCTION-TAXONOMY.md - Seven cognitive function definitions
- .claude/docs/AGENT-REGISTRY.md - Catalog of existing agents
- .claude/protocols/CONTEXT-INHERITANCE.md - Context inheritance protocol
- .claude/protocols/REASONING-STRATEGIES.md - Systematic reasoning strategies
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md - Generic execution steps
- .claude/protocols/AGENT-INTERFACE-CONTRACTS.md - Input/output contract specifications
- .claude/templates/JOHARI.md - Output formatting and quadrant guidance
- .claude/skills/develop-agent/resources/agent-description-complex.md - Template for complex agents
