---
name: produce
description: "Create one durable reviewed artifact content product from a closed brief and inline supplied material. Use when the caller needs complete text, Markdown, JSON, YAML, TypeScript, JavaScript, Python, or shell content with exact criterion coverage and no filesystem or external mutation. Do not use for live research, file writing, code execution, testing, deployment, open-ended clarification, or multi-artifact production."
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [ida, demetri, skribble, carren, vera]
---

## Liveness

Derive values from actual operator policy, not test constants or model guesses. Do not invent finite step, agent-call, phase-cycle, semantic-repair or correction-attempt caps.

Ordinary permitted work has no fixed wall-clock deadline at any layer. Productive execution may continue indefinitely while trusted activity or durable convergence renews its inactivity lease. A stall ends on inactivity expiry; explicit cancellation, errors, actual operator limits, and independent input/output/resource/containment limits remain enforceable.

## When to Use

- Materialize one bounded artifact from a complete purpose, specification, and acceptance brief.
- Use inline caller-supplied source statements without independently verifying them.
- Produce `text`, `markdown`, `json`, `yaml`, `typescript`, `javascript`, `python`, or `shell` content.
- Return an honest `not_applicable` product when required material is absent or hard constraints make production impossible.

## When Not to Use

- Write a file, mutate a repository, execute or compile code, run tests, browse, fetch, publish, or deploy.
- Research missing facts or independently verify supplied source statements.
- Produce several independent artifacts or continue with an open brief.
- Seek or record direct approval state.

## Invocation Boundary

This is a model-visible, registered universal package. Pi native discovery and Penny's model-facing catalog may describe it, and explicit `skill` invocation is routed through the sole executable playbook registry with its bound contract. Model visibility does not bypass host-owned authorization or consequence boundaries.

<!-- PENNY:GENERATED-INVOCATION:START -->

## Invocation

This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.

<!-- prettier-ignore -->
```ts
skill({
  skill_name: "produce",
  goal: "Produce a short project note.",
  constraints: {"acceptance_criteria":[{"statement":"State the start date."}],"artifact_kind":"markdown","hard_constraints":[],"known_uncertainties":[],"non_goals":[],"output_name":"note.md","schema_version":1,"source_material":[{"source_label":"brief","statement":"The project starts Tuesday."}],"specification":[{"statement":"Write one concise note."}]},
});
```

The request port is `penny.produce-request.v1` v1. Produces content only; it does not write, execute, test, or publish it.

### Contract I/O

- `produce_request` — input/inline_request; schema `penny.produce-request.v1` v1; 1..1 item(s).
- `produced_artifact` — output/artifact; schema `penny.produced-artifact.v2` v2; 1..1 item(s); artifact kind semantic-core.

### Runtime constraints schema

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "required": [
    "schema_version",
    "output_name",
    "artifact_kind",
    "specification",
    "source_material",
    "acceptance_criteria",
    "hard_constraints",
    "non_goals",
    "known_uncertainties"
  ],
  "properties": {
    "schema_version": {
      "type": "number",
      "const": 1
    },
    "output_name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
    },
    "artifact_kind": {
      "anyOf": [
        {
          "type": "string",
          "const": "text"
        },
        {
          "type": "string",
          "const": "markdown"
        },
        {
          "type": "string",
          "const": "json"
        },
        {
          "type": "string",
          "const": "yaml"
        },
        {
          "type": "string",
          "const": "typescript"
        },
        {
          "type": "string",
          "const": "javascript"
        },
        {
          "type": "string",
          "const": "python"
        },
        {
          "type": "string",
          "const": "shell"
        }
      ]
    },
    "specification": {
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
    "source_material": {
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
            "maxLength": 16384
          },
          "source_label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          }
        },
        "additionalProperties": false
      },
      "maxItems": 128
    },
    "acceptance_criteria": {
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
    }
  },
  "additionalProperties": false
}
```

<!-- PENNY:GENERATED-INVOCATION:END -->

## Orchestrated Flow

```text
intake (host canonical request)
  → exploring_artifact_approaches (Ida; unranked alternatives, no selection)
  → selecting_artifact_approach (Demetri; justified selection or unresolved)
  → materializing_artifact (Skribble; one complete draft)
  → sealing_artifact (host canonical ProducedArtifactV2 with required-only effect graph)
  → critiquing_artifact (Carren quality review)
  → verifying_artifact (Vera objective compliance and lineage)
  → admitting_artifact (host current-product receipts + integrity/envelope)
  → complete
