# Assess candidate

`assess` is a registered universal orchestration workflow for one evidence-linked categorical assessment of a closed inline target. It is model-visible through Pi native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
host intake → Annie analysis → Carren assessment draft → host seal
            → Vera objective verification → host validity/integrity/envelope → complete
```

Host seal rejection creates a readable `SealDiagnosticV1` for the exact rejected draft, including the final rejection. Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Old diagnostics never enter a new epoch. Seal corrections do not spend semantic review repair budget. An exhausted run is incomplete; its rejected draft is not a canonical product.

## Order rules and prevented failure modes

| Order rule                                                   | Failure mode it prevents                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Host canonical intake precedes analysis                      | Workers silently changing the target, criterion importance, or supplied-evidence boundary.                          |
| Annie analyzes before Carren judges                          | The final assessment skipping decomposition or overlooking a criterion/evidence relationship.                       |
| Annie never makes the final judgment                         | Analytical framing predetermining the subjective disposition before the designated author weighs quality.           |
| Carren authors one complete draft before host sealing        | Split or conflicting judgments and model-authored lineage/digests.                                                  |
| Host sealing precedes Vera                                   | Vera verifying an unvalidated draft rather than the canonical current product.                                      |
| Vera independently checks objective invariants after Carren  | Carren's subjective judgment substituting for criterion coverage, evidence-index, disposition, or lineage validity. |
| Every repair reseals and reverifies                          | A replacement assessment inheriting stale verification evidence.                                                    |
| Host mints the validity receipt only for the current product | Old or wrong-run Vera evidence admitting a newer assessment.                                                        |

## Frozen boundaries

- Closed inline request only; no caller artifacts.
- Supplied evidence is caller-provided task material, not independently verified evidence.
- Categorical truth only: no numeric score, weighted total, ranking, or invented precision.
- Ordinary workflow phases omit `allowed_tools`; runtime therefore activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for exact predecessors, and no other channel may replace a missing predecessor ref.
- Other YAML tools are usable only when materially relevant and allowed by caller/task and phase boundaries. Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. These controls do not authorize browsing, fetching, external verification, execution, filesystem writing, change initiation, mutation, approval, enablement, or promotion.
- Carren is the assessment author, so no separate Carren approval receipt exists.
- Vera `analysis_gap` and `evidence_gap` route to Annie then Carren; `assessment_product_gap` routes to Carren. Every revision is resealed and reverified.
- Pre-review native host checks are bound into the signed verifier task as canonical `HOST_MECHANICAL_CHECKS`; they establish mechanical validity, not semantic approval or effect absence. Post-review receipts/envelopes are not verifier prerequisites.
- Vera `UNVERIFIABLE/verification_incomplete/none` ends durably incomplete with findings and evidence limitations, no author repair or positive receipt. A valid inconclusive product remains eligible for PASS; unknown effects alone are not a defect.
- Review routing repair preserves the complete original SUMMARY judgment and confidence. A missing judgment cannot acquire PASS. Exact request/candidate/failure recurrence can end `repair_stalled` on product gaps only while upstream analysis bytes remain unchanged throughout the run. Analysis/evidence gaps and any changed upstream prose are unmeasured (`null`), not proof of progress. No time/count cap or prose classifier is added.
- A current-product Vera PASS is necessary but not sufficient: deterministic integrity and envelope artifacts must bind exact accepted execution evidence before CompletionGate v2 admission.
- Any valid disposition—`meets`, `partially_meets`, `does_not_meet`, `inconclusive`, or `not_applicable`—may complete.

See `resources/reference.md` for the wire contract and `resources/flow.html` for the exact topology.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `ASSESS_FLOW`.
Validate it with `tests/assess-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill assess`.
It preserves Carren's authorship and Vera's verification roles while documenting
uniform omitted negative seams and out-of-band errors.
