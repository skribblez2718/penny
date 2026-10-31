# Research Skill

Quick / Standard / Deep evidence research that returns one authoritative `GroundedSynthesisV1` semantic core plus an external receipt/render/product-envelope graph.

## Runtime truth

`ResearchPlaybook` in `apps/orchestration/src/playbooks/research.ts` is the sole runtime. This directory contains only the manifest, prompts, and resources.

- Node SQLite checkpoints are keyed by exact `run_id`.
- `RunContext` stores refs, never product or private context bodies.
- Owner persistence and exact-byte re-read precede routing.
- Restart, clarification, fan recovery, cancellation, and best-partial delivery are memory-independent.
- Selected-agent tools remain exactly YAML under both trust profiles and every context mode.
- `sealing_core` and `rendering` are deterministic host states; they add no model turns, agents, or tools.

## P3 topology

| State               | Owner    | Role                                                                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `planning`          | Piper    | Decompose evidence need and declare mode when unset.                                                                                 |
| `critiquing_plan`   | Carren   | Optional evidence-gated deep-plan critique.                                                                                          |
| `researching`       | Echo × N | Bounded dynamic evidence fan.                                                                                                        |
| `synthesizing`      | Synthia  | Emit a closed typed semantic draft over exact findings and review feedback.                                                          |
| `sealing_core`      | host     | Deterministically resolve indexes, verify excerpt containment/hashes and exact lineage, then persist canonical immutable core bytes. |
| `validating`        | Vera     | Objective latest-core grounding gate in every mode.                                                                                  |
| `critiquing_report` | Carren   | Optional report-quality critique after Vera PASS.                                                                                    |
| `rendering`         | host     | Persist receipts/renders/envelope, atomically materialize files, enforce DoD.                                                        |

Quick skips planning; Standard plans; Deep adds plan and report critique. Every route from Echo or Synthia reaches `synthesizing → sealing_core → validating`. A Carren quality defect reaches `synthesizing → sealing_core → validating → critiquing_report`; there is no fix-to-render edge.

## Request, context, and compatibility

The owner canonicalizes `ResearchRequestV1` before run mutation. Unknown fields, `rigor_escalation`, host liveness overrides, duplicate bindings, and incompatible typed imports fail closed.

A typed import must be exact canonical `penny.grounded-synthesis.v1` bytes in a matching `semantic-core`. Historical untyped `agent-output` input remains `legacy_context`. Deprecated `report_format` becomes caller-owned output-shape guidance for Synthia, report Carren, and Vera.

Context bindings are identifier-only versioned documents, exact pre-resolved approved-KB results, or caller output shape. Resolver-v2 admissions persist metadata-only `ContextSourceRefV2` artifacts. Admission-only compatibility may create exact V1 artifacts, and exact V1 bytes remain immutable/readable, but neither can dispatch external context without resolver-v2 revalidation. External content is re-resolved through the v2 current-resolution contract and its exact bytes, source/revision/approval identity, freshness, eligibility, and conflict state are checked at the injected use-time clock immediately before each worker/model-client dispatch. This repeats after restart/retry and after worker queue delay. `valid_from` is inclusive and `valid_through` is exclusive; unavailable or admission-only resolvers and missing/expired/revoked/ineligible/conflicted/drifted evidence fail before model input. A V1 envelope may proceed only through the same current v2 revalidation and is never rewritten.

Caller output-shape context stays fixed to its admitted bytes across restart and is not assigned external approval. Approved-KB content stays advisory and private bodies never enter checkpoints, generic products, receipts, renders, envelopes, or telemetry. Eligibility is a dispatch-time snapshot: revocation after validation and before or during the model call remains a residual race, not a continuous-monitoring guarantee.

## Bounded considered history and cited active provenance

Research retains every exact collected Echo artifact, including earlier revisions, in append-only checkpoint history. The synthesis slot table maps stable zero-based history indexes to exact IDs; later evidence appends slots without renumbering earlier ones. Synthia, Vera, and optional report Carren receive the complete exact history, admitted request/scope, and latest core/draft/review context. No lossy summary or last-64 window substitutes for those artifacts.

The host derives **cited active provenance** from the distinct history slots named by `ResearchSemanticDraftV1.evidence`, ordered by history index. Repeated citations count once. Core `provenance.evidence_artifacts` and its direct Echo upstream refs contain only those cited artifacts; the exact Synthia artifact's upstreams retain all considered history. Every excerpt must still occur verbatim in its addressed artifact, and every claim/evidence/source relation must resolve.

