# Research Skill

The research skill runs structured, evidence-based investigations in Quick, Standard, or Deep mode. It separates planning, evidence gathering, typed semantic synthesis, deterministic host projection/sealing, critique, citation validation, and compatibility rendering so no single stage silently substitutes for another.

## How to use it

```
skill({
  skill_name: "research",
  goal: "What are the tradeoffs of microservices vs monoliths?"
})
```

Optional constraints select the mode, report format, sub-query/fan budgets, research-round budget, critique budget, and an optional different model for citation validation. If mode is omitted, Piper chooses it from the actual query; no keyword list auto-detects it.

## What each mode does

- **Quick:** one focused research pass → Synthia typed draft → host projection/sealing → citation validation → renders, with `low` thinking.
- **Standard:** plan → parallel evidence branches → typed draft → host projection/sealing → citation validation → renders, with `high` thinking.
- **Deep:** Standard plus evidence-gated plan and report critiques, with `xhigh` thinking.

When mode is initially unspecified, planning uses the bootstrap `high` level. The Research host derives these levels from the durable mode preset and overrides ordinary session thinking defaults; unknown Research presets are refused. Other capabilities keep their existing settings behavior.

All modes can seek further evidence when Vera identifies a claim that needs a specific source. Derive values from actual operator policy, not test constants or model guesses. Modes do not impose finite round, evaluator, repair or correction counts. Actual operator-supplied controls and decomposition/output limits remain enforceable. Liveness is a trusted-activity renewable inactivity lease, not a total elapsed-work cutoff; cancellation and inactivity expiry still stop work. Blocking ambiguity can pause for clarification.

## Exact handoff and recovery

Each stage receives exact, owner-verified artifact IDs from any run. Workers read needed IDs with `artifact_read` and `next_range`; full responses are persisted/re-read before the small routing SUMMARY is accepted. YAML-declared read-only memory remains advisory, and parallel branches are matched by branch ID rather than completion order.

Checkpoint state retains the exact selected refs, so retry, clarification, and restart do not depend on semantic search. The complete workflow works when no memory endpoint or memory extension exists.

## Considered history and cited evidence

Research keeps all exact collected Echo history, including earlier revisions, for synthesis and review. Stable history indexes let a repair cite both old and new evidence. The sealed core's active provenance lists only the distinct artifacts actually cited by its draft, not everything considered. Synthia and reviewers must still account for material counterevidence and scope obligations outside that cited list; no summary or last-64 window replaces the history.

One core can cite at most 64 distinct Echo artifacts. Complete stage inputs must fit the existing 256-total-ref handoff and 32,768-character task limit, including request, context, core, draft, and reviews. Overflow returns an explicit incomplete result with history and best exact partials retained; it does not silently drop evidence or partition indefinitely. Mechanical citation checks do not prove that a model noticed every contradiction; reviewers must check for consequential omissions against the complete supplied history.

## What you get

Synthia returns a closed `ResearchSemanticDraftV1` containing semantic content and local indexes only. The host deterministically assigns stable IDs, verifies that every quoted excerpt occurs in the exact selected Echo artifact, computes hashes, binds the admitted request/context/Echo/Synthia lineage, and seals canonical `GroundedSynthesisV1` bytes. Vera must pass that exact core.

The host then renders three user-facing compatibility files:

1. `report.md` — grounded narrative, qualifications, contradictions, gaps, and uncertainty;
2. `sources.md` — ordered source and evidence index;
3. `README.md` — question, scope, summary, status, and semantic-core binding.

The terminal `output_artifact_ref` is the exact semantic core, not one of the files or the product envelope. A positive result requires same-core Vera PASS, all deterministic product checks, all three matching files, and central completion admission. Validation or repair exhaustion remains honestly non-positive with the best exact partial preserved.

## Evidence quality

Echo cites every material claim and ranks sources contextually: primary sources first, reputable secondary sources next, weak sources last. Search, browser rendering, and video transcripts are available according to the question; no modality is mandatory merely to satisfy a checklist. Synthia preserves disagreement and uncertainty. Vera checks that citations actually support the claims attributed to them.

The historical PG4 Quick pass is scoped to its recorded cohort, not current seven-skill seal/assurance reliability or golden-template certification. The [agent qualification section](../../../agents/capabilities/research-skill/research-skill.md#qualification-scope) identifies the evidence owner and prose-guard limits; no fresh live evaluation is claimed here.

## When not to use it

Use direct search for simple lookups. Skip research when enough evidence already exists or when the task is implementation and more investigation would not change the result. The skill delivers research; it does not execute recommendations.
