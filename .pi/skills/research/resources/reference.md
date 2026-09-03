# Research Reference

The research skill is a registered TypeScript playbook. `OrchestrationService` combines the engine, Node SQLite checkpointer, immutable artifact owner, signed worker receipts, Pi SDK workers, owner-resolved context, deterministic host product work, and digest-only observability. No executable delegate exists in this skill directory.

## Normative current-truth map

`documentation-traceability.test.ts` enforces bidirectional claim/source/oracle equality.

| Claim ID | Normative claim | Source surface | Deterministic oracle |
|---|---|---|---|
| `RSC-001` | The sole research runtime is the TypeScript `ResearchPlaybook`; no Python child or skill delegate runs. | `SKILL.md`; `README.md`; this reference | `package-surface.test.ts`; `documentation-traceability.test.ts` |
| `RSC-002` | The authoritative output and chain handoff are the latest exact `GroundedSynthesisV1` semantic core; three Markdown files remain deterministic compatibility renders. | `SKILL.md`; `README.md`; this reference | `research-product-activation.test.ts`; `research-parity.test.ts` |
| `RSC-003` | P3 activates the acyclic latest-core receipt/render/product-envelope graph and deterministic crash-recoverable host renderer. | `SKILL.md`; `README.md`; this reference | `research-contract-v2.test.ts`; `research-product-activation.test.ts` |
| `RSC-004` | P3 projects Synthia's typed semantic draft before sealing, runs Vera before report Carren, and sends every changed core back through Vera before Carren or rendering. | `resources/flow.html`; this reference | `flow-diagrams.test.ts`; `research-product-activation.test.ts` |
| `RSC-005` | Deterministic P1 liveness/cancellation remains certified; the live-model PG4 Quick gate passed in verified run `p4-qr-live-20260827-009`. | `SKILL.md`; `README.md`; this reference | `liveness-budget.test.ts`; `worker-cancellation.test.ts`; ignored local PG4 verification bundle |
| `RSC-006` | Deprecated `report_format` remains real caller-owned output-shape guidance for the three declared cognitive consumers. | `SKILL.md`; phase prompts; this reference | `research-context.test.ts`; `prompt-guidance-contract.test.ts` |
| `RSC-007` | `rigor_escalation` is rejected and new terminal projections omit decoder-only `rigor_escalated`. | `SKILL.md`; this reference | `research-request-admission.test.ts`; `research-parity.test.ts` |
| `RSC-008` | Context/product metadata never alter exact selected-agent YAML tools, and private KB bodies never enter the product graph. | `SKILL.md`; this reference | `worker-tool-surface-matrix.test.ts`; `worker-registration.test.ts` |

## Closed request and ports

| Port | Direction | Cardinality | P3 status |
|---|---|---:|---|
| `request` | input | 1 | active inline `penny.research-request.v1` |
| `prior_grounded_synthesis` | input | 0–8 | active canonical `semantic-core` import |
| `legacy_context` | input | 0–64 | active untyped historical `agent-output` compatibility |
| `legacy_report_artifact` | output | 1 | recognized compatibility schema; not authoritative or chain-forwarded |
| `grounded_synthesis` | output | 1 | sole active semantic output |

Receipt, render, and research-product envelopes are graph products, never semantic output-port values. The existing W7 `CompletionAdmissionEnvelope` remains separate control-plane evidence.

Before a new run row or model session, owner code normalizes goal, scope, budget aliases, typed inputs, and identifier-only context into `ResearchRequestV1`. It persists canonical admitted-request bytes as an exact internal artifact. Unknown fields, `rigor_escalation`, duplicate refs/slots, host liveness fields, and cross-field conflicts fail closed.

## Presets and frozen liveness

| Mode | Plan critique | Quality critique | Total research rounds | Evaluator attempts |
|---|---:|---:|---:|---:|
| Quick | no | no | 2 | 3 |
| Standard | no | no | 2 | 3 |
| Deep | yes | yes | 3 | 3 |

Effective breadth remains `min(max_sub_queries, max_fan_width)`. Compatibility aliases remain value-preserving. Existing P1 phase/model/tool/external/time/malformed/protocol/cancellation ceilings and durable counters are unchanged. Host `sealing_core`/`rendering` work consumes no model turns or model-visible tools.

## Owner-resolved context

Bindings carry identifiers and expected digests—not paths, grants, tokens, TTLs, model-selected providers, or arbitrary KB queries. The owner supports versioned documents, exact already-approved KB results, and caller output shape.

