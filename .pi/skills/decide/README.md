# Decide candidate

`decide` is a source-defined, registered universal orchestration workflow. It is model-visible through native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
intake → analyzing_decision (Annie) → decision_evidence_gate (host)
       → [typed gap only] gathering_decision_evidence (Echo) → deciding (Demetri)
       → sealing_decision (host) → verifying_decision (Vera)
       → critiquing_decision (Carren) → admitting_decision (host) → complete
```

Reviewer evidence and analysis gaps use engine-owned routes back through Annie and the explicit evidence gate; product gaps return to Demetri. Every repaired product is resealed and re-verified. Exhausted or stalled work terminates as `incomplete` with the exact typed reason and without resetting the state counter; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results and are not Decide flow states.

## Frozen boundaries

- Annie analyzes; the host validates and persists the typed evidence admission; only Echo may acquire narrowly targeted read-only local/web evidence for the exact admitted gap when caller constraints permit; Demetri authors; Vera verifies validity; Carren alone approves quality; the host seals, mints receipts/envelopes, and performs final completion admission. Echo records source locators and reports unresolved evidence honestly.
- Ordinary workflow phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors and no other channel may substitute for missing refs. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase consequence boundaries. Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair remains at 0. This is not OS/process sandboxing and does not isolate provider extension code.
- Exact artifact handoff is mandatory. Request, analysis, evidence packet, draft, review, receipt, and feedback refs are transport lineage, never semantic basis IDs. Only admitted exact `GroundedSynthesisV1` refs may be artifact basis IDs.
- `DecisionV2` remains the canonical semantic product with `execution_started:false`.
- Host-derived validity and quality receipts bind the exact latest product, admitted upstream digest, report, reviewer verdict, and signed execution result. Quality depends on validity.
- A deterministic integrity artifact and `DecisionProductEnvelopeV1` bind the full exact graph, including the host evidence-admission artifact and one-to-one accepted worker execution evidence.
- `complete/met:true` requires Carren APPROVE over the current Vera-passed product. Valid `unresolved` and `not_applicable` assessments may complete. Missing exact material is `incomplete` with a typed reason; it creates no internal clarification state.
- No execution, taskification, external mutation, false sandbox claim, native registration, promotion, or enablement authority exists.

## Review and repair

Vera FAIL and Carren NEEDS_REVISION expose only one closed `gap_kind` with its owner, never a target state. Carren cannot approve a major or critical finding. Product repair returns to Demetri, then host sealing and Vera. Analysis or evidence repair returns to Annie; only Annie's newly accepted typed gap may reopen bounded Echo, which then hands directly to Demetri. Stale receipts cannot complete a revised product.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `DECIDE_FLOW`.
It is checked by `tests/decide-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill decide`.
Uniform incomplete/cancelled seams and out-of-band engine errors are documented,
not invented as descriptor edges.
