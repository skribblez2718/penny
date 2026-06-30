# DOCUMENT Phase Prompt

Add documentation to the implementation.

## Task

Document feature: **{{feature_name}}**

Implementation: `{{impl_file}}`
Tests: `{{test_file}}`

## Requirements

1. Add comprehensive docstrings to public APIs
2. Update README if adding new functionality
3. Add inline comments for complex logic
4. Document any configuration or environment variables

## Documentation Checklist

- [ ] Module-level docstring
- [ ] Class docstrings with examples
- [ ] Function/method docstrings (args, returns, raises)
- [ ] README updates (if new feature)
- [ ] API documentation (if public API)
- [ ] Usage examples

## Output Format

Return JSON:

```json
{
  "docs_updated": ["src/auth.py", "README.md"],
  "docstrings_added": 5,
  "readme_sections": ["## Authentication"],
  "api_documented": true
}
```

## Guidelines

- **Clear and concise**: Documentation should be easy to understand
- **Show examples**: Include usage examples in docstrings
- **Document intent**: Explain _why_, not just _what_
- **Keep up to date**: Remove outdated documentation
