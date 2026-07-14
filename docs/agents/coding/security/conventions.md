# Secure Coding Conventions — Universal rules for generated code

## What

Every agent that generates code must apply these security rules before delivering output. These are universal — they apply regardless of language, framework, or domain.

## Why

Generated code is the highest-risk surface for security vulnerabilities. Agents lack the contextual judgment of human developers. Explicit rules prevent common injection, exposure, and configuration mistakes.

## Rules

1. **Never generate code that logs secrets.** No `console.log(token)`, no `print(password)`, no logging of API keys, tokens, or credentials.
2. **Never hardcode secrets.** Use environment variables or a secrets manager. No `const API_KEY = "sk-..."`.
3. **Never generate SQL via string concatenation.** Use parameterized queries or an ORM.
4. **Never render user input as HTML without escaping.** Use framework escaping: React's JSX, `DOMPurify`, or equivalent.
5. **Never use `eval()`, `Function()`, or `exec()`.** No dynamic code execution.
6. **Never disable security features.** No `--disable-security`, no `dangerouslySetInnerHTML` without explicit justification.
7. **Never generate code with known-vulnerable dependency versions.** Check against the latest CVE database for the ecosystem.
8. **Validate all inputs at the boundary.** Every external input (user, API, file) must be validated before use.

## Severity

| Severity | Meaning | Action |
|----------|---------|--------|
| **BLOCKER** | Rule 1-6 violation | Must fix before delivery |
| **CRITICAL** | Rule 7-8 violation | Must fix or document exception |
| **WARN** | Best practice deviation | Should fix; document if deferred |

## Constraints

- **These rules apply to ALL generated code.** No exceptions for "quick scripts" or "prototypes."
- **Agents must verify compliance before returning SUMMARY.** The frame's What Done Requires contract enforces this — a compliance claim without evidence is an unverified claim.

## Verification

- [ ] No secrets in generated code
- [ ] No string-concatenated SQL
- [ ] No unescaped user input in HTML
- [ ] No `eval()` or dynamic code execution
- [ ] Inputs validated at boundaries

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/injection.md` | Injection-specific rules |
| `docs/agents/coding/security/xss.md` | XSS-specific rules |
| `docs/agents/coding/security/authentication.md` | Auth-specific rules |
| `docs/agents/coding/security/secrets.md` | Secrets handling |
| `docs/agents/coding/security/input-validation.md` | Input validation |
