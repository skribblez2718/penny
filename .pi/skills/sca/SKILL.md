---
name: sca
description: Run a durable, evidence-grounded source-composition security analysis over one caller-admitted immutable repository snapshot. Use for repository-scale vulnerability discovery requiring independent analyses, explicit coverage limits, resumability, and human-gated report release. Do not use for remediation, quick review, unauthorised execution, or claims that a repository is secure.
metadata:
  version: "1.0.0"
  penny:
    engine: orchestration
    mempalace: false
    subagents: [annie, vera, skribble]
---

## When to Use

- Analyze a repository-scale source snapshot for security weaknesses.
- Preserve independent primary analyses, critic review, evidence lineage, and limitations.
- Require explicit human approval before releasing the final report.

## When Not to Use

- Small supplied-code reviews that one focused agent can handle.
- Remediation or modification of the audited repository.
- Target execution, network access, or stronger evidence without separate authorization.
- Any request to certify that scanner silence means the repository is secure.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "sca",
  goal: "Assess the admitted repository snapshot for source-composition security weaknesses.",
  constraints: {"critic_model":"provider/model-c","execution_mode":"static_only","primary_a_model":"provider/model-a","primary_b_model":"provider/model-b","schema_version":1,"scope":{"exclude":["vendor"],"include":["src"]},"source_root":"/absolute/path/supplied/by/caller","source_snapshot_sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
});
```

The request port is `penny.sca-request.v1` v1. The source root and immutable snapshot digest are caller-bound; release always pauses for an exact human approval response.

### Contract I/O

- `sca_request` — input/inline_request; schema `penny.sca-request.v1` v1; 1..1 item(s).
- `sca_report` — output/artifact; schema `penny.sca-report.v1` v1; 1..1 item(s); artifact kind semantic-core.

### Runtime constraints schema

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "required": [
    "schema_version",
    "source_root",
    "source_snapshot_sha256",
    "scope",
    "execution_mode",
    "primary_a_model",
    "primary_b_model",
    "critic_model"
  ],
  "properties": {
    "schema_version": {
      "type": "number",
      "const": 1
    },
    "source_root": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "source_snapshot_sha256": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
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
            "minLength": 1,
            "maxLength": 4096
          },
          "maxItems": 256
        },
        "exclude": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "maxItems": 256
        }
      },
      "additionalProperties": false
    },
    "execution_mode": {
      "anyOf": [
        {
          "type": "string",
          "const": "static_only"
        },
        {
          "type": "string",
          "const": "propose_stronger_evidence"
        }
      ]
    },
    "primary_a_model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "primary_b_model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "critic_model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    }
  },
  "additionalProperties": false
}
```

<!-- PENNY:GENERATED-INVOCATION:END -->

## Execution Contract

The wrapper declares intent only. The orchestration engine owns admission, a zero-model host static inventory, durable state, exact artifact handoff, two model-pinned primary branches, critic review, report production, final verification, recovery, and the release-approval pause.

The caller supplies an absolute source root, immutable snapshot digest, normalized repository-relative scope, execution mode, and three distinct pinned model identifiers. The skill does not modify the target. `propose_stronger_evidence` may identify evidence needs; it does not authorize execution.

## Terminal Truth

A positive result requires the complete registered state sequence, the exact current report, independent final PASS, and a human response bound to that report's artifact ID and digest. Rejection, drift, incomplete evidence, model/tool failure, cancellation, or liveness exhaustion terminates non-positively with the best exact report artifact available.

Completion means this bounded analysis and release gate completed. It never means the repository is vulnerability-free.
