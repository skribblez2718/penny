# Produce contract reference

## Canonical request

`ProduceRequestV1` is closed and bounded:

- `purpose_statement` comes from the skill goal;
- `schema_version` is exactly `1`;
- `output_name` is one non-path name;
- `artifact_kind` is exactly `text|markdown|json|yaml|typescript|javascript|python|shell`;
- `specification` and `acceptance_criteria` are nonempty statement arrays;
- `source_material` is an inline statement array with optional `source_label`;
- `hard_constraints`, `non_goals`, and `known_uncertainties` are explicit arrays.

Produce accepts no caller artifact inputs. Source statements are supplied task material; Produce neither retrieves nor independently verifies them.

## Ida alternatives

Ida emits exactly two lines: canonical `ARTIFACT_APPROACH:<json>` and compact SUMMARY. `ArtifactApproachV1` contains one to four genuinely different, unranked approaches with concrete tradeoffs and confidence. One approach is valid only when the brief and host output contract fully determine the representation; it must not be padded with cosmetic variants. The closed schema has no recommendation or final artifact content field.

## Demetri decision

Demetri emits canonical `ARTIFACT_APPROACH_DECISION:<json>` and compact SUMMARY. `ArtifactApproachDecisionV1` assesses every exact Ida approach once on common dimensions, records feasibility, and either selects one feasible in-set approach with rationale and sensitivity or returns an honest `unresolved` disposition with no selection, concrete blocking questions, and `UNCERTAIN` confidence. Unresolved selection terminates non-positive before materialization.

## Skribble draft

Skribble emits canonical `PRODUCED_ARTIFACT_DRAFT:<json>` and compact SUMMARY. `ProducedArtifactDraftV2` contains:

- disposition `produced|not_applicable`;
- exact request `output_name` and `artifact_kind` plus deterministic media type;
- exact `content`; the host derives `content_sha256` while sealing;
- rationale, assumptions, uncertainties, and confidence;
- complete ascending zero-based coverage arrays for specification, source material, acceptance criteria, hard constraints, non-goals, and known uncertainties.

Effect assertions are not worker-authored draft fields.

`produced` requires nonempty content. For `json`, content must parse and equal canonical JSON. Other kinds are not compiled, executed, or syntax-checked. `not_applicable` requires empty content and an explanation that is reviewed against the exact brief. The model never supplies a digest; host sealing derives the SHA-256 for either disposition.

## Host sealing and source lineage

A host `SealDiagnosticV1` is selected only for the current product epoch and binds the rejected draft, predecessor diagnostic (if any), and actual operator correction policy. Every rejection persists an exact diagnostic before another attempt or incomplete terminalization; no finite allowance is inferred when unspecified. A successfully sealed replacement receives fresh reviews in this skill’s native order; historical reports remain regression context, not approvals. Legacy feedback remains historical evidence, not a new correction allowance.

The host validates the exact Ida, Demetri, and Skribble framing, decision semantics, draft semantics, output identity, media type, content digest, JSON canonicality when applicable, disposition rules, and coverage. It seals canonical `ProducedArtifactV2` with the exact embedded request and digest plus source lineage for:

1. host-admitted request artifact ID and SHA-256;
2. current Ida alternatives artifact ID and SHA-256;
3. current Demetri decision artifact ID and SHA-256;
4. current Skribble draft artifact ID, artifact SHA-256, and canonical draft SHA-256;
5. every inline source index, statement SHA-256, and exact optional source label.

A derived lineage digest covers the closed lineage object. Revisions form one exact host product chain.

## Review and repair

Carren reviews subjective quality first. `quality_gap` returns to Skribble. Vera then independently reviews semantic correctness and compliance using the exact host mechanical evidence described below. Unknown effect observation or prevention remains unknown. `brief_gap` returns to Ida, then Demetri, then Skribble; `artifact_product_gap` returns directly to Skribble. Every change is resealed and repeats Carren then Vera.

