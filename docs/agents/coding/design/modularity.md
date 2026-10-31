# Modularity and Complexity

## Applies when

Designing, changing, reviewing or diagnosing decomposition, shared abstractions, module responsibilities or a change that spreads across several places.

## Judge the reader's work

Complexity appears as change amplification, many facts needed at once, hidden dependencies, surprising special cases and requirements a caller cannot discover from the interface. Ask which knowledge a change touches and how far that knowledge is spread. Fewer lines or smaller files do not establish a simpler design.

Prefer a **deep module**: a small, meaningful interface hiding substantial implementation work. A wrapper that merely renames an operation may add navigation without hiding anything. Keep it when it protects a real policy, compatibility seam, trust boundary or volatile dependency; remove or avoid it when callers must still understand the underlying mechanism.

Put a decision in the module that understands it. Hide representation, normalization, storage formats, protocol quirks, bookkeeping and optimization details there. A somewhat more complex implementation can be worthwhile if it removes repeated reasoning from every caller. Do not move complexity downward when the lower component lacks the information or authority to decide correctly.

## Split or combine by knowledge

Split when responsibilities change independently, a boundary hides a volatile decision, or each part becomes independently understandable. Combine when fragments share an invariant and separating them forces callers to coordinate intermediate state or jump through shallow helpers. Keep related state and behavior together unless separation supports a concrete need, such as interchangeable algorithms or a plain boundary-data model.

Execution order alone is usually a weak module boundary. `prepare`, `process` and `finalize` may expose a hidden protocol rather than a stable concept. Prefer an operation that manages the lifecycle internally when it can do so safely. Explicit phases remain useful when transactions, streaming, external protocols or resource lifetimes genuinely require them; document valid states and transitions.

Generalize around a real concept, not imagined callers. A slightly more general interface may remove special cases without becoming a framework. Conversely, one caller does not automatically make an abstraction wrong: a strong boundary can localize complexity for that caller. Compare the abstraction's maintenance and navigation cost with the coupling it actually removes.

## Knowledge duplication and independence

DRY concerns repeated **knowledge**, not similar text. A rule, calculation, status meaning or configuration contract should have a clear authoritative representation; derive or check dependent representations where practical. Security checks at distinct trust boundaries may intentionally repeat enforcement while sharing the same policy meaning.

Do not merge code merely because it currently looks alike. Independently changing use cases may become harder to change if forced through one abstraction. Repeated changes that must stay synchronized are stronger evidence for centralization than a count of occurrences. A shared `common` package is not a solution if it creates sideways coupling or mixes unrelated decisions.

Prefer orthogonal components: changing one concern should not unexpectedly alter another. Watch globals, ambient context, shared mutable state, cycles and objects that expose collaborator internals. Reduce collaborator knowledge without introducing a forwarding layer that only moves the dependency out of sight.

## Design work within scope

For a consequential uncertain choice, compare plausible approaches using caller knowledge, hidden decisions, special cases, compatibility and likely change cost. The comparison need not follow a fixed template or contain a prescribed number of alternatives. Sketching an interface contract or explanatory comment can expose a confused abstraction before implementation; simplify the design if its explanation requires callers to understand internals.

Treat recurring friction as evidence, not permission for a rewrite. Improve the boundary needed by the authorized change. Report broader debt rather than automatically fixing every nearby problem. Patterns, paradigms and frameworks earn their cost through a concrete benefit; fashion, test convenience and existing machinery are not sufficient reasons to keep or add them.

## Verification

Trace a representative change and a normal caller through the proposed boundary. Check whether a volatile decision is localized, invalid intermediate state stays hidden, and callers need fewer facts. Test observable contracts and isolated special cases without forcing tests to depend on hidden representation. Use measurements before trading information hiding for performance; keep necessary optimization details behind the contract.

For public operation semantics, use [Interfaces and Contracts](interfaces.md). Architectural dependency direction and boundary economics belong in [Architecture Boundaries](architecture.md); read them when those decisions are affected.
