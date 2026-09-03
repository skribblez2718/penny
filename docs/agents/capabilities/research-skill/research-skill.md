# Research Skill — Grounded synthesis product

## What

A TypeScript multi-agent workflow that decomposes a question, gathers cited evidence, produces a typed semantic draft, deterministically projects and seals one canonical `GroundedSynthesisV1` semantic core, verifies that core with Vera, optionally critiques report quality with Carren, and deterministically renders compatibility files.

## Current rules

1. Use research for complex or multi-source questions, not simple lookups or implementation when evidence is already sufficient.
2. Exact owner artifacts carry stage content; `SUMMARY` carries routing data only.
3. Caller mode wins; otherwise Piper declares it. No keyword detector selects mode.
4. Echo gathers evidence under frozen fan/round/liveness ceilings.
5. Synthia emits a closed `ResearchSemanticDraftV1` containing semantic content and local indexes only.
6. Host projection/sealing assigns stable IDs, verifies excerpt containment/hashes, and supplies exact request/context/Echo/Synthia lineage before sealing canonical bytes.
7. Vera reviews every core revision before optional report Carren; a Carren defect must return through Vera.
8. Host rendering is deterministic, idempotent, path-bounded, atomic, and crash-recoverable.
9. Research returns information products, not authorization to execute recommendations.
10. Exact YAML tools, owner-resolved context, private-KB, liveness, cancellation, state-custody, and memory-independent recovery boundaries remain P1/P2-equal.

## Request, budgets, and context

Owner code canonicalizes `ResearchRequestV1` before run mutation and persists exact admitted-request bytes. Compatibility aliases remain value-preserving: `validate_model`, `max_research_rounds`, `max_iterations`, and deprecated `report_format` as caller output-shape guidance. `rigor_escalation`, unknown fields, duplicate refs/bindings, and caller host ceilings are rejected.

Quick/Standard use two total rounds and no critique; Deep uses three rounds plus plan/report critique. All default to three evaluator attempts. Effective decomposition width remains `min(max_sub_queries, max_fan_width)`. Host states consume no model turns/tools, and P1 liveness values/counters remain unchanged.

Research inference effort is host-owned and derived from the durable liveness preset: bootstrap `high`, Quick `low`, Standard `high`, and Deep `xhigh`. Unknown Research presets fail closed. This invocation policy overrides ordinary session thinking defaults; non-Research sessions are unchanged.

Context may bind versioned documents, exact pre-resolved approved-KB results, and caller output shape. Persisted `ContextSourceRefV1` artifacts contain metadata only; content is re-resolved and checked before model use. Approved-KB content stays advisory and research performs no query, ingestion, promotion, approval, or write. Private KB bodies do not enter checkpoints, generic artifacts, semantic cores, receipts, renders, envelopes, or telemetry. Context never changes YAML tools.

## Typed ports and product graph

Typed prior synthesis imports pass through generic composition and must be exact canonical
`semantic-core` artifacts matching the GroundedSynthesis validator. Historical untyped
`agent-output` input remains the non-semantic `legacy_context` compatibility port.

The sole active output port is `grounded_synthesis`. The latest semantic-core ID is returned and chain-forwarded unchanged. `legacy_report_artifact` remains recognized compatibility schema only.

```text
semantic core
  ├─ Vera grounding receipt
  ├─ optional Carren quality receipt
  ├─ host deterministic-validation receipt
  ├─ report render
  ├─ sources render
  └─ README render
        ↓
research product envelope
```

The research product envelope is graph evidence, not output-port authority and not the separate W7 completion-admission envelope.

## P3 topology

- **Quick:** intake → researching → Synthia typed draft → host projection/core sealing → Vera → rendering.
- **Standard:** intake → planning → researching → Synthia typed draft → host projection/core sealing → Vera → rendering.
- **Deep:** intake → planning → plan Carren → researching → Synthia typed draft → host projection/core sealing → Vera → report Carren → rendering.

Vera evidence gaps route to Echo; synthesis/core defects route to Synthia. Report Carren quality defects route to Synthia, deterministic projection/sealing, Vera, then Carren again. No changed core reaches Carren, rendering, or completion directly.

## Deterministic rendering and terminal truth

Renderer `penny.research.compat-markdown.v1` consumes only immutable validated core bytes/ref. A durable intent freezes core binding, exact target bytes/digests, operation identity, and host receipt time. Render artifacts precede no-follow file materialization with exact temporary names, file fsync, atomic rename, directory fsync, matching-file adoption, and full-set verification.

Positive completion requires latest canonical core and lineage, no unsupported/blocking work, same-core Vera PASS, same-core Carren PASS when enabled, no exhausted required budget, exactly three matching renders/files, host deterministic-product PASS, exact envelope graph, semantic-core terminal output, and central admission from `rendering` with zero blockers. Disclosed non-blocking uncertainty may set `qualified:true`; it waives nothing.

Non-positive outcomes preserve best exact partial refs and create no complete product envelope. Decoder-only `rigor_escalated:false` stays absent from new public results.

Deterministic PG3 does not itself establish a live-model or golden-template claim. The live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`; golden-template certification remains separate.
