---
name: research
description: Structured research workflow with Quick, Standard, and Deep modes. Use when a task requires investigating an unfamiliar topic or gathering authoritative external evidence. Do not use for simple lookups, analysis of already-supplied material, or implementation when sufficient evidence exists.
metadata:
  version: "3.0.1"
  penny:
    engine: orchestration
    mempalace: false
    subagents:
      - piper
      - echo
      - carren
      - synthia
      - vera
---

## When to Use

- Investigate an unfamiliar technical topic or concept.
- Research practices, design patterns, or architectural tradeoffs.
- Compare options using authoritative external evidence.
- Review literature or gather evidence before a decision.
- Answer a complex question requiring multiple independent research angles.

## When Not to Use

- Simple lookup: use `web_search` directly.
- Analysis of material already provided: use the relevant analysis role.
- Implementation when sufficient evidence exists: proceed directly.
- The user requests immediate execution and research would not change the result.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "research",
  goal: "Research the supplied question.",
  constraints: {"mode":"quick","scope":{"exclude":[],"include":[]}},
});
```

The request port is `penny.research-request.v1` v1. Caller artifacts must be exact admitted ports; ordinary constraints cannot set host liveness.

### Contract I/O

- `request` — input/inline_request; schema `penny.research-request.v1` v1; 1..1 item(s).
- `prior_grounded_synthesis` — input/artifact; schema `penny.grounded-synthesis.v1` v1; 0..8 item(s); artifact kind semantic-core.
- `legacy_context` — input/artifact; schema `penny.research-legacy-agent-output.v1` v1; 0..64 item(s); artifact kind agent-output.
- `grounded_synthesis` — output/artifact; schema `penny.grounded-synthesis.v1` v1; 1..1 item(s); artifact kind semantic-core.

### Runtime constraints schema

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "mode": {
      "anyOf": [
        {
          "type": "string",
          "const": "quick"
        },
        {
          "type": "string",
          "const": "standard"
        },
        {
          "type": "string",
          "const": "deep"
        },
        {
          "type": "null"
        }
      ]
    },
    "scope": {
      "type": "object",
      "required": [
        "include",
        "exclude"
      ],
      "properties": {
        "include": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 0,
            "maxLength": 32768
          },
          "maxItems": 32,
          "uniqueItems": true
        },
        "exclude": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 0,
            "maxLength": 32768
          },
          "maxItems": 32,
          "uniqueItems": true
        }
      },
      "additionalProperties": false
    },
    "verification_model_override": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "validate_model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "budget_overrides": {
      "type": "object",
      "properties": {
        "max_sub_queries": {
          "type": "integer",
          "minimum": 1,
          "maximum": 64
        },
        "max_fan_width": {
          "type": "integer",
          "minimum": 1,
          "maximum": 64
        },
        "total_research_rounds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16
        },
        "max_evaluator_attempts_per_loop": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16
        },
        "critique_passes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        }
      },
      "additionalProperties": false
    },
    "max_sub_queries": {
      "type": "integer",
      "minimum": 1,
      "maximum": 64
    },
    "max_fan_width": {
      "type": "integer",
      "minimum": 1,
      "maximum": 64
    },
    "total_research_rounds": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16
    },
    "max_research_rounds": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16
    },
    "max_evaluator_attempts_per_loop": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16
    },
    "max_iterations": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16
    },
    "critique_passes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 2
    },
    "context_bindings": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "slot",
              "binding_kind",
              "selected_by",
              "source_id",
              "document_id",
              "revision_id",
              "expected_sha256"
            ],
            "properties": {
              "slot": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "domain_guidance"
                  },
                  {
                    "type": "string",
                    "const": "standard_guidance"
                  },
                  {
                    "type": "string",
                    "const": "output_shape_guidance"
                  }
                ]
              },
              "binding_kind": {
                "type": "string",
                "const": "versioned_document"
              },
              "selected_by": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "caller"
                  },
                  {
                    "type": "string",
                    "const": "host"
                  }
                ]
              },
              "source_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "document_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "revision_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "expected_sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "slot",
              "binding_kind",
              "selected_by",
              "source_id",
              "kb_profile_id",
              "result_id",
              "expected_sha256"
            ],
            "properties": {
              "slot": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "domain_guidance"
                  },
                  {
                    "type": "string",
                    "const": "standard_guidance"
                  },
                  {
                    "type": "string",
                    "const": "output_shape_guidance"
                  }
                ]
              },
              "binding_kind": {
                "type": "string",
                "const": "approved_kb_result"
              },
              "selected_by": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "caller"
                  },
                  {
                    "type": "string",
                    "const": "host"
                  }
                ]
              },
              "source_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "kb_profile_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "result_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "expected_sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "slot",
              "binding_kind",
              "selected_by",
              "source_id",
              "content"
            ],
            "properties": {
              "slot": {
                "type": "string",
                "const": "output_shape_guidance"
              },
              "binding_kind": {
                "type": "string",
                "const": "caller_input"
              },
              "selected_by": {
                "type": "string",
                "const": "caller"
              },
              "source_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              "content": {
                "type": "string",
                "minLength": 1,
                "maxLength": 32768
              }
            },
            "additionalProperties": false
          }
        ]
      },
      "maxItems": 9
    },
    "report_format": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    }
  },
  "additionalProperties": false
}
```

