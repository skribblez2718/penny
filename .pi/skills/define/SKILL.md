---
name: define
description: "Create or fully revise one durable, reviewed, cross-domain SpecificationV1 from a bounded creation brief and exact prior products. Use when the caller needs explicit scope, objectives, requirements, acceptance criteria, constraints, risks, standards status, source coverage, stable lineage, or a planning-ready handoff. Do not use for planning, taskification, approval, mutation, or execution."
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [piper, echo, rhea, vera, carren]
---

## Liveness

Derive values from actual operator policy, not test constants or model guesses. Do not invent finite step, agent-call, phase-cycle, semantic-repair or correction-attempt caps.

Ordinary permitted work has no fixed wall-clock deadline. Productive execution may continue while trusted activity or durable convergence renews its inactivity lease. A stall ends on inactivity expiry; explicit cancellation, errors, actual operator limits, and independent input/output/resource/containment limits remain enforceable.

## When to Use

- Turn a bounded creation brief into a complete specification before planning or implementation.
- Revise one exact prior SpecificationV1 as a standalone full replacement with explicit supersession.
- Define software, business-process, research, or generic cross-domain work using one canonical schema and a registered semantic profile.

## When Not to Use

- Form a strategy, choose among supplied alternatives, create executor tasks, request approval, mutate, or execute.
- Perform open-ended research. Echo may resolve only one host-admitted specification-blocking evidence question.
- Treat a profile, standards hint, or model statement as proof of compliance.

## Invocation Boundary

This is a model-visible, registered universal package. Explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility does not bypass host authorization, exact-byte composition admission, or consequence boundaries.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "define",
  goal: "Define an expiring document-share-link capability.",
  constraints: {"request":{"audiences":["Document owners","Link recipients"],"desired_outcomes":["Owners can issue and revoke bounded public links."],"hard_constraints":["Do not expose document identifiers."],"in_scope":["Creation, expiry, and revocation"],"known_assumptions":[],"known_uncertainties":[],"mode":"create","non_goals":[],"out_of_scope":["Changing authenticated sharing"],"prior_decisions":[],"requested_profile_id":"software","schema_version":1,"standard_hints":[]},"schema_version":2,"specification_assurance":"reviewed_definition"},
});
```

The request port is `penny.definition-request.v1` v1. Produces specification only; it does not taskify or execute the specification.

### Contract I/O

- `define_request` — input/inline_request; schema `penny.definition-request.v1` v1; 1..1 item(s).
- `prior_specification` — input/artifact; schema `penny.specification.v1` v1; 0..1 item(s); artifact kind specification.
- `prior_grounded_synthesis` — input/artifact; schema `penny.grounded-synthesis.v1` v1; 0..1 item(s); artifact kind semantic-core.
- `prior_decision` — input/artifact; schema `penny.decision.v2` v2; 0..1 item(s); artifact kind semantic-core.
- `evidence_context` — input/artifact; schema `penny.evidence-context.v1` v1; 0..1 item(s); artifact kind evidence-context.
- `specification` — output/artifact; schema `penny.specification.v1` v1; 1..1 item(s); artifact kind specification.

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
        "mode",
        "requested_profile_id",
        "desired_outcomes",
        "audiences",
        "in_scope",
        "out_of_scope",
        "hard_constraints",
        "non_goals",
        "known_assumptions",
        "known_uncertainties",
        "prior_decisions",
        "standard_hints"
      ],
      "properties": {
        "schema_version": {
          "type": "number",
          "const": 1
        },
        "mode": {
          "anyOf": [
            {
              "type": "string",
              "const": "create"
            },
            {
              "type": "string",
              "const": "revise"
            }
          ]
        },
        "requested_profile_id": {
          "anyOf": [
            {
              "anyOf": [
                {
                  "type": "string",
                  "const": "generic"
                },
                {
                  "type": "string",
                  "const": "software"
                },
                {
                  "type": "string",
                  "const": "business_process"
                },
                {
                  "type": "string",
                  "const": "research"
                }
              ]
            },
            {
              "type": "null"
            }
          ]
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
        "audiences": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024
          },
          "maxItems": 16
        },
        "in_scope": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "maxItems": 32
        },
        "out_of_scope": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "maxItems": 32
        },
        "hard_constraints": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "maxItems": 64
        },
        "non_goals": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "maxItems": 32
        },
        "known_assumptions": {
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
                "minLength": 1,
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
        "known_uncertainties": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "question",
              "owner",
              "material"
            ],
            "properties": {
              "question": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "owner": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "caller"
                  },
                  {
                    "type": "string",
                    "const": "evidence"
                  }
                ]
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
                "minLength": 1,
                "maxLength": 4096
              },
              "binding_effect": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              }
            },
            "additionalProperties": false
          },
          "maxItems": 32
        },
        "standard_hints": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "category",
              "standard",
              "relevance"
            ],
            "properties": {
              "category": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "standard": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              },
              "relevance": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1024
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
  → framing_definition (Piper; profile and readiness route)
  → definition_readiness_gate (host seals DefinitionFrameV2 for new starts)
  → optional awaiting_clarification (durable user gate; resume to framing)
  → optional gathering_definition_evidence (Echo; one admitted question)
  → authoring_specification (Rhea; complete replacement draft)
  → sealing_specification (host seals product and DefinitionTraceV1 before review)
  → verifying_specification (Vera)
  → critiquing_specification (Carren)
  → admitting_specification (host CompletionGate v2)
  → complete
```

