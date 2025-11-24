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

- [ ] Compatible with Penny's architecture
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

## Final Approval

- [ ] Skill ready for development use
- [ ] Skill ready for testing
- [ ] Skill ready for production
- [ ] Documentation complete
- [ ] All stakeholders notified
- [ ] Architectural separation verified
