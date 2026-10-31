# Bounded Work — Decomposition, execution, and handoff

## When it applies

Use bounded assignments when substantial work benefits from separate context, meaningful dependencies, or a durable handoff. Keep straightforward work direct. A coherent larger assignment may need one worker without a task graph; long-horizon work may need a hierarchy of work packages and execution-ready leaves. Do not manufacture tasks, reviews, or delegation merely because work has several steps.

This is behavioral guidance for existing roles and invocation paths, not a new skill, scheduler, execution permission, or guarantee of model compliance. [Routing](../../penny/routing-protocol.md) owns Penny's execution-path choice; [Invocation](invocation.md) owns artifact transport and capture.

## Atomicity and readiness

An atomic assignment has one coherent outcome that a fresh executor can complete and demonstrate from sufficient declared inputs, within its authority and a conservative context allowance. The prerequisites needed for that outcome must be satisfied before dispatch. Independently completable means after those prerequisites, not independent of every other task.

A task may span files, tool calls, and ordinary implementation, testing, and correction. One file or one model call is not a useful universal unit. Avoid splits that force repeated reconstruction of the same large working set or cannot be checked meaningfully in isolation. Settle shared interfaces or keep tightly coupled work together when that produces a better boundary.

The handoff test is whether a fresh qualified worker can understand the assignment and proceed from its declared inputs without reconstructing an ancestor conversation. Use sufficient context, not the shortest possible summary.

## Task contract

For a substantial delegated assignment, supply the following information in the active consumer's supported format. This list defines meaning, not new tool parameters, SUMMARY fields, or an executable schema:

- **Identity and outcome:** stable task reference, intended result, and links to applicable requirements and acceptance conditions.
- **Inputs and prerequisites:** required evidence and predecessor products, their revisions, relevant source paths or repository baseline, and which producer outputs satisfy each dependency. During planning, describe logical producer/output relationships; bind actual exact artifact IDs at dispatch rather than inventing future IDs.
- **Boundaries:** relevant global constraints, non-goals, permitted change scope, shared resources, and escalation conditions. A scope description does not grant authorization or tools.
- **Outputs and acceptance:** products downstream workers need, observable acceptance conditions, and required evidence. Include integration, failure behavior, and operating/documentation work where applicable.
- **Context fit:** the basis for expecting the complete assignment to fit, material estimation uncertainty, and what would require discovery or re-decomposition.

Tabitha supplies the work breakdown, not a new strategy or implementation. Schemas come from the active Domain Guidance or supplied output contract; keep role definitions domain-invariant. Preserve registered skill semantics: Define specifies, Plan produces strategy rather than executor tasks, and neither authorizes execution.

## Context fit

Estimate peak retained context, including standing instructions and tool definitions, the task packet, required artifact/source reads, accumulated execution and tool output, and room for local verification, correction, and final delivery. Do not use cumulative billed tokens as peak context; cached inputs still occupy context when supplied to the model.

Use the effective model/runtime limits and actual operator policy. Do not bake model aliases, a universal token target, fixed task counts, or step/repair caps into permanent guidance. Distinguish an observed effective limit from an estimate or an unverified setting, and leave a conservative margin for uncertain growth. Artifact IDs are compact addresses, but their read contents consume context; range continuation does not remove previously read material.

If required inputs or investigation cannot be bounded responsibly, refine the assignment or first create a bounded discovery task with a concrete output. Do not invent technical findings or defer unresolved user intent to make a leaf look ready. Apply the same fit assessment to decomposition, review, and integration fan-in, not just implementation workers.

Preserve the complete agreed source record and coverage. Produce traceable, task-scoped inputs that retain every relevant requirement, qualification, and global invariant rather than sending every worker the entire project history. Full-read obligations still apply to needed supplied artifacts; do not truncate them to meet a budget or replace required predecessors with summaries. If the active contract cannot carry sufficient input, report the blocker.

Compaction remains a safety net, not the planned means of finishing an ordinary leaf. Unexpected growth is evidence to reassess scope and handoff quality, not proof of failure or permission to disable compaction. Expose incomplete work and the reason a new bounded assignment is needed; preserve exact partial-output references through the existing owners.

## Dependencies and composition

Make edges describe consumed products or necessary conditions, not arbitrary ordering. Dispatch only when the inputs and dependency acceptance conditions needed for the assigned outcome are established. Identify modification and shared-resource conflicts: missing edges alone do not make concurrent work safe, and fresh model context is not filesystem isolation.

