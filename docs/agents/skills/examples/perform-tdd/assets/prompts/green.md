# GREEN Phase Prompt

Make the failing tests pass with minimal implementation.

## Task

Make tests pass for: **{{feature_name}}**

Test file: `{{test_file}}`

## Failing Tests

{{failing_tests}}

## Requirements

1. Write the **minimum implementation** to make tests pass
2. Don't worry about perfect code - we'll refactor next
3. Hard-coding is acceptable for now
4. Focus on making tests green, not elegance

## Implementation Location

Choose an appropriate location for the implementation:

- `src/{feature}.py` for new modules
- Update existing files if extending functionality
- Follow project structure conventions

## Output Format

Return JSON:

```json
{
  "impl_file": "path/to/implementation.py",
  "remaining_failures": ["test_name", ...],
  "passing_tests": ["test_name", ...],
  "implementation_summary": "Brief description of implementation"
}
```

## Guidelines

- **YAGNI**: You Aren't Gonna Need It - don't add extra features
- **Simple design**: Choose the simplest solution that works
- **No premature optimization**: Make it work first
- **No extra abstractions**: Keep it direct
