# SCA Reference

## Status

This is a proposed descriptor and contract reference for a model-disabled development package. It is not current engine authority. The future `SCA_FLOW` TypeScript descriptor must replace proposal status and agree exactly with `flow.html` before registration.

## Proposed state vocabulary

### Host, gate, operator, and terminal states

`intake`, `admitting_snapshot_policy`, `awaiting_user`, `building_program_index`, `building_semantic_graph`, `running_taint`, `running_rules`, `auditing_dependencies`, `auditing_secrets`, `assembling_security_evidence`, `recomputing_candidates`, `validating_candidate_rules`, `running_candidate_rules`, `assembling_augmented_candidates`, `hypothesis_search`, `dispatching_child_skill`, `accepting_child_result`, `dynamic_execution_gate`, `running_dynamic_verification`, `recording_disposition`, `promoting_verified_rules`, `computing_coverage`, `sealing_security_assessment`, `sealing_results`, `completion_gate`, `complete`, `incomplete`.

### Direct cognitive states

`integrating_security_model`, `generating_candidate_rules`, `generating_hypotheses`, `selecting_next_action`, `analyzing_candidate`, `exploring_evidence_gap`, `designing_verification`, `taskifying_verification`, `verifying_evidence`, `critiquing_finding`, `verifying_coverage`, `synthesizing_security_assessment`, `verifying_security_assessment`, `materializing_report`, `critiquing_report`, `verifying_final_product`.

### Child workflow nodes

`child_research`, `child_decide`, `child_plan`.

The SCA V1 child dispatcher must reject every other target. Current `diagnose`, `assess`, and `produce` contracts accept no caller artifacts and are intentionally composed from focused catalog agents inside SCA rather than through inline evidence repackaging. Child nodes represent exact child runs, not inlined child payloads or duplicated child state machines. Each child's internal descriptor remains authoritative for that child run.

## Threat-context and security-model contract

`ScaRequestV1` does not require a threat model. It accepts optional caller-supplied threat-context hints or one exact supplied model ref and admits `threat_model_mode: adaptive | formal_required`, defaulting to `adaptive`. Admission freezes those inputs, their absence, and the modeling policy; it must not claim that a derived model already exists or ask a generic threat-model questionnaire.

`program-index` discovers in-scope architecture, deployment, security, privacy, data-flow, and threat-model documents. These remain target-controlled claims, may be stale, and never become control-plane authority. `assembling_security_evidence` preserves their provenance separately from caller context and observed program/tool facts.

After baseline fan-in, `integrating_security_model` produces an immutable versioned `SecurityModelV1` containing:

- interfaces and entry points;
- assets, sensitive data, actors/principals, and privilege transitions;
- trust boundaries, external systems, deployment assumptions, and attack surfaces;
- critical actions, security invariants, expected controls, sources, sinks, and guards;
- conflicts and material unknowns with their potential impact; and
- exact evidence refs plus a classification of each element as observed fact, caller context, target claim, inference, assumption, conflict, or unknown.

Default `adaptive` mode produces this lean operational model rather than an exhaustive STRIDE/LINDDUN worksheet. `formal_required` adds the complete formal deliverable specified by the admitted request. A material business-logic, authorization, privacy, deployment, protocol, cross-service, or other global model gap routes through the same Synthia state with changed evidence, assumptions, and expected observations. Each refinement creates a successor model revision; hypotheses, candidate-rule intents, coverage, and final products bind the exact revision used.

Ida turns the current model into bounded falsifiable vulnerability and abuse hypotheses. Focused user clarification occurs only when a concrete unresolved assumption would materially change a finding, evidence obligation, generated-rule intent, or coverage claim.

## Proposed controller intents

The `selecting_next_action` result chooses one legal action family within the admitted request; it cannot expand scope, authority, budget, child target set, or completion truth:

- focused Annie candidate analysis;
- focused Echo evidence acquisition;
- Ida hypothesis/variant generation;
- `refine_security_model` for one material security/threat-model gap with changed evidence, assumption, method, or expected observation;
- universal child `research`, `decide`, or `plan`;
- targeted verification design;
- direct evidence verification when existing static evidence is sufficient;
- coverage-closure proposal; or
- honest incomplete termination when no useful action remains.