Produce opts into `repair_progress_policy:exact_fingerprint_v1` for valid Carren and Vera FAIL repairs. Before measuring, the host rechecks the immutable review core and signed assignment binding, exact current operands, native draft/product lineage and current mechanical evidence. The fingerprint covers the complete parsed `ProducedArtifactDraftV2` (including exact content, rationale, assumptions, uncertainties, coverage and confidence), validated Ida alternatives and Demetri selection, plus every failed-check detail except `strategy_delta`. Native approach IDs are mapped to full canonical option content in assessments and selection; regenerated IDs or reordering unranked alternatives/assessments do not count as progress. Descriptions, tradeoffs, feasibility/comparisons, rationale, sensitivity and the selected option remain significant for both reviewers, even when the draft is unchanged. Other authored strings and array order remain exact; no free-text identifier rewriting or semantic-equivalence inference occurs. Host refs, revisions, receipt/time identities, effect snapshots and wire framing are not candidate meaning. An unsupported route or unmeasurable native mapping returns `null` (no recurrence inference), not a guessed cap; invalid native bytes, custody or review binding still fail closed.

The same exact candidate and failed obligation recurring in the same review phase terminates `incomplete/met:false` with `incomplete_reason:repair_stalled`, preserving the latest product and current feedback without spending another repair. Durable history also catches A/B/A across restart. A changed draft, approach/selection basis or failed-check detail permits another review repair under actual operator policy; it is not proof of improvement or approval. This is exact recurrence, not paraphrase/keyword classification, and adds no step, time or attempt cap. Routing-only repair stays separate; the stronger core projection and signed meaning binding remain authoritative, and UNVERIFIABLE still terminates verification-incomplete without an author loop.

## Receipts, integrity, and completion

Only after current-product Carren APPROVE and Vera PASS does the host mint `ProduceQualityReceiptV2` followed by `ProduceValidityReceiptV2`. Both bind exact current request/alternatives/decision/draft/product refs, signed current-run execution results, and one immutable effect-evidence snapshot; the validity receipt additionally binds the exact prior quality receipt.

`ProduceProductIntegrityV2` recomputes canonical product validity, full request coverage, exact lineage, JSON canonicality where applicable, current review bindings, signed worker execution groups, the product-effect digest, and final effect-evidence consistency. `ProduceProductEnvelopeV2` binds the same final graph.

For each category, policy requirement is separate from observation and prevention. Observation records status, exact worker/run/phase scope, coverage, result, and evidence refs; prevention records a control and exact scope. Missing evidence defaults to `unknown`, partial no-event observation remains unknown outside its scope, and host artifact persistence is separately classified and excluded from worker-effect assurance. An observed policy violation blocks positive admission. Unknown effects may complete only with the explicit terminal limitation. Bounded no-violation evidence never claims full filesystem or process confinement.

CompletionGate v2 rejects stale, wrong-run, wrong-state, wrong-agent, superseded, corrupt, mismatched, or violating evidence. V1 compatibility readers preserve historical bytes but interpret literal `false` only as legacy unverified assertions; active V1 effect checkpoints are refused rather than upgraded in place.

## Consequence boundary

Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the non-mutating phase consequence boundary. Skribble's write-capable YAML surface does not authorize filesystem mutation: Produce returns semantic-core content for owner capture. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. Those controls do not authorize external or filesystem mutation, code execution, tests, compilation, live retrieval, publication, deployment, or direct approval state. Policy is not evidence: without an admitted trace or exact prevention-control evidence, effect status remains unknown.

## Review truth and compatibility

Before Vera, the host exposes `penny.produce-mechanical-checks.v1`, bound to the exact current request/alternatives/decision/draft/product. Existing native validators recompute canonicality, content/draft/source/lineage hashes, coverage-array and disposition invariants, JSON canonicality when applicable, and effect-graph shape. Vera independently reviews semantic compliance and source fidelity; mechanical PASS is not semantic approval, execution by Vera, or evidence of effect absence. Unknown effects remain allowable only with the existing explicit limitation.

