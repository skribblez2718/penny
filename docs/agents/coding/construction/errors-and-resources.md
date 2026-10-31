# Errors, Contracts and Resource Lifetimes

## Applies when

Designing or changing validation, assertions, error propagation, recovery, construction, resource acquisition, cleanup or cancellation.

## Distinguish failure meanings

Validate external values at their authoritative trust boundary. Use programmer assertions or invariant checks for states that valid internal code should not produce, and explicit domain outcomes for expected rejection or absence. Assertions may be disabled or have different runtime semantics; they are not authorization, user validation or a type-cast escape.

Make preconditions and postconditions close to the operation that protects them. Reject corrupt or impossible state rather than continuing with an unexplained default. The component with enough context decides recovery; propagate enough safe context for that decision. Do not catch an exception merely to lose its cause or convert it into a false success.

An exception, typed result or established error convention can each be appropriate. Choose according to whether failure is expected, how callers branch and how the language propagates it. Keep failure handling readable without moving it so far away that the effects become unclear. Standardize equivalent failures, not meaningfully different ones.

Use optionality or a neutral object only when absence is valid and its meaning survives. Do not replace a missing required value with an empty object to make the happy path look cleaner. A precheck is safe only when it is authoritative for the subsequent operation; `exists()` followed by `open()` can race, so handle the actual operation's outcome too.

For protected behavior, [Secure Error Handling](../security/error-handling.md) owns fail-closed recovery and disclosure. Read it when that boundary is affected. Removing an awkward error case must not remove security enforcement or conceal partial effects.

## Construction and behavior

Keep object graph assembly, dependency wiring and configuration at a clear construction point. Ordinary business behavior should not secretly construct a client, load configuration or select a different implementation. Use a factory when it communicates real creation policy, caching, subtype selection or shared identity; simple construction needs no ceremonial factory.

Establish object invariants before use. A required lifecycle protocol must make valid transitions and failure states visible instead of exposing half-initialized objects. Keep legitimate initialization, streaming and transaction phases explicit when a single operation cannot safely own them.

## Finish acquired resources

Define who acquires, transfers and releases each file, lock, connection, allocation, subscription or worker. Prefer structured cleanup, context managers or language-provided resource scopes. Release on success, error, timeout and cancellation, usually in reverse acquisition order when resources depend on earlier ones.

Check failure during acquisition and partial initialization. Preserve the primary failure while recording cleanup failure safely. Returning early, retrying, moving statements or converting a synchronous path to asynchronous work must not leak a resource or extend its lifetime unexpectedly. A borrowed resource must not be closed as though it were owned; a transferred resource must not be released twice.

For partial state, identify the atomic commit, rollback, compensation or repair path. Cancellation does not automatically undo external effects, and a retry does not automatically resume safely. Follow [Data Consistency](../data-systems/consistency-and-coordination.md) when writes and side effects cross transaction boundaries and [Dependency Failures](../reliability/dependencies.md) when retrying remote operations.

## Verification

Inject malformed input, expected rejection, dependency failure and failure after partial acquisition. Observe cleanup and state on normal return, early exit, exception, timeout and cancellation. Verify diagnostics retain useful internal context without disclosing secrets to callers. Check that fallback paths preserve authority and invariants, and that retries do not duplicate effects. A happy-path result alone does not establish correct recovery.
