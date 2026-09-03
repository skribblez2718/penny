# Authentication

## Applies when

Code establishes, restores, or strengthens identity, including authenticators, credential verification, account recovery, MFA, passkeys, or federated identity.

## Security properties

- Identity proof is resistant to guessing, replay, and recovery abuse appropriate to the risk.
- Credential verification and recovery do not disclose account state unnecessarily.

## Requirements

- Use established, maintained authentication protocols and libraries; do not design cryptographic authentication primitives ad hoc.
- Apply rate/cost controls, generic failure responses, expiry, single-use behavior, and reauthentication for sensitive flows as appropriate.
- Treat recovery as an authentication mechanism with equivalent protection and auditability.

## Failure modes

- Treating a username lookup as proof of identity.
- Leaking account existence through response, timing, or recovery behavior.
- Moving session lifecycle or browser request integrity into this guide instead of their owners.

## Verification

- Test successful and failed login, recovery expiry/single use, enumeration resistance, MFA/passkey fallback, and reauthentication paths.
- Review provider/library configuration against current authoritative guidance.

## Related guidance

- [Session security](session-security.md) owns authenticated-state lifecycle.
- [Anti-automation](anti-automation.md), [secrets](secrets.md), and [cryptography](cryptography.md) supply related controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
