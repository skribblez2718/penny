# Authentication — Secure auth patterns for generated code

## What

Never generate code with weak authentication. Use established libraries, never roll your own crypto. Apply these rules to every auth-related code path.

## Why

Authentication failures are the highest-impact security bugs. A single weak password reset flow or missing session validation can compromise the entire system.

## Rules

1. **Use established auth libraries.** Passport.js, NextAuth, Django auth, Flask-Login. Never implement auth from scratch.
2. **Hash passwords with bcrypt, argon2, or scrypt.** Never MD5, SHA1, or plaintext.
3. **Use secure session management.** HttpOnly, Secure, SameSite=Strict cookies. Never store sessions in localStorage.
4. **Rate-limit auth endpoints.** Throttling login/reset/token attempts is mandatory; make the limit a configurable knob with a sane default (e.g. ~5/min per account). The control is required; the exact number is deployment-tunable, not fixed law.
5. **Use multi-factor where possible.** TOTP or WebAuthn for sensitive operations.
6. **Never expose whether username or password was wrong.** "Invalid credentials" — not "user not found" vs "wrong password."

## Constraints

- **BLOCKER severity.** Weak auth must be fixed before delivery.
- **Never generate password reset without token expiry.** Reset tokens must be short-lived and single-use; the exact TTL is a configurable default (e.g. ~1 hour), not a fixed law.

## Verification

- [ ] Passwords hashed with bcrypt/argon2/scrypt
- [ ] Sessions use HttpOnly + Secure + SameSite cookies
- [ ] Rate limiting on login endpoints
- [ ] Generic error messages on auth failure
- [ ] Password reset tokens expire

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/secrets.md` | Secrets handling |
| `docs/agents/coding/security/conventions.md` | Universal security rules |
