# Secrets Management — Never expose credentials in generated code

## What

Never hardcode secrets. Use environment variables or a secrets manager. Never log, commit, or transmit secrets in plaintext.

## Why

Hardcoded secrets are the most common security finding in code reviews. A single committed API key can compromise production systems.

## Rules

1. **Use environment variables for all secrets.** `process.env.API_KEY`, not `const API_KEY = "sk-..."`.
2. **Use a `.env` file for local development.** Add `.env` to `.gitignore`.
3. **Never log secrets.** No `console.log(token)`, no `print(password)`.
4. **Never commit secrets.** Check diffs before committing. Use `.gitignore` for `.env` files.
5. **Rotate exposed secrets immediately.** If a secret is committed, revoke and rotate.

## Constraints

- **BLOCKER severity.** Any hardcoded secret must be fixed before delivery.
- **`.env.example` is the only committed env file.** Shows required variables without values.

## Verification

- [ ] No hardcoded API keys, tokens, or passwords
- [ ] All secrets read from environment variables
- [ ] `.env` in `.gitignore`
- [ ] No secrets in log statements

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/conventions.md` | Universal security rules |
