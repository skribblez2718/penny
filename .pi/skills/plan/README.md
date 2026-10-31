# Plan

`plan` is a source-defined, registered universal orchestration workflow. It is model-visible through native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
intake → orienting_strategy (Piper) → strategy_evidence_gate (host)
       → [typed gap only] gathering_strategy_evidence (Echo) → strategizing (Piper)
       → sealing_strategy (host) → verifying_strategy (Vera)
       → critiquing_strategy (Carren) → admitting_strategy (host) → complete
```

Reviewer evidence and analysis gaps use engine-owned routes back through Piper orientation and the explicit evidence gate; product gaps return to Piper strategy authorship. Every revised product is resealed and re-verified before Carren. Exhausted or stalled work terminates as `incomplete` with the exact typed reason and without resetting the state counter; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results and are not Plan flow states.

## Frozen boundaries

The generated invocation example uses the closed `PlanInvocationV2` wrapper: `{schema_version:2, request:<PlanRequestConstraintsV1>, specification_assurance:"reviewed_definition"|"semantic_only"}`. Strict review requires a completed, trace-bound Define producer and refuses before Plan run creation if its exact graph cannot be verified. V1 constraints explicitly mean `semantic_only`; V2 may request that mode explicitly. With no SpecificationV1 input the durable assurance is `not_applicable`, regardless of the requested policy. Assurance is a separate provenance claim, not a replacement for SpecificationV1 or any other Plan input. Unknown fields and versions refuse.

- Piper first produces a distinct orientation; the host validates and persists the typed evidence admission; only Echo may acquire narrowly targeted read-only local/web evidence for the exact admitted gap when caller constraints permit; Piper then authors the complete replacement strategy draft. Echo records source locators and reports unresolved evidence honestly. Vera verifies validity. Carren alone approves quality. The host seals, mints receipts/envelopes, and performs final completion admission.
- Ordinary workflow phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors and no other channel may substitute for missing refs. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase consequence boundaries. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. This is not OS/process sandboxing and does not isolate provider extension code.
- The exact optional composition surface is 0–1 each canonical `SpecificationV1`, `GroundedSynthesisV1`, `DecisionV2`, and `EvidenceContextV1`; Plan accepts no caller-composed prior Strategy port.
- Exact-byte composition rejects envelope-for-core, wrong kind/version, stale or substituted refs, ambiguous bindings, corrupt or incompatible semantic products, and missing validators before run creation.
- `StrategyV2` is the active canonical product. With SpecificationV1, it preserves mandatory requirements, acceptance conditions, hard constraints, non-goals, binding standards, assumptions, risks, and profile semantics; every required source item has one explicit disposition and every strategy outcome traces backward to source items or a derived-need rationale. Without SpecificationV1, source-item traceability is empty and standalone Plan validity remains unchanged. `StrategyV1` remains an explicit historical reader only.
- Host-derived validity and quality receipts bind the exact latest product and admitted upstream graph, including the evidence-admission artifact. Quality depends on validity; exact one-to-one worker execution evidence is reconstructed, and stale or duplicate evidence cannot complete a revised product.
- `complete/met:true` requires Carren APPROVE over the current Vera-passed product. Valid `ready`, `blocked`, and `not_applicable` planning assessments may complete. `blocked` is assessment completion, not execution readiness. Missing exact material is `incomplete` with a typed reason; it creates no internal clarification state.
- No Decide dependency, Tabitha, executor task decomposition, task graph, action, approval, mutation, execution state, false sandbox claim, native registration, promotion, or enablement authority exists. Targeted Echo evidence retrieval is read-only and never expands that consequence boundary.

Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. The host persists an exact `SealDiagnosticV1` for every rejected draft, including a final rejection on actual policy exhaustion. Only same-run feedback after the last checkpoint-selected sealed product enters the next corrective author invocation. A reviewer-driven replacement starts a new epoch; its product must again pass Vera then Carren with fresh receipts. On seal exhaustion, `seal_diagnostics` names the final diagnostic and rejected draft separately from semantic `repair_diagnostics`; any negative terminal output ref is a **rejected draft**, not an accepted product. Historical seal-feedback artifacts remain readable but never grant new corrections.

## Review and repair

Vera FAIL and Carren NEEDS_REVISION expose only one closed `gap_kind` with its owner, never a target state. Carren cannot approve a major or critical finding. Product repair returns to Piper strategy authorship, then host sealing and Vera. Analysis or evidence repair returns to Piper orientation; only Piper's newly accepted typed gap may reopen bounded Echo, which then hands directly to strategy authorship.

Vera may instead return `UNVERIFIABLE/verification_incomplete/none` with nonempty findings and evidence limitations. This terminates durably as `incomplete`, retaining the partial StrategyV2 and review report; it dispatches neither author repair nor Carren and mints no positive validity receipt or completion admission. A valid blocked strategy remains a distinct, reviewable product disposition.

Both review phases use `preserve_source_summary_v1`: the existing complete SUMMARY is the structured source judgment. Routing-only correction must preserve every field, ordered array, and confidence; missing or invalid original judgment cannot acquire PASS or APPROVE. No second review-core wire is required.

Before Vera, native host validators recheck exact bytes, schema, coverage and lineage. Only successful checks produce the canonical inline `HOST_MECHANICAL_CHECKS` statement in the verifier task; the signed task hash binds its exact product/source refs. Plan binds the raw draft digest and rechecks specification source coverage, source index and assurance when applicable. Recovery requires exactly one complete matching evidence line in the frozen task, even when contextual instructions follow it; duplicate, missing or altered evidence refuses without rewriting the task. Host failure terminates incomplete rather than asking an author to repair host evidence. These checks prove neither semantic correctness nor absence of effects. Integrity/envelope artifacts are post-review, not author deliverables.

`exact_fingerprint_v1` measures the parsed semantic candidate, current analysis/orientation and gathered evidence, admission classification, current Vera review for Carren, and failed structured checks. Report prose, confidence and semantic SUMMARY details are retained; `strategy_delta`, transport identities, revisions and receipts are excluded. The host verifies exact bytes and accepted execution bindings; unavailable or unparseable measurement returns `null`, not a stall. Request, imported and contextual inputs stay frozen. For either reviewer, recurrence of the same measured content after repair—including A/B/A—ends as `repair_stalled` with partials and current feedback reports. Changed upstream content may continue despite an unchanged draft and findings; new artifact IDs alone cannot prevent recurrence. Changed fingerprints do not prove semantic progress. No paraphrase heuristic or invented attempt/time cap is used.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `PLAN_FLOW`.
Validate it with `tests/plan-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill plan`.
The diagram documents omitted uniform incomplete/cancelled seams and preserves
the no-approval/no-execution boundary.
