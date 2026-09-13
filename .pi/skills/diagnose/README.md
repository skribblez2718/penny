# Diagnose candidate

`diagnose` is a source-defined, registered universal orchestration workflow. It is model-visible through native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
intake → Annie causal decomposition → Ida competing hypotheses
       → Demetri adjudication + proposed non-executed checks
       → host canonical seal → Vera validity verification
       → host validity receipt + integrity/envelope admission → complete
```

## Frozen boundaries

- Analysis only: no test execution, probe execution, external retrieval, remediation, taskification, mutation, or approval.
- Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for exact predecessors and no other channel may replace a missing ref. Other YAML tools are usable only when materially relevant and allowed by caller/task and this analysis-only boundary. Ordinary permitted work has no model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; calibrated renewable inactivity leases stop stalled workers, independent host-operation deadlines remain an upper bound, and routing-only repair remains separately count-bounded, and neither grants external-acquisition, remediation, execution, or mutation authority.
- Annie decomposes causes; Ida forms competing hypotheses; Demetri ranks and adjudicates; the host seals; Vera verifies validity; the host alone mints receipts and admits completion.
- Vera `analysis_gap` and `evidence_gap` return through Annie, Ida, and Demetri. `diagnosis_product_gap` returns to Demetri. Every revision is resealed and reverified.
- There is no Carren phase.
- The host derives canonical `DiagnosisV1` with exact request/decomposition/hypotheses/draft lineage and literal `tests_executed:false` and `remediation_started:false`.
- A current-product Vera PASS is necessary but not sufficient: deterministic integrity and envelope artifacts must bind the exact accepted execution evidence before completion.
- Valid `inconclusive` and `not_applicable` outcomes may complete. Missing exact material or exhausted repair is non-positive `incomplete`.

See `resources/reference.md` for the wire contract and `resources/flow.html` for the state-machine mirror.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `DIAGNOSE_FLOW`.
Validate it with `tests/diagnose-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill diagnose`.
Its notes document omitted uniform negative seams and out-of-band faults without
adding Carren, test-execution, or remediation routes.
