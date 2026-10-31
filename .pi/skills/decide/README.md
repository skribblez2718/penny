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
- Ordinary workflow phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors and no other channel may substitute for missing refs. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase consequence boundaries. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. This is not OS/process sandboxing and does not isolate provider extension code.
- Exact artifact handoff is mandatory. Request, analysis, evidence packet, draft, review, receipt, and feedback refs are transport lineage, never semantic basis IDs. Only admitted native exact `GroundedSynthesisV1` or `EvidenceContextV1` refs may be artifact basis IDs; nonbinding contextual refs do not become native evidence.
- `DecisionV2` remains the canonical semantic product with `execution_started:false`.
- Host-derived validity and quality receipts bind the exact latest product, admitted upstream digest, report, reviewer verdict, and signed execution result. Quality depends on validity.
- A deterministic integrity artifact and `DecisionProductEnvelopeV1` bind the full exact graph, including the host evidence-admission artifact and one-to-one accepted worker execution evidence.
- `complete/met:true` requires Carren APPROVE over the current Vera-passed product. Valid `unresolved` and `not_applicable` assessments may complete. Missing exact material is `incomplete` with a typed reason; it creates no internal clarification state.
- No execution, taskification, external mutation, false sandbox claim, native registration, promotion, or enablement authority exists.

Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. The host persists an exact `SealDiagnosticV1` for every rejected draft, including a final rejection on actual policy exhaustion. Only same-run feedback after the last checkpoint-selected sealed product enters the next corrective author invocation. A reviewer-driven replacement starts a new epoch; its product must again pass Vera then Carren with fresh receipts. On seal exhaustion, `seal_diagnostics` names the final diagnostic and rejected draft separately from semantic `repair_diagnostics`; any negative terminal output ref is a **rejected draft**, not an accepted product. Historical seal-feedback artifacts remain readable but never grant new corrections.

## Review and repair

Vera FAIL and Carren NEEDS_REVISION expose only one closed `gap_kind` with its owner, never a target state. Carren cannot approve a major or critical finding. Product repair returns to Demetri, then host sealing and Vera. Analysis or evidence repair returns to Annie; only Annie's newly accepted typed gap may reopen bounded Echo, which then hands directly to Demetri. Stale receipts cannot complete a revised product.

Vera may instead return `UNVERIFIABLE/verification_incomplete/none` with nonempty findings and evidence limitations. This terminates durably as `incomplete`, retaining the partial DecisionV2 and review report; it dispatches neither author repair nor Carren and mints no positive validity receipt or completion admission. A valid unresolved decision remains a distinct, reviewable product disposition.

Both review phases use `preserve_source_summary_v1`: the existing complete SUMMARY is the structured source judgment. Routing-only correction must preserve every field, ordered array, and confidence; missing or invalid original judgment cannot acquire PASS or APPROVE. No second review-core wire is required.

Before Vera, native host validators recheck exact bytes, schema, coverage and lineage. Only successful checks produce the canonical inline `HOST_MECHANICAL_CHECKS` statement in the verifier task; the signed task hash binds its exact product/source refs. Decide binds the canonical parsed draft digest, not the raw report digest. Recovery requires exactly one complete matching evidence line in the frozen task, even when contextual instructions follow it; duplicate, missing or altered evidence refuses without rewriting the task. Host failure terminates incomplete rather than asking an author to repair host evidence. These checks prove neither semantic correctness nor absence of effects. Integrity/envelope artifacts are post-review, not author deliverables.

`exact_fingerprint_v1` measures the parsed semantic candidate, current analysis/orientation and gathered evidence, admission classification, current Vera review for Carren, and failed structured checks. Report prose, confidence and semantic SUMMARY details are retained; `strategy_delta`, transport identities, revisions and receipts are excluded. The host verifies exact bytes and accepted execution bindings; unavailable or unparseable measurement returns `null`, not a stall. Request, imported and contextual inputs stay frozen. For either reviewer, recurrence of the same measured content after repair—including A/B/A—ends as `repair_stalled` with partials and current feedback reports. Changed upstream content may continue despite an unchanged draft and findings; new artifact IDs alone cannot prevent recurrence. Changed fingerprints do not prove semantic progress. No paraphrase heuristic or invented attempt/time cap is used.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `DECIDE_FLOW`.
It is checked by `tests/decide-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill decide`.
Uniform incomplete/cancelled seams and out-of-band engine errors are documented,
not invented as descriptor edges.
