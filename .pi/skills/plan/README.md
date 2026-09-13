# Plan candidate

`plan` is a source-defined, registered universal orchestration workflow. It is model-visible through native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
intake → orienting_strategy (Piper) → strategy_evidence_gate (host)
       → [typed gap only] gathering_strategy_evidence (Echo) → strategizing (Piper)
       → sealing_strategy (host) → verifying_strategy (Vera)
       → critiquing_strategy (Carren) → admitting_strategy (host) → complete
```

Reviewer evidence and analysis gaps use engine-owned routes back through Piper orientation and the explicit evidence gate; product gaps return to Piper strategy authorship. Every revised product is resealed and re-verified before Carren. Exhausted or stalled work terminates as `incomplete` with the exact typed reason and without resetting the state counter; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results and are not Plan flow states.

## Frozen boundaries

- Piper first produces a distinct orientation; the host validates and persists the typed evidence admission; only Echo may acquire narrowly targeted read-only local/web evidence for the exact admitted gap when caller constraints permit; Piper then authors the complete replacement strategy draft. Echo records source locators and reports unresolved evidence honestly. Vera verifies validity. Carren alone approves quality. The host seals, mints receipts/envelopes, and performs final completion admission.
- Ordinary workflow phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors and no other channel may substitute for missing refs. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase consequence boundaries. Ordinary permitted work has no model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; calibrated renewable inactivity leases stop stalled workers, independent host-operation deadlines remain an upper bound, and routing-only repair remains separately count-bounded. This is not OS/process sandboxing and does not isolate provider extension code.
- The exact optional composition surface is 0–1 canonical `GroundedSynthesisV1` and 0–1 canonical `DecisionV2`; Plan accepts no caller-composed prior Strategy port.
- Exact-byte composition rejects envelope-for-core, wrong kind/version, stale or substituted refs, ambiguous bindings, corrupt or incompatible semantic products, and missing validators before run creation.
- `StrategyV1` remains the canonical semantic product with `execution_started:false` and compatibility for existing valid V1 products.
- Host-derived validity and quality receipts bind the exact latest product and admitted upstream graph, including the evidence-admission artifact. Quality depends on validity; exact one-to-one worker execution evidence is reconstructed, and stale or duplicate evidence cannot complete a revised product.
- `complete/met:true` requires Carren APPROVE over the current Vera-passed product. Valid `ready`, `blocked`, and `not_applicable` planning assessments may complete. `blocked` is assessment completion, not execution readiness. Missing exact material is `incomplete` with a typed reason; it creates no internal clarification state.
- No Decide dependency, Tabitha, executor task decomposition, task graph, action, approval, mutation, execution state, false sandbox claim, native registration, promotion, or enablement authority exists. Targeted Echo evidence retrieval is read-only and never expands that consequence boundary.

## Review and repair

Vera FAIL and Carren NEEDS_REVISION expose only one closed `gap_kind` with its owner, never a target state. Carren cannot approve a major or critical finding. Product repair returns to Piper strategy authorship, then host sealing and Vera. Analysis or evidence repair returns to Piper orientation; only Piper's newly accepted typed gap may reopen bounded Echo, which then hands directly to strategy authorship.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `PLAN_FLOW`.
Validate it with `tests/plan-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill plan`.
The diagram documents omitted uniform incomplete/cancelled seams and preserves
the no-approval/no-execution candidate boundary.
