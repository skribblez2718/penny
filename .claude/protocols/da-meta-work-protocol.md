# Penny Meta Work Protocol

## Overview

This protocol defines the execution flow for tasks that involve modifying the Penny system itself - its architecture, agents, protocols, skills, or configuration files.

## Trigger Conditions

Use this protocol when:
- Task involves modifying Penny system itself
- File paths reference: `${PAI_DIRECTORY}/.claude/*/**/`
- Keywords: "modify agent", "update protocol", "refactor template", "Penny architecture"
- Any changes to system configuration or core functionality

---

## Execution Steps

### Step 1: READ navigation hub

**Required Reading:**
`${PAI_DIRECTORY}/.claude/docs/philosophy.md`

**Purpose:**
- Understand system design principles
- Review architectural patterns
- Ensure consistency with system philosophy
- Avoid anti-patterns and violations

### Step 2: Apply design principles

Before making any changes, ensure alignment with these principles:

#### Cognitive Domain Separation
- Organize by cognitive function, NOT task-specific agents
- One cognitive responsibility per agent
- Domain knowledge injected via context, not hardcoded

#### Orchestration-Implementation Decoupling
- Skills define WHAT (orchestration layer)
- Agents define HOW (implementation layer)
- Clear separation between coordination and execution

#### Reference Over Duplication
- Reference existing content instead of duplicating
- Single point of change for shared information
- Use protocol/reference files, don't embed in multiple places

#### Single Point of Change
- Changes to a concept should happen in one file
- Other files reference that canonical source
- Reduces maintenance burden and inconsistency

#### Minimal Size Without Sacrificing Detail
- Keep files concise but complete
- Use progressive disclosure (overview → details)
- Extract common patterns to reference files

### Step 3: EXECUTE task

Execute the task with full architectural context:

1. **Understand Impact:**
   - Which components are affected?
   - What dependencies exist?
   - Will this change require updates elsewhere?

2. **Make Changes:**
   - Follow established patterns and conventions
   - Maintain consistency with existing style
   - Update all affected files

3. **Update Documentation:**
   - Update any affected documentation
   - Ensure examples remain accurate
   - Check cross-references are still valid

### Step 4: Validate against patterns

After implementation, verify:

#### Cognitive Domain Integrity Maintained
- ✓ Agents still organized by cognitive function
- ✓ No task-specific logic hardcoded in agents
- ✓ Context injection patterns followed

#### Decision Matrices for Format/Structure Choices
- ✓ Format choices documented with rationale
- ✓ Consistent with system-wide patterns
- ✓ Trade-offs clearly understood

#### Implementation Guidelines Anti-Patterns
- ✓ No duplication of protocol content
- ✓ No violation of single responsibility
- ✓ No tight coupling between layers

#### Validation Strategies Checklists
- ✓ All affected files updated
- ✓ Cross-references verified
- ✓ Examples tested/validated
- ✓ Documentation current

---

## Key Principles for Meta Work

### Understand Before Changing
Read and understand the existing system before making modifications. Every design decision has rationale.

### Maintain Consistency
Follow established patterns and conventions. Consistency reduces cognitive load and errors.

### Think Systemically
Consider ripple effects. Changes to core components affect the entire system.

### Document Decisions
Explain WHY, not just WHAT. Future maintainers need context for decisions.

### Test Thoroughly
Meta changes can break multiple workflows. Verify changes don't introduce regressions.

---

## Common Meta Work Tasks

### Adding New Agents
1. Determine cognitive function (not task domain)
2. Follow agent template structure
3. Update agent-registry.md
4. Test with multiple task domains

### Creating New Skills
1. Use develop-skill skill for structured creation
2. Follow SKILL.md template
3. Document gate criteria clearly
4. Test full workflow end-to-end

### Updating Protocols
1. Verify changes don't break agent contracts
2. Update all affected protocol files
3. Test with existing workflows
4. Update documentation/examples

### Refactoring Architecture
1. Document current state and proposed changes
2. Identify all affected components
3. Make changes systematically
4. Verify system integrity post-refactor
