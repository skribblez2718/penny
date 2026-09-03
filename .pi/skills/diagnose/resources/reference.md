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

## Validity, integrity, and completion

After a current-subject Vera PASS, the host mints deterministic `DiagnosisValidityReceiptV1` bound to the signed execution result. It then validates canonical bytes, exact lineage, request coverage, accepted worker execution groups, and no-action flags into `DiagnosisProductIntegrityV1`, followed by `DiagnosisProductEnvelopeV1`.

CompletionGate v2 re-reads the exact terminal graph and rejects stale, wrong-run, wrong-phase, wrong-producer, superseded, corrupt, or mismatched evidence. `complete/met:true` means the assessment is valid and finished, not necessarily that a cause was supported. Valid inconclusive and not-applicable outcomes may complete.

## Consequence boundary

Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the analysis-only phase consequence boundary. Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair remains at 0. Those ceilings do not authorize tests or probes, remediation, external retrieval, mutation, taskification, approval, native registration, enablement, or promotion.
