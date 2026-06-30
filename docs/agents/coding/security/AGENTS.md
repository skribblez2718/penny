# Secure Coding Feature Index

- [Conventions](conventions.md): Universal pre-generation rules, severity legend, and usage guidance
- [secrets.md](secrets.md): Passwords, API keys, tokens, env vars, credential storage (CWE-798, CWE-259 — Critical)
- [injection.md](injection.md): Database queries, shell commands, user input in queries (CWE-89, CWE-78, CWE-90, CWE-643 — Critical)
- [xss.md](xss.md): HTML output, templates, frontend rendering (CWE-79 — Critical)
- [authentication.md](authentication.md): User auth, sessions, JWT, OAuth, MFA, password hashing (CWE-287, CWE-327, CWE-384 — Critical)
- [cryptography.md](cryptography.md): Encryption, hashing, randomness, key management (CWE-326, CWE-330 — High)
- [input-validation.md](input-validation.md): Input forms, type checking, length limits, regex, sanitization (CWE-20 — High)
- [configuration.md](configuration.md): Config files, env vars, debug mode, security headers, CORS, error messages (CWE-16, CWE-215, CWE-209 — Medium–High)
- [dependencies.md](dependencies.md): Package management, imports, dependency verification (CWE-1357 — Critical)
- [api-security.md](api-security.md): API endpoints, rate limiting, authz, IDOR, data exposure (CWE-770, CWE-200, CWE-915 — High)
- [file-handling.md](file-handling.md): File uploads, path handling, permissions, temp files (CWE-22, CWE-434, CWE-377 — High)