Caller-owned ambiguity routes to a durable clarification gate; externally resolvable facts route to bounded Echo; ready framing routes directly to authorship. Reviewer evidence or analysis gaps return to framing, while product gaps return to authorship. Every repaired draft is resealed and re-reviewed.

## Exact Artifact Handoff

The host canonicalizes and persists `DefinitionRequestV1`. The exact optional semantic inputs are 0–1 `SpecificationV1`, 0–1 `GroundedSynthesisV1`, 0–1 `DecisionV2`, and 0–1 `EvidenceContextV1`. `create` forbids a prior specification; `revise` requires exactly one. Exact-byte composition rejects wrong kind/version, stale or substituted refs, ambiguous bindings, corrupt semantic products, and missing validators before run creation. The V2 invocation wrapper explicitly chooses `reviewed_definition` or `semantic_only`; legacy V1 constraints always mean `semantic_only`. With no prior specification, the host records `not_applicable`. A strict revision requires the completed Define producer and its exact immediate parent graph; refusal creates no consumer run and never falls back to semantic-only. The sealed assurance ref travels with reviews and completion but is not a second semantic specification.

Every phase receives exact refs. `artifact_read` is mandatory for every needed predecessor and workers continue through `next_range`; memory, `/tmp`, repository search, conversation history, and name-only pointers are never transport fallbacks. Ordinary phase tools remain bounded by the assigned role, task, and consequence boundary.

## Product and Review Truth

On new starts the host derives `DefinitionSourceManifestV1` before framing and refuses protected caller content that cannot fit SpecificationV1 before run/model creation. FrameV2 records stable question IDs; exact per-question clarification responses and EvidenceAdmissionV2 support slots distinguish actual answered choices from evidence-owned gaps. Rhea emits bounded specification prose, one closed `SPECIFICATION_CORE:<json>` footer containing keyed `{schema_version:3, specification, support_claims}`, and one SUMMARY (historical V1/V2 drafts retain their readers). Stable draft-local keys carry semantic relationships across correction; immutable request-source relationships continue to use manifest ordinals. The host validates and seals canonical `SpecificationV1` with static profile identity, stable item IDs, exact request/source lineage, full-replacement revision supersession, deterministic planning handoff, and `planning_started:false`, `taskification_started:false`, and `execution_started:false`. It projects a separate product-bound `DefinitionTraceV1` before either review. A material question without supported resolution stays blocked; a useful blocked specification can still complete.

Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Complete diagnostics use precise keyed paths. When every issue is `UNCOVERED_REQUIREMENT`, Rhea may return one closed `SpecificationDraftRepairV1` bound to the exact rejected draft ref/digest and diagnostic ref; the host applies only its acceptance-criterion operations, materializes a new immutable complete V3 draft revision, and revalidates it normally. Other defects require a complete replacement. An identical rejected digest or unchanged complete diagnostic set stalls before another correction is spent. Product and diagnostic refs use separate draft-addressed version-1 operations, not run-global attempt versions. Negative `seal_diagnostics` identifies the rejected draft separately from semantic `repair_diagnostics` or any accepted best partial. Vera verifies validity. Carren alone approves quality. For new starts, the host mints trace-bound validity and quality ReviewReceiptV2 in order, then V2 integrity evidence and an envelope. `complete/met:true` requires that exact graph, including re-read trace and support. Historical V1/V2 readers remain available. A valid `blocked` specification may complete as an honest specification assessment but is not planning or execution readiness.

## Consequence Boundary

No path plans, taskifies, approves action, mutates external state, executes the specified work, or grants tools through a profile. Profiles are static, versioned, digest-bound semantic overlays only. Targeted Echo evidence retrieval is read-only and never expands caller scope or decides caller intent.
