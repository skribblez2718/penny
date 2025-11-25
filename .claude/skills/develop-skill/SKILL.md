---
name: develop-skill
description: Meta-skill for creating and updating workflow skills in the Penny AI system using 6 universal cognitive agents
tags: meta-skill, skill-creation, workflow-design, orchestration
---

# develop-skill

**Description:** Meta-skill for creating and updating workflow skills in the Penny AI system using 6 universal cognitive agents

**Status:** production

**Complexity:** medium

## Overview

The develop-skill meta-skill guides creation and modification of workflow skills within Penny. Penny handles skill creation directly - this skill defines the orchestration process for that work. Created skills will themselves define workflows that utilize the 6 universal cognitive agents.

## Critical Distinction

### ORCHESTRATION VS EXECUTION

Skills define ONLY orchestration - the WHAT and WHEN, never the HOW.

- **Skills specify:** Workflows, cognitive sequences, when to invoke which agents, context requirements
- **Skills DO NOT specify:** Implementation details, execution methods, agent internal behaviors
- **The HOW is defined in:** Agent descriptions (agent-registry.md), execution protocols, context format

This separation ensures skills remain lightweight, reusable, and agent-agnostic.

## Cognitive Agent Architecture

Penny uses 6 universal cognitive agents that adapt to ANY domain:

**Agents:**
- clarification-specialist (CLARIFICATION function)
- research-discovery (RESEARCH function)
- analysis-agent (ANALYSIS function)
- synthesis-agent (SYNTHESIS function)
- generation-agent (GENERATION function)
- quality-validator (VALIDATION function)

**Reference:** For complete agent descriptions: See `.claude/references/agent-registry.md`

**Critical:** Agents are ALWAYS invoked sequentially, never in parallel. Skills must define cognitive sequences as ordered steps, not parallel operations.

## Core Principles

1. **Orchestration Only:** Skills define workflows, not implementations
2. **Cognitive Sequences:** Skills define which cognitive functions, in what order
3. **Domain Classification:** Skills specify or detect task domain (technical/personal/creative/professional/recreational)
4. **Context Requirements:** Skills define what context agents need (quality_standards, artifact_types, etc.)
5. **Sequential Execution:** All agent invocations must be sequential
6. **Reference Over Duplication:** Skills reference existing documentation, don't duplicate it
7. **Modularity:** Skills are self-contained, composable units
8. **Agent-Agnostic:** Skills remain valid even if agent implementations change

## Workflow Efficiency Principles

When designing skill workflows, apply these principles from philosophy.md:

**Principles:**
- **embedded-validation:** Integrate quality checks into cognitive agents rather than creating separate validation phases
- **phase-collapse:** Merge adjacent phases handling related cognitive functions when appropriate
- **progressive-compression:** Ensure each phase compresses its output for efficient downstream consumption

**Note:** These principles reduce agent invocations and token overhead while maintaining quality. For complete details, see `.claude/docs/philosophy.md`.

## Context Passing Requirements

All skills MUST define how context flows between agents:

### Required Context Structure

- **task_domain:** Domain classification for cognitive adaptation
- **quality_standards:** Domain-specific standards agents must apply
- **artifact_types:** Expected output types
- **success_criteria:** Measurable success indicators
- **cognitive_sequence:** Ordered list of cognitive functions

### Scoped Context Loading

**Critical:** Each agent invocation MUST specify which context files to load

**Requirements:**
- Use scope annotations: [ALWAYS REQUIRED], [REQUIRED], [OPTIONAL]
- Include token budget guidance for context loading (e.g., "Token Budget: 2,500-3,000 tokens")
- Agents should only read immediate predecessors, not all previous outputs
- STRICT REQUIREMENT: Agent Johari summary outputs limited to 1,200 tokens maximum

