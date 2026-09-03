---
name: research
description: Structured research workflow with Quick, Standard, and Deep modes. Use when a task requires investigating an unfamiliar topic or gathering authoritative external evidence. Do not use for simple lookups, analysis of already-supplied material, or implementation when sufficient evidence exists.
metadata:
  version: "3.0.0"
  penny:
    engine: orchestration
    release_status: production
    mempalace: false
    subagents:
      - piper
      - echo
      - carren
      - synthia
      - vera
---

## When to Use

- Investigate an unfamiliar technical topic or concept.
- Research practices, design patterns, or architectural tradeoffs.
- Compare options using authoritative external evidence.
- Review literature or gather evidence before a decision.
- Answer a complex question requiring multiple independent research angles.

## When Not to Use

- Simple lookup: use `web_search` directly.
- Analysis of material already provided: use the relevant analysis role.
- Implementation when sufficient evidence exists: proceed directly.
- The user requests immediate execution and research would not change the result.

## Invocation

Invoke through the `skill` tool:

```text
skill({
  skill_name: "research",
  goal: "Your research query here"
})
```

| Parameter | Required | Description |
|---|---:|---|
| `skill_name` | yes | Must be `research`. |
| `goal` | yes | Research question; normalized into `ResearchRequestV1`. |
| `session_id` | no | Generated when omitted. |
| `constraints` | no | Closed research mode, scope, budget, context, and output-shape fields below. |
| `model` | no | Optional test/caller override; production defaults remain in agent SSOT. |

### Current constraints

| Constraint | Default | Meaning |
|---|---:|---|
| `mode` | unset | `quick`, `standard`, or `deep`; omit to let Piper declare it. Only explicit caller `quick` skips planning. |
| `scope.include` / `scope.exclude` | empty | Distinct bounded scope lists. |
| `report_format` | unset | **Deprecated compatibility field.** Becomes caller-owned `output_shape_guidance` for Synthia, report Carren, and Vera. |
| `max_sub_queries` | 4 | Decomposition width, effectively `min(max_sub_queries, max_fan_width)`. |
| `max_fan_width` | 8 | Maximum parallel Echo branches. |
| `verification_model_override` | unset | Canonical Vera-only model policy; legacy alias: `validate_model`. |
| `critique_passes` | by mode | `0` none, `1` report critique, `2` plan plus report critique. |
| `total_research_rounds` | by mode | Initial plus evidence-seeking rounds; legacy alias: `max_research_rounds`. |
| `max_evaluator_attempts_per_loop` | 3 | Evaluator attempts; legacy alias: `max_iterations`. Repairs are attempts minus one. |
| `context_bindings` | empty | Identifier-only versioned-document, pre-resolved approved-KB, or caller output-shape bindings. |

`rigor_escalation` is rejected. Caller input cannot set host liveness ceilings or counters.

### Presets

| Mode | Plan critique | Report critique | Total research rounds | Evaluator attempts |
|---|---:|---:|---:|---:|
| quick | no | no | 2 | 3 |
| standard | no | no | 2 | 3 |
| deep | yes | yes | 3 | 3 |

P1 liveness values remain unchanged. Deterministic liveness, cancellation, and best-partial behavior are locally certified. The live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`; no provider rerun is required.

## Exact Artifact Handoff

Every cognitive directive carries exact `input_artifacts` plus an owner output contract. Agents read every needed predecessor with `artifact_read` and `next_range`, return complete stage content, and emit routing-only `SUMMARY` data. Owner persistence and exact-byte re-read precede routing. Research remains correct without memory.

Typed `prior_grounded_synthesis` imports require canonical `penny.grounded-synthesis.v1` bytes in a matching `semantic-core` artifact. Untyped historical `agent-output` inputs remain accepted through `legacy_context`. Envelope, render, or receipt substitution fails before model work.

Owner-resolved context persists only `ContextSourceRefV1` metadata envelopes. Approved-KB content must already be approved and pre-resolved; research performs no KB query, ingestion, promotion, approval, or write. Private KB bodies never enter checkpoints, generic artifacts, receipts, renders, envelopes, or telemetry. Context never changes YAML tools.

## Agent and Host Flow

One approved P3 graph serves every mode:

```text
intake → optional planning → optional plan critique → Echo evidence fan
→ Synthia typed `ResearchSemanticDraftV1`
→ deterministic host projection/core sealing → Vera grounding
→ optional report Carren → host rendering/product checks → completion admission
```

- Every Synthia revision passes through deterministic host projection/core sealing and Vera.
- Vera evidence gaps route to Echo; synthesis defects route to Synthia.
- Carren quality defects route to Synthia, then a new core, Vera, and Carren again.
- No changed core can proceed directly to Carren, rendering, or completion.
- `sealing_core` and `rendering` are host-only states and consume no model turns or tools.

## Product and Terminal Truth

The sole active output port is `grounded_synthesis`. Positive terminal `output_artifact_ref` and chain handoff are the latest exact canonical `GroundedSynthesisV1` `semantic-core` ref—not the envelope, render, receipt, or Synthia draft artifact.

The acyclic graph is:

```text
semantic core
  ├─ Vera grounding receipt
  ├─ optional Carren quality receipt
  ├─ host deterministic-validation receipt
  ├─ report.md render
  ├─ sources.md render
  └─ README.md render
        ↓
research product envelope
```

Host renderer `penny.research.compat-markdown.v1` consumes only the immutable core. It persists a stable render intent, immutable render artifacts, then uses no-follow checks, indexed temporary files, file/directory fsync, and atomic rename. Recovery adopts matching files and converges to identical refs, receipts, envelope ID, and bytes. The three compatibility filenames remain an open loan.

A positive result requires the latest canonical core, no unsupported claim or blocking issue, same-core Vera PASS, same-core Carren PASS when enabled, exactly three verified renders/files, host deterministic-validation PASS, an exact product graph, no exhausted required budget, and the existing engine completion gate from `rendering`. Fully disclosed non-blocking uncertainty may produce `complete/met:true/qualified:true`; it never waives a receipt or budget.

Non-positive runs return the best exact core/artifacts and blockers. They do not receive a complete product envelope. The recognized `legacy_report_artifact` schema remains compatibility-only and is neither authoritative nor chain-forwarded. Decoder-only historical `rigor_escalated:false` remains absent from new terminal projections.
