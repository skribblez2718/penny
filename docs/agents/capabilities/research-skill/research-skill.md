# Research Skill — Grounded synthesis product

## What

A TypeScript multi-agent workflow that decomposes a question, gathers cited evidence, produces a typed semantic draft, deterministically projects and seals one canonical `GroundedSynthesisV1` semantic core, verifies that core with Vera, optionally critiques report quality with Carren, and deterministically renders compatibility files.

## Current rules

1. Use research for complex or multi-source questions, not simple lookups or implementation when evidence is already sufficient.
2. [Invocation](../../agents/invocation.md) owns exact communication/capture; owner artifacts carry stage content and `SUMMARY` carries routing data only.
3. Caller mode wins; otherwise Piper declares it. No keyword detector selects mode.
4. Echo gathers evidence under actual operator policy, finite decomposition bounds and trusted-activity renewable inactivity leases, not a total elapsed-work ceiling.
5. Synthia emits a closed `ResearchSemanticDraftV1` containing semantic content and local indexes only.
6. Host projection/sealing assigns stable IDs, verifies exact excerpt containment/hashes and claim/evidence/source links, and derives active Echo provenance from the draft's cited history slots (deduplicated, at most 64) before sealing canonical bytes. Considered history is not the active-provenance list.
7. Vera reviews every core revision before optional report Carren; a Carren defect must return through Vera.
8. Host rendering is deterministic, idempotent, path-bounded, atomic, and crash-recoverable.
9. Research returns information products, not authorization to execute recommendations.
10. The [binding runtime rule](../../agents/discovery-and-tools.md#binding-runtime-rule) owns catalog tool selection; profiles lint static maxima. Owner-resolved context, private-KB, liveness, cancellation, state-custody, and memory-independent recovery boundaries remain P1/P2-equal.

## Request, budgets, and context

Owner code canonicalizes `ResearchRequestV1` before run mutation and persists exact admitted-request bytes. Compatibility aliases remain value-preserving: `validate_model`, `max_research_rounds`, `max_iterations`, and deprecated `report_format` as caller output-shape guidance. `rigor_escalation`, unknown fields, duplicate refs/bindings, and caller host ceilings are rejected.

Quick/Standard omit critique; Deep adds plan/report critique. Modes do not prescribe finite research-round, evaluator, semantic-repair or correction counts. Derive values from actual operator policy, not test constants or model guesses. Honor actual operator-supplied limits; unspecified controls remain optional. Effective decomposition width remains `min(max_sub_queries, max_fan_width)`. Host states consume no model turns/tools, and P1 liveness values/counters remain unchanged.

Research inference effort is host-owned and derived from the durable liveness preset: bootstrap `high`, Quick `low`, Standard `high`, and Deep `xhigh`. Unknown Research presets fail closed. This invocation policy overrides ordinary session thinking defaults; non-Research sessions are unchanged.

Context may bind versioned documents, exact pre-resolved approved-KB results, and caller output shape. Persisted versioned `ContextSourceRef` artifacts contain metadata only. Resolver-v2 uses bounded admission snapshots and trusted in-process async adapters; every current or legacy external selection is re-resolved under a host-owned renewable inactivity boundary and `AbortSignal` immediately before model execution. Cancellation, inactivity expiry, provider failure/non-settlement, stale metadata, drift, and revocation fail closed before the model seam. Only trusted observed progress renews the lease; productive execution has no total elapsed-work cutoff, while actual operator limits, finite decomposition and input/output bounds, and measured-error controls still apply. Adapter invocation is deferred so cancellation can win before start, but the JavaScript host does not claim to preempt malicious CPU-infinite synchronous adapter code; untrusted resolver logic must run behind an interruptible worker/process boundary. Approved-KB content stays advisory and research performs no query, ingestion, promotion, approval, or write. Private KB bodies do not enter checkpoints, generic artifacts, semantic cores, receipts, renders, envelopes, or telemetry. Context never changes YAML tools.

## Bounded considered history and cited active provenance

Research retains every exact collected Echo artifact, including earlier revisions, in append-only checkpoint history. The synthesis slot table maps stable zero-based history indexes to exact IDs; later evidence appends slots without renumbering earlier ones. Synthia, Vera, and optional report Carren receive the complete exact history, admitted request/scope, and latest core/draft/review context. No lossy summary or last-64 window substitutes for those artifacts.

The host derives **cited active provenance** from the distinct history slots named by `ResearchSemanticDraftV1.evidence`, ordered by history index. Repeated citations count once. Core `provenance.evidence_artifacts` and its direct Echo upstream refs contain only those cited artifacts; the exact Synthia artifact's upstreams retain all considered history. Every excerpt must still occur verbatim in its addressed artifact, and every claim/evidence/source relation must resolve.

The existing core bound stays **64 distinct cited artifacts**. The existing catalog handoff stays **256 total input refs**, including request, context, drafts, core, and review refs; the existing **32,768-character directive task bound** can refuse earlier. Slot schema indexes are 0–255, but only actually supplied slots resolve. If the complete history/context cannot fit transport, or a draft actually cites more than 64 distinct artifacts, Research returns explicit `incomplete/met:false`, retaining history, the draft, and any earlier accepted core. Capacity is not a semantic-correction loop. This is one bounded core, not unlimited partitioning.

Preserving history is not automatic proof of semantic coverage. Synthia must preserve material scope obligations and counterevidence; Vera and Carren must compare the core against the complete supplied history and reject consequential omissions or conflicts, including uncited ones. Deterministic containment and relation checks cannot in general detect an omitted natural-language contradiction. Fixture-oracle tests demonstrate that the real review route can reject such an omission; they do not establish live-model reliability.

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

## Qualification scope

See [Research Reference — Qualification evidence](../../../../.pi/skills/research/resources/reference.md#qualification-evidence) for the historical result and evidence limits; it is not fresh or current qualification. Deterministic PG3 and offline test conformance do not establish live-model reliability or golden-template certification. Child-workflow Gate 2 remains `not_run`.
