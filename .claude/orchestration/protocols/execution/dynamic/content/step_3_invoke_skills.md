# Invoke Skills in Sequence

Execute each orchestrate-* skill from your Step 2 sequence using the Skill tool.

## Action Required

You must NOW invoke each skill in your planned sequence. This is not documentation - this is an action step.

### Skill Invocation

For each skill in your Step 2 sequence:

```
Skill(skill="orchestrate-{name}")
```

### Skill to Agent Mapping

| Skill | Agent |
|-------|-------|
| orchestrate-clarification | clarification |
| orchestrate-research | research |
| orchestrate-analysis | analysis |
| orchestrate-synthesis | synthesis |
| orchestrate-generation | generation |
| orchestrate-validation | validation |

### Execution Order

1. Invoke the first skill in your sequence
2. Wait for it to complete (memory file will be created)
3. Invoke the next skill
4. Repeat until all skills are invoked
5. Proceed to Step 4 to verify completion

### Output Tracking

After each skill invocation, note:
- Which skill was invoked
- Whether it completed successfully
- Any errors encountered
