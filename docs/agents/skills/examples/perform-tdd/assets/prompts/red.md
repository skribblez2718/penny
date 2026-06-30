# RED Phase Prompt

Write a failing test for the specified feature.

## Context

{{context}}

## Task

Write a failing test for: **{{feature_name}}**

Test file: `{{test_file}}`

## Requirements

1. Write a test that describes the **expected behavior** of the feature
2. The test **must fail** (not implemented yet)
3. Follow the Arrange-Act-Assert pattern
4. Use descriptive test names that explain the expected behavior
5. Include edge case tests if applicable

## Current Failing Tests (if any)

{{failing_tests}}

## Output Format

Return JSON:

```json
{
  "test_file": "path/to/test_file.py",
  "failing_tests": ["test_name_1", "test_name_2"],
  "test_code": "// The test code written"
}
```

## Guidelines

- Test file should be in `tests/` directory
- Name the file `test_{feature}.py` where appropriate
- Use pytest or unittest conventions for your project
- Write **one test at a time** for initial focus
- The test should be **meaningful** - testing actual behavior
