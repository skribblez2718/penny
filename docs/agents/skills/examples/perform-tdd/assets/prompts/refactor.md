# REFACTOR Phase Prompt

Improve code quality while keeping tests green.

## Task

Refactor implementation for: **{{feature_name}}**

Implementation: `{{impl_file}}`
Tests: `{{test_file}}`

## Requirements

1. Improve code quality while keeping tests passing
2. Run tests after each refactoring step
3. Commit to meaningful improvements, not just changes

## Refactoring Checklist

Choose applicable refactorings:

- [ ] Extract method/function for clarity
- [ ] Remove duplication (DRY)
- [ ] Improve naming
- [ ] Simplify conditionals
- [ ] Extract class/module for cohesion
- [ ] Apply design patterns where beneficial

## Output Format

Return JSON:

```json
{
  "changes": ["Extracted TokenManager class", "Improved password hashing method"],
  "needs_more_tests": false,
  "suggestions": [
    "Consider adding refresh token pattern",
    "Password strength validation could be extracted"
  ],
  "all_tests_still_passing": true
}
```

## Guidelines

- **Keep tests green**: Never break passing tests
- **Small steps**: Refactor incrementally
- **Run tests frequently**: Verify after each change
- **Meaningful changes**: Only change what improves the code
- **Be honest**: If refactoring revealed missing tests, set `needs_more_tests: true`
