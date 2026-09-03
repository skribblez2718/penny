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

V1 accepts no caller artifact inputs. Source statements are supplied task material; Produce neither retrieves nor independently verifies them.

## Ida approach

Ida emits exactly two lines: canonical `ARTIFACT_APPROACH:<json>` and compact SUMMARY. `ArtifactApproachV1` contains two to four genuinely different approaches, concrete tradeoffs, exactly one recommended approach ID, rationale, and confidence. Its closed schema has no final artifact content field.

## Skribble draft

Skribble emits canonical `PRODUCED_ARTIFACT_DRAFT:<json>` and compact SUMMARY. `ProducedArtifactDraftV1` contains:

- disposition `produced|not_applicable`;
- exact request `output_name` and `artifact_kind` plus deterministic media type;
- exact `content`; the host derives `content_sha256` while sealing;
- rationale, assumptions, uncertainties, and confidence;
- complete ascending zero-based coverage arrays for specification, source material, acceptance criteria, hard constraints, non-goals, and known uncertainties;
- literal `external_actions_performed:false`, `filesystem_writes_performed:false`, and `tests_executed:false`.

`produced` requires nonempty content. For `json`, content must parse and equal canonical JSON. Other kinds are not compiled, executed, or syntax-checked. `not_applicable` requires empty content and an explanation that is reviewed against the exact brief. The model never supplies a digest; host sealing derives the SHA-256 for either disposition.

## Host sealing and source lineage

The host validates the exact Ida and Skribble framing, draft semantics, output identity, media type, content digest, JSON canonicality when applicable, disposition rules, coverage, and no-action flags. It seals canonical `ProducedArtifactV1` with the exact embedded request and digest plus source lineage for:

1. host-admitted request artifact ID and SHA-256;
2. current Ida approach artifact ID and SHA-256;
3. current Skribble draft artifact ID, artifact SHA-256, and canonical draft SHA-256;
4. every inline source index, statement SHA-256, and exact optional source label.

A derived lineage digest covers the closed lineage object. Revisions form one exact host product chain.

## Review and repair

Carren reviews subjective quality first. `quality_gap` returns to Skribble. Vera then independently verifies objective correctness, compliance, canonical content/hash rules, request coverage, no-action flags, and exact lineage. `brief_gap` returns to Ida and then Skribble; `artifact_product_gap` returns directly to Skribble. Every change is resealed and repeats Carren then Vera.

## Receipts, integrity, and completion

Only after current-product Carren APPROVE and Vera PASS does the host mint `ProduceQualityReceiptV1` followed by `ProduceValidityReceiptV1`. Both bind exact current request/approach/draft/product refs and signed current-run execution results; the validity receipt additionally binds the exact prior quality receipt.

`ProduceProductIntegrityV1` recomputes canonical product validity, full request coverage, exact lineage, JSON canonicality where applicable, current review bindings, signed worker execution groups, and no side effects. `ProduceProductEnvelopeV1` binds the complete graph. CompletionGate v2 rejects stale, wrong-run, wrong-state, wrong-agent, superseded, corrupt, or mismatched evidence.

## Consequence boundary

Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and no other channel may substitute for a missing ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the non-mutating phase consequence boundary. Skribble's write-capable YAML surface does not authorize filesystem mutation: Produce returns semantic-core content for owner capture. Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair remains at 0. Those ceilings do not authorize external or filesystem mutation, code execution, tests, compilation, live retrieval, publication, deployment, or direct approval state.
