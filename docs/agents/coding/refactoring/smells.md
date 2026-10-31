# Diagnose Structural Friction

## Applies when

Explaining why existing code is difficult to change or deciding whether a structural intervention would help. Apply [Safe Structural Change](safe-change.md).

## Locate the actual difficulty

Start with the requested change and inspect what makes it hard. Trace the relevant callers, data, effects and edit sites. Use observed dependencies and change history when available. Do not infer a defect from length, repetition or a design label alone, and do not scan a fixed catalog merely to find something to remove. During bug investigation, inspect surrounding structure when it obscures the cause or safe fix. In review, identify structural friction before accepting the change: resolve small issues only within the authorized scope, and describe larger work separately. Clarify uncertain intent with the available author or user rather than guessing; a review finding does not itself authorize an edit.

A useful diagnosis connects a particular arrangement to its consequence. For example, unrelated edits repeatedly arriving in one module suggest different responsibilities have been joined; the same rule being changed in many modules suggests its knowledge is dispersed. Mirrored class hierarchies can reveal a variation represented twice. In each case, test whether a different boundary would localize the change without coupling work that ought to remain independent.

## Examine what readers and callers must know

Follow the knowledge needed to use an operation correctly. Navigation through collaborator internals, ambient mutable state, unexplained argument groups and forwarding chains can make a small edit require a large mental model. Move or encapsulate the relevant decision only when doing so actually reduces that burden. A forwarding layer that hides no policy or volatility may worsen it.

Long routines and large objects may mix independent concepts, or may simply express one coherent algorithm. Splitting is useful when the resulting part has a meaningful contract; it is harmful when readers must reconstruct the same invariant through more jumps. Conversely, moving an operation nearer the data it interprets can remove unnecessary exposure, unless separate behavior is intentional and useful.

Comments and names are evidence about understanding. Preserve explanations of constraints and difficult reasoning. If comments merely translate tangled mechanics, consider whether a clearer representation or operation would make that explanation unnecessary. Do not require a rewrite simply because an accurate comment exists.

## Examine the state and variation

Look for representational ambiguity: values with unexplained units, positional fields with different meanings, arguments that form an unnamed concept, or fields valid only during an undocumented phase. Consider a more meaningful representation when it reduces invalid states or repeated interpretation. Avoid a wrapper or argument bag that only renames the ambiguity.

Inspect repeated branching to determine what actually varies. A straightforward condition may be sufficient. A recurring behavioral distinction may deserve a stable abstraction; a state that changes during an object's life is not automatically a subtype. Inheritance that exposes unusable operations or forces access to another object's internals may represent the wrong relationship. Similar interfaces may merit alignment only if clients genuinely share the same contract.

Data-only objects can be deliberate transport models. They become a concern when callers repeatedly bypass invariants or implement the same state rules outside the responsible component. Getters and setters alone do not establish encapsulation.

## Question whether an abstraction earns its cost

Compare each relevant layer with the simpler alternative. Small compatibility seams and protection boundaries may justify their existence; unused generality, empty hierarchies and pure forwarding may not. Verify real consumers before deletion, including reflected, generated, serialized, plugin, framework and test-facing uses.

When an external library is missing behavior, prefer a scoped integration rather than automatically introducing a wrapper framework or fork. A local helper can fill an isolated gap; a coherent extension may be worthwhile when several related gaps form a real contract. Evaluate upgrade and compatibility costs.

## Verify the diagnosis

Predict the improvement and check it against the changed code: fewer synchronized edits, less caller knowledge, a protected invariant, or another concrete benefit. Inspect for new coupling and lost behavior. If the prediction fails, revise the diagnosis or retain the simpler arrangement. A successful fix for one difficulty is not an obligation to treat every other imperfection.
