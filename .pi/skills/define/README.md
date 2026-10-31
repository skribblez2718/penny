# Define

`define` is a registered universal orchestration workflow that creates or fully revises one canonical `SpecificationV1` before planning or implementation. After request admission, the host persists a deterministic `DefinitionSourceManifestV1` with the exact request ref/digest/count and ordered source ordinals, kinds, IDs, and value digests; the request remains the authority for full values.

```text
intake → framing_definition (Piper) → definition_readiness_gate (host)
       → [caller gap] awaiting_clarification → framing_definition
       → [evidence gap] gathering_definition_evidence (Echo)
       → authoring_specification (Rhea) → sealing_specification (host)
       → verifying_specification (Vera) → critiquing_specification (Carren)
       → admitting_specification (host) → complete
```

## Activation boundary

The generated invocation example uses the closed `DefineInvocationV2` wrapper: `{schema_version:2, request:<DefinitionRequestConstraintsV1>, specification_assurance:"reviewed_definition"|"semantic_only"}`. V1 constraints map explicitly to `semantic_only`. Create accepts no prior specification, so its durable assurance is `not_applicable`; revise requires one and strict review checks the completed Define producer and its immediate parent before a new run is created. The assurance record is provenance, not a new semantic specification. Unknown fields or versions refuse without a weaker retry.

New starts use `DefinitionFrameV2`, ordered `EvidenceAdmissionV2` support slots, and keyed `SpecificationDraftV3`. Stable draft-local keys replace mutable objective, requirement, standard, and supersession indexes; immutable source-manifest ordinals remain indexes. Before a sealed product is written, the host validates exact target/locator claims and preflights `DefinitionTraceV1`; it persists that product-bound trace before any review dispatch. An interrupted product/trace write is adopted only at the same immutable coordinates. Vera and Carren consume that exact trace and the latest product in order; their V2 review receipts bind the frame, request, admission, draft, support-bearing trace, reports, and prior validity receipt. V2 integrity and envelope artifacts seal the reviewed graph. Positive completion re-reads and reprojects current trace/support and product lineage, checks exact signed review evidence, and refuses missing or stale refs. A valid blocked specification may complete with planning readiness false. V1/V2 draft readers remain for historical runs; Decide and Plan keep their V1 receipts.

## Frozen boundaries

- One cross-domain schema serves the `generic`, `software`, `business_process`, and `research` profiles. Profiles are immutable, versioned, digest-bound semantic overlays and cannot add tools, code, schemas, destinations, or authority.
- Caller-owned ambiguity enters a durable user gate. External fact or standards gaps may enter one bounded read-only Echo phase. Evidence never decides caller intent.
- `create` forbids a prior specification. `revise` requires exactly one canonical prior SpecificationV1 and returns a standalone full replacement with explicit item and product supersession.
- The exact optional composition surface is prior SpecificationV1, GroundedSynthesisV1, DecisionV2, and EvidenceContextV1, each 0–1.
- New-contract intake refuses protected caller content that cannot fit `SpecificationV1` before creating a run/model (`DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE`), rather than silently truncating excluded scope or merging distinct non-goals. Host sealing assigns stable IDs and lineage, rejects projected-ID seed collisions before product persistence, verifies exact source coverage and profile semantics, derives the reciprocal source-to-product index from authoritative item-side source links, and forces planning, taskification, and execution flags false. Missing/duplicate/out-of-range ordinals are diagnosed without padding.
- FrameV2 binds request and discovered questions by stable IDs. A durable challenge/response records per-question answered, declined or not-answered status. Only target-specific admitted support and reviewed meaning can resolve material questions; useful blocked products can complete, while nonblocking questions can stay open in ready.
- Vera owns validity; Carren owns quality approval; CompletionGate v2 admits only the latest exact reviewed graph. Vera `UNVERIFIABLE/verification_incomplete/none` ends incomplete with the exact product/report, not reauthoring. A valid blocked specification remains eligible for PASS. Both reviewers preserve the complete source SUMMARY during routing repair.
- Before review, the host replays current canonical/lineage/custody/admission/DefinitionTrace checks and supplies signed-task-bound inline `HOST_MECHANICAL_CHECKS`, scoped to mechanics only. Host failure ends incomplete; post-review integrity/envelope artifacts are never author deliverables. Exact repeated semantic candidate/evidence plus failed structured judgment stalls as `repair_stalled`; changed candidates may reseal and repeat Vera-before-Carren. No paraphrase detection or invented repair cap is claimed.
- Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Complete typed diagnostics identify stable keyed paths and bounded context. A diagnostic containing only uncovered requirements may use a closed `SpecificationDraftRepairV1`; the host verifies its exact base/digest/diagnostic binding, applies only criteria that cover diagnosed keys (or key-appending replacements that preserve the existing criterion), rejects removals and unrelated edits, persists a new immutable draft revision, and revalidates the whole result. Other defects still require one complete replacement. An identical rejected digest or unchanged complete diagnostic set stalls before another correction is spent. Seal product and diagnostic refs remain separate draft-addressed version-1 operations. Every rejected draft has its own exact diagnostic, including the final rejection; `seal_diagnostics` is separate from semantic `repair_diagnostics`, and a negative rejected draft is never an accepted specification.
- No path plans, taskifies, approves action, mutates, or executes. Provider-free checks do not establish live-model completion reliability; a repeated authorized live cohort has not been run for this seven-skill fix.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `DEFINE_FLOW`.
