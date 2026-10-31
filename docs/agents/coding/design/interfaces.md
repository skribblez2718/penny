# Interfaces and Contracts

## Applies when

Designing, adding, changing, reviewing or diagnosing a public API, module interface, lifecycle protocol or caller-visible contract.

## Make the operation meaningful

Design around what callers need to accomplish rather than the implementation's internal steps. Names, arguments, results and failure behavior should reveal the abstraction. State preconditions, postconditions, invariants, side effects and required ordering where they affect correct use. Make common valid use straightforward without exposing every internal option.

Prefer meaningful typed values over ambiguous primitive bundles. Keep the surface focused on actual client needs; avoid passing an entire large collaborator merely to shorten a signature. A boolean can model an ordinary binary fact. Split a selector into named operations when it chooses genuinely different behavior and the split makes intent clearer. Do not turn this into a ban on booleans, parameters or contextual options.

Separate queries from commands when this makes effects explicit. Preserve a single atomic read-modify operation when that is its contract: splitting `withdraw_if_available()` into `balance()` followed by `withdraw()` introduces a race unless the same synchronization and transaction boundary is retained. Returning the result of a mutation is not inherently a design defect.

## Hide invalid intermediate states

Prefer construction and operations that establish invariants rather than half-valid objects callers must repair. Localize special-case normalization and shared validation. An interface may define away an unnecessary error case, but it must not turn real failure, missing authorization, corrupt data or meaningful absence into success.

Document expected absence explicitly. An optional value, result variant or neutral object is appropriate only when it preserves the meaning callers need. A missing required account is not automatically an empty account. Distinguish programmer contract violations from expected domain failures and malformed external input; assertions do not replace boundary validation.

Keep failure decisions at the level with sufficient context. Describe retry eligibility, uncertain outcomes, partial effects and cleanup when relevant. A timeout does not establish that an operation did not occur. Do not expose secrets or internal topology in public diagnostics; security requirements remain in [Secure Error Handling](../security/error-handling.md) when those boundaries are affected.

## Compatibility and consistency

Use consistent vocabulary, argument ordering, units, error conventions and lifecycle semantics for related operations. Review all consumers before changing signatures, visibility, constructors, serialization or type relationships, including generated, reflected, plugin and external uses.

Preserve a compatibility path when required: an adapter or transitional entry point can migrate callers without silently changing behavior. Removing an apparently unused public operation needs more evidence than local text search. A change in ordering, exception type, evaluation count, identity or resource lifetime may be observable even when return values are unchanged.

Do not hide network behavior behind a local-looking promise. Remote APIs must expose material latency, cancellation, retry, version-skew and partial-failure semantics. Plain request/response data can decouple policy from delivery details without inventing a parallel model for every trivial function.

## Verification

Exercise normal use, boundary inputs, invalid state, meaningful absence and failure. Test each supported caller contract and substitutable implementation. For stateful APIs, verify transitions, atomicity and cleanup on cancellation or error. Check old and new consumers when compatibility matters. A smaller interface is an improvement only if callers remain able to use it safely and understand its guarantees.
