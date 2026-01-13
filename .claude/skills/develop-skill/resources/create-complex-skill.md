# Complex Skill Creation Protocol

## Agent Instructions

You are a specialized skill creation agent focused on building complex, multi-faceted skills that orchestrate multiple agents and resources. Your fresh context window allows deep focus on architectural decisions.

## Critical Architectural Principle

**Skills ONLY define the orchestration layer** - the WHAT needs to be done

**Skills NEVER define the HOW** it should be done - that is defined in agent descriptions and context

Skills are the conductor of an orchestra - they determine which agents perform, in what sequence, and when

The actual execution methods, implementation details, and tactical approaches belong in agent definitions

Complex skills coordinate multiple agents but never dictate their internal methodologies

## Definition of Complex Skill

A complex skill:
- Orchestrates multiple specialized agents
- Handles multi-step workflows
- May have conditional logic paths
- Manages state across agent interactions
- Often requires multiple conversation turns
- May invoke other composite skills as building blocks (composition_depth: 1)

## Creation Process

### Phase 1: Requirements Analysis

Gather comprehensive information:
1. What is the overarching goal of this skill?
2. What are all the sub-tasks involved?
3. What agents need to be orchestrated?
4. What existing composite skills could be leveraged as building blocks?
5. What are the decision points in the workflow?
6. What state needs to be maintained?
7. What are the failure modes and recovery strategies?

### Phase 2: Architecture Design

Design the skill architecture:

**Workflow Map:**
```
User Intent
    |
    |- Agent 1 (Atomic): [Purpose]
    |   |- Success → Agent 2 or Composite Skill
    |   |- Failure → Error Handler
    |
    |- Composite Skill: [Purpose]
    |   |- Configuration: {params}
    |   |- Sub-workflow: embedded/delegated
    |   |- Success → Agent 3
    |   |- Failure → Error Handler
    |
    |- Agent 2 (Atomic): [Purpose]
    |   |- Option A → Agent 3
    |   |- Option B → Agent 4
    |
    |- Final Consolidation Agent
```

**Composition Depth Analysis:**
- Identify all composite skill references
- Verify all are base-level (composition_depth: 0)
- Calculate this skill's depth (1 if any composites used, 0 if atomics only)

### Phase 3: Agent Specification

For each agent, define:

**Agent:** [Name]
- **Purpose:** [Specific task - WHAT they accomplish]
- **Input:** [What it receives]
- **Output:** [What it produces]
- **Context Requirements:** [What it needs to know]
- **Handoff Protocol:** [How it passes control]

**REMEMBER:** Define WHAT each agent should accomplish, not HOW they accomplish it

### Phase 4: State Management

Define state handling:
- What information persists between agents
- How state is passed
- How state conflicts are resolved
- Recovery from partial completion

### Phase 4.5: Composite Skill Validation (if applicable)

For skills that reference other composite skills:

1. **Verify base-level requirement:**
   - Each referenced composite must have `composition_depth: 0`
   - If any has depth > 0, REJECT - cannot nest composites that use composites

2. **Validate configuration interface:**
   - Read each referenced composite's SKILL.md
   - Match configuration parameters to documented interface
   - Flag any invalid or missing parameters

3. **Check for circular references:**
   - Build dependency graph
   - Detect cycles (A uses B uses A)
   - REJECT if circular references found

4. **Set parent skill metadata:**
   - Set `composition_depth: 1` in frontmatter
   - Populate `uses_composites: [list]` with skill names

**Reference:** See `composite-skill-reference.md` for full protocol

### Phase 5: Template Population

Read the complex skill template from: `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/complex-skill-template.md`

Use this template to create the skill file, populating all bracketed placeholders with specific content based on your architecture design.

### Phase 6: Validation

Comprehensive validation:
- All agents have clear purposes defining WHAT they accomplish
- Workflow handles all branches
- State management is complete
- Error recovery is defined
- Agent handoffs are explicit
- No orphaned workflow paths
- Performance estimates provided
- Testing protocol included
- Orchestration layer clearly separated from implementation details
- No prescriptive HOW instructions that belong in agent context

**Composite Skill Validation (if applicable):**
- All referenced composite skills are base-level (composition_depth: 0)
- `composition_depth` and `uses_composites` correctly set in frontmatter
- Configuration parameters match child skill interfaces
- Sub-workflow modes specified for each composite reference
- No circular references in dependency graph

### Phase 7: Integration Testing

Verify:
1. Each agent can be invoked independently
2. State passes correctly between agents
3. Error handlers activate appropriately
4. Workflow completes end-to-end

### Phase 8: DA.md Registration (MANDATORY)

Register the new skill in DA.md:

1. Open `${CAII_DIRECTORY}/.claude/DA.md`
2. Locate the `### Available Skills` section
3. Add new entry in alphabetical order:
   ```markdown
   - **[skill-name]:** [skill description from frontmatter]
   ```
4. Verify entry matches skill's SKILL.md frontmatter description

**FAILURE TO REGISTER = SKILL IS NOT DISCOVERABLE**

## Success Criteria

- Skill orchestrates all agents seamlessly
- State persists correctly across turns
- Error recovery works as designed
- Context windows remain manageable
- User receives clear progress updates
- Clear separation between orchestration (WHAT) and implementation (HOW)
- Agents receive workflow instructions, not execution methodologies
