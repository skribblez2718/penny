---
name: produce
description: "Create one durable reviewed artifact content product from a closed brief and inline supplied material. Use when the caller needs complete text, Markdown, JSON, YAML, TypeScript, JavaScript, Python, or shell content with exact criterion coverage and no filesystem or external mutation. Do not use for live research, file writing, code execution, testing, deployment, open-ended clarification, or multi-artifact production."
disable-model-invocation: false
metadata:
  penny:
    engine: orchestration
    release_status: candidate
    mempalace: false
    subagents: [ida, skribble, carren, vera]
---

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

This package is a model-visible candidate: Pi native discovery and Penny's model-facing catalog may describe it, but it remains absent from the production registry and never self-enables or promotes. Model visibility grants no execution authority. Explicit `skill` invocation is available only when ignored host configuration enables the exact candidate contract digest. Candidate enablement is reversible and is not production admission or promotion.

## Invocation

`skill({ skill_name: "produce", goal: "Purpose/problem statement", constraints: { schema_version: 1, output_name: "artifact.md", artifact_kind: "markdown", specification: [{ statement: "..." }], source_material: [{ statement: "...", source_label: "optional" }], acceptance_criteria: [{ statement: "..." }], hard_constraints: [], non_goals: [], known_uncertainties: [] } })`

Produce V1 accepts no caller artifact inputs. Every request array is closed and bounded; `specification` and `acceptance_criteria` are nonempty.

## Orchestrated Flow

```text
intake (host canonical request)
  → exploring_artifact_approaches (Ida; recommend, do not author)
  → materializing_artifact (Skribble; one complete draft)
  → sealing_artifact (host canonical ProducedArtifactV1)
  → critiquing_artifact (Carren quality review)
  → verifying_artifact (Vera objective compliance and lineage)
  → admitting_artifact (host current-product receipts + integrity/envelope)
  → complete
```

Carren `quality_gap` returns to Skribble. Vera `brief_gap` returns through Ida and then Skribble; Vera `artifact_product_gap` returns directly to Skribble. Every replacement draft is resealed and repeats Carren before Vera. Exhausted, malformed, stale, wrong-run, or missing exact material is non-positive `incomplete`; cancellation is `cancelled`.

## Exact Artifact Handoff

The host canonicalizes and persists `ProduceRequestV1`. Every cognitive directive carries owner-selected exact `input_artifacts` refs and an `output_artifact` contract. Ordinary candidate phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Other YAML tools may be used only when materially relevant, permitted by caller/task, and within the phase consequence boundary. In particular, Skribble's YAML write-capable surface does not authorize this workflow to write files: the complete product remains response content captured by the owner.

Normal-phase liveness permits at most 8 external calls per worker and 64 per run; routing-only repair remains at 0. These are resource ceilings, not authority for external research, filesystem mutation, execution, testing, publication, or deployment. The owner captures and re-reads exact bytes before routing, and memory availability cannot affect correctness.

## Output and Terminal Truth

The selected terminal `output_artifact_ref` identifies canonical `penny.produced-artifact.v1` semantic-core bytes. The product embeds exact output identity, content and SHA-256, rationale, assumptions, uncertainties, full request coverage, the canonical request, inline-source lineage, confidence, and literal `external_actions_performed:false`, `filesystem_writes_performed:false`, and `tests_executed:false`.

For `json`, the host requires parseable canonical JSON content. Other kinds are not compiled, executed, or syntax-checked. `produced` requires nonempty content. `not_applicable` requires empty content and a truthful explanation. Host sealing—not a worker—derives `content_sha256` from the exact UTF-8 content.

`complete/met:true` requires current-product Carren APPROVE and Vera PASS evidence, host-minted quality and validity receipts, deterministic integrity, an exact envelope, and CompletionGate v2 admission. It is not approval to write, publish, or execute the artifact.

## Recovery and Consequence Boundary

Recovery reuses the same exact selected refs and safely converges deterministic host sealing/admission. No state performs external reads, external actions, filesystem writes, tests, compilation, execution, deployment, publication, or direct approval.
