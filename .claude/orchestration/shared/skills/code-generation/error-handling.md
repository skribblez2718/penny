# Error Handling for Code Generation

## Common Failure Modes

| Failure Mode | Description | Recovery Path |
|--------------|-------------|---------------|
| REQUIREMENTS_UNCLEAR | Cannot generate code without clear specifications | Invoke CLARIFICATION agent |
| TECHNOLOGY_MISMATCH | Selected technology inappropriate for requirements | Re-evaluate tech stack |
| TEST_GENERATION_FAILED | Cannot create meaningful tests from requirements | Refine requirements first |
| SECURITY_VIOLATION | Generated code has unresolvable security issues | Apply security patterns |
| COMPLEXITY_EXCEEDED | Solution too complex for requirements | Simplify or decompose |

---

## Graceful Failure Response

When code generation fails, return:

```json
{
  "status": "FAILED",
  "reason": "Failure type description",
  "recovery": "Recovery path suggestions",
  "partial_result": "Save partial progress",
  "next_agent": "CLARIFICATION"
}
```

---

## Error Prevention

### Before Generation

- [ ] Requirements are clear and testable
- [ ] Technology stack is appropriate
- [ ] Security requirements identified
- [ ] Test framework selected

### During Generation

- [ ] TDD cycle followed (RED-GREEN-REFACTOR)
- [ ] Security patterns applied
- [ ] Complexity stays manageable
- [ ] Tests remain passing

### After Generation

- [ ] All tests pass
- [ ] Coverage meets target
- [ ] Security scan clean
- [ ] Documentation complete

---

## Recovery Patterns

### Requirements Unclear

1. Note specific ambiguities
2. Document assumptions made
3. Recommend CLARIFICATION agent
4. Save partial work

### Technology Mismatch

1. Document why mismatch occurred
2. Propose alternative technology
3. Request user confirmation
4. Restart with new stack

### Security Violation

1. Identify specific vulnerabilities
2. Apply security patterns from shared
3. If unresolvable, escalate to user
4. Document security decisions