```

Carren `quality_gap` returns to Skribble. Vera `brief_gap` returns through Ida, Demetri, and then Skribble; Vera `artifact_product_gap` returns directly to Skribble. Every replacement draft is resealed and repeats Carren before Vera. A deterministic draft rejection persists an exact seal diagnostic before a correction or negative terminal. Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Product and diagnostic refs use separate draft-addressed version-1 operations, not run-global version counters. `seal_diagnostics` identifies a rejected draft apart from semantic `repair_diagnostics` or an earlier accepted best partial. Exhausted, malformed, stale, wrong-run, or missing exact material is non-positive `incomplete`; cancellation is `cancelled`.

## Exact Artifact Handoff

The host canonicalizes and persists `ProduceRequestV1`. Every cognitive directive carries owner-selected exact `input_artifacts` refs and an `output_artifact` contract. Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary. In particular, Skribble's YAML write-capable surface does not authorize this workflow to write files: the complete product remains response content captured by the owner.

Normal permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply. Calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls; none grants authority for external research, filesystem mutation, execution, testing, publication, or deployment. The owner captures and re-reads exact bytes before routing, and memory availability cannot affect correctness.

## Output and Terminal Truth

The selected terminal `output_artifact_ref` identifies canonical `penny.produced-artifact.v2` semantic-core bytes. The product embeds exact output identity, content and SHA-256, rationale, assumptions, uncertainties, full request coverage, the canonical request, Ida-alternative and Demetri-decision lineage, inline-source lineage, confidence, and a host-authored versioned effect-evidence graph. Each of external action, filesystem write, test execution, and task change separately records the absence policy, worker/run/phase scope, observation status/coverage/result/evidence refs, and prevention control/scope. Unsupported facts are `unknown`; host artifact persistence is explicitly outside worker-effect assurance.

For `json`, the host requires parseable canonical JSON content. Other kinds are not compiled, executed, or syntax-checked. `produced` requires nonempty content. `not_applicable` requires empty content and a truthful explanation. Host sealing—not a worker—derives `content_sha256` from the exact UTF-8 content.

`complete/met:true` requires current-product Carren APPROVE and Vera PASS evidence, host-minted quality and validity receipts, deterministic integrity, an exact envelope, and CompletionGate v2 admission. An observed effect-policy violation blocks completion. Unknown effects may complete only with the terminal's explicit unknown-effect limitation. Even bounded no-violation evidence is scoped evidence, not full filesystem or process confinement. Completion is not approval to write, publish, or execute the artifact.

## Recovery and Consequence Boundary

Recovery reuses the same exact selected refs and safely converges deterministic host sealing/admission. Active V1 effect checkpoints are refused rather than silently resealed as V2 evidence. The policy forbids external research, worker external actions, worker filesystem writes, tests, compilation, execution, deployment, publication, and direct approval; absent observation or prevention evidence remains unknown.

## Review truth and compatibility

Before Vera, the host exposes `penny.produce-mechanical-checks.v1`, bound to the exact current request/alternatives/decision/draft/product. Existing native validators recompute canonicality, content/draft/source/lineage hashes, coverage-array and disposition invariants, JSON canonicality when applicable, and effect-graph shape. Vera independently reviews semantic compliance and source fidelity; mechanical PASS is not semantic approval, execution by Vera, or evidence of effect absence. Unknown effects remain allowable only with the existing explicit limitation.

Carren and Vera emit one immutable semantic-only `PRODUCE_REVIEW` V2 core: `schema_version:2`, `review_kind`, `confidence`, and the complete closed `review` judgment. No opaque refs, IDs, digests or metadata are model-authored; extra fields refuse. The active prompt exposes only its quality or validity branch. Registration binds `penny.produce-review-semantic-projection.v1`, the version-1 host projection for this V2 wire. After exact raw capture/readback and receipt signing, the host derives phase confidence and the COMPLETE review object without another model call. This narrow exception replaces the duplicate model-authored final SUMMARY only for these review phases. Original bytes, digest and signed source provenance remain intact; projection grants no new judgment or completion authority. The host binds the exact current product and, for Vera, mechanical evidence through the original assignment, immutable source metadata and signed invocation digest. Receipt minting, reuse, continuation and final admission reparse original bytes and recheck exact role/run/phase/attempt/output revision, native operands, context designation and custody. Host receipts retain exact report and execution-result linkage; the signed invocation transitively binds the exact mechanical-check ref. Arbitrary unbound V2 bytes or existing minted receipts are never a bypass.

Review grammar: strict UTF-8, `PRODUCE_REVIEW:` at the beginning followed by exactly one closed JSON object, optionally followed by newline-separated `SUMMARY:` and one closed JSON object. Standard JSON whitespace (including multiline JSON and trailing whitespace) and object-key order are insignificant; arrays and every string/value retain their exact meaning and order. The whole wire is at most 262,144 bytes; preflight permits at most 16 JSON nesting levels and 4,096 values before the existing closed schema bounds apply. Duplicate decoded keys at any depth (including escaped aliases), invalid/unsafe/nonfinite numbers, incomplete JSON, BOM, NUL, prose, fences, multiple cores and trailing junk refuse. A present SUMMARY must independently parse and equal core confidence plus every review field. Contradictory, ambiguous or malformed present SUMMARY fails closed even if later routing correction is supplied; the previous malformed-footer salvage expectation is deliberately removed for reviews only. Author wires retain their existing canonical two-line grammar. No missing core, binding, evidence or judgment is reconstructed.

Vera `UNVERIFIABLE/verification_incomplete/none` ends `incomplete/met:false`, without an author-defect claim, product-repair loop, PASS receipt or positive admission. Evidenced FAIL still follows the existing typed repair routes and every revision repeats Carren then Vera.

New review cores are version 2; mechanical checks remain version 1. Historical V1 review cores remain strictly interpretable with their original exact `product_ref` and `host_check_ref` requirements, including rejection of truncated or wrong refs; no fields are dropped, corrected or upgraded. Phase identifiers remain `penny.produce.quality-review-summary.v1` and `penny.produce.validity-review-summary.v1` because judgment details are unchanged (phase schema version remains 1; outer `PhaseResult` remains `schema_version:2`). Product, request, receipt, integrity and envelope formats are unchanged. Old prose review wires are not upgraded or inferred. Changed active registration bindings refuse interrupted old runs; unbound legacy active reviews without the new evidence fail closed. Already committed historical terminals retain exact existing replay under their original admission envelopes. No retained-state rewrite, resealing, discovery or migration occurs, and historical positives are not retroactively requalified.
