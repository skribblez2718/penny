# Knowledge Base — Operator Entry

The knowledge base (KB) is a **private, advisory, evidence-linked synthesis store**. It sits
beside the `AGENTS.md` documentation tree; it does not replace, flatten, or compete with it.

`AGENTS.md` routes canonical current-state lookup; navigation itself does not verify freshness or correctness. KB queries instead synthesize what captured sources say, where they disagree, and what remains unknown. Verify advisory synthesis before treating it as current.

Nothing becomes canonical by being stored, queried, linted, or proposed. Promotion into a
canonical document is a separate, explicitly approved authority transition, never an automatic
consequence of KB work.

## The eight public actions

The model-visible surface is exactly eight actions on one typed `knowledge_base` tool. There is
no ninth action, and in particular there is **no public approve or apply action**.

| Action    | Behavior                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`    | Validate an already-granted profile and, when host policy permits, create or validate the KB. Cannot register a root, choose a path, or change policy         |
| `ingest`  | Consume host-minted source capabilities; capture immutable evidence; extract, compose, check, review; publish only after an explicit content-review approval  |
| `query`   | Read one selected immutable generation and return an advisory, cited, bounded result. Returns an artifact reference by default; never a raw body              |
| `save`    | Turn an explicit prior query run into a proposed advisory revision, through the same review gate                                                              |
| `lint`    | Deterministic validation first; bounded semantic review only after that floor passes. Reports findings and candidate conflicts; repairs and publishes nothing |
| `promote` | Prepare and verify a candidate only. Never applies a canonical change through the public tool                                                                 |
| `status`  | Safe projection of a run after profile and identity revalidation. Cannot reveal roots or bodies                                                               |
| `resume`  | Continue a compatible run after profile re-resolution and guard checks. Cannot carry an approval                                                              |

`init`, `ingest`, `query`, `save`, `lint`, and `promote` are **start actions**; each creates a run
with durable idempotency bound to the host session and invocation. `status` and `resume` operate on
an existing run in the same session and profile.

## Authority order

1. **System and runtime constraints, and explicit human authorization.** Outrank everything else.
2. **Current code, tests, and canonical `AGENTS.md`-routed documents.** Decide current-state claims.
3. **Captured sources.** Evidence only.
4. **KB pages, claims, lint output, conflict candidates, query syntheses, promotion candidates.** Advisory.
5. **Model output and tool arguments.** Requests, never authority grants.

A model may name an opaque profile or capability ID it has been granted. It may never supply a
filesystem root, source path or locator, canonical target, provider choice, approval decision, or
receipt body. Those are host-owned. For profile, custody, policy, or promotion work, also read [Privacy and Promotion](privacy-and-promotion.md).

Canonical lookup stays on the `AGENTS.md` route. Ignored `$PROJECT_ROOT/research/` remains human-directed, point-in-time material, never a live data plane or automatic ingest source. No action accepts arbitrary paths/URLs/roots/targets/providers or returns raw source, page, claim, report, or patch bodies. A useful query does not authorize save; clean lint does not authorize publication; prepared promotion does not authorize apply.

## Advisory claim model

Each load-bearing page statement has a stable claim ID, kind (`fact`, `inference`, `speculation`, `unknown`), state (`supported`, `contested`, `superseded`, `unverified_current`), confidence, and evidence citations to source records. Preserve disagreement in explicit conflict records and state uncertainty. No supported citation means _unmet_ with the evidence gap named, never a fabricated answer.

## Requests, results, and retries

Every call is a request, not an authority grant. The host validates the closed schema and resolves authority before use.

No request carries a root, path, locator, canonical target, approval decision, receipt body, start
`run_id`, or idempotency key. Requests name an opaque `kb_profile_id` and, where applicable, opaque
capability IDs the host already minted.

A result carries the action, host-generated `run_id`, optional `kb_id`, status, `met`, opaque IDs
and counts, path-free artifact handles, safe evidence references, bounded warnings and unresolved
items, and a `next` step. Cross-fields are closed:

| Status                          | `met`                                                                         | `next`   |
| ------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `running`                       | false                                                                         | `resume` |
| `awaiting_user`                 | false                                                                         | `review` |
| `refused`, `error`, `exhausted` | false                                                                         | `none`   |
| `complete`                      | true for a satisfied action, false for a completed deny or unsupported answer | `none`   |

An **artifact handle is path-free**: an ID, kind, digest, media type, and byte length. It has no
path, relative path, logical filename, root, or locator. `answer_delivery: "artifact_ref"` means the
result carries that handle — it is not a second reference schema.

Start admission is atomic before capability claims or private reads. Exact session/invocation retries replay the stored safe projection; a changed request under the same identity is refused. A derived answer is never persisted or redelivered on retry: a new delivery needs a new invocation and grant.

## Select the operation guide

- **Query:** read [Retrieval and Lint](retrieval-and-lint.md#query-results) for the complete delivery/grounding/refusal contract. Default delivery is a path-free artifact handle; no action returns raw private bodies.
- **Ingest/save:** publication requires an explicit human content-review decision through the authenticated host service. A useful query does not authorize save: after generic start admission, the host re-reads the sealed answer to validate its current digest, then claims that exact grounded query answer before composition or consumer use. Refine retains that claim; deny releases it only while the sealed answer remains valid. No new sources enter save.
- **Promotion:** read [Privacy and Promotion](privacy-and-promotion.md#promotion). Public `promote` prepares only; apply needs separate host-only signed approval and exact target/preimage checks. Content-review approval cannot authorize promotion.
- **Status/resume:** revalidate the same session/profile and KB identity. Status exposes no roots or bodies; ordinary resume cannot carry any approval. Ingest/save decisions use the authenticated host callback, not generic engine `respond`; promotion has its separate approval service. Re-present a pending gate rather than inventing a decision.
- **Host implementation/maintenance:** read [Workflows](workflows.md) for admission, claim, publication, child-tool, and recovery ordering; [Manifest and Records](manifest-and-records.md) for immutable storage; [Privacy and Promotion](privacy-and-promotion.md) for custody or authorization changes; [Evaluation](evaluation.md) for quality gates. These implementation details are not prerequisites for an ordinary query/status call.

## Exact contract owners

For schema or implementation work, use these tracked owners; ordinary calls need not load their source:

[KB contracts](../../../apps/orchestration/src/kb/contracts.ts) owns the sole normative, closed, versioned TypeBox schemas, exact keys, states, path vocabulary, and digest contracts. Types derive from those schemas; [contract tests](../../../apps/orchestration/tests/kb-contracts.test.ts) import them directly and cover valid instances and negative mutations. Workflow ordering belongs to the [KB playbook](../../../apps/orchestration/src/playbooks/knowledge-base.ts) and its host KB modules, not an ignored implementation plan. A clean checkout is sufficient to locate these owners.