Separate preliminary exploration/component testing from application integration acceptance
and deployment. Apply prerequisites where their actual causal, resource, or authority need
begins, not at the start of all development. If later acceptance requirements would block
independent earlier work, narrow or split the assignment and keep the later gate explicit.
Earlier work still needs its own safety controls and authorization; this is not permission
to bypass a binding prerequisite or claim final acceptance from component success.

Plan explicit integration and end-to-end verification where component results must compose. Each join needs a sufficient, context-manageable input set and its own observable outcome. Local component success does not establish system behavior. New evidence may require revising the graph and marking dependent products stale; do not silently change agreed scope.

## Execution and handoff

One bounded assignment belongs to one fresh worker invocation; the same role may perform later assignments in separate invocations. The executor owns its method within the assigned outcome, permitted capabilities, and actual resource policy. It must not advance into neighboring tasks or silently expand scope. Return completed work with evidence, or explicit partial results and blockers when the assignment cannot responsibly be completed. Productive work is not subject to invented wall-clock or retry limits.

Use the existing complete-output and exact-input contracts. A substantial task handoff identifies the task addressed, acceptance conditions met and unmet, actual outputs and changes, relevant revisions, checks and results, material decisions downstream consumers must preserve, and remaining issues or incomplete work. Follow any registered output/SUMMARY format; do not add undeclared machine fields. A code handoff also identifies the relevant repository revision or patch relationship: an immutable report does not freeze a mutable workspace.

The owner persists and re-reads the actual response and returns its exact artifact reference. The worker does not mint a persistence receipt. A required missing ID or path produces `missing_input:` without substitute search. Preserve uncertainty and source authority: a saved note, predecessor claim, or accepted document is not permission to act or proof of an external result.

Penny checks the promised products and appropriate evidence before accepting the task or releasing dependent work. Apply [proportionality](../architecture/project-standards.md#proportionality-outcomes-before-mechanisms) to unsupported additions and their cost, not merely fidelity to a predecessor model's design; preserve binding requirements and surface conflicts rather than silently waiving them. Use separate verification when its stakes or uncertainty warrant it, not a mandatory reviewer for every trivial task. Process/model completion and successful artifact delivery do not establish semantic task completion; a blocked report can be faithfully persisted. A transport-success chain must not stand in for a required task-acceptance decision.

Penny may repair, clarify, or re-decompose based on the result. Keep coordinator context focused on the current decision and needed exact refs rather than accumulating every child transcript. Existing registered engine/checkpointer state remains authoritative where used; do not introduce a parallel JSON execution ledger or treat plan annotations as checkpoints. Supervised delegation is not an unattended durable DAG scheduler or exactly-once side-effect guarantee.

## Evaluation and limits

Evaluate outcomes with representative cases; these are evaluation requirements, not claims of executed model tests:

| Case                                          | Required observation                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Straightforward direct request                | No unnecessary task graph, worker, or review ceremony.                                           |
| One substantial coherent assignment           | Sufficient inputs and one bounded outcome without artificial microtasks.                         |
| Long-horizon dependent work                   | Execution-ready leaves, explicit consumed outputs, and composition coverage.                     |
| Unknown or oversized working set              | Honest fit uncertainty, bounded discovery or further decomposition; no silent source truncation. |
| Fresh worker replacing the original           | Can proceed from declared inputs without ancestor conversation or memory search.                 |
| Required predecessor absent                   | `missing_input:`; dependent work does not proceed using a guessed substitute.                    |
| Worker reports a blocker or incomplete checks | Persisted response is not mistaken for accepted task completion.                                 |
| Shared-file or shared-resource conflict       | Parallelism is withheld or a safe boundary is established.                                       |
| Components pass but integration fails         | System completion remains unestablished; explicit integration work addresses the gap.            |
| New evidence changes scope or context fit     | Partial work and revisions remain identifiable; dependent work is reassessed.                    |

Capture actual peak context, unexpected compactions, handoff omissions, rework, and integration results when available. Compare useful outcomes and overhead, not task count, exact prose, or checklist length. Structural prompt tests establish loading and assembly only; live behavioral evidence is a separate claim. Hard context enforcement, semantic acceptance schemas, unattended scheduling, and execution isolation require their owning runtime controls, not stronger prompt wording.
