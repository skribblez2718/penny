# Diagnose contract reference

## Canonical request

`DiagnosisRequestV1` is closed and bounded. It contains one problem statement, one or more symptoms, supplied observations with optional source labels, environment facts, hard constraints, non-goals, known uncertainties, and a closed `permitted_test_boundary` of `proposal_only` or `none`.

Diagnose V1 accepts no caller artifact inputs. Supplied observations are the complete evidence boundary: workers neither acquire nor execute anything.

## Draft and semantic core

Demetri emits exactly two adjacent lines: `DIAGNOSIS_CORE:<single-line-json>` and a compact SUMMARY. The host enforces strict UTF-8, byte bounds, no BOM/NUL/CR, exact framing, and a closed `DiagnosisDraftV1`.

The draft contains:

- disposition `supported`, `inconclusive`, or `not_applicable`;
- a complete uniquely ranked hypothesis set with status `supported`, `plausible`, or `ruled_out`;
- exact zero-based request observation, environment-fact, and hard-constraint indexes;
- at most one named primary supported cause;
- reasoning, explicit uncertainty (blocking for inconclusive; potentially residual and non-blocking for supported), proposed non-executed discriminating checks, exact request coverage, and confidence;
- literal `tests_executed:false` and `remediation_started:false`.

Supported and ruled-out statuses require corresponding supplied evidence. Index lists are ascending, unique, in range, and non-overlapping per hypothesis. `permitted_test_boundary:none` forbids checks. An inconclusive proposal-only assessment requires a discriminating check and at least two plausible hypotheses. A supported assessment requires exactly one named supported primary cause and no uncertainty that prevents selecting it; non-blocking residual uncertainty remains explicit. A not-applicable assessment has no primary cause or checks.

## Host sealing and lineage

A host `SealDiagnosticV1` is selected only for the current product epoch and binds the rejected draft, predecessor diagnostic (if any), and actual operator correction policy. Every rejection persists an exact diagnostic before another attempt or incomplete terminalization; no finite allowance is inferred when unspecified. A successfully sealed replacement receives fresh reviews in this skill’s native order; historical reports remain regression context, not approvals. Legacy feedback remains historical evidence, not a new correction allowance.

The host transforms a valid draft into canonical `DiagnosisV1`. The semantic core binds the canonical request and digest plus exact source refs and content digests for:

1. admitted request;
2. Annie causal decomposition;
3. Ida competing hypotheses;
4. Demetri draft.

A derived lineage digest covers that closed source lineage. Request and worker artifact IDs are transport lineage, not independent evidence.

## Verification and repair

Vera verifies validity against the exact current graph. Closed engine-owned repair routes are:

- `analysis_gap` or `evidence_gap` → Annie → Ida → Demetri;
- `diagnosis_product_gap` → Demetri.

Every revision returns through host sealing and Vera. There is no Carren phase and no quality-approval receipt.

Before review, the host re-runs native canonical-byte/digest, draft, exact lineage and custody validators. Only then does it append canonical `HOST_MECHANICAL_CHECKS:{schema_version:1,product_ref,source_refs,checks,scope:'host_mechanical_only_not_semantic_or_effect_absence'}` to the verifier task. Authored no-action literals are shape checks, not effect-absence evidence. The signed assignment task hash binds this evidence; no extra storage or model-computed hashes are involved. Host validator failure ends incomplete without an author loop. Recovery verifies and retains the frozen task.

`UNVERIFIABLE/verification_incomplete/none` records missing verification support, findings and evidence limitations, and ends durably incomplete without author repair, positive validity receipt or admission. It differs from a valid inconclusive diagnosis. Unknown effects alone are not a product defect or verification failure.

Review routing opts into `preserve_source_summary_v1`: the complete original SUMMARY is the closed judgment, and correction cannot invent a missing judgment or change any detail or confidence. There is no new review core wire. Unpreservable originals end incomplete before correction dispatch.

Registration opts into `exact_fingerprint_v1`. For `diagnosis_product_gap`, the host fingerprints the validated canonical request, parsed authored draft and failed structured details, excluding `strategy_delta`, lineage, revisions and framing SUMMARY. Opaque hypothesis/check IDs are normalized to hypothesis positions while preserving their references. This measurement is available only while all selected same-run Annie decompositions and Ida hypotheses are host-verified byte-identical within each phase: the unstructured prose has no safe semantic projection separating substance from embedded transport metadata. A new ref with identical bytes does not create progress. Any upstream byte change disables measurement for the run, including later product gaps, so an old fingerprint cannot falsely stall a changed basis. `analysis_gap` and `evidence_gap` always return `null` (unmeasured). Measurable exact recurrence after repair ends `repair_stalled` with current reports and best product retained. Neither `null` nor changed content proves improvement; no prose classifier or time/count cap is added.

## Validity, integrity, and completion

After a current-subject Vera PASS, the host mints deterministic `DiagnosisValidityReceiptV1` bound to the signed execution result. It then validates canonical bytes, exact lineage, request coverage, accepted worker execution groups, and no-action flags into `DiagnosisProductIntegrityV1`, followed by `DiagnosisProductEnvelopeV1`.

CompletionGate v2 re-reads the exact terminal graph and rejects stale, wrong-run, wrong-phase, wrong-producer, superseded, corrupt, or mismatched evidence. `complete/met:true` means the assessment is valid and finished, not necessarily that a cause was supported. Valid inconclusive and not-applicable outcomes may complete.

## Consequence boundary

Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the analysis-only phase consequence boundary. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. Those controls do not authorize tests or probes, remediation, external retrieval, mutation, taskification, approval, executable registration or model discovery.