**Example:**
```
Context Loading: IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
Predecessor: {predecessor-agent-name}

Protocol References:
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF code generation]

Memory Output:
- Write to: `.claude/memory/task-{id}-{agent-name}-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format
```

### References

- **Context format:** See `.claude/references/johari.md` (WorkflowMetadata schema)
- **Context examples:** See `.claude/references/context-inheritance.md` (examples)
- **Execution protocols (core):** See `.claude/protocols/agent-protocol-core.md` (scoped context loading - Section 2.2)
- **Execution protocols (extended):** See `.claude/protocols/agent-protocol-extended.md` (technical code generation)
- **Context pruning:** See `.claude/protocols/context-pruning-protocol.md` (progressive context compression)

## Workflow Protocol (When Using This Skill)

**CRITICAL:** When Penny invokes the develop-skill skill, full workflow protocol MUST be followed.

### Workflow Initialization (MANDATORY)

Before any skill development work begins:

1. **Generate task-id:** `task-skill-{skill-name}`
2. **Create workflow metadata:** `.claude/memory/task-{task-id}-memory.md`
3. **Include in metadata:**
   - Task domain: technical (skill creation is a technical task)
   - Quality standards: Orchestration-only, sequential agents, reference over duplication
   - Artifact types: Skill markdown file with agent orchestration sections
   - Success criteria: Skill is immediately functional, passes validation checklist

**Reference:** See `.claude/protocols/cognitive-skill-orchestration-protocol.md` Step 4

### Workflow Completion (MANDATORY)

After skill creation or update completes:

1. **Present complete skill file** to user
2. **Review Unknown Registry** for any unresolved design decisions
3. **Validate skill** against orchestration-only checklist
4. **ALWAYS prompt for develop-learnings invocation:**

   ```
   Would you like to capture learnings from this workflow using the develop-learnings skill?

   This will extract insights and patterns from the develop-skill workflow to improve future skill creation.
   Task ID: task-{task-id}
   ```

5. **Finalize workflow:** Mark as COMPLETED in metadata

**FAILURE CONDITION:** Skipping workflow initialization or completion breaks memory protocol and learning loop.

## Usage Decision Tree

```
User Intent
    |
    |- New Skill Request?
    |   |- Analyze Complexity
    |       |- Simple Skill (single cognitive sequence) → resources/create-simple-skill.md
    |       |- Complex Skill (multiple phases/sequences) → resources/create-complex-skill.md
    |
    |- Update Existing Skill?
        |- resources/update-skill.md
```

## Quick Start

### Creating New Skill

1. Identify skill type: Simple (single sequence) or complex (multi-phase)
2. Load appropriate protocol from resources/
3. Define cognitive sequences (ALWAYS sequential)
4. Specify context requirements (domain, standards, artifacts)
5. Validate: Orchestration-only, no implementation details
6. Ensure no parallel agent invocations

### Updating Existing Skill

1. Locate skill file
2. Load resources/update-skill.md protocol
3. Apply changes maintaining orchestration-only principle
4. Verify cognitive sequences remain sequential
5. Update context requirements if needed

## Architecture

### Directory Structure

```
skills/develop-skill/
|- SKILL.md                           (This file - main entry point)
|- resources/
    |- create-simple-skill.md         (Protocol for simple skills)
    |- create-complex-skill.md        (Protocol for complex skills)
    |- update-skill.md                (Protocol for updating skills)
    |- simple-skill-template.md       (Template for simple skills)
    |- complex-skill-template.md      (Template for complex skills)
    |- validation-checklist.md        (Quality assurance checklist)
```

### Invocation

When this skill is activated, Penny should:

1. Analyze request to determine protocol (create simple/complex or update)
2. Load corresponding protocol file from resources/
3. Execute protocol with cognitive agents as needed
4. Ensure created skill follows cognitive architecture principles
5. Validate: Sequential execution, orchestration-only, proper context-passing

## Key Features

- **Automatic Protocol Selection:** Routes to correct protocol based on request type
- **Cognitive-Aware:** Guides creation of skills using 6-agent architecture
- **Template-Driven:** Uses standardized templates for consistency
- **Validation Built-In:** Quality checks at each step
- **Context-Passing Guidance:** Ensures proper context structure
- **Sequential Enforcement:** Prevents parallel agent invocation patterns
- **Zero Redundancy:** References existing docs instead of duplicating

## Anti-Patterns

### Parallel Agent Invocation

**Wrong:**
```
Phase 1: Research and Analysis
- Invoke research-discovery AND analysis-agent simultaneously
```

**Right:**
```
Phase 1: Research
- Invoke research-discovery (RESEARCH)

