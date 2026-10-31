# Routines, Control Flow and State

## Applies when

Creating, changing, reviewing or diagnosing routine bodies, parameters, data representation, mutable state, conditionals, loops or concurrency behavior.

## Cohesive routines and visible effects

Give a routine one coherent purpose and an interface that reveals its action or result. Keep abstraction levels understandable: separate policy from incidental parsing or wiring where that makes the path clearer. Setup, validation, computation and I/O may deserve separate operations, but do not fragment one invariant into shallow steps callers must coordinate.

Keep parameters meaningful and dependencies explicit. A parameter object is useful for a recurring concept with related validation, not a bag hiding unrelated arguments. Passing a whole object may simplify a call or unnecessarily couple the callee to a large collaborator. Deriving an argument inside the callee is appropriate only when it does not hide surprising I/O, ambient state or cost.

Distinguish ordinary data flags from selectors for different behaviors. Named operations or modeled states can clarify a confusing mode switch; a straightforward boolean may be the clearest representation of a true binary fact. Make output-parameter and mutation conventions explicit when the language legitimately uses them.

Prefer query/command separation for predictable effects, not at the expense of atomicity. An operation that checks a balance and debits it atomically must not become a race-prone check followed by a write. Preserve transaction, synchronization and caller-visible result semantics.

## Model the data

Choose types that express valid states and reject ambiguity. Make units, range, precision, encoding, nullability and ownership clear at the affected boundary. Name meaningful limits and sentinel values; identical numeric literals do not necessarily represent the same concept. Do not introduce constants for obvious local syntax merely to eliminate every literal.

Initialize deliberately, keep scope and lifetime narrow, and separate variables that acquire different meanings. Preserve an intentional accumulator. Avoid reusing loop counters or scratch variables across unrelated work. Use immutable values or controlled mutation where they simplify invariants; broad setters and exposed mutable collections often let callers bypass those invariants.

Use a closed state model when its valid alternatives are intentionally exhaustive at that boundary. For extensible or versioned input, model permitted unknown or extension cases explicitly without accepting values the contract forbids. Arrays suit homogeneous sequences; named records suit fixed positions with different meanings. Value objects need deliberate equality, validation and serialization, while entity objects may need stable identity and shared updates. Do not wrap a primitive unless the wrapper adds meaning, safety or behavior.

## Control flow a reader can verify

Keep dependencies before use and related statements together. Prefer direct conditions and named predicates over complicated boolean algebra. A positive condition often reads better, but negation can be the honest expression of an absence or failure case. Keep the normal path discoverable.

Use guard clauses when early exits simplify exceptional paths. Preserve required transaction, lock and cleanup scope: moving a return outside a `finally` or resource manager is not a cosmetic change. Conditions with side effects cannot be freely reordered, combined or hoisted.

Give loops clear initialization, progress and termination. Check empty collections, bounds, off-by-one cases and mutation during iteration. Make exits and recursive progress explicit. Replace a control flag with direct flow only if it is not a meaningful persistent state. Delete unreachable branches after checking assumptions, not by suppressing a diagnostic.

A stable, explicit mapping can be clearer as validated data than repeated branching. Keep a simple conditional when a table or polymorphic hierarchy adds more interpretation cost. Do not encode changing world knowledge or opaque control flow in an unreviewable table.

For an uncertain complex routine, a sketch, example, pseudocode or contract can clarify the algorithm. Use the lightest aid that resolves the uncertainty and retain only useful explanatory comments; none is a mandatory methodology.

## Shared state and concurrency

Introduce concurrency for an actual latency, throughput or isolation need; sequential code may be sufficient. Understand the execution model before changing it. When introducing or diagnosing concurrency, check ordinary sequential behavior separately when that helps distinguish functional defects from scheduling or coordination defects. Sequential success does not establish concurrency safety. Prefer immutable messages, isolated state or explicit synchronization over ambient shared mutation. Separate scheduling policy from the computation when it improves testing and tunability.

Keep the critical section no larger than necessary but large enough to preserve the whole invariant. Individually synchronized methods do not make their composition atomic. Specify cancellation, shutdown, ordering, resource cleanup and what happens when a collaborator is slow. Do not hold scarce connections or locks across unrelated remote work without a justified contract.

## Verification

Test routine results and effects for normal, boundary, empty and invalid inputs. Cover meaningful state transitions, data-driven cases and error paths. For concurrency-sensitive changes, exercise relevant interleavings and levels of parallelism; unexplained intermittent failures may be races. Check evaluation order and count when extracting or inlining expressions, especially clocks, randomness, I/O and mutable reads. Use [Errors and Resources](errors-and-resources.md) when those paths change and [Data Consistency](../data-systems/consistency-and-coordination.md) when the invariant spans durable or distributed state.
