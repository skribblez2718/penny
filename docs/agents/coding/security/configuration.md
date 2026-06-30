# Configuration Security — Safe config patterns for generated code

## What

Never hardcode configuration. Use environment-specific config files with sensible defaults. Never expose configuration to clients.

## Why

Hardcoded config makes code brittle and leaks implementation details. Environment-specific config prevents dev credentials from reaching production.

## Rules

1. **Use environment-specific config.** `config/development.json`, `config/production.json`. Never `if (env === 'prod')` inline.
2. **Never expose server-side config to the client.** No `NEXT_PUBLIC_*` for secrets.
3. **Use sensible secure defaults.** TLS enabled, debug mode off, verbose errors off in production.
4. **Validate config at startup.** Fail fast if required values are missing.

## Constraints

- **CRITICAL severity.** Secrets in client-side config must be fixed.
- **Debug mode must be off in production.** No stack traces in error responses.

## Verification

- [ ] No hardcoded environment-specific values
- [ ] No server-side config exposed to client
- [ ] Debug mode off in production
- [ ] Config validated at startup

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/secrets.md` | Secrets handling |