<!-- PENNY:GENERATED-INVOCATION:END -->

New V3 runs use host-enforced renewable inactivity leases rather than ordinary model-turn, phase-admission, tool-call, external-call, or total elapsed-work quotas. Trusted non-empty Pi generation/tool activity and durable workflow convergence renew the lease; independent host-operation deadlines, routing repair, malformed/protocol protections, cancellation, and exact V1/V2 continuation remain bounded. Deterministic offline liveness and cancellation behavior are locally certified. The live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`; no provider rerun is required.

## Exact Artifact Handoff

Every cognitive directive carries exact `input_artifacts` plus an owner output contract. Agents read every needed predecessor with `artifact_read` and `next_range`, return complete stage content, and emit routing-only `SUMMARY` data. Owner persistence and exact-byte re-read precede routing. Research remains correct without memory.

Typed `prior_grounded_synthesis` imports require canonical `penny.grounded-synthesis.v1` bytes in a matching `semantic-core` artifact. Untyped historical `agent-output` inputs remain accepted through `legacy_context`. Envelope, render, or receipt substitution fails before model work.

Resolver-v2 admissions persist metadata-only `ContextSourceRefV2` envelopes. Admission-only compatibility may create exact V1 envelopes, and exact V1 bytes remain readable, but neither can dispatch external context without resolver-v2 revalidation. Every external use requires a resolver-v2 response containing the exact current source/revision/approval identity, bytes, freshness, provider eligibility, and conflict state. The owner validates that one snapshot immediately before each worker/model-client dispatch, including retries, restart, and queued branches. `valid_from` is inclusive and `valid_through` is exclusive, so equality is expired; missing, unavailable, future-dated, stale, revoked, ineligible, conflicted, drifted, or admission-only resolution fails before model input. An exact V1 envelope can proceed only after resolver-v2 revalidation and is never rewritten.

Caller-supplied output-shape context remains fixed to its originally admitted bytes across restart and receives no invented external approval. Approved-KB content must already be approved and pre-resolved; research performs no KB query, ingestion, promotion, approval, or write. Private KB bodies never enter checkpoints, generic artifacts, receipts, renders, envelopes, or telemetry. Context never changes YAML tools. Eligibility is a bounded dispatch-time snapshot: revocation after validation and before or during the model call remains the unavoidable residual race, not a continuous-monitoring guarantee.

## Agent and Host Flow

One approved P3 graph serves every mode:

```text
intake → optional planning → optional plan critique → Echo evidence fan
→ Synthia typed `ResearchSemanticDraftV1`
→ deterministic host projection/core sealing → Vera grounding
→ optional report Carren → host rendering/product checks → completion admission
```

- Every Synthia revision passes through deterministic host projection/core sealing and Vera.
- Vera evidence gaps route to Echo; synthesis defects route to Synthia.
- Carren quality defects route to Synthia, then a new core, Vera, and Carren again.
- No changed core can proceed directly to Carren, rendering, or completion.
- `sealing_core` and `rendering` are host-only states and consume no model turns or tools.

## Product and Terminal Truth

The sole active output port is `grounded_synthesis`. Positive terminal `output_artifact_ref` and chain handoff are the latest exact canonical `GroundedSynthesisV1` `semantic-core` ref—not the envelope, render, receipt, or Synthia draft artifact.

The acyclic graph is:

```text
semantic core
  ├─ Vera grounding receipt
  ├─ optional Carren quality receipt
  ├─ host deterministic-validation receipt
  ├─ report.md render
  ├─ sources.md render
  └─ README.md render
        ↓
research product envelope
```

Host renderer `penny.research.compat-markdown.v1` consumes only the immutable core. It persists a stable render intent, immutable render artifacts, then uses no-follow checks, indexed temporary files, file/directory fsync, and atomic rename. Recovery adopts matching files and converges to identical refs, receipts, envelope ID, and bytes. The three compatibility filenames remain an open loan.

A positive result requires the latest canonical core, no unsupported claim or blocking issue, same-core Vera PASS, same-core Carren PASS when enabled, exactly three verified renders/files, host deterministic-validation PASS, an exact product graph, no exhausted required budget, and the existing engine completion gate from `rendering`. Fully disclosed non-blocking uncertainty may produce `complete/met:true/qualified:true`; it never waives a receipt or budget.

Non-positive runs return the best exact core/artifacts and blockers. They do not receive a complete product envelope. The recognized `legacy_report_artifact` schema remains compatibility-only and is neither authoritative nor chain-forwarded. Decoder-only historical `rigor_escalated:false` remains absent from new terminal projections.
