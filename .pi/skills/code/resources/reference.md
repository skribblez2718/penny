# Code Reference

## State Machine

### States
| State | Description | Entry Action |
|-------|-------------|--------------|
| intake | Starting state | Validate input |
| working | Main work phase | Execute subagent |
| reviewing | Review results | Validate output |
| complete | Success state | Store learnings |
| error | Failure state | Log and report |

### Transitions
| Transition | From | To | Guard |
|------------|------|-----|-------|
| start | intake | working | has_goal |
| proceed | working | reviewing | work_complete |
| finish | reviewing | complete | review_approved |
| fail | working | error | error_occurred |

## Subagents Used

| Name | Purpose | Expected Output |
|------|---------|-----------------|
| echo | code-specific task | Structured SUMMARY |
| annie | code-specific task | Structured SUMMARY |
| piper | code-specific task | Structured SUMMARY |
| synthia | code-specific task | Structured SUMMARY |
| skribble | code-specific task | Structured SUMMARY |
| carren | code-specific task | Structured SUMMARY |

## Mempalace Integration

### Context Sources
- `skills/code-<session_id>` — Session-specific context

### Learning Outputs
- `penny/skills` — Session summary

## Error Handling

- Max iterations: configurable via constraints
- Error states log to stderr and mempalace
