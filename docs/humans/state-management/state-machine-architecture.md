# State Machine Architecture

Penny's state-machine architecture has three responsibility categories, each with two
ownership layers.

| Category                  | Ownership layer         | Responsibility                                                                                                                                                   |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow definition       | **Playbook**            | Domain states, happy-path routing, valid-gap classification, domain bookkeeping, gates, and terminal candidates.                                                 |
| Workflow definition       | **Registration**        | Required guidance, state/agent/result contracts, state-aware repair routes, and completion criteria.                                                             |
| Execution and persistence | **Engine/checkpointer** | Closed requests, repair budgets and transitions, durable control state, receipts, admission, and checkpoint operations.                                          |
| Execution and persistence | **Artifact plane**      | Exact input-ID verification plus immutable output persistence and re-read.                                                                                       |
| Child composition         | **Child state owner**   | Project-bound artifact custody and the atomic boundary for parent suspension, child reservation, call linkage, and terminal consumption.                         |
| Child composition         | **Child runtime owner** | Running a reserved child through the ordinary engine and runner, validating its terminal result, and returning it to the parent without granting parent success. |
| Host operations           | **Host state owner**    | Project-bound artifact custody, canonical operation journal transitions, and atomic parent/result consumption.                                                   |
| Host operations           | **Host runtime owner**  | Registration-bound asynchronous adapter execution, bounded persistence, cancellation, and recovery under a catalog-global fenced backend lease.                  |

A cognitive directive carries current task facts, exact `input_artifacts`, and an output
contract. Inputs may cross runs. The worker reads needed IDs with `artifact_read` and
`next_range`, returns complete content, and ends with a routing-only `SUMMARY`. The owner
persists and re-reads the bytes before parsing that `SUMMARY`.

The seven ordinary generic-child peers use exact agent YAML tools; this is not universal across
registrations. SCA cognitive phases use the registered `["artifact_read"]` strict subset. Other
registration-bound exceptions follow the [binding runtime rule](../../agents/agents/discovery-and-tools.md#binding-runtime-rule).
The runtime checks exact equality with the accepted surface before the model prompt.
This limits model-visible tools; it is not filesystem, process, operating-system, or
extension-code sandboxing. Untrusted execution requires an external container or virtual
machine boundary.

`RunContext` stores compact values and refs, never payload bodies. Retry,
clarification, parallel fan-in, and compaction reuse exact IDs. Large compaction ref sets
become one handoff-index artifact; semantic memory and global artifact scans are not
continuity mechanisms.

For the canonical data-plane and recovery model, see [Skill State Management](state-management.md#three-data-planes)
and [Recovery](state-management.md#recovery). For current child-workflow availability,
limits, exclusions, and qualification status, see [Current child-workflow status](state-management.md#current-child-workflow-status).
