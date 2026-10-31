# Research Reference

The research skill is a registered TypeScript playbook. `OrchestrationService` combines the engine, Node SQLite checkpointer, immutable artifact owner, signed worker receipts, Pi SDK workers, owner-resolved context, deterministic host product work, and digest-only observability. No executable delegate exists in this skill directory.

## Normative current-truth map

`documentation-traceability.test.ts` enforces bidirectional claim/source/oracle equality.

| Claim ID  | Normative claim                                                                                                                                                                                                                                                                                                                                                                                                                               | Source surface                            | Deterministic oracle                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `RSC-001` | The sole research runtime is the TypeScript `ResearchPlaybook`; no Python child or skill delegate runs.                                                                                                                                                                                                                                                                                                                                       | `SKILL.md`; `README.md`; this reference   | `package-surface.test.ts`; `documentation-traceability.test.ts`       |
| `RSC-002` | The authoritative output and chain handoff are the latest exact `GroundedSynthesisV1` semantic core; three Markdown files remain deterministic compatibility renders.                                                                                                                                                                                                                                                                         | `SKILL.md`; `README.md`; this reference   | `research-product-activation.test.ts`; `research-parity.test.ts`      |
| `RSC-003` | P3 activates the acyclic latest-core receipt/render/product-envelope graph and deterministic crash-recoverable host renderer.                                                                                                                                                                                                                                                                                                                 | `SKILL.md`; `README.md`; this reference   | `research-contract-v2.test.ts`; `research-product-activation.test.ts` |
| `RSC-004` | P3 projects Synthia's typed semantic draft before sealing, runs Vera before report Carren, and sends every changed core back through Vera before Carren or rendering.                                                                                                                                                                                                                                                                         | `resources/flow.html`; this reference     | `flow-diagrams.test.ts`; `research-product-activation.test.ts`        |
| `RSC-005` | New V3 ordinary work has no phase/model/tool/external count or total elapsed-work quota; calibrated renewable worker and host-operation inactivity leases, cancellation, malformed/protocol protection, actual operator repair policy, and non-aborting exact V1/V2 duration telemetry apply; current runtime qualification must be checked separately. [Qualification evidence](#qualification-evidence) owns the separate historical scope. | `SKILL.md`; `README.md`; this reference   | `liveness-budget.test.ts`; `worker-cancellation.test.ts`              |
| `RSC-006` | Deprecated `report_format` remains real caller-owned output-shape guidance for the three declared cognitive consumers.                                                                                                                                                                                                                                                                                                                        | `SKILL.md`; phase prompts; this reference | `research-context.test.ts`; `prompt-guidance-contract.test.ts`        |
| `RSC-007` | `rigor_escalation` is rejected and new terminal projections omit decoder-only `rigor_escalated`.                                                                                                                                                                                                                                                                                                                                              | `SKILL.md`; this reference                | `research-request-admission.test.ts`; `research-parity.test.ts`       |
| `RSC-008` | Context/product metadata never alter exact selected-agent YAML tools, and private KB bodies never enter the product graph.                                                                                                                                                                                                                                                                                                                    | `SKILL.md`; this reference                | `worker-tool-surface-matrix.test.ts`; `worker-registration.test.ts`   |

## Qualification evidence

This section is the sole owner of the historical qualification claim. As recorded, the historical live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`. The recorded evidence was an ignored local PG4 verification bundle; that bundle and its receipt are not supplied or reproduced here and are not a clean-checkout prerequisite. This preserves the recorded historical result without independently verifying or disproving it.

That result covers only its historical Quick cohort. It is not fresh or current qualification of current code, prompts, or documentation, and it does not qualify the current seven-skill seal/assurance changes for repeated live reliability. No new live run or repeated cohort is established by this documentation change.

Deterministic PG3 and offline test conformance establish only their tested host/product/liveness behavior, not live-model reliability or golden-template certification. `documentation-traceability.test.ts` checks claim ownership, precise consumer references, and scope disclaimers; prose agreement and deterministic tests are not independent live-pass evidence. Child-workflow Gate 2 remains `not_run`; neither the historical result nor deterministic conformance supplies its qualification evidence.

## Closed request and ports

| Port                       | Direction | Cardinality | P3 status                                                                                                                        |
| -------------------------- | --------- | ----------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `request`                  | input     |           1 | active inline `penny.research-request.v1`                                                                                        |
| `prior_grounded_synthesis` | input     |         0–8 | active canonical `semantic-core` import                                                                                          |
| `legacy_context`           | input     |        0–64 | active untyped historical `agent-output` compatibility                                                                           |
| `evidence_context`         | input     |         0–1 | active exact `penny.evidence-context.v1` contextual input; does not grant authority or replace native request/product validation |
| `legacy_report_artifact`   | output    |           1 | recognized compatibility schema; not authoritative or chain-forwarded                                                            |
| `grounded_synthesis`       | output    |           1 | sole active semantic output                                                                                                      |

Receipt, render, and research-product envelopes are graph products, never semantic output-port values. The existing W7 `CompletionAdmissionEnvelope` remains separate control-plane evidence.

Before a new run row or model session, owner code normalizes goal, scope, budget aliases, typed inputs, and identifier-only context into `ResearchRequestV1`. It persists canonical admitted-request bytes as an exact internal artifact. Unknown fields, `rigor_escalation`, duplicate refs/slots, host liveness fields, and cross-field conflicts fail closed.

## Presets and frozen liveness

| Mode     | Plan critique | Quality critique |
| -------- | ------------- | ---------------- |
| Quick    | no            | no               |
| Standard | no            | no               |
| Deep     | yes           | yes              |

Derive values from actual operator policy, not test constants or model guesses. Modes select workflow/rigor, not mandatory round, evaluator, semantic-repair or seal-correction counts. Unspecified controls remain optional; actual operator-supplied limits and finite decomposition/output bounds still apply.

Effective breadth remains `min(max_sub_queries, max_fan_width)`. Synthesis task metadata maps stable local history slots to exact artifact IDs, not duplicated full refs. All collected Echo history, including earlier revisions, is retained and supplied to synthesis and review within existing transport bounds. The core's unchanged 64-artifact bound applies only to distinct artifacts actually cited by draft evidence slots, not to total considered history; a 64→65 repair can cite old slot 0 and new slot 64. No arbitrary historical truncation or unlimited partitioning is performed. Compatibility aliases remain value-preserving. V3 replaces ordinary active-work/run-duration termination with calibrated renewable inactivity leases while retaining malformed/protocol, cancellation, and routing-repair containment; counters remain durable telemetry. Bound V1/V2 records retain exact historical policy fields; they are not defaults for new runs. Verify replay enforcement against the active runtime. Duration fields remain non-aborting telemetry. Host `sealing_core`/`rendering` work consumes no model turns or model-visible tools.

## Bounded considered history and cited active provenance

Research retains every exact collected Echo artifact, including earlier revisions, in append-only checkpoint history. The synthesis slot table maps stable zero-based history indexes to exact IDs; later evidence appends slots without renumbering earlier ones. Synthia, Vera, and optional report Carren receive the complete exact history, admitted request/scope, and latest core/draft/review context. No lossy summary or last-64 window substitutes for those artifacts.

The host derives **cited active provenance** from the distinct history slots named by `ResearchSemanticDraftV1.evidence`, ordered by history index. Repeated citations count once. Core `provenance.evidence_artifacts` and its direct Echo upstream refs contain only those cited artifacts; the exact Synthia artifact's upstreams retain all considered history. Every excerpt must still occur verbatim in its addressed artifact, and every claim/evidence/source relation must resolve.

The existing core bound stays **64 distinct cited artifacts**. The existing catalog handoff stays **256 total input refs**, including request, context, drafts, core, and review refs; the existing **32,768-character directive task bound** can refuse earlier. Slot schema indexes are 0–255, but only actually supplied slots resolve. If the complete history/context cannot fit transport, or a draft actually cites more than 64 distinct artifacts, Research returns explicit `incomplete/met:false`, retaining history, the draft, and any earlier accepted core. Capacity is not a semantic-correction loop. This is one bounded core, not unlimited partitioning.

Preserving history is not automatic proof of semantic coverage. Synthia must preserve material scope obligations and counterevidence; Vera and Carren must compare the core against the complete supplied history and reject consequential omissions or conflicts, including uncited ones. Deterministic containment and relation checks cannot in general detect an omitted natural-language contradiction. Fixture-oracle tests demonstrate that the real review route can reject such an omission; they do not establish live-model reliability.

## Owner-resolved context

Bindings carry identifiers and expected digests—not paths, grants, tokens, TTLs, model-selected providers, or arbitrary KB queries. The owner supports versioned documents, exact already-approved KB results, and caller output shape.

Current resolver-v2 admission persists canonical `ContextSourceRefV2` artifacts; retained `ContextSourceRefV1` envelopes remain an exact legacy read path. Both record metadata only: source identity, slot, role, scope, content digest/length/media, revision, freshness, upstream locators, provider eligibility evidence, verification/conflict disposition, and exact cognitive consumers. Before model use, owner code re-resolves content and verifies the exact envelope, digest, length, freshness, approval, conflict, and consumer state. Private KB bodies do not enter checkpoints, telemetry, generic result bodies, semantic cores, receipts, renders, or envelopes. Context does not select/filter tools.

Consumer equality remains frozen:

| Slot                  | Cognitive consumers                                                             |
| --------------------- | ------------------------------------------------------------------------------- |
| domain guidance       | planning, plan critique, researching, synthesizing, report critique, validating |
| standard guidance     | planning, plan critique, researching, synthesizing, report critique, validating |
| output shape guidance | synthesizing, report critique, validating                                       |

## P3 topology

```text
intake
  → optional planning
  → optional plan critique
  → Echo evidence fan
  → Synthia typed ResearchSemanticDraftV1
  → deterministic host projection/sealing_core
  → Vera validating
  → optional Carren report critique
  → host rendering/product checks
  → engine completion admission
```

Routing laws:

- Every scope-dependent worker, including Piper, plan Carren, and every Echo branch, receives the exact admitted request for its question and include/exclude scope.
- Vera evidence gaps route to Echo with the exact reviewed latest sealed core; synthesis/core defects route to Synthia. Seal corrections receive the current epoch's exact diagnostic and rejected draft. Earlier epoch diagnostics remain history, not current instructions.
- Carren quality defects route to Synthia, then host projection/sealing, Vera, and Carren again.
- Every Echo/Synthia route reaches typed drafting and host projection/sealing before Vera.
- No changed core routes directly to Carren, rendering, or completion.
- Core-draft rejections use actual operator correction policy after the current same-run core, with no invented finite default. Every rejection, including the last, persists an exact `SealDiagnosticV1` tied to its draft, policy and core epoch. `seal_product` and `seal_diagnostic` use separate draft-addressed version-1 operations; recovery adopts exact bytes rather than allocating another artifact version. A negative terminal's `seal_diagnostics` labels the rejected draft separately from any earlier accepted best partial core and from semantic `repair_diagnostics`. Changed message wording alone is not progress and cannot override actual operator policy. Custody, persistence, and unexpected host faults are not Synthia corrections.
- Reviewer FAIL/NEEDS_REVISION routes through the engine's actual operator semantic-repair policy and `exact_fingerprint_v1`. The host replays native projection/custody validators, fingerprints semantic draft content, resolved evidence bodies (including considered uncited history), and complete failed structured details, excluding strategy wording, footer framing, and artifact/revision/slot identities. Exact candidate/evidence-plus-failure recurrence ends `incomplete/met:false` with `incomplete_reason:"repair_stalled"`, current feedback and latest core retained; it does not charge another repair. Changed candidate or evidence permits another attempt, not a claim of proven improvement. No keyword/paraphrase equivalence, new counter, or time cap is used. Plan-critique discovery/history semantics remain separate.
- Vera's closed existing SUMMARY admits `UNVERIFIABLE/verification_incomplete/none` with native `unsupported_claims` and concrete `evidence` limitations, without `evidence_needed`. This is inability to verify, not a supported product defect or merely an unresolved research finding. It ends durably incomplete with the exact core and verification report, no Echo/Synthia/Carren loop, render, positive product receipt, or completion admission. Genuine user-only clarification keeps its native gate.
- Vera and both Carren phases bind `preserve_source_summary_v1`: complete source SUMMARY details and confidence are immutable judgments. Routing repair cannot turn malformed/missing judgment into another verdict or change evidence/clarification.
- Before Vera or report Carren, the host re-reads exact current source/core custody and canonical bytes, replays typed draft projection, excerpt containment/hashes, relations and exact lineage, then includes inline `HOST_MECHANICAL_CHECKS` in the task. Inline `source_refs` are compact `artifact_id`/`content_digest` bindings; complete refs remain in `input_artifacts`, avoiding duplicated history metadata under the existing task bound. The signed execution task hash binds this evidence to exact sources. Recovery rechecks that frozen evidence; failure ends incomplete with no author repair. Its scope is `host_mechanical_only_not_semantic_or_effect_absence`; post-review receipts/renders/envelopes are not missing author work. Blocking ambiguity, unsafe render paths, and drift remain non-positive.

## Semantic core and graph

Synthia returns a closed `ResearchSemanticDraftV1` containing only semantic content and local numeric relations. Deterministic host projection assigns stable owner IDs by array order, range-checks every relation, maps evidence slots only to exact selected Echo artifacts, verifies each excerpt is contained in those exact bytes, computes `excerpt_sha256`, supplies admitted request/context/Echo/Synthia lineage, validates unchanged `GroundedSynthesisV1`, and persists only canonical core bytes. Each new immutable `semantic-core` is selected by its exact draft-addressed seal operation; the same-run previous core is retained as the epoch anchor/upstream relation, not inferred from a run-global artifact version or used as a cross-operation store revision parent. New cores make prior reviews/renders/envelopes stale for completion.

The graph is acyclic:

```text
semantic core
  ├─ grounding_verification receipt (Vera)
  ├─ optional quality_critique receipt (Carren)
  ├─ deterministic_product_validation receipt (host)
  ├─ report render
  ├─ sources render
  └─ README render
        ↓
ResearchProductEnvelopeV1
```

Every PASS receipt has non-empty exact evidence refs and exact latest-core ID/digest/schema/version. Agent receipt time derives from the durable execution receipt. Host receipt time is frozen in the first durable render intent. The envelope contains one grounding and deterministic receipt, optional one quality receipt, and exactly report/sources/readme renders. It is terminal graph evidence, never the output-port value.

## Deterministic renderer and recovery

Renderer ID is `penny.research.compat-markdown.v1`. It consumes only validated core bytes/ref and emits UTF-8 NFC LF-only files ending in exactly one LF:

- `report.md`: title, summary, declared narrative order, every claim statement with support status/confidence/qualifications, linked evidence, contradictions, gaps, uncertainty, and stable IDs;
- `sources.md`: sources/evidence in stable ID order with provenance fields, captured locators, and bidirectional claim/evidence/source links; excerpt hashes are not source quotations, and the exact Echo artifact ID addresses the captured evidence bytes;
- `README.md`: question/scope, title/summary/posture, core binding, and linked file inventory.

New intents use the claim-navigation layout. Retained v1 intents and terminals may replay the exact historical layout. Adoption and terminal verification require a complete set matching one of these deterministic layouts for the same validated core; mixed layouts or changed bytes fail closed. Recovery does not rewrite a historical product merely to add navigation.

The host persists a path-bounded intent and render artifacts before file writes. No-follow checks, exact indexed temporary names, file fsync, atomic rename, directory fsync, matching-file adoption, and post-write/full-set verification make retries idempotent. Symlinks, non-regular targets, escape, post-write drift, and incomplete sets return non-positive with the exact core preserved.

## Research Definition of Done

A positive terminal requires:

1. valid admitted request and latest canonical core manifest re-read;
2. exact request/context/evidence/synthesis lineage;
3. no unsupported claim, blocking gap/uncertainty, or unresolved contradiction;
4. same-core Vera PASS;
5. same-core Carren PASS when quality critique is enabled;
6. no exhausted required critique/verification/repair/liveness budget;
7. exactly three latest-core renders and matching files;
8. host deterministic-product PASS;
9. exact resolvable envelope graph;
10. terminal `output_artifact_ref` equal to the semantic-core ref;
11. central completion admission from `rendering` with zero unresolved blockers.

`complete/met:true/qualified:true` is allowed only for disclosed non-blocking uncertainty with every ordinary predicate still passing. Non-positive runs preserve the best exact partial and create no complete envelope. Decoder-only historical `rigor_escalated:false` is not projected in new results.
