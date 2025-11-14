SKILL VALIDATION CHECKLIST

CRITICAL ARCHITECTURAL PRINCIPLE
This checklist ensures skills properly define the orchestration layer (WHAT) and do not prescribe implementation details (HOW)
Skills must coordinate agent activities without dictating their execution methodologies

METADATA VALIDATION
- Skill name follows kebab-case convention
- Version number follows semantic versioning (x.y.z)
- Description is clear and concise
- Author information present
- Tags are relevant and searchable
- Status accurately reflects development state
- Complexity level correctly assigned

STRUCTURE VALIDATION
- SKILL.md exists in correct location
- All referenced resources exist
- Directory structure follows standards
- No unnecessary files present
- File permissions appropriate

CONTENT VALIDATION

DOCUMENTATION
- Purpose clearly stated
- All sections complete
- Examples provided and functional
- Error cases documented
- Dependencies listed

AGENT CONFIGURATION
- All agents properly defined with WHAT they accomplish
- Instructions clear and unambiguous about orchestration, not implementation
- Handoff protocols explicit
- Context requirements specified
- No code execution required
- No prescriptive HOW instructions that belong in agent context
- Clear separation between coordination and execution

WORKFLOW
- All paths lead to completion
- No infinite loops possible
- Decision points clearly defined
- State management consistent
- Error recovery paths exist
- Orchestration logic separated from implementation details

INTEGRATION VALIDATION
- Compatible with Penny's architecture
- Doesn't conflict with existing skills
- Proper agent invocation protocols
- State passing mechanisms work
- Resource access appropriate

PERFORMANCE VALIDATION
- Context window usage acceptable
- Agent transitions efficient
- No unnecessary complexity
- Response times reasonable
- Resource usage optimized

TESTING VALIDATION
- Test cases cover main functionality
- Edge cases identified and tested
- Error conditions properly handled
- Integration tests pass
- User acceptance criteria met

SECURITY AND PRIVACY VALIDATION
- No hardcoded sensitive information
- Data handling follows best practices
- User privacy respected
- No unauthorized data access
- Audit trail maintained

MAINTENANCE VALIDATION
- Version history maintained
- Change documentation complete
- Update procedures defined
- Rollback plan exists
- Monitoring points identified

ARCHITECTURAL COMPLIANCE VALIDATION
- Skill defines only orchestration layer (WHAT happens)
- No implementation methodologies prescribed (HOW it happens)
- Agent coordination clearly separated from agent execution
- Workflow logic distinct from task execution logic
- Instructions focus on sequencing and coordination, not tactics

FINAL APPROVAL
- Skill ready for development use
- Skill ready for testing
- Skill ready for production
- Documentation complete
- All stakeholders notified
- Architectural separation verified