The engine, not the model, resolves each intent to a registered edge and enforces budgets, gates, exact input ports, and exhaustion successors. Post-disposition generated-rule routing is host-owned rather than a controller authority expansion.

## Generated-rule augmentation and promotion

The proposed flow has two rule-generation triggers that share one fail-closed pipeline:

1. **Confirmed-finding variant mining — phase one.** After a finding has normal `CONFIRMED` evidence plus Carren approval, the host may route its exact root-cause specification to `generating_candidate_rules`.
2. **Security-model gap generation — phase two.** After `integrating_security_model`, an admitted policy may accept bounded rule intents grounded in the exact current model revision and trust-boundary, source, sink, guard, observed-pattern, or unresolved-gap refs. This trigger remains disabled until phase one is measured and useful.

`generating_candidate_rules` materializes constrained Semgrep YAML and synthetic positive and safe/fixed negative fixtures. `validating_candidate_rules` checks schema, allowed features, pinned-engine compatibility, fixtures, duplicate/overmatch metadata, provenance, scope, and finite budgets. `running_candidate_rules` scans only validated overlays against the same frozen target snapshot. `assembling_augmented_candidates` records matches, no-intent/disabled outcomes, and typed validation/scan failures before Ida creates hypotheses. No generated match may confirm itself.

Every candidate execution binds the immutable baseline release/profile digest, candidate rule/fixture digest, target snapshot digest, generator and trigger evidence refs, engine identity, arguments/policy, raw result, normalized hypotheses, coverage, and typed failure state. The campaign's admitted baseline release is never changed.

After ordinary evidence verification and critique confirms a finding matched by a generated rule, `promoting_verified_rules` may run under pre-admitted write authority. It requires a sanitized/generalized detector or explicit target scope, atomically persists rule/fixtures/provenance in the caller-supplied external authoring workspace, validates/tests the resulting corpus, and builds a successor immutable release for future campaigns. It emits the successor release digest or an explicit `skipped_no_authority`/typed failure outcome. Promotion outcome does not alter finding truth and never changes the current campaign baseline.

## Evidence and terminal dispositions

Each hypothesis reaches one of:

- `CONFIRMED`;
- `REJECTED_WITH_EVIDENCE`;
- `INCONCLUSIVE`;
- `DEFERRED` with reason;
- `DUPLICATE_OF` an exact hypothesis ID; or
- `OUT_OF_SCOPE` with reason.

A dynamic negative result cannot support `REJECTED_WITH_EVIDENCE` unless target coverage proves the relevant site and behavior were exercised. A Semgrep match, including a generated-rule match, is a hypothesis and never terminal truth. Unsupported tools, candidate-rule failures, absent promotion authority, and language capabilities remain explicit coverage/lifecycle facts.

## Proposed completion gate

`complete/met:true` requires all of the following on the current admitted snapshot:

1. snapshot, scope, authority, optional threat inputs/modeling policy, baseline release/profile, candidate workspace, and tool identities are exact and current;
2. the latest security/threat-model revision is exact, all material unknowns are resolved or disclosed with impact, and every hypothesis or rule intent binds the revision it used;
3. every required analysis family is complete, supported with disclosed limitation, or explicitly unsupported;
4. every admitted high-priority hypothesis has a terminal disposition;
5. every confirmed finding satisfies its typed evidence contract;
6. every admitted candidate-rule action has an exact validated/failed/skipped/scan outcome and every eligible promotion has a successor-release or explicit skipped/failed outcome;
7. current Vera evidence and coverage verification pass;
8. the current SCA assessment core has Vera PASS and the current report has Carren APPROVE;
9. exact `research`, `decide`, and `plan` child refs are compatible wherever those children were used;
10. deterministic findings, SARIF, coverage, hypothesis, evidence, security-model, generated-rule/promotion, graph, report, and tool manifests are sealed;
11. current final-product Vera verification passes; and
12. no required budget is exhausted and no blocking unresolved policy remains.

Completion means the admitted campaign completed under disclosed coverage. It never means the repository is free of vulnerabilities.

## Uniform omitted seams

The visual flow omits per-state cancel, malformed-result, dispatch-pause, and infrastructure-error edges to keep the graph legible. The registered descriptor and tests must still provide the engine-standard cancellation, bounded structural repair, pause/recover, and typed error behavior. No omitted seam may become a success edge.
