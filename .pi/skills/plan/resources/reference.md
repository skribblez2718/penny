# Plan contract reference

## Request and exact composition

`PlanRequestConstraintsV1` is the closed start-constraint shape: desired outcomes; provided current-state facts or an unavailable reason; hard constraints; non-goals; material uncertainties; and prior decisions. Canonically equal duplicates fail. The host combines the admitted goal and sorted exact input IDs, then derives `request_id` from the complete request seed.

Typed semantic input ports admit at most one exact `GroundedSynthesisV1` product and at most one exact `DecisionV2`. Plan has no caller-composed prior Strategy input. Admission checks the canonical manifest ref, kind, schema identity/version, registered validator, and exact bytes before run creation. Transport envelopes cannot substitute for semantic cores.

Piper orientation precedes one host `EvidenceAdmissionV1` bound to the exact accepted routing result. Only a typed strategy-blocking gap opens bounded Echo; otherwise the host routes directly to strategy authorship. When caller constraints permit, Echo may acquire narrowly targeted read-only local or web evidence only for that exact gap, must preserve source locators, and must report unresolved evidence honestly rather than broadening into open-ended research.

## Draft transport and semantic rules

Piper returns bounded strategy prose followed by one line-start `STRATEGY_CORE:<single-line JSON>` footer and one final SUMMARY. Strict UTF-8, no BOM/NUL/CR, no code fences, no duplicate marker, and no trailing content are enforced. JSON key order, legal insignificant whitespace, and ordering of set-valued arrays do not affect validity. Exact prose bytes are preserved.

The model core contains disposition, applicability reason, indexed outcomes, indexed dependencies, indexed request coverage, blockers, and confidence. It contains no artifact refs, tasks, task graph, execution, approval, action state, or host lineage.

- Every index is unique within its set field and in range.
- Each outcome links to at least one desired outcome.
- Dependencies have existing distinct endpoints, are unique, and form an acyclic graph.
- `ready` covers every desired outcome and exact request/input context, with no blockers.
- `blocked` has blockers and blocked desired outcomes; linked plus blocked outcomes cover every desired outcome.
- `not_applicable` has no outcomes, dependencies, blockers, blocked outcomes, or coverage claims.
- No edge or executor task is manufactured merely to create a sequence.

## Stable host projection and lineage

`stable_id(namespace,value)` is `namespace + "-" + sha256(canonicalJson(value))`. Fixed namespaces cover the request, request-item families, outcomes, and strategy. Request-item IDs hash values rather than positions. Outcome IDs hash projected outcomes without their IDs. `strategy_id` binds the semantic product, request digest, and exact report digest while excluding run-specific artifact IDs.

Set-valued IDs, dependencies, blockers, and outcomes are canonically sorted in `StrategyV1`. The product embeds the exact report, complete request and digest, exact request/draft/input lineage and digest, raw draft digest, and `execution_started:false`. Canonical Strategy validation remains available for Plan's own sealing, replay, and output recovery; it is not a caller-composition port.

## Review receipts and terminal truth

A review subject binds the exact request, distinct Piper orientation, host evidence admission, optional Echo evidence, imported products, Piper draft, latest sealed strategy, product digest, and admitted-upstream digest. Vera PASS produces a host validity receipt only for that subject. Carren receives the exact Vera-passed subject and host validity receipt; Carren APPROVE produces the dependent quality receipt.

Any product revision changes the review subject, invalidates prior receipt substitution, reseals the product, and requires Vera then Carren again. A deterministic integrity artifact and envelope bind the latest product, both reports, both host receipts, and signed worker execution evidence. Completion rejects stale or substituted refs and receipts.

## Recovery and consequence boundary

Host feedback, sealing, receipts, integrity, and envelope persistence are deterministic and idempotent across recovery. Closed evidence, analysis, and product gaps use finite engine-owned routes. Exhausted or stalled work is `incomplete` with an exact typed reason and the latest exact partial; cancellation is `cancelled`. Missing exact material is typed `incomplete`, with no internal clarification state. Engine faults remain out-of-band `error` results rather than Plan states.

Planning completion means the planning assessment is complete, not that the underlying goal has been achieved or execution is ready. This is especially explicit for `blocked`. Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary; only the host-admitted Echo gap permits targeted local/web evidence acquisition. Normal-phase external calls are capped at 8 per worker and 64 per run, while routing-only repair remains at 0. No path executes, mutates, taskifies, introduces Tabitha, enters an approval state/directive/gate, enables the candidate, or enters production/native discovery.
