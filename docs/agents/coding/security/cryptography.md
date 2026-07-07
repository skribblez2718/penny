# Cryptography — Safe crypto patterns for generated code

## What

Never generate custom cryptographic code. Use established libraries with safe defaults. Never use deprecated algorithms.

## Why

Cryptography is the hardest domain to get right. Even experts make mistakes with custom implementations. Generated code must use battle-tested libraries exclusively.

## Rules

1. **Use established libraries.** `cryptography` (Python), `node:crypto` (Node), Web Crypto API (browser). Never implement ciphers, hashes, or RNG from scratch.
2. **Use safe defaults.** AES-256-GCM for encryption, SHA-256 for hashing, bcrypt/argon2 for passwords.
3. **Never use deprecated algorithms.** No MD5, SHA1, DES, RC4, or ECB mode.
4. **Use cryptographically secure random.** `secrets` module (Python), `crypto.randomBytes` (Node). Never `Math.random()`.
5. **Never hardcode keys, IVs, or salts.** Generate fresh for each operation.

## Constraints

- **BLOCKER severity.** Custom crypto or deprecated algorithms must be fixed.
- **Never use ECB mode.** It leaks plaintext patterns.

## Verification

- [ ] No custom cipher/hash/RNG implementations
- [ ] AES-256-GCM for symmetric encryption
- [ ] SHA-256 or stronger for hashing
- [ ] Cryptographically secure random for all security-sensitive operations
- [ ] No MD5, SHA1, DES, RC4, or ECB

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/secrets.md` | Secrets handling |
| `docs/agents/coding/security/authentication.md` | Auth patterns |
