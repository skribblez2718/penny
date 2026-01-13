# Generate Task ID

Generate a unique task identifier for this workflow.

## Task ID Format

**Pattern:** `task-<descriptive-keywords>`

**Validation Rules:**
- Length: 5-40 characters
- Characters: lowercase letters, numbers, dashes only
- Must start with "task-"
- Must be descriptive of the task

## Examples

| User Request | Task ID |
|--------------|---------|
| "Implement OAuth2 authentication" | `task-oauth2-auth` |
| "Help me decide on career change" | `task-career-decision` |
| "Write a creative story about AI" | `task-ai-story` |
| "Build a REST API for users" | `task-user-api` |

## Output Requirements

Generate and output:
1. The task-id following the format above
2. Brief justification for the chosen keywords

**Format your response as:**
```
TASK-ID: task-{your-keywords}
JUSTIFICATION: {brief explanation of keyword choice}
```