The existing core bound stays **64 distinct cited artifacts**. The existing catalog handoff stays **256 total input refs**, including request, context, drafts, core, and review refs; the existing **32,768-character directive task bound** can refuse earlier. Slot schema indexes are 0–255, but only actually supplied slots resolve. If the complete history/context cannot fit transport, or a draft actually cites more than 64 distinct artifacts, Research returns explicit `incomplete/met:false`, retaining history, the draft, and any earlier accepted core. Capacity is not a semantic-correction loop. This is one bounded core, not unlimited partitioning.

Preserving history is not automatic proof of semantic coverage. Synthia must preserve material scope obligations and counterevidence; Vera and Carren must compare the core against the complete supplied history and reject consequential omissions or conflicts, including uncited ones. Deterministic containment and relation checks cannot in general detect an omitted natural-language contradiction. Fixture-oracle tests demonstrate that the real review route can reject such an omission; they do not establish live-model reliability.

## Product graph

The sole active output port and chain handoff are `grounded_synthesis`: the latest semantic-core ID is forwarded unchanged. The recognized `legacy_report_artifact` schema remains compatibility-only.

```text
GroundedSynthesisV1 semantic core
  ├─ grounding_verification receipt (Vera)
  ├─ optional quality_critique receipt (Carren)
  ├─ deterministic_product_validation receipt (host)
  ├─ report.md deterministic render
  ├─ sources.md deterministic render
  └─ README.md deterministic render
        ↓
ResearchProductEnvelopeV1
```

The envelope is terminal graph evidence, not an output-port value and not a second W7 completion envelope.

Renderer `penny.research.compat-markdown.v1` consumes only the validated core. Stable intent identity/time, immutable artifacts, no-follow checks, exact temporary names, file/directory fsync, atomic rename, matching-file adoption, and final three-file verification make restart idempotent and drift fail closed.

## Verification and repair truth

Vera can return the closed `UNVERIFIABLE/verification_incomplete/none` SUMMARY variant when required verification cannot be performed. It preserves the exact core/report and ends durably incomplete, without author/evidence/critic loops, rendering, positive product receipts, or admission. A valid unresolved research finding is not itself verification incapability; genuine user-only ambiguity retains native clarification.

Vera and both Carren phases preserve the complete original SUMMARY judgment and confidence during routing correction. Before core review, inline `HOST_MECHANICAL_CHECKS` records replayed native custody, canonical-byte, draft projection, excerpt/hash, relation and lineage validators for the exact product/sources. Recovery rechecks it; failures are incomplete, not author repair. It is not semantic approval or proof of effect absence, and downstream receipts/envelopes are not missing author work.

`exact_fingerprint_v1` stops recurrent identical semantic candidate/evidence plus structured review failure as `repair_stalled`, retaining the latest core and feedback. IDs, revisions, strategy wording and footer framing cannot manufacture progress. Changed semantic content or evidence permits another review; no counter/time cap or keyword-equivalence rule is added. Discovery and plan-clarification semantics remain separate.

## Positive terminal

`complete/met:true` requires:

- latest exact canonical core with request/context/Echo-evidence/Synthia lineage and host-verified excerpt hashes;
- no unsupported claim, blocking gap/uncertainty, or unresolved contradiction;
- same-core Vera PASS and same-core Carren PASS when quality critique is enabled;
- no exhausted actual operator limit, unresolved required critique/verification/repair, measured protocol failure, inactivity expiry or cancellation;
- exactly three render artifacts and matching files;
- host deterministic-product PASS and exact envelope graph;
- terminal `output_artifact_ref` equal to the semantic-core ref;
- admission through the existing engine gate from `rendering`.

Fully disclosed non-blocking uncertainty may be `qualified:true`; failed evidence or budget may not. Non-positive outcomes preserve the best exact partial and create no complete envelope.

Deterministic PG3 does not claim live-model reliability or golden-template certification. See [Qualification evidence](resources/reference.md#qualification-evidence) for the historical result and evidence limits; it is not fresh or current qualification. See the [normative claim map](resources/reference.md#normative-current-truth-map) and `resources/flow.html` for current contracts and the exact graph mirror.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `RESEARCH_FLOW`. It
uses the shared flow template and passes the descriptor drift test plus
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill research`.
The footer documents the intentionally omitted uniform cancellation/abort seams
and out-of-band error outcome; it does not add them to the descriptor graph.
