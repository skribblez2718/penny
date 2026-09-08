# SCA

Design-stage resources for a future engine-owned Secure Code Analysis (`sca`) domain skill. The package is model-disabled and contains no executable delegate. No TypeScript playbook or runtime registration exists yet.

## Chosen execution envelope

The target is one durable SCA run whose controller may dispatch catalog-agent states, host-owned operators, and a closed set of universal child skills. Penny's engine does not currently expose child-skill dispatch, aggregate parent/child budgets, or atomic child recovery. Those are explicit prerequisites; the package must remain model-disabled until they exist.

The target child-skill set is closed to:

- `research` for durable external evidence;
- `decide` for a durable choice among known investigation alternatives; and
- `plan` for a reviewed multi-step verification strategy.

Current `diagnose`, `assess`, and `produce` V1 requests accept no caller artifacts. SCA therefore does not repack exact evidence into inline statements to force composition: it uses Annie/Ida/Demetri/Vera directly for causal work, and Synthia/Vera/Skribble/Carren plus host sealing for final assessment and reporting. A full child skill is dispatched only when its complete compatible contract earns the overhead. Focused gaps use the smallest suitable catalog agent instead.

## Direct cognitive states

| Proposed state                     | Owner    | Mission                                                                                         |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `integrating_security_model`       | Synthia  | Derive a versioned evidence-grounded security/threat model; refine it only for material gaps.   |
| `generating_candidate_rules`       | Skribble | Materialize Semgrep YAML and synthetic fixtures from an exact model-gap or confirmed-root spec. |
| `generating_hypotheses`            | Ida      | Generate bounded hypotheses from baseline, semantic, and candidate-rule evidence.               |
| `selecting_next_action`            | Demetri  | Select the smallest legal next action with the highest expected information value.              |
| `analyzing_candidate`              | Annie    | Analyze one supplied candidate slice, guards, relations, and competing explanations.            |
| `exploring_evidence_gap`           | Echo     | Acquire one admitted, focused contextual or external evidence gap.                              |
| `designing_verification`           | Piper    | Form a targeted verification strategy when the next experiment is non-obvious.                  |
| `taskifying_verification`          | Tabitha  | Convert an approved strategy into bounded executable checks for the host operator.              |
| `verifying_evidence`               | Vera     | Test current finding evidence against the weakness-family confirmation contract.                |
| `critiquing_finding`               | Carren   | Challenge exploitability reasoning and false-positive risk after objective verification.        |
| `verifying_coverage`               | Vera     | Verify coverage-ledger completeness and disclosed limitations.                                  |
| `synthesizing_security_assessment` | Synthia  | Integrate terminal hypotheses, findings, evidence, and coverage into the SCA assessment core.   |
| `verifying_security_assessment`    | Vera     | Verify the current sealed assessment core before report work.                                   |
| `materializing_report`             | Skribble | Materialize the human report from the exact verified assessment core.                           |
| `critiquing_report`                | Carren   | Critique final narrative quality and evidence communication.                                    |
| `verifying_final_product`          | Vera     | Verify current final-product lineage, criterion coverage, and evidence references.              |

## Host-owned operators and traditional tools

| Internal operator           | Position                   | Traditional tools behind the typed host boundary                                                                                            |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `program-index`             | Baseline acquisition       | Git/filesystem census, language/build detection, Tree-sitter, optional SCIP, and discovery of relevant repository documents as evidence.    |
| `semantic-graph`            | After indexing             | Joern initially; optional licensed CodeQL backend where permitted.                                                                          |
| `taint`                     | After semantic graph       | Joern data-flow/taint and optional licensed CodeQL taint queries.                                                                           |
| `rules`                     | Baseline and candidate     | Semgrep CE against an immutable external release/profile or a host-validated run-scoped candidate overlay.                                  |
| `candidate-rule-validation` | Before candidate scan      | Schema/feature checks, pinned-engine validation, synthetic positive/negative fixtures, digesting, provenance, and budget enforcement.       |
| `rulepack-promotion`        | Post-confirmation          | Atomically persist an eligible generated rule/fixtures/provenance and build a successor immutable external release for future campaigns.    |
| `dependency-audit`          | Parallel baseline          | OSV-Scanner and ecosystem-native lockfile resolution where needed.                                                                          |
| `secret-audit`              | Parallel baseline          | An approved dedicated deterministic secret scanner.                                                                                         |
| `hypothesis-search`         | Campaign loop hub          | Evidence-ledger queries, bounded slices, candidate lookup, deduplication, and progress accounting.                                          |
| `dynamic-verification`      | Gated evidence acquisition | Build/test runners, coverage, differential/invariant tests, fuzzers, and compiler/runtime sanitizers inside the admitted isolation profile. |

Agents request operator actions; host code validates and executes them. Workers do not receive raw CPGQL/Scala, scanner shell, compiler, fuzzer, container, Docker-socket, or unrestricted target-execution authority.

## Loop points

