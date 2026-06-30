# Security Review Checklist

Mandatory before writing any code. skribble MUST review applicable sections based on task domain.

## How to Use
1. annie identifies security domains relevant to the task during `analyze` state
2. skribble reads this checklist + relevant `docs/agents/secure-coding/` docs before `implement`
3. carren verifies compliance in `learn` state

## Pre-Code Security Gates

### 1. Input Validation
- All user input is validated and sanitized
- File uploads have size limits and type restrictions
- Query parameters and form data are validated before use
- See: `docs/agents/secure-coding/input-validation.md`

### 2. Injection Prevention
- SQL: parameterized queries only (no string concatenation)
- Command: use subprocess arrays, never shell=True with user input
- Path traversal: validate and sanitize file paths
- See: `docs/agents/secure-coding/injection.md`

### 3. Authentication & Authorization
- Authentication checks before any protected operation
- Authorization per-endpoint or per-function
- Session tokens use secure, httpOnly, SameSite cookies
- See: `docs/agents/secure-coding/authentication.md`

### 4. Secrets Management
- NO hardcoded secrets, API keys, tokens, or passwords
- Use environment variables or secrets manager
- .env files in .gitignore
- See: `docs/agents/secure-coding/secrets.md`

### 5. API Security
- Rate limiting on authentication endpoints
- CORS configured explicitly (no wildcard origins)
- HTTPS enforced for all external endpoints
- See: `docs/agents/secure-coding/api-security.md`

### 6. Cryptography
- Use standard libraries (cryptography, hashlib, bcrypt)
- Never implement custom crypto
- Passwords: bcrypt/argon2 with appropriate work factor
- See: `docs/agents/secure-coding/cryptography.md`

### 7. XSS Prevention (Frontend)
- Output encoding for all user-generated content
- Content-Security-Policy headers
- No innerHTML with user data
- See: `docs/agents/secure-coding/xss.md`

### 8. File Handling
- Validate file types (magic bytes, not just extension)
- Store uploads outside web root
- Limit file sizes
- See: `docs/agents/secure-coding/file-handling.md`

### 9. Configuration
- Production config separate from development
- Debug mode OFF in production
- Error messages don't leak internals
- See: `docs/agents/secure-coding/configuration.md`

### 10. Dependencies
- No known vulnerabilities in added packages
- Pin dependency versions
- Regular audit (`pip-audit`, `bun audit`)
- See: `docs/agents/secure-coding/dependencies.md`
