# Authorization

## Applies when

Code decides whether a subject may perform an action or access an object, field, relationship, tenant, or administrative capability.

## Security properties

- Every protected decision uses subject, action, object, and contextual authorization at the authoritative execution boundary. In client/server systems this is server-side, never delegated to client claims.
- Object and property access is denied by default and cannot be granted by client-supplied identity or ownership claims.

## Requirements

- Authorize every route and secondary access path, including search, export, history, nested relationships, bulk operations, and background work.
- Use allowlisted writable fields and re-check authority at the system that executes the action.
- Choose error behavior that does not unnecessarily disclose protected object existence.

## Failure modes

- Equating authentication with authorization.
- Checking only a route while leaving object, relationship, or property access unchecked.
- Trusting client-provided roles, tenant IDs, ownership IDs, or UI visibility.

## Verification

- Exercise owner, non-owner, anonymous, privileged, and malformed/nonexistent object cases for each protected operation.
- Test mass-assignment and alternate-route access paths.

## Related guidance

- [Authentication](authentication.md) establishes identity.
- [API security](api-security.md) owns interface composition; [session security](session-security.md) owns state lifecycle.
