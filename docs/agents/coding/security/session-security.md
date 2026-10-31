# Session Security

## Applies when

Code creates, stores, transports, rotates, expires, revokes, or validates authenticated state.

## Security properties

- Authenticated state is verifiable by the authoritative component (server-side in client/server systems), scoped, protected in transit and storage, rotated when risk changes, and revocable.
- Session state cannot be fixed, replayed, or extended outside documented policy.

## Requirements

- Use established framework/session mechanisms; set cookie attributes and storage according to the selected architecture and current browser guidance.
- Rotate identifiers after authentication and relevant privilege changes; define idle and absolute expiry, logout, and revocation at the authoritative component, server-side in client/server systems.
- Keep bearer material and server secrets out of client-visible storage unless the explicit architecture and threat model justify it.

## Failure modes

- Treating client storage as a secure session vault.
- Failing to rotate or revoke after privilege changes, compromise, or logout.
- Using SameSite as the only state-transition protection.

## Verification

- Test fixation, rotation, expiry, revocation, logout, privilege changes, and transport/storage attributes.
- Test that a revoked or expired session cannot reach protected operations.

## Related guidance

- [Authentication](authentication.md) owns identity proof.
- [CSRF](csrf.md) protects browser state transitions; [configuration](configuration.md) owns trusted-proxy and runtime policy.
