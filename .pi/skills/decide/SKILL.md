---
name: decide
description: "Create a durable reviewed decision from supplied alternatives, constraints, preferences, uncertainty, and evidence. Use when the caller needs a selection, complete ranking, no-feasible finding, explicit unresolved disposition, or not-applicable assessment. Do not use when the caller needs ideation, planning, taskification, or execution."
disable-model-invocation: false
metadata:
  penny:
    engine: orchestration
    release_status: candidate
    mempalace: false
    subagents: [annie, echo, demetri, vera, carren]
---

## When to Use

- Select one supplied feasible alternative or rank the complete feasible set.
- Establish that no supplied alternative is feasible.
- Produce a valid `unresolved` assessment with concrete blocking questions.
- Produce a valid `not_applicable` assessment.

## When Not to Use

- Generating alternatives, comparing without deciding, planning, taskification, or execution.
- Open-ended or exploratory research. Narrowly targeted local/web evidence acquisition is allowed only inside the bounded, host-admitted Echo evidence gap.

## Invocation Boundary

This package is a model-visible candidate: Pi native discovery and Penny's model-facing catalog may describe it, but it remains outside the production registry and never self-enables or promotes. Model visibility grants no execution authority. Explicit `skill` invocation is available only when ignored host configuration enables the exact candidate contract digest; evaluation callers may instead supply its registration explicitly. Candidate enablement is reversible and is not formal admission or production promotion.

## Orchestrated Flow

```text
intake
  → analyzing_decision (Annie)
  → decision_evidence_gate (host typed admission)
  → optional gathering_decision_evidence (Echo; one admitted decision-sensitive gap)
  → deciding (Demetri)
  → sealing_decision (host)
  → verifying_decision (Vera)
  → critiquing_decision (Carren)
  → admitting_decision (host CompletionGate v2)
  → complete
```

Vera and Carren emit only a closed gap kind plus repair owner. Engine-owned registered routes send reviewer evidence/analysis gaps to Annie and product gaps to Demetri. Only an accepted Annie evidence gap opens the host evidence gate and bounded Echo. Every revision returns through deterministic sealing and Vera verification before Carren. Exhausted or stalled work terminates honestly as `incomplete` with the exact typed reason and no state-counter reset; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results, not Decide states.

## Exact Artifact Handoff

Every phase receives exact artifact refs. Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by the caller and task, and within the phase consequence boundary; they cannot bypass host-owned evidence admission. Request, analysis, evidence packet, draft, reviewer report, receipt, and feedback IDs are transport lineage, not semantic basis IDs. Only exact admitted `GroundedSynthesisV1` artifacts may contribute artifact basis IDs.

Only the host-admitted Echo gap may acquire new evidence, and only through narrowly targeted read-only local inspection or web retrieval for the exact decision-sensitive fact when compatible with caller constraints. Echo must provide source locators, stop rather than broaden into open-ended research, and report unavailable, conflicting, disallowed, insufficient, or budget-exhausted evidence honestly as unresolved. Normal-phase liveness permits at most 8 external calls per worker and 64 per run; routing-only repair remains at 0.

## Product and Review Truth

Demetri returns bounded decision prose, one closed `DECISION_CORE:<json>` footer, and one SUMMARY. The host validates and seals exact canonical `DecisionV2` bytes with request/source lineage and `execution_started:false`.

Vera independently verifies validity. The host mints a validity receipt only for a latest-product PASS. Carren then critiques quality and is the sole approval authority; any major or critical finding requires revision. The host mints a quality receipt only for latest-product APPROVE, then deterministically validates product integrity and emits a `DecisionProductEnvelopeV1` that binds request, analysis, optional evidence, imports, draft, decision, both reports, both receipts, and integrity evidence.

`complete/met:true` requires that exact latest graph and Carren APPROVE. Valid `unresolved` and `not_applicable` outcomes may complete because completion means the assessment is finished, not that a selection exists. Missing exact material is `incomplete` with a typed reason; the candidate has no `await_user`, `awaiting_user`, challenge, or same-run `respond` path.

## Consequence Boundary

No path executes, taskifies, mutates externally, changes credentials, registers natively, enables, promotes, or creates action state. Targeted Echo evidence retrieval does not authorize side effects, open-ended research, or any expansion of caller/task scope.
