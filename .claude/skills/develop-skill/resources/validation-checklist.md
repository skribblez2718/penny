# Skill Validation Checklist

## Critical Architectural Principle

This checklist ensures skills properly define the orchestration layer (WHAT) and do not prescribe implementation details (HOW)

Skills must coordinate agent activities without dictating their execution methodologies

## Metadata Validation

- [ ] Skill name follows kebab-case convention
- [ ] Description is clear and concise
- [ ] Tags are relevant and searchable

## Structure Validation

- [ ] SKILL.md exists in correct location
- [ ] All referenced resources exist
- [ ] Directory structure follows standards
- [ ] No unnecessary files present
- [ ] File permissions appropriate

## Content Validation

### Documentation

- [ ] Purpose clearly stated
- [ ] All sections complete
- [ ] Examples provided and functional
- [ ] Error cases documented
- [ ] Dependencies listed

### Agent Configuration

- [ ] All agents properly defined with WHAT they accomplish
- [ ] Instructions clear and unambiguous about orchestration, not implementation
- [ ] Handoff protocols explicit
- [ ] Context requirements specified
- [ ] No code execution required
- [ ] No prescriptive HOW instructions that belong in agent context
- [ ] Clear separation between coordination and execution

### Workflow

- [ ] All paths lead to completion
- [ ] No infinite loops possible
- [ ] Decision points clearly defined
- [ ] State management consistent
- [ ] Error recovery paths exist
- [ ] Orchestration logic separated from implementation details

## Integration Validation

- [ ] Compatible with the system architecture
- [ ] Doesn't conflict with existing skills
- [ ] Proper agent invocation protocols
- [ ] State passing mechanisms work
- [ ] Resource access appropriate

## Performance Validation

- [ ] Context window usage acceptable
- [ ] Agent transitions efficient
- [ ] No unnecessary complexity
- [ ] Response times reasonable
- [ ] Resource usage optimized

## Testing Validation

- [ ] Test cases cover main functionality
- [ ] Edge cases identified and tested
- [ ] Error conditions properly handled
- [ ] Integration tests pass
- [ ] User acceptance criteria met

## Security and Privacy Validation

- [ ] No hardcoded sensitive information
- [ ] Data handling follows best practices
- [ ] User privacy respected
- [ ] No unauthorized data access
- [ ] Audit trail maintained

## Maintenance Validation

- [ ] Change documentation complete
- [ ] Update procedures defined
- [ ] Rollback plan exists
- [ ] Monitoring points identified

## Architectural Compliance Validation

- [ ] Skill defines only orchestration layer (WHAT happens)
- [ ] No implementation methodologies prescribed (HOW it happens)
- [ ] Agent coordination clearly separated from agent execution
- [ ] Workflow logic distinct from task execution logic
- [ ] Instructions focus on sequencing and coordination, not tactics

## Atomic Skill Validation

- [ ] All referenced atomic skills exist in `${CAII_DIRECTORY}/.claude/skills/` directory
- [ ] Referenced atomic skills have `type: atomic` in YAML frontmatter
- [ ] No duplicate atomic skill functionality (each skill maps to one agent)
- [ ] Atomic skill references use pure 1:1 pattern (one agent per atomic)
- [ ] Composite skills correctly reference atomic skills with "Uses Atomic Skill:" syntax

## Composite Skill Reference Validation

> For skills that reference other composite skills (composition_depth: 1)

### Frontmatter Requirements

- [ ] `composition_depth` field present in YAML frontmatter
- [ ] `composition_depth` value is correct (0 if atomics only, 1 if composites used)
- [ ] `uses_composites` list present in YAML frontmatter
- [ ] `uses_composites` list matches actual composite references in phases

### Reference Validity

- [ ] All referenced composite skills exist in `${CAII_DIRECTORY}/.claude/skills/` directory
- [ ] Referenced composite skills have `type: composite` in YAML frontmatter
- [ ] Referenced composite skills have `composition_depth: 0` (base composites only)
- [ ] Composite skill references use "Uses Composite Skill:" syntax

### Configuration Validation

- [ ] Configuration parameters documented for each composite reference
- [ ] Configuration parameters match child skill's documented interface
- [ ] Required parameters are provided
- [ ] Parameter types and values are valid

### Context Management

- [ ] Sub-workflow mode specified (embedded/delegated) for each reference
- [ ] Context passthrough strategy defined (task_id, workflow_memory)
- [ ] Memory file namespacing prevents conflicts in embedded mode

### Dependency Validation

- [ ] No circular references (skill does not reference itself directly or indirectly)
- [ ] Depth constraint satisfied: parent can only reference depth-0 composites
- [ ] Dependency graph is acyclic

### Phase Structure

- [ ] Each phase uses EITHER atomic OR composite skills, not both
- [ ] Gate exit criteria defined for composite skill phases
- [ ] Trigger conditions documented for composite invocations

## DA.md Registration Validation

- [ ] Skill entry added to `${CAII_DIRECTORY}/.claude/DA.md` Available Skills section
- [ ] Entry placed in correct subsection (Composite Skills or Atomic Skills)
- [ ] "When to Use" section includes 5 semantic trigger examples
- [ ] Each trigger follows pattern: `**Condition:** Description → "Example utterance"`
- [ ] Entry is in alphabetical order within subsection
- [ ] Formatting matches existing skill documentation

## Final Approval

- [ ] Skill ready for development use
- [ ] Skill ready for testing
- [ ] Skill ready for production
- [ ] Documentation complete
- [ ] All stakeholders notified
- [ ] Architectural separation verified
- [ ] DA.md registration complete
- [ ] Composition depth validated (if applicable)
- [ ] Composite skill dependencies validated (if applicable)
