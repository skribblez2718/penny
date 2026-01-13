# Plan Skill Sequence

Determine the order of orchestrate-* skill invocations.

## Instructions

Based on the cognitive functions identified in Step 1, plan the sequence
of orchestrate-* skill invocations.

### Sequencing Principles

1. **Dependency Order**
   - Skills must be ordered by their output→input dependencies
   - Clarification outputs feed Research inputs
   - Research outputs feed Analysis inputs
   - Analysis outputs feed Synthesis inputs
   - Synthesis outputs feed Generation inputs
   - Generation outputs feed Validation inputs

2. **Context Preservation**
   - Each skill writes its output to a memory file
   - Next skill reads the previous skill's memory file
   - Memory file path format: `{task_id}-{skill}-memory.md`

3. **Skip Conditions**
   - If a function was marked optional in Step 1, include skip condition
   - Skill can be skipped if skip condition is met at runtime

### Common Sequences

| Task Type | Typical Sequence |
|-----------|------------------|
| Research task | clarification → research → synthesis |
| Analysis task | analysis → synthesis → validation |
| Development task | clarification → research → analysis → synthesis → generation → validation |
| Simple task | generation → validation |

### Output Requirements

Produce a concrete sequence plan:

```
SKILL SEQUENCE PLAN
===================

1. orchestrate-{first}: {reason}
   - Skip if: {condition or "never"}
   - Reads: {input source}
   - Writes: {output destination}

2. orchestrate-{second}: {reason}
   - Skip if: {condition or "never"}
   - Reads: {previous output}
   - Writes: {output destination}

[continue for all skills...]

SEQUENCE COMPLETE
```

## Important Notes

- NEVER invoke agents directly - always through orchestrate-* skills
- Each skill in the sequence uses the Task tool with the appropriate subagent_type
- If uncertain about sequence, default to: clarification → research → analysis → synthesis
