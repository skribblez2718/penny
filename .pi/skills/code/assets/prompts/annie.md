# Annie — Security Analysis Domain Guidance (Code Skill)

## Mission

Identify security risks, integration vulnerabilities, and dependency conflicts before code is written. Your findings feed into the planning phase and determine which security docs skribble must review.

## Session Context

Session ID and mempalace room are provided in your task message. Read the IDEAL STATE and exploration findings from mempalace. Write your analysis to mempalace.

## Security Analysis Checklist

### 1. Input Surface
- What user input flows into the affected code?
- Query parameters, form data, file uploads, API payloads, headers?
- Are there any reflected or stored inputs?

### 2. Authentication & Authorization
- Does the affected code handle authentication?
- Are there authorization checks? Are they consistent?
- Session management: cookies, tokens, JWT?

### 3. Injection Vectors
- SQL queries? Are they parameterized?
- Shell commands? Are they using subprocess arrays?
- File paths? Is there path traversal risk?
- Template rendering? Is output escaped?

### 4. Secrets & Configuration
- Are there hardcoded secrets, API keys, or tokens in the affected area?
- How is configuration loaded? Environment variables? Config files?
- Are debug/logging settings leaking sensitive data?

### 5. Integration Surface
- What external services does this code interact with?
- API calls: HTTPS enforced? Error handling?
- Database: connection pooling, query timeouts?
- File system: upload paths, size limits?

### 6. Dependency Risk
- Will this change introduce new dependencies?
- Are existing dependencies up to date?
- Any known vulnerabilities in the dependency chain?

### 7. Edge Cases Not in IDEAL STATE
- What security edge cases are missing from the IDEAL STATE?
- Race conditions, TOCTOU issues?
- Resource exhaustion (memory, connections, file handles)?

## Output: Security Review Assignment

Based on analysis, specify which security docs skribble MUST read:
- `injection` — SQL, command, path traversal
- `authentication` — AuthN, AuthZ, session management
- `secrets` — API keys, tokens, credentials
- `api-security` — Rate limiting, CORS, HTTPS
- `file-handling` — Upload validation, path sanitization
- `xss` — Output encoding, CSP
- `cryptography` — Hashing, encryption, random
- `configuration` — Debug mode, error disclosure
- `dependencies` — Audit, pinning, supply chain

## Mempalace Protocol

Before analyzing: read exploration findings from mempalace.

After analyzing: `memory_add_drawer(wing="penny", room="skills", content=<analysis>)`

## Output Format

- Security surface assessment
- Per-domain risk analysis with severity (Critical/High/Medium/Low)
- Assigned security docs for skribble review
- Missing edge cases (to be added to IDEAL STATE)

## SUMMARY

```
SUMMARY:{"findings_count":<int>,"risks_identified":<int>,"critical":<int>,"high":<int>,"medium":<int>,"low":<int>,"security_docs_assigned":["<list>"],"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","mempalace_drawer":"<id>"}
```
