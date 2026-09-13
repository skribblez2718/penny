---
name: diagnose
description: "Create a durable reviewed causal diagnosis from supplied symptoms, observations, environment facts, constraints, non-goals, and uncertainty. Use when the caller needs supported, inconclusive, or not-applicable causal assessment with ranked competing hypotheses and optional non-executed discriminating checks. Do not use to execute tests, perform remediation, plan changes, or mutate anything."
metadata:
  penny:
    engine: orchestration
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

This is a model-visible, registered universal package. Pi native discovery and Penny's model-facing catalog may describe it, and explicit `skill` invocation is routed through the sole executable playbook registry with its bound contract. Model visibility does not bypass host-owned authorization or consequence boundaries.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "diagnose",
  goal: "Diagnose the reported startup failure.",
  constraints: {"environment_facts":[],"hard_constraints":[{"statement":"Do not execute tests."}],"known_uncertainties":[],"non_goals":[],"permitted_test_boundary":{"mode":"proposal_only"},"schema_version":1,"supplied_observations":[],"symptoms":[{"statement":"The service exits during startup."}]},
});
```

The request port is `penny.diagnosis-request.v1` v1. Returns a causal assessment and optional proposed checks; it executes neither.

### Contract I/O

- `diagnosis_request` — input/inline_request; schema `penny.diagnosis-request.v1` v1; 1..1 item(s).
- `diagnosis` — output/artifact; schema `penny.diagnosis.v1` v1; 1..1 item(s); artifact kind semantic-core.

### Runtime constraints schema

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "required": [
    "schema_version",
    "symptoms",
    "supplied_observations",
    "environment_facts",
    "hard_constraints",
    "non_goals",
    "known_uncertainties",
    "permitted_test_boundary"
  ],
  "properties": {
    "schema_version": {
      "type": "number",
      "const": 1
    },
    "symptoms": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "statement"
        ],
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 64
    },
    "supplied_observations": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "statement"
        ],
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          },
          "source_label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          }
        },
        "additionalProperties": false
      },
      "maxItems": 64
    },
    "environment_facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "statement"
        ],
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 64
    },
    "hard_constraints": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "statement"
        ],
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 64
    },
    "non_goals": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "statement"
        ],
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 64
    },
    "known_uncertainties": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "statement"
        ],
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 64
    },
    "permitted_test_boundary": {
      "type": "object",
      "required": [
        "mode"
      ],
      "properties": {
        "mode": {
          "anyOf": [
            {
              "type": "string",
              "const": "proposal_only"
            },
            {
              "type": "string",
              "const": "none"
            }
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

<!-- PENNY:GENERATED-INVOCATION:END -->

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

The host canonicalizes and persists `DiagnosisRequestV1`. Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the analysis-only phase consequence boundary; they cannot enlarge the closed supplied-evidence boundary, execute tests or probes, begin remediation, or mutate anything.

The request contains observations directly; Diagnose V1 accepts no caller artifact inputs and performs no external acquisition. Request, decomposition, hypotheses, draft, report, receipt, integrity, envelope, and feedback IDs are exact transport lineage, not independent semantic evidence. Normal permitted work has no model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; calibrated renewable inactivity leases stop stalled workers, independent host-operation deadlines remain an upper bound, and routing-only repair remains separately count-bounded. Neither permits external acquisition or action beyond the request boundary.

## Product and Verification Truth

Demetri emits exactly one closed `DIAGNOSIS_CORE:<json>` line and one adjacent SUMMARY. The host validates request coverage, evidence indexes, hypothesis ranks/statuses, disposition invariants, proposed-check boundaries, and literal `tests_executed:false` and `remediation_started:false`, then seals canonical `DiagnosisV1` bytes with exact request/Annie/Ida/Demetri lineage.

Vera independently verifies the current sealed product. The host mints `DiagnosisValidityReceiptV1` only from a signed current-run Vera PASS bound to that exact current subject. It then deterministically validates product integrity and emits `DiagnosisProductEnvelopeV1` before CompletionGate v2 admission. Any revision makes older verification evidence stale.

`complete/met:true` means the causal assessment is complete and verified; it does not mean a cause was supported. Valid `inconclusive` and `not_applicable` products may complete. The candidate has no `await_user`, approval, action, or same-run response state.

## Consequence Boundary

No path executes a test, probe, command, remediation, mutation, task, deployment, external read, or provider tool; claims sandbox isolation; registers natively; enables the candidate; promotes it; or creates action state.
