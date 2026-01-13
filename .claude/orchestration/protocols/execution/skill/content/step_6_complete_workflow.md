# Complete Workflow and Prompt for Learning Capture

**CRITICAL:** This step is MANDATORY. Learning capture closes the improvement loop.

## Completion Actions

### 1. Aggregate Deliverables
- Compile all agent outputs into final deliverables
- Present complete package to user
- Verify all success criteria from Step 4 are met

### 2. Review Unknown Registry
- Check workflow memory file for unresolved unknowns
- Document any remaining uncertainty
- Flag critical unresolved items for user attention

### 3. Prompt for Learning Capture

**ALWAYS use this prompt template:**

```
Would you like to capture learnings from this workflow using the develop-learnings skill?

This will extract insights and patterns from the {workflow-name} workflow to improve future executions.
Task ID: task-{task-id}
```

**User Response Handling:**
- **If user accepts:** Invoke `develop-learnings` skill with task-id
- **If user declines:** Log decision and complete workflow

### 4. Finalize Workflow
- Update workflow memory with COMPLETED status
- Record completion timestamp
- Clear working context

## Output Requirements

Report workflow completion:
```
WORKFLOW COMPLETED: task-{task-id}
DELIVERABLES: [list of outputs]
UNKNOWN STATUS: {all resolved | X unresolved}
LEARNING PROMPT: {presented to user}
FINAL STATUS: COMPLETED
```

## FAILURE CONDITION

If learning prompt is skipped, the continuous improvement loop is broken.
This is a SYSTEM-LEVEL FAILURE.

Always prompt. Always offer. Let the user decide.
