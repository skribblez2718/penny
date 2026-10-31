# Safe Structural Change

## Applies when

Changing or assessing code structure without intending to alter its supported behavior.

## Scope and behavior

Improve the structure that obstructs the authorized outcome. Explain the concrete difficulty: a hidden dependency, an unclear operation, an invariant spread across edit sites, or another observed maintenance cost. A familiar smell name is not evidence that a change is needed. Choose the method from the code and contract, not from a required transformation sequence.

Define what must remain observable to callers. Results alone may be insufficient: effects, error meaning, concurrency guarantees, evaluation timing, identity, creation, persistence formats and resource disposal can distinguish two otherwise similar implementations. Treat an intended change to any supported contract as a behavior change, even if the edit is called cleanup.

Structural preparation and follow-up can support a feature or fix, but stay attributable to that work. Do not turn nearby imperfections into an implicit expansion of scope. Prefer changes that can be understood and reversed independently when that reduces risk; no fixed patch size or named methodology is required. Keep intermediate steps runnable and buildable where practical so feedback stays meaningful; distinguish an explicitly requested unfinished draft from a completed change. This does not require a build after every edit.

## Evidence and stopping

Obtain enough behavioral evidence for the risk of the proposed movement. When existing tests do not explain the behavior, characterize the relevant path or establish another reliable observation before relying on equivalence. Keep incidental defects distinguishable from intended behavior so a structural edit does not silently become a fix.

Use feedback to control the change. A failing check should cause investigation of the implementation, expectation and test boundary, not automatic deletion of the check. Tests tied to a discarded private arrangement may be restructured when the replacement still detects the same behavioral failures. [Behavioral Tests](../testing/behavior.md) supplies the evidence criteria.

Assess the result against the original difficulty. Continue only while additional work is necessary for the requested outcome or supported by a separately authorized objective. If a proposed simplification creates a compatibility migration, a new system dependency or substantial additional uncertainty, reassess rather than treating sunk effort as permission to proceed. Record an unresolved limitation when the evidence or scope is insufficient.

## Select the relevant guide

Use the guides whose contracts the change touches: [structural diagnosis](smells.md), [local code and dependency movement](local-transformations.md), [representation and identity](data-models.md), [decisions and callers](conditions-and-calls.md), or [shared abstractions](generalization.md). Read applicable guidance completely, without treating the collection as an exhaustive menu of allowed methods or a mandatory inspection circuit.

These references constrain the outcome, not your reasoning process. A different technique is acceptable when it respects the governing contract, fits the actual code and has adequate evidence. Existing safety, platform and completion requirements still apply; neither a technique name nor reviewer agreement establishes equivalence.