1. **Security/threat-model and generated-rule augmentation loop:** Admission supplies only optional caller threat context/model refs and an adaptive-or-formal policy. After baseline evidence, Synthia derives a versioned operational security/threat model and, under the phase-two policy, bounded rule intents. Host code applies semantic overlays, Skribble materializes candidate rules/fixtures, validation fails closed, and `rules` candidate mode scans the same frozen snapshot. A material model gap re-enters Synthia with changed evidence or assumptions; the augmented fan-in preserves an explicit disabled/no-intent/failure result before Ida updates hypotheses.
2. **Investigation loop:** `hypothesis-search` prepares the current ledger; Demetri chooses one focused agent, child skill, operator request, verification path, or coverage proposal. Every result returns to the ledger.
3. **Verification repair loop:** Vera gaps or Carren challenges return to `hypothesis-search`. A new pass requires a non-empty strategy change and expected new evidence. Exact repeats stall and escalate or exhaust.
4. **Confirmed-finding rule loop:** a confirmed root cause may re-enter candidate authoring for same-snapshot variant mining. A generated-rule match that normal Vera/Carren verification confirms may enter host promotion; promotion creates a successor external release for future campaigns or records an explicit skipped/failed outcome. Variant mining is phase one; model-gap rule generation is enabled only after that path proves useful.
5. **Coverage loop:** Vera coverage gaps return to the campaign loop. Progression requires every required analysis family and candidate-rule/promotion outcome to be complete, supported-with-limitations, or explicitly unsupported; all admitted high-priority hypotheses must have terminal dispositions.
6. **Assessment/report loop:** Vera assessment gaps return to the campaign; Carren report gaps return to Skribble when the verified core is unchanged or to the controller when evidence/assessment changed. Every changed core is reverified before reporting.
7. **Final admission loop:** final-product or host-admission gaps return to the smallest responsible producer through the controller. Success is host-gated; budget/stall/required-backend failure is `incomplete/met:false`.

## Order rules and prevented failure modes

| Order rule                                                                                                                 | Failure mode it prevents                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Immutable snapshot, scope, authority, optional threat context, modeling policy, and budgets precede scanner or model work. | Findings, assumptions, provenance, cost, or authority drifting during a long audit.      |
| `program-index` precedes `semantic-graph`, and `semantic-graph` precedes deterministic `taint`.                            | Taint and slices being computed against missing or stale program identities.             |
| Baseline operators precede the first derived security/threat model.                                                        | Generic pre-evidence threat enumeration and model context spent on repository mechanics. |
| Repository threat/architecture/security documents remain target-controlled evidence.                                       | Stale or adversarial target claims becoming trusted threat-model authority.              |
| Candidate-rule validation and fixtures precede same-snapshot candidate scanning.                                           | Invalid, unbounded, or untested generated rules entering the hypothesis ledger.          |
| Candidate scans preserve the admitted baseline release and frozen target digest.                                           | Same-campaign learning silently changing the baseline or contaminating reproducibility.  |
| Objective Vera evidence verification precedes Carren's subjective exploitability critique.                                 | Treating critique as proof or spending critique cycles on structurally invalid evidence. |
| Tabitha's bounded verification task precedes `dynamic-verification`.                                                       | A model-authored strategy becoming an unvalidated executable action.                     |
| Dynamic execution passes the host policy/approval gate.                                                                    | Unadmitted target code, network, credentials, or host capabilities being exposed.        |
| Every repair returns through Vera and every changed final product is reverified.                                           | A repair silently invalidating earlier evidence or lineage.                              |
| Verified generated-rule matches and admitted write authority precede rulepack promotion.                                   | Self-confirming detections or unauthorized mutation of the external rulepack.            |
| A promotion builds a successor release for future campaigns only.                                                          | Mid-campaign baseline drift and irreproducible scan lineage.                             |
| Coverage closure precedes Synthia assessment synthesis and report materialization.                                         | A polished report hiding open high-priority hypotheses or unsupported analysis families. |
| Vera verifies the sealed assessment core before Skribble/Carren report work.                                               | Narrative work proceeding from an objectively invalid or stale SCA core.                 |
| Host product sealing and CompletionGate admission follow all agent and child products.                                     | A child skill or report approval becoming SCA terminal truth without aggregate checks.   |

## Exact handoff and state

The owner persists complete worker and child terminal bytes before routing. The SCA checkpoint stores exact selected refs, child-run identities, budgets, current security/threat-model revision, prior-model lineage, and compact ledger state; it never stores source, report, or evidence payload bytes. Memory is optional advisory context and never workflow transport or completion evidence.

## Implementation prerequisites

1. Freeze `ScaRequestV1`, optional threat-context and threat-model-policy inputs, versioned `SecurityModelV1`, evidence, candidate, generated-rule, rulepack-promotion, hypothesis, coverage, finding, execution, product, and terminal schemas.
2. Add a registered child-skill directive closed to `research | decide | plan`, with typed compatible ports, exact terminal refs, parent/child run linkage, aggregate budgets, cancellation, recovery, and failure semantics.
3. Implement typed host operator/service boundaries for baseline/candidate rules, candidate-rule validation, external rulepack promotion, and external isolation for target execution.
4. Implement and register `apps/orchestration/src/playbooks/sca.ts` plus `SCA_FLOW` matching `resources/flow.html`.
5. Replace these design prompts with final registration-bound contracts where they change during manual proof.
6. Add playbook, child-dispatch, operator, candidate-rule fixture/scan/promotion, artifact, gate, recovery, stall, exhaustion, flow-drift, browser, security, and live-entrypoint tests.
7. Keep the child set closed to the artifact-compatible `research`, `decide`, and `plan` contracts. `diagnose`, `assess`, and `produce` are not SCA V1 child targets.

## Implementation locations

- Planned playbook: `apps/orchestration/src/playbooks/sca.ts`
- Planned tests: `apps/orchestration/tests/sca-playbook.test.ts`
- Flow design target: `resources/flow.html`
