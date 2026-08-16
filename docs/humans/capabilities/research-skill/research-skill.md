# Research Skill

The research skill runs structured, evidence-based investigations in Quick, Standard, or Deep mode. It separates planning, evidence gathering, synthesis, critique, citation validation, and final report writing so no single stage silently substitutes for another.

## How to use it

```
skill({
  skill_name: "research",
  goal: "What are the tradeoffs of microservices vs monoliths?"
})
```

Optional constraints select the mode, report format, sub-query/fan budgets, research-round budget, critique budget, and an optional different model for citation validation. If mode is omitted, Piper chooses it from the actual query; no keyword list auto-detects it.

## What each mode does

- **Quick:** one focused research pass → synthesis → citation validation → report.
- **Standard:** plan → parallel evidence branches → synthesis → citation validation → report.
- **Deep:** Standard plus evidence-gated plan and report critiques.

All modes can run a bounded additional evidence-seeking round when Vera identifies a claim that needs a specific source. Loops and retries are bounded; repeated unresolved issues pause for clarification instead of spinning.

## Exact handoff and recovery

Each stage receives exact, execution-owner-verified artifact references. Workers read every ref with `artifact_read` and follow typed continuation until complete; their full responses are captured before the small routing SUMMARY is accepted. Workers have no durable-memory tools, and parallel branches are matched by branch ID rather than completion order.

Checkpoint state retains the exact selected refs, so retry, clarification, and restart do not depend on semantic search. The complete workflow works when no memory endpoint or memory extension exists.

## What you get

Skribble writes three user-facing files:

1. `report.md` — full thematic report with inline citations;
2. `sources.md` — complete source-tiered bibliography;
3. `README.md` — query, headline findings, status, limitations, and orientation.

Skribble also returns the complete contents of all three in its response. The execution owner captures that response as the registered product artifact, and the terminal result exposes its exact `output_artifact_ref`.

The result reports both:

- `met`: the final report product was completed;
- `grounded`: Vera's citation gate passed.

A report may be delivered after validation budget exhaustion with `grounded: false`. In that case, unresolved claims remain explicitly listed and should not be presented as verified.

## Evidence quality

Echo cites every material claim and ranks sources contextually: primary sources first, reputable secondary sources next, weak sources last. Search, browser rendering, and video transcripts are available according to the question; no modality is mandatory merely to satisfy a checklist. Synthia preserves disagreement and uncertainty. Vera checks that citations actually support the claims attributed to them.

## When not to use it

Use direct search for simple lookups. Skip research when enough evidence already exists or when the task is implementation and more investigation would not change the result. The skill delivers research; it does not execute recommendations.
