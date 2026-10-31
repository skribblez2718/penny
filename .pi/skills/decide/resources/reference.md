# Decide contract reference

## Request and analysis

`DecisionRequestV1` is closed and bounded: one question; 0–24 alternatives; 0–32 hard constraints, objectives, preferences, and uncertainties; and 0–64 evidence statements. IDs are unique across the request.

Annie maps all alternatives to the request and admitted evidence. The host persists an `EvidenceAdmissionV1` bound to Annie's exact accepted routing result. Echo may be invoked only when that admission records one closed decision-sensitive evidence gap. When compatible with caller constraints, Echo may acquire narrowly targeted read-only local or web evidence for that exact gap, must preserve source locators, and must report unresolved evidence honestly rather than broadening the question.

## Decision draft and semantic basis

Demetri returns bounded nonempty decision prose followed by exactly one `DECISION_CORE:<json>` footer and one SUMMARY. The closed core contains feasibility, recommendation, comparison dimensions, semantic bases, sensitivity, blocker/questions, applicability, outcome, and confidence.

Transport artifact IDs—including request, analysis, evidence packet, draft, seal feedback, reviewer reports, and receipts—are forbidden from `basis_ids_used` and `sensitivity[].basis_ids`. Exact admitted `GroundedSynthesisV1` artifact IDs may be semantic bases when their content is actually used.

The existing outcome invariants remain: applicable outcomes cover all alternatives; selected chooses one feasible ID; ranked orders the complete feasible set; no-feasible marks all infeasible; unresolved has blockers and no recommendation; not-applicable has empty decision fields. Valid unresolved and not-applicable assessments may complete.

## Sealing and lineage

The host validates the draft and seals canonical `DecisionV2` bytes with the exact rationale, canonical request and digest, exact request/draft/import lineage, and `execution_started:false`. A model-correctable seal defect may return to the author under actual operator policy in the current same-run product epoch; each rejection gets a separate exact draft-addressed version-1 diagnostic operation, not a run-global feedback revision. Every reviewer-driven revision also returns through sealing.

Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. The host persists an exact `SealDiagnosticV1` for every rejected draft, including a final rejection on actual policy exhaustion. Only same-run feedback after the last checkpoint-selected sealed product enters the next corrective author invocation. A reviewer-driven replacement starts a new epoch; its product must again pass Vera then Carren with fresh receipts. On seal exhaustion, `seal_diagnostics` names the final diagnostic and rejected draft separately from semantic `repair_diagnostics`; any negative terminal output ref is a **rejected draft**, not an accepted product. Historical seal-feedback artifacts remain readable but never grant new corrections.

## Review receipts

Vera reviews validity and returns PASS, one closed repair gap, or UNVERIFIABLE as described below. The host mints `ReviewReceiptV1(kind=validity)` only when Vera PASS is bound to the exact latest product and exact admitted upstream graph. Carren receives that receipt and reviews quality. Carren APPROVE is the only completion approval; any major or critical finding forces revision. The host then mints `ReviewReceiptV1(kind=quality)` linked to the validity receipt.

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

Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary; only the host-admitted Echo gap permits targeted local/web evidence acquisition. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. No component executes, taskifies, performs external mutation, changes executable registration or model discovery.

## Verification uncertainty and repair progress

Vera's closed negative verification outcome is `UNVERIFIABLE/verification_incomplete/none`, with nonempty `findings` and `evidence` describing the limitations. `strategy_delta` remains required but does not authorize author repair. The terminal exposes `verification_findings`, `evidence_limitations`, exact `feedback_report_refs`, and a best partial. It is durable incomplete, not a positive receipt/admission, and never advances to Carren. Valid unresolved products still follow ordinary validity and quality review.

Both Vera and Carren opt into `routing_repair_policy:preserve_source_summary_v1`. The complete final SUMMARY is already structured judgment: routing correction preserves every detail and confidence exactly, including ordered arrays. Absent, malformed or schema-invalid original judgment refuses rather than becoming a new review verdict. Review prose is not mined for substitute judgment; no extra core/footer is introduced.

The verifier task alone carries canonical `HOST_MECHANICAL_CHECKS` after exact-ref/digest, native request/draft/product schema, coverage, admitted-evidence binding and lineage validators succeed. It contains schema version 1, exact `product_ref`, `source_refs`, named successful `checks`, the domain-specific draft digest, and scope `host_mechanical_only_not_semantic_or_effect_absence`. The digest is SHA-256 of canonical parsed DecisionDraftV2 JSON, not complete Demetri output bytes. The ordinary signed task hash binds this statement without a new receipt kind. Recovery recomputes it against selected exact operands and requires exactly one complete matching evidence line in the frozen task, wherever contextual enrichment places it. Missing, altered or duplicate evidence refuses without rewriting the task; validator failure is `host_mechanical_validation_failed`, never author repair. Later integrity/envelope artifacts cannot be demanded as missing pre-review author evidence.

The registration's paired `exact_fingerprint_v1` methods hash the parsed semantic draft, current analysis/orientation and gathered evidence, admission classification and evidence requirement, current Vera review for Carren, and failed structured details. The host rechecks exact refs, bytes, digests and accepted execution bindings. Report prose, confidence and semantic SUMMARY details are retained; `strategy_delta`, transport identities, revisions, receipt fields and historical feedback are excluded. Request, imported and contextual inputs are frozen. Unavailable or unparseable measurement returns `null`, not a recurrence claim. The shared engine stores phase-scoped recurrence evidence atomically with accepted results. Identical measured content after repair, even A/B/A or a replacement ref with unchanged content, returns `repair_stalled` without another author dispatch or reviewer repair charge. Changed upstream analysis/evidence may continue despite an unchanged draft and findings. Best partials and current reports survive restart. Changed measurements do not prove semantic improvement; no prose-equivalence heuristic, wall-clock cutoff or finite repair default is added.
