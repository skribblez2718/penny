# Data, Identity and Mutation Refactoring

## Applies when

Changing representations, field/collection access, shared identity, associations, variant models or synchronized copies. Apply [Safe Structural Change](safe-change.md).

## Choose the semantic contract before moving representation

Establish what the data means before selecting its new shape. Relevant distinctions include value equality versus entity identity, shared versus private mutation, valid states, lifetime, and storage or interchange representation. A structural improvement should make these meanings easier to enforce, not silently replace them.

Introduce a named type, record or domain value when it removes ambiguity or gathers a real invariant. Meaningful units, limits and sentinel values should be discoverable; identical literals need not describe the same rule. Homogeneous sequences can remain arrays, while positions with different meanings may need names. A plain boundary record can be appropriate without acquiring a behavior-rich class.

Encapsulate according to the invariant at risk. Control meaningful updates rather than merely adding accessors around public state. Internal access methods are worthwhile when they carry validation, lazy behavior or a real variation point; unnecessary indirection can remain unnecessary. Check constructor and override behavior before changing how internal reads and writes dispatch.

Collection access also exposes mutation through aliases. Choose operations, copies or read-only views that preserve the intended update contract, and verify what a caller can actually modify. A setter accepting an arbitrary mutable collection may leave the original invariant unprotected.

## Preserve authority and lifecycle

Changing values into shared entities introduces canonical identity, lookup and shared-update obligations. Changing entities into values removes those obligations only if clients do not depend on identity or mutation being shared. Preserve meaningful absence, equality, construction and serialization behavior through either transition.

Relationship direction should follow real navigation needs. Adding reverse references requires a coherent update operation that maintains both ends; removing them requires checking reverse readers and providing an appropriate alternative where needed. Do not create cycles or dual authorities merely for convenience.

Distinguish fixed behavioral variants, mutable lifecycle states and ordinary coded data. A validated value may be enough for a code; changing states may need explicit transition behavior; stable substitutable variants may justify separate implementations. Conversely, variants differing only by constant data may not need subclasses. Keep stored codes and public type expectations compatible during any representation change.

Presentation and domain state can be separated without inventing two independent truths. If a view must maintain a copy, define authority, synchronization, invalidation and loop prevention. Preserve the applicable atomic update or reconciliation contract. UI-only state does not need a duplicate domain representation just to fit an architectural pattern.

For durable data or external formats, follow the applicable [Data Systems](../data-systems/AGENTS.md) guidance. A migration of stored meaning or compatibility is not behavior preservation merely because the in-memory change looks structural.

## Verification

Select examples that would distinguish the old and proposed meanings: equal-but-distinct values, shared aliases, absent entities, collection mutation, relationship updates, construction failure and persisted round trips. Check whether supported clients can still express valid operations and whether any path can bypass the invariant.

Test synchronization and interruption where copies or relationships are updated in multiple steps. Establish evidence for the actual boundary affected; a successful type conversion alone does not establish preserved identity, lifecycle or compatibility.
