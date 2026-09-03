# Assess candidate

`assess` is a source-defined orchestration candidate for one evidence-linked categorical assessment of a closed inline target. It is model-visible: Pi native discovery and Penny's model-facing catalog may describe it, but visibility grants no execution authority. It remains outside the production registry and never self-enables or promotes. Explicit `skill` invocation is available only when ignored host configuration enables its exact contract digest.

```text
host intake → Annie analysis → Carren assessment draft → host seal
            → Vera objective verification → host validity/integrity/envelope → complete
```

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

- Closed inline request only; V1 accepts no caller artifacts.
- Supplied evidence is caller-provided task material, not independently verified evidence.
- Categorical truth only: no numeric score, weighted total, ranking, or invented precision.
- Ordinary candidate phases omit `allowed_tools`; runtime therefore activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for exact predecessors, and no other channel may replace a missing predecessor ref.
- Other YAML tools are usable only when materially relevant and allowed by caller/task and phase boundaries. Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair stays at 0. These ceilings do not authorize browsing, fetching, external verification, execution, filesystem writing, change initiation, mutation, approval, enablement, or promotion.
- Carren is the assessment author, so no separate Carren approval receipt exists.
- Vera `analysis_gap` and `evidence_gap` route to Annie then Carren; `assessment_product_gap` routes to Carren. Every revision is resealed and reverified.
- A current-product Vera PASS is necessary but not sufficient: deterministic integrity and envelope artifacts must bind exact accepted execution evidence before CompletionGate v2 admission.
- Any valid disposition—`meets`, `partially_meets`, `does_not_meet`, `inconclusive`, or `not_applicable`—may complete.

See `resources/reference.md` for the wire contract and `resources/flow.html` for the exact topology.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `ASSESS_FLOW`.
Validate it with `tests/assess-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill assess`.
It preserves Carren's authorship and Vera's verification roles while documenting
uniform omitted negative seams and out-of-band errors.