Carren and Vera emit one immutable semantic-only `PRODUCE_REVIEW` V2 core: `schema_version:2`, `review_kind`, `confidence`, and the complete closed `review` judgment. No opaque refs, IDs, digests or metadata are model-authored; extra fields refuse. The active prompt exposes only its quality or validity branch. Registration binds `penny.produce-review-semantic-projection.v1`, the version-1 host projection for this V2 wire. After exact raw capture/readback and receipt signing, the host derives phase confidence and the COMPLETE review object without another model call. This narrow exception replaces the duplicate model-authored final SUMMARY only for these review phases. Original bytes, digest and signed source provenance remain intact; projection grants no new judgment or completion authority. The host binds the exact current product and, for Vera, mechanical evidence through the original assignment, immutable source metadata and signed invocation digest. Receipt minting, reuse, continuation and final admission reparse original bytes and recheck exact role/run/phase/attempt/output revision, native operands, context designation and custody. Host receipts retain exact report and execution-result linkage; the signed invocation transitively binds the exact mechanical-check ref. Arbitrary unbound V2 bytes or existing minted receipts are never a bypass.

Before dispatch checkpointing, the host persists `penny.produce-review-assignment.v1` after contextual-input enrichment. This immutable companion contains the exact task hash, native/context slots and refs, output metadata, run/state/agent/attempt/trust/model coordinates, and routing-repair binding when applicable. It is retained by exact ref in RunContext, never added to model operands. Historical verification uses these frozen fields rather than regenerating current prompt text, schema descriptions or slot names. An explicit ledger-driven output rebind preserves the saved assignment and freezes its new output coordinate. Missing or changed binding evidence refuses; recovery never fabricates it. Receipt minting and admission authenticate the reloaded original signature and any routed-repair signature as well as the signed invocation digest.

Review grammar: strict UTF-8, `PRODUCE_REVIEW:` at the beginning followed by exactly one closed JSON object, optionally followed by newline-separated `SUMMARY:` and one closed JSON object. Standard JSON whitespace (including multiline JSON and trailing whitespace) and object-key order are insignificant; arrays and every string/value retain their exact meaning and order. The whole wire is at most 262,144 bytes; preflight permits at most 16 JSON nesting levels and 4,096 values before the existing closed schema bounds apply. Duplicate decoded keys at any depth (including escaped aliases), invalid/unsafe/nonfinite numbers, incomplete JSON, BOM, NUL, prose, fences, multiple cores and trailing junk refuse. A present SUMMARY must independently parse and equal core confidence plus every review field. Contradictory, ambiguous or malformed present SUMMARY fails closed even if later routing correction is supplied; the previous malformed-footer salvage expectation is deliberately removed for reviews only. Author wires retain their existing canonical two-line grammar. No missing core, binding, evidence or judgment is reconstructed.

Vera `UNVERIFIABLE/verification_incomplete/none` ends `incomplete/met:false`, without an author-defect claim, product-repair loop, PASS receipt or positive admission. Evidenced FAIL still follows the existing typed repair routes and every revision repeats Carren then Vera.

New review cores are version 2; mechanical checks remain version 1. Historical V1 review cores remain strictly interpretable with their original exact `product_ref` and `host_check_ref` requirements, including rejection of truncated or wrong refs; no fields are dropped, corrected or upgraded. Phase identifiers remain `penny.produce.quality-review-summary.v1` and `penny.produce.validity-review-summary.v1` because judgment details are unchanged (phase schema version remains 1; outer `PhaseResult` remains `schema_version:2`). Product, request, receipt, integrity and envelope formats are unchanged. Old prose review wires are not upgraded or inferred. Changed active registration bindings refuse interrupted old runs; unbound legacy active reviews without the new evidence fail closed. Already committed historical terminals retain exact existing replay under their original admission envelopes. No retained-state rewrite, resealing, discovery or migration occurs, and historical positives are not retroactively requalified.
