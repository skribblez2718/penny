---
name: develop-skill
description: Meta-skill for creating and updating workflow skills in the Penny AI system using 6 universal cognitive agents
status: production
complexity: medium
---

DEVELOP-SKILL

OVERVIEW

The develop-skill meta-skill guides creation and modification of workflow skills within Penny. Penny handles skill creation directly - this skill defines the orchestration process for that work. Created skills will themselves define workflows that utilize the 6 universal cognitive agents.

CRITICAL DISTINCTION: ORCHESTRATION VS EXECUTION

Skills define ONLY orchestration - the WHAT and WHEN, never the HOW.
- Skills specify: Workflows, cognitive sequences, when to invoke which agents, context requirements
- Skills DO NOT specify: Implementation details, execution methods, agent internal behaviors
- The HOW is defined in: Agent descriptions (agent-registry.md), execution protocols, context format

This separation ensures skills remain lightweight, reusable, and agent-agnostic.

COGNITIVE AGENT ARCHITECTURE

Penny uses 6 universal cognitive agents that adapt to ANY domain:
- clarification-specialist (CLARIFICATION function)
- research-discovery (RESEARCH function)
- analysis-agent (ANALYSIS function)
- synthesis-agent (SYNTHESIS function)
- generation-agent (GENERATION function)
- quality-validator (VALIDATION function)

For complete agent descriptions:
  See .claude/references/agent-registry.md

CRITICAL: Agents are ALWAYS invoked sequentially, never in parallel.
Skills must define cognitive sequences as ordered steps, not parallel operations.

CORE PRINCIPLES

1. Orchestration Only: Skills define workflows, not implementations
2. Cognitive Sequences: Skills define which cognitive functions, in what order
3. Domain Classification: Skills specify or detect task domain (technical/personal/creative/professional/recreational)
4. Context Requirements: Skills define what context agents need (quality_standards, artifact_types, etc.)
5. Sequential Execution: All agent invocations must be sequential
6. Reference Over Duplication: Skills reference existing documentation, don't duplicate it
7. Modularity: Skills are self-contained, composable units
8. Agent-Agnostic: Skills remain valid even if agent implementations change

WORKFLOW EFFICIENCY PRINCIPLES

When designing skill workflows, apply these principles from philosophy.md:

- EMBEDDED VALIDATION: Integrate quality checks into cognitive agents rather than creating separate validation phases
- PHASE COLLAPSE: Merge adjacent phases handling related cognitive functions when appropriate
- PROGRESSIVE COMPRESSION: Ensure each phase compresses its output for efficient downstream consumption

These principles reduce agent invocations and token overhead while maintaining quality. For complete details, see `.claude/docs/philosophy.md`.

CONTEXT-PASSING REQUIREMENTS

All skills MUST define how context flows between agents:

Required Context Structure:
- task_domain: Domain classification for cognitive adaptation
- quality_standards: Domain-specific standards agents must apply
- artifact_types: Expected output types
- success_criteria: Measurable success indicators
- cognitive_sequence: Ordered list of cognitive functions

Scoped Context Loading (CRITICAL):
- Each agent invocation MUST specify which context files to load
- Use scope annotations: [ALWAYS REQUIRED], [REQUIRED], [OPTIONAL]
- Include token budget guidance for context loading (e.g., "Token Budget: 2,500-3,000 tokens")
- Agents should only read immediate predecessors, not all previous outputs
- STRICT REQUIREMENT: Agent Johari summary outputs limited to 1,200 tokens maximum
- Example:
  ```
  Context References:
  - .claude/memory/task-{id}-memory.md (workflow metadata) [ALWAYS REQUIRED]
  - .claude/memory/task-{id}-{predecessor}-memory.md [IMMEDIATE PREDECESSOR - REQUIRED]

  Context Scope: IMMEDIATE_PREDECESSORS
  Token Budget: 2,500-3,000 tokens (context loading)
  Johari Output Limit: 1,200 tokens maximum (strictly enforced)
  ```

For context format details:
  See .claude/references/johari.md (WorkflowMetadata schema)
  See .claude/references/context-inheritance.md (examples)

For execution protocols:
  See .claude/protocols/agent-protocol-core.md (scoped context loading - Section 2.2)
  See .claude/protocols/agent-protocol-extended.md (technical code generation)
  See .claude/protocols/context-pruning-protocol.md (progressive context compression)

USAGE DECISION TREE

User Intent
    |
    |- New Skill Request?
    |   |- Analyze Complexity
    |       |- Simple Skill (single cognitive sequence) → resources/create-simple-skill.md
    |       |- Complex Skill (multiple phases/sequences) → resources/create-complex-skill.md
    |
    |- Update Existing Skill?
        |- resources/update-skill.md

QUICK START

CREATING A NEW SKILL:
1. Identify skill type: Simple (single sequence) or complex (multi-phase)
2. Load appropriate protocol from resources/
3. Define cognitive sequences (ALWAYS sequential)
4. Specify context requirements (domain, standards, artifacts)
5. Validate: Orchestration-only, no implementation details
6. Ensure no parallel agent invocations

