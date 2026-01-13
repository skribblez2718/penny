# Error Handling and Recovery

## Cognitive Function Failures

When agent cannot complete cognitive function:

### Steps

1. **Document** specific failure in Johari "blind" section
2. **Add** to Unknown Registry with `resolution_phase`
3. **Suggest** alternative cognitive path
4. **Request** orchestrator intervention if critical

### Failure Output Format

```json
{
  "failure_type": "COGNITIVE_FUNCTION_FAILURE",
  "function_attempted": "{function_name}",
  "failure_reason": "{specific reason}",
  "recovery_suggestion": "{alternative path}",
  "critical": true/false,
  "unknown_registered": "U{N}: {description}"
}
```

---

## Domain Adaptation Failures

When domain is unclear or hybrid:

### Steps

1. **Default** to most conservative domain
2. **Document** ambiguity in output
3. **Request** CLARIFICATION agent intervention
4. **Apply** multiple domain criteria if needed

### Domain Ambiguity Output

```json
{
  "failure_type": "DOMAIN_AMBIGUITY",
  "possible_domains": ["domain1", "domain2"],
  "default_selected": "most_conservative",
  "clarification_needed": true,
  "applied_criteria": ["criteria from domain1", "criteria from domain2"]
}
```

---

## Context Loading Failures

When required context files are missing:

### Steps

1. **Report** missing file immediately
2. **Do NOT** proceed without required context
3. **Fail loudly** - do not guess or assume
4. **Request** orchestrator to verify workflow state

---

## Recovery Paths

| Failure Type | Recovery Action |
|--------------|-----------------|
| Cognitive function blocked | Try alternative function or escalate |
| Domain unclear | Default conservative + request clarification |
| Context missing | Fail immediately, report to orchestrator |
| Token budget exceeded | Compress outputs, retry |
| Quality gate failed | Iterate with focused improvement |
