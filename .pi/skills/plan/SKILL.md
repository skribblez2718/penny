---
name: plan
description: "Create a durable reviewed strategy assessment from a goal, desired outcomes, current state, constraints, uncertainties, prior decisions, and exact prior products. Use when the caller needs outcome structure, meaningful dependencies, risks, contingencies, trade-offs, or an explicit ready, blocked, or not-applicable planning result. Do not use for deciding among alternatives, taskification, approval, mutation, or execution."
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [piper, echo, vera, carren]
---

## Liveness

Derive values from actual operator policy, not test constants or model guesses. Do not invent finite step, agent-call, phase-cycle, semantic-repair or correction-attempt caps.

Ordinary permitted work has no fixed wall-clock deadline at any layer. Productive execution may continue indefinitely while trusted activity or durable convergence renews its inactivity lease. A stall ends on inactivity expiry; explicit cancellation, errors, actual operator limits, and independent input/output/resource/containment limits remain enforceable.

## When to Use

- Form a strategy connecting supplied current state to desired outcomes.
- Identify meaningful causal, temporal, resource, or informational dependencies.
- Return an honest `ready`, `blocked`, or `not_applicable` planning disposition.

## When Not to Use

- Decide among alternatives, create an executor task graph, request approval, mutate, or execute.
- Open-ended or exploratory research. Narrowly targeted local/web evidence acquisition is allowed only inside the bounded, host-admitted Echo evidence gap.
- Treat planning completion as execution readiness.

## Invocation Boundary

This is a model-visible, registered universal package. Pi native discovery and Penny's model-facing catalog may describe it, and explicit `skill` invocation is routed through the sole executable playbook registry with its bound contract. Model visibility does not bypass host-owned authorization or consequence boundaries.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "plan",
  goal: "Plan the migration.",
  constraints: {"request":{"current_state":{"facts":["The current system is running."],"status":"provided"},"desired_outcomes":["A staged migration strategy."],"hard_constraints":["Do not deploy."],"known_uncertainties":[],"non_goals":[],"prior_decisions":[],"schema_version":1},"schema_version":2,"specification_assurance":"reviewed_definition"},
});
```

The request port is `penny.plan-request.v1` v1. Produces strategy only; it does not taskify or execute the strategy. With no SpecificationV1 input, assurance is recorded as not_applicable.

### Contract I/O

- `plan_request` — input/inline_request; schema `penny.plan-request.v1` v1; 1..1 item(s).
- `prior_specification` — input/artifact; schema `penny.specification.v1` v1; 0..1 item(s); artifact kind specification.
- `prior_grounded_synthesis` — input/artifact; schema `penny.grounded-synthesis.v1` v1; 0..1 item(s); artifact kind semantic-core.
- `prior_decision` — input/artifact; schema `penny.decision.v2` v2; 0..1 item(s); artifact kind semantic-core.
- `evidence_context` — input/artifact; schema `penny.evidence-context.v1` v1; 0..1 item(s); artifact kind evidence-context.
- `strategy` — output/artifact; schema `penny.strategy.v2` v2; 1..1 item(s); artifact kind strategy.

### Runtime constraints schema

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "required": [
    "schema_version",
    "request",
    "specification_assurance"
  ],
  "properties": {
    "schema_version": {
      "type": "number",
      "const": 2
    },
    "request": {
      "type": "object",
      "required": [
        "schema_version",
        "desired_outcomes",
        "current_state",
        "hard_constraints",
        "non_goals",
        "known_uncertainties",
        "prior_decisions"
      ],
      "properties": {
        "schema_version": {
          "type": "number",
          "const": 1
        },
        "desired_outcomes": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "minItems": 1,
          "maxItems": 24
        },
        "current_state": {
          "anyOf": [
            {
              "type": "object",
              "required": [
                "status",
                "facts"
              ],
              "properties": {
                "status": {
                  "type": "string",
                  "const": "provided"
                },
                "facts": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 0,
                    "maxLength": 8192
                  },
                  "minItems": 1,
                  "maxItems": 64
                }
              },
              "additionalProperties": false
            },
            {
              "type": "object",
              "required": [
                "status",
                "reason"
              ],
              "properties": {
                "status": {
                  "type": "string",
                  "const": "unavailable"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                }
              },
              "additionalProperties": false
            }
          ]
        },
        "hard_constraints": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 0,
            "maxLength": 4096
          },
          "maxItems": 64
        },
        "non_goals": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 0,
            "maxLength": 4096
          },
          "maxItems": 32
        },
        "known_uncertainties": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "statement",
              "material"
            ],
            "properties": {
              "statement": {
                "type": "string",
                "minLength": 0,
                "maxLength": 4096
              },
              "material": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          },
          "maxItems": 32
        },
        "prior_decisions": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "statement",
              "binding_effect"
            ],
            "properties": {
              "statement": {
                "type": "string",
                "minLength": 0,
                "maxLength": 4096
              },
              "binding_effect": {
                "type": "string",
                "minLength": 0,
                "maxLength": 4096
              }
            },
            "additionalProperties": false
          },
          "maxItems": 32
        }
      },
      "additionalProperties": false
    },
    "specification_assurance": {
      "anyOf": [
        {
          "type": "string",
          "const": "reviewed_definition"
        },
        {
          "type": "string",
          "const": "semantic_only"
        }
      ]
    }
  },
  "additionalProperties": false
}
```