UPDATING AN EXISTING SKILL:
1. Locate skill file
2. Load resources/update-skill.md protocol
3. Apply changes maintaining orchestration-only principle
4. Verify cognitive sequences remain sequential
5. Update context requirements if needed

ARCHITECTURE

DIRECTORY STRUCTURE:
skills/develop-skill/
|- SKILL.md                           (This file - main entry point)
|- resources/
    |- create-simple-skill.md         (Protocol for simple skills)
    |- create-complex-skill.md        (Protocol for complex skills)
    |- update-skill.md                (Protocol for updating skills)
    |- simple-skill-template.md       (Template for simple skills)
    |- complex-skill-template.md      (Template for complex skills)
    |- validation-checklist.md        (Quality assurance checklist)

INVOCATION:
When this skill is activated, Penny should:
1. Analyze request to determine protocol (create simple/complex or update)
2. Load corresponding protocol file from resources/
3. Execute protocol with cognitive agents as needed
4. Ensure created skill follows cognitive architecture principles
5. Validate: Sequential execution, orchestration-only, proper context-passing

KEY FEATURES

- Automatic Protocol Selection: Routes to correct protocol based on request type
- Cognitive-Aware: Guides creation of skills using 6-agent architecture
- Template-Driven: Uses standardized templates for consistency
- Validation Built-In: Quality checks at each step
- Context-Passing Guidance: Ensures proper context structure
- Sequential Enforcement: Prevents parallel agent invocation patterns
- Zero Redundancy: References existing docs instead of duplicating

ANTI-PATTERNS TO AVOID

WRONG: Parallel Agent Invocation
```
Phase 1: Research and Analysis
- Invoke research-discovery AND analysis-agent simultaneously
```

RIGHT: Sequential Agent Invocation
```
Phase 1: Research
- Invoke research-discovery (RESEARCH)

Phase 2: Analysis
- Invoke analysis-agent (ANALYSIS)
```

WRONG: Implementation Details in Skill
```
The generation-agent will use React with TypeScript, implementing
components using functional patterns with hooks...
```

RIGHT: Orchestration Focus
```
Phase 5: Core Implementation
Cognitive Sequence: GENERATION

Agent Invocations:
1. generation-agent (GENERATION)
   Purpose: Generate implementation following architecture
   Protocol References: agent-protocol-extended.md (if technical)
```

WRONG: Duplicating Existing Documentation
```
Skills must follow Johari Window format:
- open: Known to all
- hidden: Non-obvious insights
- blind: Limitations
- unknown: Areas needing other agents
[... full format specification ...]
```

RIGHT: Referencing Existing Documentation
```
For output format:
  See .claude/references/johari.md
```

BEST PRACTICES

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

COGNITIVE SEQUENCE DESIGN GUIDANCE

COMMON PATTERNS:

Discovery Pattern:
  CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS

Decision Pattern:
  ANALYSIS → SYNTHESIS → VALIDATION

Implementation Pattern:
  GENERATION → VALIDATION

Full Development Pattern:
  CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION

Investigation Pattern:
  RESEARCH → ANALYSIS

Creative Pattern:
  CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION → VALIDATION

Choose sequence based on skill purpose, always maintaining sequential order.

DOMAIN ADAPTATION

Skills should specify or detect task domain:
- technical: Code, systems, technical implementations
- personal: Life decisions, goal planning, personal projects
- creative: Content, art, creative works
- professional: Business, strategy, operations
- recreational: Entertainment, events, fun activities
- hybrid: Multiple domains combined

Domain affects:
- Quality standards agents apply
- Artifact types expected
- Evaluation criteria used
- Protocol references (core vs extended)

VALIDATION REQUIREMENTS

Before considering skill complete, verify:
- [ ] Defines cognitive sequences (which agents, what order)
- [ ] All sequences are sequential (no parallel agent calls)
- [ ] Includes domain classification approach
- [ ] Specifies context requirements (standards, artifacts, criteria)
- [ ] References documentation instead of duplicating
- [ ] Zero implementation details (100% orchestration)
- [ ] Gate criteria defined (if multi-phase)
- [ ] Context-passing approach clear
- [ ] Follows zero redundancy principle

RELATED DOCUMENTATION

- .claude/references/agent-registry.md - Agent capabilities and descriptions
- .claude/references/johari.md - Context structure and format
- .claude/references/context-inheritance.md - Context-passing examples
- .claude/protocols/agent-protocol-core.md - Agent execution protocol
- .claude/protocols/agent-protocol-extended.md - Technical code generation protocol
- .claude/docs/philosophy.md - System design principles
- .claude/docs/cognitive-function-taxonomy.md - Cognitive function definitions

SUCCESS METRICS

- Skills created are immediately functional
- Cognitive sequences are appropriate for skill purpose
- All agent invocations are sequential
- Context requirements are clearly defined
- Zero implementation details included
- Skills pass all validation checks
- Documentation references used (not duplicated)
- Skills remain valid if agent implementations change

REMEMBER

Skills orchestrate cognitive agents to accomplish workflows.
Agents execute cognitive functions across domains.
Skills define WHAT. Agents define HOW.

Keep this boundary sacred. Respect sequential execution. Reference existing documentation. Maintain zero redundancy.
