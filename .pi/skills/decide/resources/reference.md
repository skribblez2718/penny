# Decide contract reference

## Request and analysis

`DecisionRequestV1` is closed and bounded: one question; 0–24 alternatives; 0–32 hard constraints, objectives, preferences, and uncertainties; and 0–64 evidence statements. IDs are unique across the request.

Annie maps all alternatives to the request and admitted evidence. The host persists an `EvidenceAdmissionV1` bound to Annie's exact accepted routing result. Echo may be invoked only when that admission records one closed decision-sensitive evidence gap. When compatible with caller constraints, Echo may acquire narrowly targeted read-only local or web evidence for that exact gap, must preserve source locators, and must report unresolved evidence honestly rather than broadening the question.

## Decision draft and semantic basis

Demetri returns bounded nonempty decision prose followed by exactly one `DECISION_CORE:<json>` footer and one SUMMARY. The closed core contains feasibility, recommendation, comparison dimensions, semantic bases, sensitivity, blocker/questions, applicability, outcome, and confidence.

Transport artifact IDs—including request, analysis, evidence packet, draft, seal feedback, reviewer reports, and receipts—are forbidden from `basis_ids_used` and `sensitivity[].basis_ids`. Exact admitted `GroundedSynthesisV1` artifact IDs may be semantic bases when their content is actually used.

The existing outcome invariants remain: applicable outcomes cover all alternatives; selected chooses one feasible ID; ranked orders the complete feasible set; no-feasible marks all infeasible; unresolved has blockers and no recommendation; not-applicable has empty decision fields. Valid unresolved and not-applicable assessments may complete.

## Sealing and lineage

The host validates the draft and seals canonical `DecisionV2` bytes with the exact rationale, canonical request and digest, exact request/draft/import lineage, and `execution_started:false`. A model-correctable seal defect receives one deterministic feedback revision. Every reviewer-driven revision also returns through sealing.

## Review receipts

Vera reviews validity and returns PASS or one closed repair gap. The host mints `ReviewReceiptV1(kind=validity)` only when Vera PASS is bound to the exact latest product and exact admitted upstream graph. Carren receives that receipt and reviews quality. Carren APPROVE is the only completion approval; any major or critical finding forces revision. The host then mints `ReviewReceiptV1(kind=quality)` linked to the validity receipt.

Receipts are deterministic, host-derived, product- and upstream-bound, and tied to the corresponding signed execution result. A revision makes old receipts stale.

## Product envelope

After both current receipts, the host validates canonical decision bytes, exact lineage, signed worker evidence, and no-execution truth. It persists `DecisionProductIntegrityV1` and then `DecisionProductEnvelopeV1`, binding:

- request, analysis, host evidence admission, optional admitted evidence, and imported inputs;
- draft and sealed decision;
- Vera and Carren reports;
- validity and quality receipts;
- integrity evidence and signed execution receipt IDs.

The completion predicate re-reads and validates this exact graph. Exhausted or stalled work is `incomplete` with the exact typed reason; cancellation is `cancelled`. Missing exact material is typed `incomplete`, with no internal clarification state. Engine faults remain out-of-band `error` results rather than Decide states.

## Consequence boundary

Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary; only the host-admitted Echo gap permits targeted local/web evidence acquisition. Normal-phase external calls are capped at 8 per worker and 64 per run, while routing-only repair remains at 0. No component executes, taskifies, performs external mutation, registers the candidate natively, enables it, or promotes it.
