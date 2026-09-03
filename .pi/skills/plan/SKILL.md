---
name: plan
description: "Create a durable reviewed strategy assessment from a goal, desired outcomes, current state, constraints, uncertainties, prior decisions, and exact prior products. Use when the caller needs outcome structure, meaningful dependencies, risks, contingencies, trade-offs, or an explicit ready, blocked, or not-applicable planning result. Do not use for deciding among alternatives, taskification, approval, mutation, or execution."
disable-model-invocation: false
metadata:
  penny:
    engine: orchestration
    release_status: candidate
    mempalace: false
    subagents: [piper, echo, vera, carren]
---

## When to Use

- Form a strategy connecting supplied current state to desired outcomes.
- Identify meaningful causal, temporal, resource, or informational dependencies.
- Return an honest `ready`, `blocked`, or `not_applicable` planning disposition.

## When Not to Use

- Decide among alternatives, create an executor task graph, request approval, mutate, or execute.
- Open-ended or exploratory research. Narrowly targeted local/web evidence acquisition is allowed only inside the bounded, host-admitted Echo evidence gap.
- Treat planning completion as execution readiness.

## Invocation Boundary

This package is a model-visible candidate: Pi native discovery and Penny's model-facing catalog may describe it, but it remains outside the production registry and never self-enables or promotes. Model visibility grants no execution authority. Explicit `skill` invocation is available only when ignored host configuration enables the exact candidate contract digest; evaluation callers may instead supply its registration explicitly. Candidate enablement is reversible and is not formal admission or production promotion.

## Orchestrated Flow

```text
intake
  → orienting_strategy (Piper; distinct orientation artifact)
  → strategy_evidence_gate (host typed admission)
  → optional gathering_strategy_evidence (Echo; one admitted strategy-blocking gap)
  → strategizing (Piper; complete replacement draft)
  → sealing_strategy (host)
  → verifying_strategy (Vera)
  → critiquing_strategy (Carren)
  → admitting_strategy (host CompletionGate v2)
  → complete
```

Vera and Carren emit only one closed gap kind plus repair owner. Engine-owned registered routes send reviewer evidence/analysis gaps to Piper orientation and product gaps to Piper strategy authorship. Only an accepted Piper evidence gap opens the host evidence gate and bounded Echo. Every strategy revision returns through deterministic host sealing, Vera, and Carren. Exhausted or stalled work terminates honestly as `incomplete` with the exact typed reason and without resetting the state counter; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results, not Plan states.

## Exact Artifact Handoff

The owner canonicalizes and persists `PlanRequestV1`. The exact optional semantic inputs are 0–1 `GroundedSynthesisV1` and 0–1 `DecisionV2`; each is validated from canonical bytes before run creation. There is no caller-composed prior Strategy port. Envelope-for-core, wrong version/kind, stale, ambiguous, corrupt, incompatible, and validator-missing inputs are rejected.

Every phase receives exact refs. Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary; they cannot bypass host-owned evidence admission. Piper authors from the exact request directly plus orientation and evidence. Vera and Carren receive the exact request, orientation, draft, latest sealed strategy, source refs, and required prior review evidence.

Only the host-admitted Echo gap may acquire new evidence, and only through narrowly targeted read-only local inspection or web retrieval for the exact strategy-blocking fact when compatible with caller constraints. Echo must provide source locators, stop rather than broaden into open-ended research, and report unavailable, conflicting, disallowed, insufficient, or budget-exhausted evidence honestly as unresolved. Normal-phase liveness permits at most 8 external calls per worker and 64 per run; routing-only repair remains at 0.

## Product and Review Truth

Piper returns bounded strategy prose, one closed `STRATEGY_CORE:<json>` footer, and one SUMMARY. The host validates and seals canonical `StrategyV1` with exact request/source lineage and `execution_started:false`.

Vera independently verifies validity. The host mints a validity receipt only for a latest-product PASS. Carren is the sole quality approval authority; any major or critical finding requires revision. The host mints a quality receipt only for latest-product APPROVE, then deterministically validates integrity and emits a strategy product envelope binding the exact request, orientation, evidence, imports, draft, strategy, reports, receipts, and integrity evidence.

`complete/met:true` requires that exact latest graph and Carren APPROVE. Valid `ready`, `blocked`, and `not_applicable` assessments may complete. `blocked` means the planning assessment is complete; it does not mean the underlying execution is ready. Missing exact material is `incomplete` with a typed reason; the candidate has no `await_user`, `awaiting_user`, challenge, or same-run `respond` path.

## Consequence Boundary

No path introduces Decide as a required phase, Tabitha, executor tasks, task graphs, action state, approval state/directive/gate/product, external mutation, execution, OS/process sandbox or provider-extension-code-isolation claims, native registration, promotion, or enablement. Targeted Echo evidence retrieval does not authorize side effects, open-ended research, or any expansion of caller/task scope.