Canonical `ContextSourceRefV1` artifacts record metadata only: source identity, slot, role, scope, content digest/length/media, revision, freshness, upstream locators, provider eligibility evidence, verification/conflict disposition, and exact cognitive consumers. Before model use, owner code re-resolves content and verifies the exact envelope, digest, length, freshness, approval, conflict, and consumer state. Private KB bodies do not enter checkpoints, telemetry, generic result bodies, semantic cores, receipts, renders, or envelopes. Context does not select/filter tools.

Consumer equality remains frozen:

| Slot | Cognitive consumers |
|---|---|
| domain guidance | planning, plan critique, researching, synthesizing, report critique, validating |
| standard guidance | planning, plan critique, researching, synthesizing, report critique, validating |
| output shape guidance | synthesizing, report critique, validating |

## P3 topology

```text
intake
  → optional planning
  → optional plan critique
  → Echo evidence fan
  → Synthia typed ResearchSemanticDraftV1
  → deterministic host projection/sealing_core
  → Vera validating
  → optional Carren report critique
  → host rendering/product checks
  → engine completion admission
```

Routing laws:

- Vera evidence gaps route to Echo; synthesis/core defects route to Synthia.
- Carren quality defects route to Synthia, then host projection/sealing, Vera, and Carren again.
- Every Echo/Synthia route reaches typed drafting and host projection/sealing before Vera.
- No changed core routes directly to Carren, rendering, or completion.
- Repair exhaustion, repeated deterministic defects, blocking ambiguity, unsafe paths, and drift are non-positive.

## Semantic core and graph

Synthia returns a closed `ResearchSemanticDraftV1` containing only semantic content and local numeric relations. Deterministic host projection assigns stable owner IDs by array order, range-checks every relation, maps evidence slots only to exact selected Echo artifacts, verifies each excerpt is contained in those exact bytes, computes `excerpt_sha256`, supplies admitted request/context/Echo/Synthia lineage, validates unchanged `GroundedSynthesisV1`, and persists only canonical core bytes. Immutable `semantic-core` revisions share one operation lineage; each revision has the prior core as parent. New cores make prior reviews/renders/envelopes stale for completion.

The graph is acyclic:

```text
semantic core
  ├─ grounding_verification receipt (Vera)
  ├─ optional quality_critique receipt (Carren)
  ├─ deterministic_product_validation receipt (host)
  ├─ report render
  ├─ sources render
  └─ README render
        ↓
ResearchProductEnvelopeV1
```

Every PASS receipt has non-empty exact evidence refs and exact latest-core ID/digest/schema/version. Agent receipt time derives from the durable execution receipt. Host receipt time is frozen in the first durable render intent. The envelope contains one grounding and deterministic receipt, optional one quality receipt, and exactly report/sources/readme renders. It is terminal graph evidence, never the output-port value.

## Deterministic renderer and recovery

Renderer ID is `penny.research.compat-markdown.v1`. It consumes only validated core bytes/ref and emits UTF-8 NFC LF-only files ending in exactly one LF:

- `report.md`: title, summary, declared narrative order, qualifications, contradictions, gaps, uncertainty, and stable IDs;
- `sources.md`: sources/evidence in stable ID order with provenance fields;
- `README.md`: question/scope, title/summary/posture, core binding, and fixed inventory.

The host persists a path-bounded intent and render artifacts before file writes. No-follow checks, exact indexed temporary names, file fsync, atomic rename, directory fsync, matching-file adoption, and post-write/full-set verification make retries idempotent. Symlinks, non-regular targets, escape, post-write drift, and incomplete sets return non-positive with the exact core preserved.

## Research Definition of Done

A positive terminal requires:

1. valid admitted request and latest canonical core manifest re-read;
2. exact request/context/evidence/synthesis lineage;
3. no unsupported claim, blocking gap/uncertainty, or unresolved contradiction;
4. same-core Vera PASS;
5. same-core Carren PASS when quality critique is enabled;
6. no exhausted required critique/verification/repair/liveness budget;
7. exactly three latest-core renders and matching files;
8. host deterministic-product PASS;
9. exact resolvable envelope graph;
10. terminal `output_artifact_ref` equal to the semantic-core ref;
11. central completion admission from `rendering` with zero unresolved blockers.

`complete/met:true/qualified:true` is allowed only for disclosed non-blocking uncertainty with every ordinary predicate still passing. Non-positive runs preserve the best exact partial and create no complete envelope. Decoder-only historical `rigor_escalated:false` is not projected in new results.
