# Create Memory File with Domain Context

**CRITICAL:** This step is MANDATORY. Workflow metadata MUST exist before invoking ANY agent.

## Memory File Location

Create: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`

## Required Sections

The memory file MUST contain these sections:

### WORKFLOW METADATA
```markdown
# WORKFLOW METADATA
## Task ID: task-{task-id}
## Workflow: {skill-name or cognitive-orchestration}
## Task Domain: {domain from Step 2}
## Start Date: {current date YYYY-MM-DD}
```

### CRITICAL CONSTRAINTS
Domain-specific constraints and technical requirements.

### QUALITY STANDARDS
Domain-appropriate quality criteria for agents to apply.

### ARTIFACT TYPES
Expected outputs (code, docs, plans, etc.).

### SUCCESS CRITERIA
Measurable completion criteria.

### UNKNOWN REGISTRY
```markdown
## UNKNOWN REGISTRY
### Active Unknowns
[Initially empty - agents populate as unknowns discovered]

### Resolved Unknowns
[Initially empty - moved from Active when resolved]
```

### PHASE HISTORY
```markdown
## PHASE HISTORY
[Initially empty - updated after each agent completes]
```

### CURRENT CONTEXT
```markdown
## CURRENT CONTEXT
### Current Phase
- **Phase Number**: 0
- **Phase Name**: Initialization
- **Status**: PENDING
```

## Verification

After creating the file, verify:
1. File exists at correct path
2. All required sections present
3. Task domain correctly classified
4. Success criteria defined

**FAILURE CONDITION:** If this file is missing or incomplete, agents WILL FAIL.

## Output Requirements

Create the memory file and output:
```
MEMORY FILE CREATED: ${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md
SECTIONS VERIFIED: [list of sections]
STATUS: READY FOR AGENT INVOCATION
```
