# Research Skill — Historical Frontier Evaluation and P3 Disposition

> Historical design evidence only. The observations below motivated bounded fan-out, independent verification, and iterative evidence seeking. Current normative behavior lives in `reference.md` and `flow.html`.

## Historical source observations

| Source | Observation used in the design | Evidence posture |
|---|---|---|
| Anthropic, *How we built our multi-agent research system* (2025) | Orchestrator/worker decomposition, parallel research, iterative gap-driven search, dedicated citation verification, and effort scaled to query complexity. | Primary engineering account captured during the original evaluation. |
| OpenAI, *Introducing deep research* (2025) | Up-front clarification before a long research run. | Secondary design input; original page body was not captured reliably. |
| Google, Gemini Deep Research | Reviewable plans before execution. | Secondary design input from the original evaluation. |

Durable conclusions were separation of decomposition/evidence/synthesis/verification, bounded effort presets, primary-source preference, explicit contradiction/uncertainty, evidence-seeking repair, and honest exhaustion/clarification.

## Current P3 implementation truth

| Frontier pattern | Current research skill |
|---|---|
| Scale effort to complexity | Quick, Standard, and Deep select frozen budget presets. |
| Parallel evidence gathering | `researching` is a dynamic Echo fan bounded by `max_fan_width`; explicit quick is one branch. |
| Planning | Piper plans Standard/Deep; Deep may run Carren plan critique before evidence acquisition. |
| Semantic production | Synthia emits a closed `ResearchSemanticDraftV1`; deterministic host projection assigns owner fields, verifies excerpts/hashes and lineage, and seals canonical core bytes before review. |
| Objective grounding | Host seals the immutable semantic core; Vera verifies every mode. |
| Quality critique | Deep report Carren follows Vera PASS. A defect creates a new core that must pass Vera before Carren repeats. |
| Evidence repair | Vera may name `evidence_needed`; Echo → Synthia typed draft → host projection/sealing → Vera repeats within budget. |
| Product graph | Latest core → receipts/renders → research product envelope. The semantic core alone is output-port and chain authority. |
| Compatibility files | Host renderer `penny.research.compat-markdown.v1` deterministically and crash-recoverably materializes `report.md`, `sources.md`, and `README.md`. |
| Clarification | Reactive `await_user` remains producer-oriented; proactive plan approval is not part of the topology. |

A different verifier model is supplementary scrutiny, not independent evidence. Host rules, exact source checks, canonical schemas, immutable refs, and completion admission remain stronger gates.

## P3 disposition

P3 activates the already-frozen request/core/receipt/render/envelope schemas without changing their shapes. The sole active output becomes `grounded_synthesis`; the legacy report artifact remains a recognized compatibility schema only. Every semantic revision re-enters Vera before optional report Carren, rendering, or completion.

The deterministic host persists stable core/render operation lineages, a path-bounded render intent with fixed receipt time, immutable render artifacts, no-follow/atomic/fsync file writes, latest-core receipts, and the terminal product envelope. Success requires the research DoD plus the existing engine completion gate from `rendering`. Blocking work, stale reviews, unsafe targets, drift, exhaustion, and cancellation remain non-positive with best exact partial delivery.

All four compatibility loans remain open: mode presets, fixed topology (ratcheted to the P3 graph), three-file output, and verifier-model default. The live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`; P3 itself makes no live-model or golden-template claim.

## Remaining opportunities outside P3

- separately authorized private live-KB canaries;
- golden-template quality certification and clean-copy release evidence;
- future topology/three-file loan ablation based on measured value.

No P4/P5 behavior should be inferred from this historical evaluation.
