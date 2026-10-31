---
name: decide
description: "Create a durable reviewed decision from supplied alternatives, constraints, preferences, uncertainty, and evidence. Use when the caller needs a selection, complete ranking, no-feasible finding, explicit unresolved disposition, or not-applicable assessment. Do not use when the caller needs ideation, planning, taskification, or execution."
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [annie, echo, demetri, vera, carren]
---

## Liveness

Derive values from actual operator policy, not test constants or model guesses. Do not invent finite step, agent-call, phase-cycle, semantic-repair or correction-attempt caps.

Ordinary permitted work has no fixed wall-clock deadline at any layer. Productive execution may continue indefinitely while trusted activity or durable convergence renews its inactivity lease. A stall ends on inactivity expiry; explicit cancellation, errors, actual operator limits, and independent input/output/resource/containment limits remain enforceable.

## When to Use

- Select one supplied feasible alternative or rank the complete feasible set.
- Establish that no supplied alternative is feasible.
- Produce a valid `unresolved` assessment with concrete blocking questions.
- Produce a valid `not_applicable` assessment.

## When Not to Use

- Generating alternatives, comparing without deciding, planning, taskification, or execution.
- Open-ended or exploratory research. Narrowly targeted local/web evidence acquisition is allowed only inside the bounded, host-admitted Echo evidence gap.

## Invocation Boundary

This is a model-visible, registered universal package. Pi native discovery and Penny's model-facing catalog may describe it, and explicit `skill` invocation is routed through the sole executable playbook registry with its bound contract. Model visibility does not bypass host-owned authorization or consequence boundaries.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "decide",
  goal: "Choose a communication channel.",
  constraints: {"alternatives":[{"alternative_id":"email","description":"Send an email.","label":"Email"},{"alternative_id":"chat","description":"Send a chat message.","label":"Chat"}],"evidence":[],"hard_constraints":[],"objectives":[{"objective_id":"clarity","statement":"Reach the team clearly."}],"preferences":[],"schema_version":1,"uncertainties":[]},
});
```

The request port is `penny.decision-request.v1` v1. Selects among supplied alternatives; it does not execute the choice.

### Contract I/O

- `decision_request` — input/inline_request; schema `penny.decision-request.v1` v1; 1..1 item(s).
- `prior_grounded_synthesis` — input/artifact; schema `penny.grounded-synthesis.v1` v1; 0..1 item(s); artifact kind semantic-core.
- `evidence_context` — input/artifact; schema `penny.evidence-context.v1` v1; 0..1 item(s); artifact kind evidence-context.
- `decision` — output/artifact; schema `penny.decision.v2` v2; 1..1 item(s); artifact kind semantic-core.

### Runtime constraints schema

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "required": [
    "schema_version",
    "alternatives",
    "hard_constraints",
    "objectives",
    "preferences",
    "uncertainties",
    "evidence"
  ],
  "properties": {
    "schema_version": {
      "type": "number",
      "const": 1
    },
    "alternatives": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "alternative_id",
          "label",
          "description"
        ],
        "properties": {
          "alternative_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 24
    },
    "hard_constraints": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "constraint_id",
          "statement"
        ],
        "properties": {
          "constraint_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 32
    },
    "objectives": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "objective_id",
          "statement"
        ],
        "properties": {
          "objective_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 32
    },
    "preferences": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "preference_id",
          "statement"
        ],
        "properties": {
          "preference_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 32
    },
    "uncertainties": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "uncertainty_id",
          "statement"
        ],
        "properties": {
          "uncertainty_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 32
    },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "evidence_id",
          "statement"
        ],
        "properties": {
          "evidence_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          }
        },
        "additionalProperties": false
      },
      "maxItems": 64
    }
  },
  "additionalProperties": false
}
```

<!-- PENNY:GENERATED-INVOCATION:END -->

## Orchestrated Flow

```text
intake
  → analyzing_decision (Annie)
  → decision_evidence_gate (host typed admission)
  → optional gathering_decision_evidence (Echo; one admitted decision-sensitive gap)
  → deciding (Demetri)
  → sealing_decision (host)
  → verifying_decision (Vera)
  → critiquing_decision (Carren)
  → admitting_decision (host CompletionGate v2)
  → complete
```

Vera and Carren emit only a closed gap kind plus repair owner. Engine-owned registered routes send reviewer evidence/analysis gaps to Annie and product gaps to Demetri. Only an accepted Annie evidence gap opens the host evidence gate and bounded Echo. Every revision returns through deterministic sealing and Vera verification before Carren. Exhausted or stalled work terminates honestly as `incomplete` with the exact typed reason and no state-counter reset; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results, not Decide states.

## Exact Artifact Handoff

Every phase receives exact artifact refs. Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by the caller and task, and within the phase consequence boundary; they cannot bypass host-owned evidence admission. Request, analysis, evidence packet, draft, reviewer report, receipt, and feedback IDs are transport lineage, not semantic basis IDs. Only exact admitted `GroundedSynthesisV1` artifacts may contribute artifact basis IDs.

Only the host-admitted Echo gap may acquire new evidence, and only through narrowly targeted read-only local inspection or web retrieval for the exact decision-sensitive fact when compatible with caller constraints. Echo must provide source locators, stop rather than broaden into open-ended research, and report unavailable, conflicting, disallowed, insufficient, or budget-exhausted evidence honestly as unresolved. Normal permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply. Calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls.

## Product and Review Truth

Demetri returns bounded decision prose, one closed `DECISION_CORE:<json>` footer, and one SUMMARY. The host validates and seals exact canonical `DecisionV2` bytes with request/source lineage and `execution_started:false`. Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Product and diagnostic operations are separately draft-addressed at version 1, not run-global revision counters. Negative `seal_diagnostics` identifies a rejected draft separately from semantic `repair_diagnostics` and any accepted best partial; an older product requires new Vera-then-Carren review after replacement.

Vera independently verifies validity. The host mints a validity receipt only for a latest-product PASS. Carren then critiques quality and is the sole approval authority; any major or critical finding requires revision. The host mints a quality receipt only for latest-product APPROVE, then deterministically validates product integrity and emits a `DecisionProductEnvelopeV1` that binds request, analysis, optional evidence, imports, draft, decision, both reports, both receipts, and integrity evidence.

`complete/met:true` requires that exact latest graph and Carren APPROVE. Valid `unresolved` and `not_applicable` outcomes may complete because completion means the assessment is finished, not that a selection exists. Missing exact material is `incomplete` with a typed reason; the candidate has no `await_user`, `awaiting_user`, challenge, or same-run `respond` path.

## Consequence Boundary

No path executes, taskifies, mutates externally, changes credentials, registers natively, enables, promotes, or creates action state. Targeted Echo evidence retrieval does not authorize side effects, open-ended research, or any expansion of caller/task scope.
