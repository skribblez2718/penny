# Inheritance, Generalization and Larger Restructuring

## Applies when

Changing shared abstractions, type relationships, member placement, composition or intertwined responsibilities. Apply [Safe Structural Change](safe-change.md).

## Require a real shared contract

Infer commonality from supported client behavior, not matching text or an available pattern name. Identify what implementations promise, where they legitimately differ, and which changes should remain independent. A shared function, interface, composition or hierarchy is justified by that contract; retaining separate code can be better when apparent similarity is incidental.

Place shared members where their contract genuinely applies. Moving data or behavior upward makes it available to more implementations and therefore strengthens what the common abstraction promises. Moving it toward particular variants can remove an invalid promise, but may break callers depending on the old base type. Examine both consumers and implementations before choosing the direction.

Initialization is part of the contract. Shared constructor work can change ordering, override dispatch, partial state and resource acquisition. A common algorithm skeleton is useful only when its sequence and lifecycle semantics are genuinely stable; superficial similarity is not enough to impose a template.

Expose the interface a real client needs without introducing an interface merely because the language permits one. Likewise, a coherent stable variant may justify a subtype, while constant data or temporary state may be clearer without another class. Collapse a hierarchy that no longer distinguishes meaningful behavior only after checking public type use, construction and persisted type information.

Evaluate inheritance and delegation through substitutability. An object that merely uses another object's capability is not automatically its subtype. Replacing inheritance with composition can contain inappropriate access; replacing forwarding with inheritance can simplify a genuine subtype but expose behavior it cannot honor. Preserve the public obligations and dependency boundary that matter, rather than maximizing reuse.

## Larger changes remain incremental

Separate independent variation axes when their combination forces mirrored or multiplying subclasses. Prefer a representation in which each decision has a coherent home and the required combinations can be checked. Do not add speculative axes to anticipate hypothetical flexibility.

Move rules out of presentation or framework code when a useful invariant or independent capability emerges. Establish which state is authoritative and how any presentation copy stays synchronized. Plain functions and data may implement the resulting boundary perfectly well; moving procedural code into objects is useful only when it improves responsibility and state control.

A large restructuring can include these local decisions, but its risk comes from the contracts crossed, not its pattern label. Keep behavior observable during migration where practical, resolve compatibility and data transitions deliberately, and preserve the project's actual platform constraints. Stop or seek a changed scope when the intended improvement depends on an unassigned rewrite or migration.

## Verification

Exercise clients against every supported variant relevant to the change. Check preconditions, outcomes, failure, identity, initialization, cleanup and runtime dispatch; compilation alone does not establish substitution. Include dynamic consumers and old stored representations where applicable.

Verify the claimed dependency or change-independence benefit as well as behavioral preservation. If shared machinery makes unrelated variants harder to change, reconsider the common abstraction instead of protecting it merely because it has been implemented.
