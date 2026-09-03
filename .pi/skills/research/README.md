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

| State | Owner | Role |
|---|---|---|
| `planning` | Piper | Decompose evidence need and declare mode when unset. |
| `critiquing_plan` | Carren | Optional evidence-gated deep-plan critique. |
| `researching` | Echo × N | Bounded dynamic evidence fan. |
| `synthesizing` | Synthia | Emit a closed typed semantic draft over exact findings and review feedback. |
| `sealing_core` | host | Deterministically resolve indexes, verify excerpt containment/hashes and exact lineage, then persist canonical immutable core bytes. |
| `validating` | Vera | Objective latest-core grounding gate in every mode. |
| `critiquing_report` | Carren | Optional report-quality critique after Vera PASS. |
| `rendering` | host | Persist receipts/renders/envelope, atomically materialize files, enforce DoD. |

Quick skips planning; Standard plans; Deep adds plan and report critique. Every route from Echo or Synthia reaches `synthesizing → sealing_core → validating`. A Carren quality defect reaches `synthesizing → sealing_core → validating → critiquing_report`; there is no fix-to-render edge.

## Request, context, and compatibility

The owner canonicalizes `ResearchRequestV1` before run mutation. Unknown fields, `rigor_escalation`, host liveness overrides, duplicate bindings, and incompatible typed imports fail closed.

A typed import must be exact canonical `penny.grounded-synthesis.v1` bytes in a matching `semantic-core`. Historical untyped `agent-output` input remains `legacy_context`. Deprecated `report_format` becomes caller-owned output-shape guidance for Synthia, report Carren, and Vera.

Context bindings are identifier-only versioned documents, exact pre-resolved approved-KB results, or caller output shape. Persisted `ContextSourceRefV1` artifacts contain metadata only. Content is re-resolved and checked before model use. Approved-KB content stays advisory and private bodies never enter checkpoints, generic products, receipts, renders, envelopes, or telemetry.

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

## Positive terminal

`complete/met:true` requires:

- latest exact canonical core with request/context/Echo-evidence/Synthia lineage and host-verified excerpt hashes;
- no unsupported claim, blocking gap/uncertainty, or unresolved contradiction;
- same-core Vera PASS and same-core Carren PASS when quality critique is enabled;
- no exhausted required critique, verification, repair, malformed, protocol, call, time, or cancellation budget;
- exactly three render artifacts and matching files;
- host deterministic-product PASS and exact envelope graph;
- terminal `output_artifact_ref` equal to the semantic-core ref;
- admission through the existing engine gate from `rendering`.

Fully disclosed non-blocking uncertainty may be `qualified:true`; failed evidence or budget may not. Non-positive outcomes preserve the best exact partial and create no complete envelope.

Deterministic PG3 does not claim golden-template certification. The live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`; golden-template certification remains outside that gate. See `resources/reference.md` for the normative claim map and `resources/flow.html` for the exact graph mirror.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `RESEARCH_FLOW`. It
uses the shared flow template and passes the descriptor drift test plus
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill research`.
The footer documents the intentionally omitted uniform cancellation/abort seams
and out-of-band error outcome; it does not add them to the descriptor graph.