Phase 2: Analysis
- Invoke analysis-agent (ANALYSIS)
```

### Implementation Details in Skill

**Wrong:**
```
The generation-agent will use React with TypeScript, implementing
components using functional patterns with hooks...
```

**Right:**
```
Phase 5: Core Implementation
Cognitive Sequence: GENERATION

Agent Invocations:
1. generation-agent (GENERATION)
   Purpose: Generate implementation following architecture
   Protocol References: agent-protocol-extended.md (if technical)
```

### Duplicating Existing Documentation

**Wrong:**
```
Skills must follow Johari Window format:
- open: Known to all
- hidden: Non-obvious insights
- blind: Limitations
- unknown: Areas needing other agents
[... full format specification ...]
```

**Right:**
```
For output format:
  See .claude/references/johari.md
```

## Best Practices

1. Penny creates skills directly; skills define agent workflows
2. Keep skills focused on single responsibility/domain
3. Define WHAT and WHEN, never HOW
4. Always specify cognitive sequences as sequential steps
5. Include domain classification (or detection method)
6. Define context requirements (standards, artifacts, criteria)
7. Reference documentation instead of duplicating
8. Validate against checklist before completion
9. Test cognitive sequences make sense for skill purpose
10. Ask: "Am I orchestrating or implementing?"

## Cognitive Sequence Design Guidance

Common cognitive sequence patterns:

**Patterns:**
- **discovery:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS
- **decision:** ANALYSIS → SYNTHESIS → VALIDATION
- **implementation:** GENERATION → VALIDATION
- **full-development:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION
- **investigation:** RESEARCH → ANALYSIS
- **creative:** CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION → VALIDATION

**Note:** Choose sequence based on skill purpose, always maintaining sequential order.

## Domain Adaptation

Skills should specify or detect task domain:

**Domains:**
- **technical:** Code, systems, technical implementations
- **personal:** Life decisions, goal planning, personal projects
- **creative:** Content, art, creative works
- **professional:** Business, strategy, operations
- **recreational:** Entertainment, events, fun activities
- **hybrid:** Multiple domains combined

**Domain Effects:**
- Quality standards agents apply
- Artifact types expected
- Evaluation criteria used
- Protocol references (core vs extended)

## Validation Requirements

Before considering skill complete, verify:

- Defines cognitive sequences (which agents, what order)
- All sequences are sequential (no parallel agent calls)
- Includes domain classification approach
- Specifies context requirements (standards, artifacts, criteria)
- **EVERY agent specifies context loading pattern** (WORKFLOW_ONLY / IMMEDIATE_PREDECESSORS / MULTIPLE_PREDECESSORS)
- **EVERY agent includes "Context Verification (MANDATORY)" subsection** with verification requirements
- **Skill defines how orchestrator verifies agents read required context** (pre-invocation, during, post-completion)
- **Memory Output format specifies Four-Section structure** (Context Loaded + Step Overview + Johari + Downstream)
- References documentation instead of duplicating
- Zero implementation details (100% orchestration)
- Gate criteria defined (if multi-phase)
- Context-passing approach clear
- Follows zero redundancy principle
- **Pattern compliance verification specified** for each agent

## Related Documentation

- `.claude/references/agent-registry.md` - Agent capabilities and descriptions
- `.claude/references/johari.md` - Context structure and format
- `.claude/references/context-inheritance.md` - Context-passing examples
- `.claude/protocols/agent-protocol-core.md` - Agent execution protocol
- `.claude/protocols/agent-protocol-extended.md` - Technical code generation protocol
- `.claude/docs/philosophy.md` - System design principles
- `.claude/docs/cognitive-function-taxonomy.md` - Cognitive function definitions

## Success Metrics

- Skills created are immediately functional
- Cognitive sequences are appropriate for skill purpose
- All agent invocations are sequential
- Context requirements are clearly defined
- Zero implementation details included
- Skills pass all validation checks
- Documentation references used (not duplicated)
- Skills remain valid if agent implementations change

## Remember

Skills orchestrate cognitive agents to accomplish workflows.
Agents execute cognitive functions across domains.
Skills define WHAT. Agents define HOW.

Keep this boundary sacred. Respect sequential execution. Reference existing documentation. Maintain zero redundancy.
