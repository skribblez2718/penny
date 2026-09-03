---
name: diagnose
description: "Create a durable reviewed causal diagnosis from supplied symptoms, observations, environment facts, constraints, non-goals, and uncertainty. Use when the caller needs supported, inconclusive, or not-applicable causal assessment with ranked competing hypotheses and optional non-executed discriminating checks. Do not use to execute tests, perform remediation, plan changes, or mutate anything."
disable-model-invocation: false
metadata:
  penny:
    engine: orchestration
    release_status: candidate
    mempalace: false
    subagents: [annie, ida, demetri, vera]
---

## When to Use

- Diagnose a supplied symptom set against supplied observations and environment facts.
- Rank a complete bounded set of competing causal hypotheses.
- Produce an honest `supported`, `inconclusive`, or `not_applicable` causal assessment.
- Propose discriminating checks without executing them when the request permits proposals.

## When Not to Use

- Execute tests, commands, probes, network requests, or filesystem inspection.
- Remediate, taskify, implement, deploy, mutate, or approve changes.
- Perform live external research or invent observations that the caller did not supply.

## Invocation Boundary

This package is a model-visible candidate: Pi native discovery and Penny's model-facing catalog may describe it, but it remains absent from the production registry and never self-enables or promotes. Model visibility grants no execution authority. Explicit `skill` invocation is available only when ignored host configuration enables the exact candidate contract digest. Candidate enablement is reversible and is not production admission or promotion.

## Orchestrated Flow

```text
intake (host canonical request)
  → decomposing_causes (Annie)
  → generating_hypotheses (Ida)
  → adjudicating_diagnosis (Demetri)
  → sealing_diagnosis (host canonical seal)
  → verifying_diagnosis (Vera)
  → admitting_diagnosis (host exact-core validity receipt + integrity/admission)
  → complete
```

Vera returns only PASS or one closed gap kind and repair owner. Engine-owned routes send `analysis_gap` and `evidence_gap` to Annie, then Ida and Demetri; `diagnosis_product_gap` returns to Demetri. Every revision returns through host sealing and Vera verification. There is no Carren phase. Exhausted, stalled, malformed, or missing-exact-input work terminates honestly as `incomplete`; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results rather than Diagnose states.

## Exact Artifact Handoff

The host canonicalizes and persists `DiagnosisRequestV1`. Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the analysis-only phase consequence boundary; they cannot enlarge the closed supplied-evidence boundary, execute tests or probes, begin remediation, or mutate anything.

The request contains observations directly; Diagnose V1 accepts no caller artifact inputs and performs no external acquisition. Request, decomposition, hypotheses, draft, report, receipt, integrity, envelope, and feedback IDs are exact transport lineage, not independent semantic evidence. Normal-phase liveness caps external calls at 8 per worker and 64 per run, while routing-only repair remains at 0; these ceilings do not grant external-acquisition or action authority.

## Product and Verification Truth

Demetri emits exactly one closed `DIAGNOSIS_CORE:<json>` line and one adjacent SUMMARY. The host validates request coverage, evidence indexes, hypothesis ranks/statuses, disposition invariants, proposed-check boundaries, and literal `tests_executed:false` and `remediation_started:false`, then seals canonical `DiagnosisV1` bytes with exact request/Annie/Ida/Demetri lineage.

Vera independently verifies the current sealed product. The host mints `DiagnosisValidityReceiptV1` only from a signed current-run Vera PASS bound to that exact current subject. It then deterministically validates product integrity and emits `DiagnosisProductEnvelopeV1` before CompletionGate v2 admission. Any revision makes older verification evidence stale.

`complete/met:true` means the causal assessment is complete and verified; it does not mean a cause was supported. Valid `inconclusive` and `not_applicable` products may complete. The candidate has no `await_user`, approval, action, or same-run response state.

## Consequence Boundary

No path executes a test, probe, command, remediation, mutation, task, deployment, external read, or provider tool; claims sandbox isolation; registers natively; enables the candidate; promotes it; or creates action state.
