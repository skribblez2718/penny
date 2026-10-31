# Local Extraction, Inlining and Movement

## Applies when

Reshaping expressions, routines, algorithms or local module boundaries, including moving state and behavior or changing delegation. Apply [Safe Structural Change](safe-change.md).

## Expressions and routines

Choose boundaries that expose meaning without hiding effects. Naming an expression or extracting a routine can reduce the facts a reader must hold at once. Inlining can remove indirection whose contract adds nothing. Decide from the surrounding code rather than preferring either direction categorically.

Trace inputs, outputs and mutations across the proposed boundary. Keep temporary state local when possible; make a value needed by later work explicit. Separate a variable that has acquired unrelated meanings, but retain an intentional accumulator. Reassigning an input may obscure its original meaning; a local value can clarify it, provided reference/output-parameter semantics remain intact.

Moving an expression changes when and how often it executes. Check short-circuiting, exceptions, clocks, randomness, I/O, mutable reads and expensive computation. A cached result is not necessarily equivalent to a repeated query. A descriptive name can be useful even when substitution would be syntactically shorter.

For example, capturing a request identifier once and reusing it is different from calling an identifier generator at each use. Likewise, evaluating a query before an early return may introduce work that previously never happened. Verify the relevant observations, not merely the final returned value.

When intertwined algorithm state prevents a useful extraction, a dedicated per-invocation object may make that state manageable. Compare this with simpler local restructuring; do not introduce a class merely to satisfy a technique. For algorithm replacement, establish equivalence at edge cases and preserve required numerical, ordering, failure and performance properties.

## Move responsibilities without leaking internals

Place a decision where its inputs and invariant can be understood together. Moving a routine, a coherent fragment or its state can reduce exposure of another component's representation. Do not justify the move solely by access counts, and do not widen visibility merely to make it compile. Check the resulting dependency direction and whether intentionally interchangeable behavior still remains independent.

Extract a component when it creates a meaningful responsibility; absorb one when its extra boundary no longer helps. Migrate construction, initialization and callers consistently. Transitional delegation can preserve compatibility during movement, but should not become permanent unexplained forwarding. Removing delegation is safe only when the direct dependency does not bypass policy or protection.

Treat state movement as a lifecycle change to investigate, not a field relocation alone. Initialization, aliases, serialized shape, resource release and relationships may depend on its current location. Avoid creating competing authoritative copies during the transition.

For code outside the project’s control, a narrow integration operation may be enough. A larger local extension needs a coherent purpose, supported construction and evidence against the external contract. Preserve useful isolation without wrapping every operation by default.

## Checks that matter

Inspect actual consumers, dispatch/override behavior and construction paths before changing or removing entry points. Text search can miss dynamic uses. Select tests or comparisons that observe the affected calls, mutations, ordering and lifetime, and exercise the real integration seam when its behavior matters.

Keep necessary dependency and compatibility constraints intact. If the new structure makes callers coordinate more state, creates a cycle or merely moves the original confusion, reconsider the boundary rather than completing the planned move for its own sake.
