# Assess contract reference

## Canonical request

`AssessmentRequestV1` is closed and bounded. The invocation goal becomes `assessment_purpose`. Constraints contain:

- `schema_version: 1`;
- `target`: one nonempty inline string or one to 64 `{ statement }` target statements;
- one to 64 criteria, each with a statement and importance `required|advisory`;
- zero to 64 supplied-evidence statements with optional source labels;
- bounded hard constraints, non-goals, and known uncertainties.

Assess V1 rejects any caller artifact envelope. Supplied evidence is the complete evidence boundary and is not independently verified.

## Carren draft and categorical truth

Carren emits exactly two adjacent lines: `ASSESSMENT_DRAFT:<canonical-single-line-json>` and a compact SUMMARY. The host enforces strict UTF-8, byte bounds, no BOM/NUL/CR, exact framing, no unknown fields, and a closed `AssessmentDraftV1`. The worker never calculates a digest or ID.

The draft contains exactly one ascending outcome per exact criterion index. Each outcome has verdict `met|partially_met|not_met|not_assessable`, exact supporting and contradicting supplied-evidence indexes, and a concise rationale. Supporting and contradicting indexes cannot overlap.

The overall disposition is one of:

- `meets`: every required criterion is `met` and no major gap exists;
- `does_not_meet`: at least one required criterion is `not_met`;
- `partially_meets`: required outcomes are assessable, none is `not_met`, and at least one is `partially_met`;
- `inconclusive`: at least one required criterion is `not_assessable`, no required criterion is decisively `not_met`, and uncertainty is explicit;
- `not_applicable`: target/criteria make assessment inapplicable, every criterion is `not_assessable`, uncertainty is explicit, and no strength is claimed.

No numeric score field exists. Unknown score or weighting fields fail the closed schema.

The draft also contains a summary; strengths tied to criterion and evidence indexes; gaps tied to criterion/evidence indexes with `major|minor` severity; at most 32 advice-only improvement suggestions tied to criterion indexes; assumptions; uncertainties; complete exact request coverage; confidence; and literal `external_actions_performed:false`, `filesystem_writes_performed:false`, `tests_executed:false`, and `changes_started:false`.

## Host sealing and lineage

The host transforms a valid draft into canonical `penny.assessment.v1`. The semantic core binds the canonical request and request digest plus exact source refs/content digests for:

1. admitted request;
2. latest Annie analysis;
3. latest Carren draft.

The closed lineage also carries host-derived statement digests for every normalized target statement, criterion (including importance), and supplied-evidence statement/source label, plus a host-derived draft digest and lineage digest.

## Vera verification and repair

Vera receives the exact current request, Annie analysis, Carren draft, and sealed assessment. Vera checks objective criterion coverage, evidence-index fidelity, disposition invariants, request coverage, false consequence flags, canonical product shape, and exact lineage. Vera does not re-author Carren's subjective quality judgment.

Closed engine-owned routes are:

- `analysis_gap` or `evidence_gap` → Annie → Carren → host reseal → Vera;
- `assessment_product_gap` → Carren → host reseal → Vera.

There is no Carren approval receipt. Structural malformed routing uses the shared bounded routing-repair path and remains one event-type-scoped accepted execution group.

## Validity, integrity, and completion

After a current-subject Vera PASS, the host mints `AssessmentValidityReceiptV1` bound to Vera's signed accepted execution result. It then creates `AssessmentProductIntegrityV1` from canonical bytes, exact lineage, exact accepted Annie/Carren/Vera execution groups, current-product receipt linkage, and false consequence flags, followed by `AssessmentProductEnvelopeV1`.

CompletionGate v2 re-reads the exact terminal graph and rejects stale, wrong-run, wrong-phase, wrong-producer, superseded, corrupt, or mismatched evidence. `complete/met:true` means the assessment is valid and finished, not that its disposition is `meets`.

## Consequence boundary

Ordinary candidate phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors, and no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant and permitted by caller/task and this closed assessment boundary. Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair remains at 0. Those ceilings do not authorize external verification, numeric scoring, actions, writes, tests, changes, approval, native registration, enablement, or promotion.
