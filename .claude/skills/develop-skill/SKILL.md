---
name: skill-creator
description: Comprehensive framework for creating and updating skills in the Penny AI system
---

SKILL CREATOR

OVERVIEW
The Skill Creator is a meta-skill that guides the creation and modification of skills within the `${DA_NAME}` AI ecosystem. This skill follows a text-based, modular architecture that promotes reusability and scalability. `${DA_NAME}` handles skill creation directly without requiring a specialized agent, though the skills created will themselves define workflows that utilize specialized agents.

CRITICAL DISTINCTION: ORCHESTRATION VS EXECUTION
Skills define ONLY the orchestration layer - the WHAT needs to be done, not the HOW.
- Skills specify: workflows, decision trees, when to invoke agents, what information to gather
- Skills DO NOT specify: implementation details, execution methods, or agent behaviors
- The HOW is defined in: agent descriptions, agent context, and agent instructions
- This separation ensures skills remain lightweight, reusable, and agent-agnostic

CORE PRINCIPLES
1. Orchestration Only: Skills define workflows and decision points, never implementation details
2. Agent-First Workflows: Skills define protocols that utilize specialized agents for fresh context windows
3. Text-Based Operations: No code execution - all operations are text-based transformations
4. Progressive Disclosure: Information is revealed in layers to prevent context bloat
5. Modularity: Skills are self-contained units that can be composed together
6. Separation of Concerns: Creation and update protocols are distinct operations
7. Abstraction Boundary: Skills orchestrate; agents execute

USAGE DECISION TREE
User Intent
    |
    |- New Skill Request?
    |   |- Analyze Complexity
    |       |- Simple Skill → resources/create-simple-skill.md
    |       |- Complex Skill → resources/create-complex-skill.md
    |
    |- Update Existing Skill?
        |- resources/update-skill.md

QUICK START

CREATING A NEW SKILL
1. Identify Skill Type: Determine if the skill is simple (single-purpose) or complex (multi-faceted)
2. Load the appropriate protocol from resources/
3. Follow Guided Process
4. Validate Output: Ensure the skill meets all structural and system requirements and maintains orchestration-only focus

UPDATING AN EXISTING SKILL
1. Locate Skill: Identify the skill to be modified
2. Load resources/update-skill.md protocol
3. Apply Changes: Follow the systematic update process
4. Verify Abstraction: Ensure updates maintain orchestration-only principle

ARCHITECTURE

DIRECTORY STRUCTURE
skills/skill-creator/
|- SKILL.md                           (This file - main entry point)
|- resources/
    |- create-simple-skill.md         (Protocol for simple skills)
    |- create-complex-skill.md        (Protocol for complex skills)
    |- update-skill.md                (Protocol for updating skills)
    |- skill-template-simple.md       (Template for simple skills)
    |- skill-template-complex.md      (Template for complex skills)
    |- validation-checklist.md        (Quality assurance checklist)

INVOCATION
When this skill is activated, `${DA_NAME}` should:
1. Analyze the user's request to determine the appropriate protocol
2. Load the corresponding protocol file from resources/
3. Execute the protocol directly and perform any required research for creating the skill
4. Ensure the created skill defines workflows that appropriately utilize specialized agents

KEY FEATURES
- Automatic Protocol Selection: Routes to the correct protocol based on request type
- Direct Execution: `${DA_NAME}` handles skill creation without requiring a meta-agent
- Template-Driven: Uses standardized templates for consistency
- Validation Built-In: Includes quality checks at each step
- Version Management: Tracks skill evolution and changes
- Abstraction Enforcement: Ensures skills remain at orchestration layer only
- Agent Workflow Design: Created skills properly define agent utilization patterns

BEST PRACTICES
1. `${DA_NAME}` creates skills directly; the skills themselves define agent workflows
2. Keep skills focused on a single domain or responsibility
3. Skills define WHAT and WHEN, never HOW or implementation details
4. Document all agent handoffs clearly within skill workflows
5. Validate skills against the checklist before deployment
6. Maintain backwards compatibility when updating skills
7. When writing skills, ask: "Am I describing a workflow or an implementation?"

RELATED SKILLS
- system-architect: For designing multi-skill systems
- prompt-engineer: For optimizing agent instructions
- documentation: For creating comprehensive skill documentation

SUCCESS METRICS
- Skills created are immediately functional
- Agent workflows within skills are clearly defined
- Context windows remain under 50% capacity during creation
- Skills pass all validation checks on first attempt
- Skills contain zero implementation details (100% orchestration)