# Security Overview for Generated Code

Generated code runs with the same privileges as hand-written code, but it is produced without the contextual judgment that comes from living with a system over time. Security conventions exist to make dangerous patterns visible and impossible to ignore.

## Why Generated Code Needs Extra Security Discipline

Agents optimize for completing the stated task. They do not automatically know which data is sensitive, which inputs are untrusted, or which side effects are irreversible. That gap is where vulnerabilities appear:

- A helpful log line prints an API key.
- A quick query builds SQL from user input.
- A frontend helper renders user HTML to be "flexible."

Security rules compensate for this by encoding hard-won lessons into the generation process. The goal is not to make every agent a security expert; it is to make the safest choice the default choice.

## The Security Categories

Penny's secure-coding guidance covers ten categories. Each one addresses a different way untrusted data or misconfiguration can become an exploit.

### 1. Secrets Management

**What it is:** Handling passwords, API keys, tokens, and credentials so they are never exposed in code, logs, or version control.

**Why it matters:** A single committed secret can compromise production systems. Secrets should live in environment variables or a secrets manager, never in source files.

**The guiding principle:** If a value would let an attacker impersonate the application or access its data, it must not appear in generated code.

### 2. Injection Prevention

**What it is:** Avoiding the construction of executable strings — SQL, shell commands, LDAP queries, XML paths — from user input.

**Why it matters:** Injection is one of the most common and severe vulnerability classes. Parameterized interfaces separate code from data, which removes the attack surface entirely.

**The guiding principle:** Untrusted data is data, never code. Use the parameterized or bound API for every query and command.

### 3. Input Validation

**What it is:** Checking every external input — user form data, API payloads, files, environment variables — before using it.

**Why it matters:** Most security bugs start with unvalidated input. Schema validation at the boundary stops tainted data from propagating into business logic.

**The guiding principle:** Whitelist what is valid, reject everything else, and fail loudly rather than silently sanitizing.

### 4. Cross-Site Scripting (XSS)

**What it is:** Preventing user-controlled data from being rendered as active HTML, JavaScript, or CSS in a browser.

**Why it matters:** XSS lets attackers run scripts in a victim's browser, steal sessions, deface pages, and pivot to further attacks.

**The guiding principle:** Let the framework escape by default. If raw HTML is truly required, sanitize it explicitly and set a restrictive Content Security Policy.

### 5. Authentication

**What it is:** Verifying who a user is and protecting that verification process.

**Why it matters:** Weak authentication breaks every authorization decision downstream. Strong auth is also easy to get wrong, which is why established libraries exist.

**The guiding principle:** Use established libraries, hash passwords with bcrypt/argon2/scrypt, use secure HttpOnly cookies, rate-limit login attempts, and never leak whether the username or password was wrong.

### 6. Cryptography

**What it is:** Using encryption, hashing, randomness, and key management safely.

**Why it matters:** Cryptography is unforgiving. Deprecated algorithms, hardcoded keys, or home-grown ciphers turn confidential data into guessable data.

**The guiding principle:** Use well-reviewed libraries with safe defaults: AES-256-GCM for encryption, SHA-256 or stronger for hashing, cryptographically secure random generators, and never hardcode keys or IVs.

### 7. File Handling

**What it is:** Managing uploads, downloads, path construction, and file permissions safely.

**Why it matters:** File bugs lead to path traversal, remote code execution via malicious uploads, and information disclosure through overly permissive files.

**The guiding principle:** Resolve every path inside an allowed directory, validate upload content by type and size, and assign the most restrictive permissions that still work.

### 8. Configuration Security

**What it is:** Keeping environment-specific settings out of source code and away from clients.

**Why it matters:** Hardcoded configuration leaks environment details and can expose dev credentials in production. Debug mode, verbose errors, and permissive CORS should never ship.

**The guiding principle:** Validate configuration at startup, fail fast on missing values, and keep server-side secrets off the client.

### 9. Dependency Management

**What it is:** Choosing, pinning, and verifying the external packages the code relies on.

**Why it matters:** Supply-chain attacks and known CVEs move through dependencies. A single vulnerable package can compromise an entire application.

**The guiding principle:** Pin exact versions, use lockfiles, check for known CVEs before adding packages, and prefer the standard library over a new dependency.

### 10. API Security

**What it is:** Protecting endpoints with authentication, authorization, rate limiting, transport security, and safe headers.

**Why it matters:** APIs are the primary external attack surface. An unauthenticated or unvalidated endpoint is an open door.

**The guiding principle:** Authenticate every endpoint unless it is explicitly public, authorize per operation, rate-limit aggressively on sensitive paths, enforce HTTPS, and set security headers.

## Severity in Practice

Security rules use the same severity vocabulary as the rest of the conventions:

| Severity | Examples |
| --- | --- |
| **BLOCKER** | Hardcoded secrets, string-concatenated SQL, unescaped user HTML, `eval`, weak password hashing, path traversal. |
| **CRITICAL** | Known-vulnerable dependencies, missing input validation at a boundary, client-side exposure of server config. |
| **WARN** | Missing security headers, permissive but not exploitable defaults. |

BLOCKER issues must be fixed before delivery. CRITICAL issues must be fixed or accompanied by a documented exception. WARN issues should be addressed when practical.

## Verification, Not Good Intentions

Every security category has a verification checklist. The generation workflow requires the agent to confirm:

- No secrets in code or logs.
- No string-concatenated queries or commands.
- All external inputs validated.
- Framework escaping used for rendering.
- Strong auth and crypto defaults selected.
- Dependencies checked for known vulnerabilities.

These checks turn security from a hope into a repeatable step.

## When to Drill Deeper

This document is a high-level map. For the per-category rules and generated-code checklists, see the agent-side secure-coding index at `docs/agents/coding/security/AGENTS.md`.

The human-readable category documents are intentionally separate because the details change faster than the principles. Start here to understand the landscape; visit the category pages when you need to implement or review a specific control.
