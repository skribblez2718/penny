# Produce candidate

`produce` is a registered universal orchestration workflow for one durable artifact content product from a closed brief and inline supplied material. It is model-visible through Pi native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
host intake → Ida explores → Demetri selects → Skribble materializes
            → host seals → Carren reviews quality → Vera verifies validity
            → host mints current-product receipts + integrity/envelope → complete
```

Host seal rejection creates a readable `SealDiagnosticV1` for the exact rejected draft, including the final rejection. Seal corrections follow actual operator policy, with no invented finite allowance when unspecified. Each rejected draft gets its own exact diagnostic before another attempt or honest negative terminal; previous-epoch diagnostics are not current instructions. Old diagnostics never enter a new epoch. Seal corrections do not spend semantic review repair budget. An exhausted run is incomplete; its rejected draft is not a canonical product.

## Order rules and prevented failure modes

| Order rule                                               | Failure mode it prevents                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Canonical intake before approach exploration             | Workers silently reinterpret or omit the caller's exact brief.                                                              |
| Ida explores bounded alternatives without selecting      | The first obvious format wins prematurely, or ideation silently becomes decision authority.                                 |
| Demetri selects before Skribble authors                  | A non-selecting agent is forced to recommend, or Skribble invents a choice while materializing.                             |
| Skribble alone materializes the final draft              | The decision is confused with the finished artifact or several partial drafts compete.                                      |
| Host sealing before reviews                              | Reviewers judge unvalidated framing, stale hashes, or incomplete request coverage.                                          |
| Carren quality review before Vera objective verification | The required product-facing quality pass is skipped or quality evidence is attached after validity to a different revision. |
| Every repair reseals and repeats Carren then Vera        | A changed draft inherits stale review evidence from the prior product.                                                      |
| Host receipts and envelope after both current reviews    | Model verdict text becomes persistence or admission authority.                                                              |

The Carren-before-Vera order is an explicit product requirement for this candidate. Vera remains independent: it assesses semantic compliance independently, consumes exact host mechanical evidence, and does not defer to Carren's judgment.

## Boundaries

- Accepts one inline closed brief and no caller artifact inputs.
- Supported kinds are exactly `text`, `markdown`, `json`, `yaml`, `typescript`, `javascript`, `python`, and `shell`.
- Supplied source statements are task material, not independently verified facts.
- Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for exact predecessors and no other channel may replace a missing ref. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase boundaries; Skribble's write-capable YAML surface does not authorize filesystem mutation in Produce.
- Ordinary permitted work has no invented model-turn, phase-admission, tool-call, external-call, or total elapsed-work quota; actual operator limits still apply; calibrated renewable inactivity leases stop stalled workers, host operations use independent renewable inactivity leases, and routing-only repair remains separate, governed by actual operator policy and measured-error/inactivity controls. Those controls do not authorize file writes, code execution, compilation, tests, browsing, fetching, deployment, publication, or direct approval.
- Demetri returns a justified selection with sensitivity, or an honest `unresolved` disposition when the brief cannot support a defensible choice; unresolved selection ends non-positive before materialization.
- `not_applicable` can complete when required supplied material is absent or hard constraints make production impossible; it contains no artifact content.
- Missing exact material, malformed products, stale/wrong-run evidence, and exhausted repair remain non-positive.

## Repair routes

- Carren `quality_gap` → Skribble.
- Vera `brief_gap` → Ida → Demetri → Skribble.
- Vera `artifact_product_gap` → Skribble.
- Host-seal rejection → Skribble with the exact diagnostic; no correction-count ceiling is inferred. Any actual operator-supplied exhaustion remains `incomplete` with its final diagnostic.

All revisions return through host sealing, Carren, and Vera. There is no user-response or approval state.

Produce opts into `repair_progress_policy:exact_fingerprint_v1` for valid Carren and Vera FAIL repairs. Before measuring, the host rechecks the immutable review core and signed assignment binding, exact current operands, native draft/product lineage and current mechanical evidence. The fingerprint covers the complete parsed `ProducedArtifactDraftV2` (including exact content, rationale, assumptions, uncertainties, coverage and confidence), validated Ida alternatives and Demetri selection, plus every failed-check detail except `strategy_delta`. Native approach IDs are mapped to full canonical option content in assessments and selection; regenerated IDs or reordering unranked alternatives/assessments do not count as progress. Descriptions, tradeoffs, feasibility/comparisons, rationale, sensitivity and the selected option remain significant for both reviewers, even when the draft is unchanged. Other authored strings and array order remain exact; no free-text identifier rewriting or semantic-equivalence inference occurs. Host refs, revisions, receipt/time identities, effect snapshots and wire framing are not candidate meaning. An unsupported route or unmeasurable native mapping returns `null` (no recurrence inference), not a guessed cap; invalid native bytes, custody or review binding still fail closed.

The same exact candidate and failed obligation recurring in the same review phase terminates `incomplete/met:false` with `incomplete_reason:repair_stalled`, preserving the latest product and current feedback without spending another repair. Durable history also catches A/B/A across restart. A changed draft, approach/selection basis or failed-check detail permits another review repair under actual operator policy; it is not proof of improvement or approval. This is exact recurrence, not paraphrase/keyword classification, and adds no step, time or attempt cap. Routing-only repair stays separate; the stronger core projection and signed meaning binding remain authoritative, and UNVERIFIABLE still terminates verification-incomplete without an author loop.

See `resources/reference.md` for the wire contract and `resources/flow.html` for the exact machine mirror.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `PRODUCE_FLOW`.
Validate it with `tests/produce-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill produce`.
It preserves the Carren-before-Vera ordering and documents omitted uniform
negative seams without adding write, execution, publication, or approval routes.

## Review truth and compatibility

Before Vera, the host exposes `penny.produce-mechanical-checks.v1`, bound to the exact current request/alternatives/decision/draft/product. Existing native validators recompute canonicality, content/draft/source/lineage hashes, coverage-array and disposition invariants, JSON canonicality when applicable, and effect-graph shape. Vera independently reviews semantic compliance and source fidelity; mechanical PASS is not semantic approval, execution by Vera, or evidence of effect absence. Unknown effects remain allowable only with the existing explicit limitation.

Carren and Vera emit one immutable semantic-only `PRODUCE_REVIEW` V2 core: `schema_version:2`, `review_kind`, `confidence`, and the complete closed `review` judgment. No opaque refs, IDs, digests or metadata are model-authored; extra fields refuse. The active prompt exposes only its quality or validity branch. Registration binds `penny.produce-review-semantic-projection.v1`, the version-1 host projection for this V2 wire. After exact raw capture/readback and receipt signing, the host derives phase confidence and the COMPLETE review object without another model call. This narrow exception replaces the duplicate model-authored final SUMMARY only for these review phases. Original bytes, digest and signed source provenance remain intact; projection grants no new judgment or completion authority. The host binds the exact current product and, for Vera, mechanical evidence through the original assignment, immutable source metadata and signed invocation digest. Receipt minting, reuse, continuation and final admission reparse original bytes and recheck exact role/run/phase/attempt/output revision, native operands, context designation and custody. Host receipts retain exact report and execution-result linkage; the signed invocation transitively binds the exact mechanical-check ref. Arbitrary unbound V2 bytes or existing minted receipts are never a bypass.

The host freezes the original task hash, input bindings and output metadata in an immutable assignment companion after contextual enrichment. Recovery and re-admission verify that companion and reauthenticate the original and any routed-repair receipts; they do not regenerate historical evidence from current prompt text. A compatible wording or slot-label change therefore leaves intact historical evidence valid. Missing or changed bindings fail closed.

Review grammar: strict UTF-8, `PRODUCE_REVIEW:` at the beginning followed by exactly one closed JSON object, optionally followed by newline-separated `SUMMARY:` and one closed JSON object. Standard JSON whitespace (including multiline JSON and trailing whitespace) and object-key order are insignificant; arrays and every string/value retain their exact meaning and order. The whole wire is at most 262,144 bytes; preflight permits at most 16 JSON nesting levels and 4,096 values before the existing closed schema bounds apply. Duplicate decoded keys at any depth (including escaped aliases), invalid/unsafe/nonfinite numbers, incomplete JSON, BOM, NUL, prose, fences, multiple cores and trailing junk refuse. A present SUMMARY must independently parse and equal core confidence plus every review field. Contradictory, ambiguous or malformed present SUMMARY fails closed even if later routing correction is supplied; the previous malformed-footer salvage expectation is deliberately removed for reviews only. Author wires retain their existing canonical two-line grammar. No missing core, binding, evidence or judgment is reconstructed.

Vera `UNVERIFIABLE/verification_incomplete/none` ends `incomplete/met:false`, without an author-defect claim, product-repair loop, PASS receipt or positive admission. Evidenced FAIL still follows the existing typed repair routes and every revision repeats Carren then Vera.

New review cores are version 2; mechanical checks remain version 1. Historical V1 review cores remain strictly interpretable with their original exact `product_ref` and `host_check_ref` requirements, including rejection of truncated or wrong refs; no fields are dropped, corrected or upgraded. Phase identifiers remain `penny.produce.quality-review-summary.v1` and `penny.produce.validity-review-summary.v1` because judgment details are unchanged (phase schema version remains 1; outer `PhaseResult` remains `schema_version:2`). Product, request, receipt, integrity and envelope formats are unchanged. Old prose review wires are not upgraded or inferred. Changed active registration bindings refuse interrupted old runs; unbound legacy active reviews without the new evidence fail closed. Already committed historical terminals retain exact existing replay under their original admission envelopes. No retained-state rewrite, resealing, discovery or migration occurs, and historical positives are not retroactively requalified.
