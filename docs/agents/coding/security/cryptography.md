# Cryptography

## Applies when

Selecting or using encryption, signatures, password hashing, randomness, key derivation, or key lifecycle.

## Security properties

- Cryptographic purpose, protocol, parameters, randomness, key custody, rotation, revocation, and migration are fit for the actual threat model.
- Custom cryptography does not become a hidden security boundary.

## Requirements

- Use current, established protocols and well-maintained libraries; select primitives by purpose instead of a universal recipe.
- Use cryptographically secure randomness where security requires unpredictability; handle nonces/IVs, authentication, serialization, interoperability, rotation, and migration according to the selected primitive.
- Document key ownership, storage, access, backup/recovery, revocation, and compatibility expectations.

## Failure modes

- Implementing ciphers, signature schemes, password hashing, or randomness from scratch.
- Reusing nonces/IVs, static keys, or a generic hash where password hashing or authenticated encryption is required.
- Treating an algorithm name as a complete key-management design.

## Verification

- Use known-answer/interoperability tests where applicable and test failure, rotation, revocation, and migration paths.
- Verify library/version and parameter choices against current primary guidance.

## Related guidance

- [Secrets](secrets.md) owns secret lifecycle.
- [Authentication](authentication.md) owns identity proof; [security verification](security-verification.md) selects evidence.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
