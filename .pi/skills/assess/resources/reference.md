# Assess contract reference

## Canonical request

`AssessmentRequestV1` is closed and bounded. The invocation goal becomes `assessment_purpose`. Constraints contain:

- `schema_version: 1`;
- `target`: one nonempty inline string or one to 64 `{ statement }` target statements;
- one to 64 criteria, each with a statement and importance `required|advisory`;
- zero to 64 supplied-evidence statements with optional source labels;
- bounded hard constraints, non-goals, and known uncertainties.

Assess rejects any caller artifact envelope. Supplied evidence is the complete evidence boundary and is not independently verified.

## Carren draft and categorical truth

Carren emits exactly two adjacent lines: `ASSESSMENT_DRAFT:<canonical-single-line-json>` and a compact SUMMARY. The host enforces strict UTF-8, byte bounds, no BOM/NUL/CR, exact framing, no unknown fields, and a closed `AssessmentDraftV2`. The worker never calculates a digest, ID, or effect claim.

The draft contains exactly one ascending outcome per exact criterion index. Each outcome has verdict `met|partially_met|not_met|not_assessable`, exact supporting and contradicting supplied-evidence indexes, and a concise rationale. Supporting and contradicting indexes cannot overlap.

The overall disposition is one of:

- `meets`: every required criterion is `met` and no major gap exists;
- `does_not_meet`: at least one required criterion is `not_met`;
- `partially_meets`: required outcomes are assessable, none is `not_met`, and at least one is `partially_met`;
- `inconclusive`: at least one required criterion is `not_assessable`, no required criterion is decisively `not_met`, and uncertainty is explicit;
- `not_applicable`: target/criteria make assessment inapplicable, every criterion is `not_assessable`, uncertainty is explicit, and no strength is claimed.

No numeric score field exists. Unknown score or weighting fields fail the closed schema.

The draft also contains a summary; strengths tied to criterion and evidence indexes; gaps tied to criterion/evidence indexes with `major|minor` severity; at most 32 advice-only improvement suggestions tied to criterion indexes; assumptions; uncertainties; complete exact request coverage; and confidence. Effect assertions are not worker-authored draft fields.

## Host sealing and lineage

A host `SealDiagnosticV1` is selected only for the current product epoch and binds the rejected draft, predecessor diagnostic (if any), and actual operator correction policy. Every rejection persists an exact diagnostic before another attempt or incomplete terminalization; no finite allowance is inferred when unspecified. A successfully sealed replacement receives fresh reviews in this skill’s native order; historical reports remain regression context, not approvals. Legacy feedback remains historical evidence, not a new correction allowance.

The host transforms a valid draft into canonical `penny.assessment.v2`. The semantic core binds the canonical request and request digest plus exact source refs/content digests for:

1. admitted request;
2. latest Annie analysis;
3. latest Carren draft.

The closed lineage also carries host-derived statement digests for every normalized target statement, criterion (including importance), and supplied-evidence statement/source label, plus a host-derived draft digest and lineage digest.

## Vera verification and repair

Vera receives the exact current request, Annie analysis, Carren draft, and sealed assessment. Vera checks objective criterion coverage, evidence-index fidelity, disposition invariants, request coverage, canonical product shape, exact lineage, and the host-authored effect graph. Unknown observation or prevention evidence remains unknown. Vera does not re-author Carren's subjective quality judgment.

Closed engine-owned routes are:

- `analysis_gap` or `evidence_gap` → Annie → Carren → host reseal → Vera;
- `assessment_product_gap` → Carren → host reseal → Vera.

Before review, the host re-runs native canonical-byte/digest, draft, exact lineage/custody and effect-graph shape validators. Only then does it append canonical `HOST_MECHANICAL_CHECKS:{schema_version:1,product_ref,source_refs,checks,scope:'host_mechanical_only_not_semantic_or_effect_absence'}` to the verifier task. The signed assignment task hash binds this evidence; no extra storage or model-computed hashes are involved. Host validator failure ends incomplete without an author loop. Recovery verifies and retains the frozen task.

`UNVERIFIABLE/verification_incomplete/none` records missing verification support, findings and evidence limitations, and ends durably incomplete without author repair, positive validity receipt or admission. It differs from a valid inconclusive assessment. Unknown effects alone are not a product defect or verification failure.

There is no Carren approval receipt. Review routing opts into `preserve_source_summary_v1`: the complete original SUMMARY is the closed judgment, and correction cannot invent a missing judgment or change any detail or confidence. There is no new review core wire. Unpreservable originals end incomplete before correction dispatch.

Registration opts into `exact_fingerprint_v1`. For `assessment_product_gap`, the host fingerprints the validated canonical request, parsed authored draft and failed structured details, excluding `strategy_delta`, lineage, IDs, revisions and framing SUMMARY. This measurement is available only while all selected same-run Annie analyses are host-verified byte-identical: the unstructured prose has no safe semantic projection separating substance from embedded transport metadata. A new ref with identical bytes does not create progress. Any analysis byte change disables measurement for the run, including later product gaps, so an old fingerprint cannot falsely stall a changed basis. `analysis_gap` and `evidence_gap` always return `null` (unmeasured). Measurable exact recurrence after repair ends `repair_stalled` with current reports and best product retained. Neither `null` nor changed content proves improvement; no prose classifier or time/count cap is added.

## Validity, integrity, and completion

After a current-subject Vera PASS, the host mints `AssessmentValidityReceiptV2` bound to Vera's signed accepted execution result and one immutable effect-evidence snapshot. It then creates `AssessmentProductIntegrityV2` from canonical bytes, exact lineage, exact accepted Annie/Carren/Vera execution groups, current-product receipt linkage, product-effect digest, and the same final effect graph, followed by `AssessmentProductEnvelopeV2`.

For each effect category, policy requirement is separate from observation and prevention. Observation records status, exact worker/run/phase scope, coverage, result, and evidence refs; prevention records a control and exact scope. Missing evidence defaults to `unknown`, partial no-event observation remains unknown outside its scope, and host artifact persistence is separately classified and excluded from worker-effect assurance. An observed policy violation blocks positive admission. Unknown effects may complete only with the explicit terminal limitation. Bounded no-violation evidence never claims full filesystem or process confinement.

CompletionGate v2 re-reads the exact terminal graph and rejects stale, wrong-run, wrong-phase, wrong-producer, superseded, corrupt, mismatched, or violating evidence. V1 compatibility readers preserve historical bytes but interpret literal `false` only as legacy unverified assertions; active V1 effect checkpoints are refused rather than upgraded in place. `complete/met:true` means the assessment is valid and finished, not that its disposition is `meets`.

## Consequence boundary

Ordinary workflow phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors, and no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant and permitted by caller/task and this closed assessment boundary. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. Those controls do not authorize external verification, numeric scoring, actions, writes, tests, changes, approval, executable registration or model discovery. Policy is not evidence: without an admitted trace or exact prevention-control evidence, effect status remains unknown.
