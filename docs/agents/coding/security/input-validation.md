# Input Validation — Validate all external data at the boundary

## What

Every input from users, APIs, files, or environment must be validated before use. Reject invalid input; never sanitize and proceed silently.

## Why

Unvalidated input is the root cause of injection, buffer overflows, type confusion, and business logic bugs. Validation at the boundary prevents tainted data from propagating.

## Rules

1. **Validate at the boundary.** The first function that touches external data validates it.
2. **Use schema validation.** TypeBox (TypeScript), Pydantic (Python), Zod, Joi. Not manual `if` checks.
3. **Whitelist, not blacklist.** Define what's valid; reject everything else.
4. **Validate type, length, range, and format.** String length, number range, enum values, regex patterns.
5. **Reject invalid input with a clear error.** Never silently truncate or sanitize.

## Constraints

- **CRITICAL severity.** Unvalidated input at a security boundary must be fixed.
- **Schema validation is mandatory for API endpoints.** No manual type checking.

## Verification

- [ ] All API inputs validated with schema
- [ ] File uploads validated for type, size, and content
- [ ] Environment variables validated at startup
- [ ] Invalid input rejected with clear errors

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/injection.md` | Injection prevention |
| `docs/agents/coding/security/conventions.md` | Universal security rules |
