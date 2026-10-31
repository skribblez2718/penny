# Conditions and Call Contracts

## Applies when

Restructuring decisions, loops, absence/error handling, call signatures, visibility or object creation. Apply [Safe Structural Change](safe-change.md).

## Conditional transformations

Make a decision understandable from its meaning and effects. A named predicate, an early return, grouped conditions or a direct loop exit may clarify the path; none is intrinsically better than an honest small conditional. Choose a representation a maintainer can verify from the surrounding contract.

Preserve the conditions under which work happens. Combining predicates can change short-circuiting; moving shared work outside branches can change exception or effect order; an early exit can leave a transaction, lock or cleanup scope differently. Replace a flow-control flag only when it is not itself meaningful state. Check truth tables and meaningful schedules where the equivalence is uncertain.

Use variation mechanisms when repeated decisions express a genuine behavioral distinction. An explicit state model, a supported data mapping or substitutable implementation can help, but can also add more machinery than the condition warrants. Inspect the actual cases and likely changes rather than treating a repeated switch as an automatic design verdict.

Model absence without concealing its meaning. Neutral behavior is suitable only when the absent case can honestly satisfy the caller's contract. Keep absence explicit when a caller must reject, recover or take a different action. Assertions can expose programmer invariants; they cannot replace untrusted-input validation or make an unsupported cast safe.

## Calls and public surfaces

Change a signature to clarify what the caller supplies and what the callee guarantees. Related arguments may form a real concept; unrelated values do not become cohesive by entering a parameter bag. Passing a collaborator can reduce unpacking or create excessive dependency. Deriving an argument internally can remove redundancy or introduce hidden I/O, cost, timing and ambient state. Inspect which tradeoff applies.

Represent ordinary data with parameters and distinct operations with meaningful contracts when that distinction helps. A boolean describing a binary fact need not become two methods. Conversely, a selector hiding substantially different effects may deserve explicit operations. Combine only behavior that truly differs by ordinary values, not independent rules that happen to look alike.

Separate reading from mutation when it improves predictability, but preserve atomic read-and-change operations. Checking inventory and reserving it in separate calls allows a race unless their original synchronization is retained. A mutation can legitimately return its outcome.

Names, visibility, setters and creation APIs form contracts too. Migrate real callers when changing them, and preserve required public, generated, reflected, plugin, test and stored-format uses. Removing an argument unused by the callee can still remove an effect from its call-site expression; inspect that evaluation before deleting it. Establish immutable state at construction when later mutation is invalid; retain legitimate updates through intentional operations. Use a factory for meaningful creation, caching, variant or identity policy, not as mandatory decoration around every constructor.

If a runtime type must be narrowed, validate the relevant case at the boundary that understands it. Moving an unchecked downcast behind a helper does not improve the contract. Similarly, choosing an exception or explicit result should preserve failure meaning and useful diagnostics. An expected absence may merit an explicit outcome; a precheck does not replace handling the real operation's failure when the state can change between them.

## Verification

Exercise supported callers and affected decision paths, including meaningful absence, invalid state and error propagation. Observe evaluation timing, effects and cleanup as well as returned values. Check compatibility during transitions, and test atomicity under competing calls when the contract requires it.

Adapt tests to a stable interface where appropriate without weakening their behavioral oracle. Report an intentional contract change separately instead of claiming structural equivalence for different semantics.