<!-- PENNY:GENERATED-INVOCATION:END -->

## Orchestrated Flow

```text
intake
  → orienting_strategy (Piper; distinct orientation artifact)
  → strategy_evidence_gate (host typed admission)
  → optional gathering_strategy_evidence (Echo; one admitted strategy-blocking gap)
  → strategizing (Piper; complete replacement draft)
  → sealing_strategy (host)
  → verifying_strategy (Vera)
  → critiquing_strategy (Carren)
  → admitting_strategy (host CompletionGate v2)
  → complete
```

Vera and Carren emit only one closed gap kind plus repair owner. Engine-owned registered routes send reviewer evidence/analysis gaps to Piper orientation and product gaps to Piper strategy authorship. Only an accepted Piper evidence gap opens the host evidence gate and bounded Echo. Every strategy revision returns through deterministic host sealing, Vera, and Carren. Exhausted or stalled work terminates honestly as `incomplete` with the exact typed reason and without resetting the state counter; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results, not Plan states.

## Exact Artifact Handoff

The owner canonicalizes and persists `PlanRequestV1`. The exact optional semantic inputs are 0–1 each `SpecificationV1`, `GroundedSynthesisV1`, `DecisionV2`, and `EvidenceContextV1`; each is validated from canonical bytes before run creation. There is no caller-composed prior Strategy port. Envelope-for-core, wrong version/kind, stale, ambiguous, corrupt, incompatible, and validator-missing inputs are rejected. The V2 invocation wrapper explicitly chooses `reviewed_definition` or `semantic_only`; legacy V1 constraints always mean `semantic_only`. Without a specification, the host records `not_applicable`. Strict policy with a specification requires the completed Define producer and exact review graph before Plan run creation; refusal cannot silently become semantic-only. The assured ref binds both reviews, integrity, envelope, and completion, while SpecificationV1 remains the only specification semantic input.

Every phase receives exact refs. Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary; they cannot bypass host-owned evidence admission. Piper authors from the exact request directly plus orientation and evidence. Vera and Carren receive the exact request, orientation, draft, latest sealed strategy, source refs, and required prior review evidence.

Only the host-admitted Echo gap may acquire new evidence, and only through narrowly targeted read-only local inspection or web retrieval for the exact strategy-blocking fact when compatible with caller constraints. Echo must provide source locators, stop rather than broaden into open-ended research, and report unavailable, conflicting, disallowed, insufficient, or budget-exhausted evidence honestly as unresolved. Normal permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply. Calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls.

## Product and Review Truth

Piper returns bounded strategy prose, one closed `STRATEGY_CORE:<json>` footer, and one SUMMARY. The host validates and seals active canonical `StrategyV2` with exact request/source lineage and `execution_started:false`. Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Product and diagnostic refs use separate draft-addressed version-1 operations, not run-global artifact versions. Negative `seal_diagnostics` names a rejected draft separately from semantic `repair_diagnostics` and any earlier accepted best partial. A successful replacement must repeat Vera then Carren review. With SpecificationV1, V2 maps every required source item to an explicit disposition and every strategy outcome back to source items or a derived-need rationale; request/specification conflicts remain visible and cannot be repaired by silent specification revision. Without SpecificationV1, source-item traceability is empty and standalone Plan semantics are preserved. Historical StrategyV1 validation remains explicit compatibility only.

Vera independently verifies validity. The host mints a validity receipt only for a latest-product PASS. Carren is the sole quality approval authority; any major or critical finding requires revision. The host mints a quality receipt only for latest-product APPROVE, then deterministically validates integrity and emits a strategy product envelope binding the exact request, orientation, evidence, imports, draft, strategy, reports, receipts, and integrity evidence.

`complete/met:true` requires that exact latest graph and Carren APPROVE. Valid `ready`, `blocked`, and `not_applicable` assessments may complete. `blocked` means the planning assessment is complete; it does not mean the underlying execution is ready. Missing exact material is `incomplete` with a typed reason; Plan has no `await_user`, `awaiting_user`, challenge, or same-run `respond` path.

## Consequence Boundary

No path introduces Decide as a required phase, Tabitha, executor tasks, task graphs, action state, approval state/directive/gate/product, external mutation, execution, OS/process sandbox or provider-extension-code-isolation claims, native registration, promotion, or enablement. Targeted Echo evidence retrieval does not authorize side effects, open-ended research, or any expansion of caller/task scope.
