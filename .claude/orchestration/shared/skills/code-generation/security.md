# Security Patterns for Code Generation

## OWASP Top 10 Prevention

### 1. Injection Prevention
- Use parameterized queries
- Validate all inputs
- Escape output appropriately

### 2. Broken Authentication
- Use strong password hashing (bcrypt, argon2)
- Implement MFA where appropriate
- Session management best practices

### 3. Sensitive Data Exposure
- Encrypt data at rest and in transit
- Use HTTPS everywhere
- Secure credential storage

### 4. XML External Entities (XXE)
- Disable external entity processing
- Use JSON instead of XML where possible
- Validate XML input

### 5. Broken Access Control
- Implement RBAC or ABAC
- Verify authorization on every request
- Principle of least privilege

### 6. Security Misconfiguration
- Secure default configurations
- Remove unnecessary features
- Keep dependencies updated

### 7. Cross-Site Scripting (XSS)
- Escape output by context (HTML, JS, CSS, URL)
- Use Content Security Policy
- Validate input

### 8. Insecure Deserialization
- Avoid deserializing untrusted data
- Use safe serialization formats
- Implement integrity checks

### 9. Using Components with Known Vulnerabilities
- Keep dependencies updated
- Use dependency scanning
- Monitor security advisories

### 10. Insufficient Logging & Monitoring
- Log security events
- Implement alerting
- Regular log review

## Input Validation

```python
# Always validate:
# - Type
# - Length
# - Format
# - Range
# - Business rules

def validate_input(value, constraints):
    if not isinstance(value, constraints.type):
        raise ValidationError("Invalid type")
    if len(value) > constraints.max_length:
        raise ValidationError("Input too long")
    if not constraints.pattern.match(value):
        raise ValidationError("Invalid format")
```

## Secret Management

- Never hardcode secrets
- Use environment variables or secret managers
- Rotate secrets regularly
- Audit secret access

## Code Review Security Checklist

- [ ] No hardcoded credentials
- [ ] Input validation present
- [ ] Output encoding/escaping
- [ ] Authentication/authorization checks
- [ ] Secure error handling (no stack traces to users)
- [ ] Dependencies are current
- [ ] Logging sensitive operations
- [ ] HTTPS enforced
