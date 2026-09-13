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

Ida emits exactly two lines: canonical `ARTIFACT_APPROACH:<json>` and compact SUMMARY. `ArtifactApproachV1` contains two to four genuinely different, unranked approaches with concrete tradeoffs and confidence. Its closed schema has no recommendation or final artifact content field.

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

The host validates the exact Ida, Demetri, and Skribble framing, decision semantics, draft semantics, output identity, media type, content digest, JSON canonicality when applicable, disposition rules, and coverage. It seals canonical `ProducedArtifactV2` with the exact embedded request and digest plus source lineage for:

1. host-admitted request artifact ID and SHA-256;
2. current Ida alternatives artifact ID and SHA-256;
3. current Demetri decision artifact ID and SHA-256;
4. current Skribble draft artifact ID, artifact SHA-256, and canonical draft SHA-256;
5. every inline source index, statement SHA-256, and exact optional source label.

A derived lineage digest covers the closed lineage object. Revisions form one exact host product chain.

## Review and repair

Carren reviews subjective quality first. `quality_gap` returns to Skribble. Vera then independently verifies objective correctness, compliance, canonical content/hash rules, request coverage, the host effect graph, and exact lineage. Unknown effect observation or prevention remains unknown. `brief_gap` returns to Ida, then Demetri, then Skribble; `artifact_product_gap` returns directly to Skribble. Every change is resealed and repeats Carren then Vera.

## Receipts, integrity, and completion

Only after current-product Carren APPROVE and Vera PASS does the host mint `ProduceQualityReceiptV2` followed by `ProduceValidityReceiptV2`. Both bind exact current request/alternatives/decision/draft/product refs, signed current-run execution results, and one immutable effect-evidence snapshot; the validity receipt additionally binds the exact prior quality receipt.

`ProduceProductIntegrityV2` recomputes canonical product validity, full request coverage, exact lineage, JSON canonicality where applicable, current review bindings, signed worker execution groups, the product-effect digest, and final effect-evidence consistency. `ProduceProductEnvelopeV2` binds the same final graph.

For each category, policy requirement is separate from observation and prevention. Observation records status, exact worker/run/phase scope, coverage, result, and evidence refs; prevention records a control and exact scope. Missing evidence defaults to `unknown`, partial no-event observation remains unknown outside its scope, and host artifact persistence is separately classified and excluded from worker-effect assurance. An observed policy violation blocks positive admission. Unknown effects may complete only with the explicit terminal limitation. Bounded no-violation evidence never claims full filesystem or process confinement.

CompletionGate v2 rejects stale, wrong-run, wrong-state, wrong-agent, superseded, corrupt, mismatched, or violating evidence. V1 compatibility readers preserve historical bytes but interpret literal `false` only as legacy unverified assertions; active V1 effect checkpoints are refused rather than upgraded in place.

## Consequence boundary

Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the non-mutating phase consequence boundary. Skribble's write-capable YAML surface does not authorize filesystem mutation: Produce returns semantic-core content for owner capture. Ordinary permitted work has no model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; calibrated renewable inactivity leases stop stalled workers, independent host-operation deadlines remain an upper bound, and routing-only repair remains separately count-bounded. Those ceilings do not authorize external or filesystem mutation, code execution, tests, compilation, live retrieval, publication, deployment, or direct approval state. Policy is not evidence: without an admitted trace or exact prevention-control evidence, effect status remains unknown.
